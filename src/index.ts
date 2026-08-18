import { Hono } from 'hono';
import { fail } from './api';
import { publicRoutes } from './routes/public';
import { adminRoutes } from './routes/admin';
import { miTurnoRoutes } from './routes/mi-turno';
import { procesarBatch } from './services/notificaciones';
import { apikeyDe } from './services/callmebot';
import { limpiarVencidos, refrescarFeriadosForzado } from './services/cron';

/** 21:00 ART — recordatorios de los turnos del dia siguiente. */
const HORA_UTC_RECORDATORIOS = 0;
/** 03:00 ART — refresco de la cache de feriados nacionales. */
const HORA_UTC_FERIADOS = 6;
/** 06:00 ART — generacion de los turnos recurrentes. */
const HORA_UTC_RECURRENTES = 9;

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }, 200));

app.route('/api', publicRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/mi-turno', miTurnoRoutes);

app.notFound((c) => c.json(fail('No encontrado.'), 404));

app.onError((err, c) => {
  console.error('error no controlado', err);

  // El mensaje de 500 de la reserva es contrato: transcripcion textual.
  if (c.req.method === 'POST' && c.req.path === '/api/reservas') {
    return c.json(
      fail('Ocurrió un error al procesar la reserva. Por favor, reintentá.'),
      500,
    );
  }

  return c.json(fail('Error interno.'), 500);
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
   * Implementaciones: Fase 4 (recordatorios) y Fase 5 (recurrentes).
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

    if (horaUtc === HORA_UTC_RECORDATORIOS) {
      console.log('cron: recordatorios (no implementado)');
    }

    if (horaUtc === HORA_UTC_RECURRENTES) {
      console.log('cron: recurrentes (no implementado)');
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
