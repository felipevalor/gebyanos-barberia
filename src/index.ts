import { Hono } from 'hono';
import { fail } from './api';
import { sinCache } from './middleware/cache';
import { publicRoutes } from './routes/public';
import { adminRoutes } from './routes/admin';
import { miTurnoRoutes } from './routes/mi-turno';
import { procesarBatch } from './services/notificaciones';
import { apikeyDe } from './services/callmebot';
import { limpiarVencidos, refrescarFeriadosForzado } from './services/cron';
import { generarRecurrentesDelDia } from './services/recurrentes';

/** 03:00 ART — refresco de la cache de feriados nacionales. */
const HORA_UTC_FERIADOS = 6;
/** 06:00 ART — generacion de los turnos recurrentes. */
const HORA_UTC_RECURRENTES = 9;

/**
 * Inyectados en build time. Ver el script `deploy` en package.json.
 *
 * Se declaran con `declare const` y no se leen de `env`: un binding se puede
 * cambiar sin redesplegar, y entonces mentiria justo sobre lo que tiene que
 * decir la verdad.
 */
declare const __VERSION__: string;
declare const __DEPLOYED_AT__: string;

const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'desconocido';
const DEPLOYED_AT = typeof __DEPLOYED_AT__ === 'string' ? __DEPLOYED_AT__ : 'desconocido';

const app = new Hono<{ Bindings: Env }>();


/**
 * `GET /health` — la sonda de DRIFT, no solo de vida.
 *
 * ⚠️ Devuelve el SHA del commit desplegado, inyectado en build time por
 * `wrangler deploy --define`. Un `git log` contra un request y sabés en diez
 * segundos si lo que corre es lo que creés.
 *
 * Esto no existia, y por eso produccion estuvo 15 commits atras sin que nadie
 * lo viera: el suite de tests no puede saber qué version esta publicada.
 *
 * `desconocido` significa que se buildeo sin el `--define`, o sea `npm run dev`.
 */
/**
 * ⚠️ `sinCache()` EXPLICITO, aunque el default ya lo cubra.
 *
 * Es el unico endpoint donde una respuesta vieja es activamente dañina: miente
 * sobre qué version esta corriendo, que es exactamente lo que vino a detectar.
 * La intencion tiene que leerse en la ruta y no depender de un default.
 */
app.get('/health', sinCache(), (c) =>
  c.json({ ok: true, version: VERSION, deployedAt: DEPLOYED_AT }, 200),
);

app.route('/api', publicRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/mi-turno', miTurnoRoutes);

/**
 * ⚠️ `no-store` A MANO. El `notFound` no pasa por ningun router, asi que sin
 * esto sale sin `Cache-Control` y un CDN aplica su heuristica: un 404 cacheado
 * durante un despliegue a medias deja la landing rota hasta que expire un TTL
 * que nadie eligio.
 */
app.notFound((c) =>
  c.json(fail('No encontrado.'), 404, { 'Cache-Control': 'no-store' }),
);

app.onError((err, c) => {
  console.error('error no controlado', err);

  // El mensaje de 500 de la reserva es contrato: transcripcion textual.
  // Igual que el notFound: un 500 cacheado es peor que el 500.
  const sinGuardar = { 'Cache-Control': 'no-store' };

  if (c.req.method === 'POST' && c.req.path === '/api/reservas') {
    return c.json(
      fail('Ocurrió un error al procesar la reserva. Por favor, reintentá.'),
      500,
      sinGuardar,
    );
  }

  return c.json(fail('Error interno.'), 500, sinGuardar);
});

export default {
  fetch: app.fetch,

  /**
   * Un unico Cron Trigger horario ("0 * * * *") que despacha por hora.
   *
   * Los Cron Triggers son 5 por CUENTA en el plan Free. Consolidar los tres
   * jobs en uno deja lugar para 5 instancias del sistema (ver Fase 6) en vez
   * de una sola.
   *
   * Los crons corren en UTC; Argentina es UTC-3 fijo (sin DST).
   *
   * 🚫 NO HAY JOB DE RECORDATORIOS AL CLIENTE, y no es un olvido: CallMeBot
   * exige que el DESTINATARIO haya autorizado al bot y tenga su propia API
   * key, asi que no se le puede escribir a un numero de cliente cualquiera.
   * Todo el WhatsApp de este sistema va al BARBERO. Ver docs/pendientes.md.
   */
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const horaUtc = new Date(controller.scheduledTime).getUTCHours();
    const ahora = new Date(controller.scheduledTime);

    // ⚠️ Cada job en su propio try: uno que falle no puede impedir que corran
    // los otros. Un cron que se cae entero por un error en la limpieza dejaria
    // de refrescar los feriados sin que nadie relacione las dos cosas.
    try {
      console.log('cron: limpieza', await limpiarVencidos(env, ahora));
    } catch (e) {
      console.error('cron: falló la limpieza', e instanceof Error ? e.message : String(e));
    }

    if (horaUtc === HORA_UTC_FERIADOS) {
      try {
        console.log('cron: feriados', await refrescarFeriadosForzado(env, ahora));
      } catch (e) {
        console.error(
          'cron: falló el refresco de feriados',
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    if (horaUtc === HORA_UTC_RECURRENTES) {
      try {
        console.log('cron: recurrentes', await generarRecurrentesDelDia(env, ahora));
      } catch (e) {
        console.error(
          'cron: falló la generación de recurrentes',
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  },

  /**
   * Consumidor de la cola de avisos de WhatsApp.
   *
   * 📌 Queues esta en el plan Free (10.000 ops/dia). El comentario anterior
   * decia que requeria Workers Paid: quedo desactualizado desde febrero de
   * 2026, y el binding nunca estuvo comentado en wrangler.jsonc.
   */
  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext) {
    // El descifrado se INYECTA para que `notificaciones` no dependa del
    // esquema de cifrado: la cola no tiene por que saber como se guarda la key.
    await procesarBatch(env, batch, (guardada) => apikeyDe(env, guardada));
  },
} satisfies ExportedHandler<Env>;

export { BarberoAgenda } from './do/BarberoAgenda';
export { RateLimiter } from './do/RateLimiter';
