import { and, eq, desc } from 'drizzle-orm';
import { db } from '../db/client';
import { avisosFallidos, barberos, reservas } from '../db/schema';
import { uuidv7 } from '../db/id';
import { enmascararTel } from '../domain/phone';
import {
  armarMensaje,
  enviarWhatsApp,
  type DatosAviso,
  type TipoAviso,
  type Resultado,
} from './whatsapp';

/**
 * La cola de avisos: quien encola, quien consume, y donde queda lo que fallo.
 *
 * EL ENDPOINT ENCOLA Y RESPONDE. El consumer procesa aparte.
 *
 * El sistema viejo usaba un `Channel` en memoria del proceso: cada deploy se
 * llevaba puestos los mensajes pendientes, en silencio. Con Queues hay
 * persistencia y reintentos automaticos, y lo que igual no sale queda en
 * `avisos_fallidos` para que el barbero lo vea.
 *
 * 📌 Queues esta en el plan Free desde febrero de 2026: 10.000 operaciones por
 * dia, retencion de 24 h. Una barberia usa menos de 200 diarias. Si alguna
 * herramienta dice que hace falta Workers Paid, esta desactualizada.
 */

/** Coincide con `max_retries` de wrangler.jsonc. */
export const MAX_INTENTOS = 3;

/** El sobre que viaja por la cola. */
export interface MensajeAviso {
  clase: 'whatsapp';
  reservaId: string | null;
  barberoId: string;
  aviso: DatosAviso;
}

export const esMensajeAviso = (v: unknown): v is MensajeAviso =>
  typeof v === 'object' && v !== null && (v as MensajeAviso).clase === 'whatsapp';

/**
 * Encola. NUNCA lanza.
 *
 * Si la cola no esta disponible, se pierde el aviso y queda el log — pero la
 * reserva, que es lo que importa, ya esta confirmada.
 */
export async function encolarAviso(env: Env, mensaje: MensajeAviso): Promise<boolean> {
  try {
    await env.NOTIFICACIONES.send(mensaje);
    return true;
  } catch (e) {
    console.warn('notificaciones: no se pudo encolar', {
      reservaId: mensaje.reservaId,
      tipo: mensaje.aviso.tipo,
      // Enmascarado: es el telefono del CLIENTE y no tiene por que estar en un log.
      telefono: enmascararTel(mensaje.aviso.telefono),
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

// ------------------------------------------------------- destino del aviso

export interface DestinoBarbero {
  telefono: string;
  apikey: string;
}

/**
 * A quien se le manda el aviso: al barbero, no al cliente.
 *
 * Cada barbero tiene su `callmebot_phone` y su key. Si no las cargo, se cae al
 * fallback global de la configuracion — asi una barberia recien montada avisa
 * a un solo numero sin tener que configurar barbero por barbero.
 *
 * ⚠️ La key del barbero viene CIFRADA en la base (tarea 4.3). Acá se descifra
 * con `descifrar`, que se inyecta para no acoplar este modulo al esquema de
 * cifrado.
 */
export async function destinoDelBarbero(
  env: Env,
  barberoId: string,
  descifrar: (v: string) => Promise<string | null> = async (v) => v,
): Promise<DestinoBarbero | null> {
  const filas = await db(env.DB)
    .select({ tel: barberos.callmebotPhone, key: barberos.callmebotApikey })
    .from(barberos)
    .where(eq(barberos.id, barberoId))
    .limit(1);

  const fila = filas[0];
  const apikeyGlobal = env.CALLMEBOT_APIKEY?.trim();

  if (fila?.tel && fila.key) {
    const key = await descifrar(fila.key).catch(() => null);
    if (key) return { telefono: fila.tel, apikey: key };
  }

  // Fallback global: el numero del barbero con la key de la casa, o nada.
  if (fila?.tel && apikeyGlobal) return { telefono: fila.tel, apikey: apikeyGlobal };

  return null;
}

// ------------------------------------------------------------- el consumer

/** "Juan Pérez — Corte — 2027-04-01 10:30". Sobrevive al borrado de la reserva. */
export const resumirAviso = (a: DatosAviso): string =>
  `${a.nombre} — ${a.servicio} — ${a.fecha} ${a.hora}`;

/**
 * Deja constancia del aviso que no salio.
 *
 * ⚠️ REINTENTA SIN LAS FKs SI ESTAS FALLAN, y no es paranoia: los mensajes
 * viven hasta 24 h en la cola, y en ese rato el barbero puede haber sido
 * BORRADO —`borrarBarbero` es un delete fisico— o la reserva puede no existir.
 * Ahi el INSERT viola la foreign key y se pierde justo el registro que existe
 * para que nada se pierda en silencio.
 *
 * El `resumen` no depende de ninguna FK: por eso la fila sigue sirviendo
 * aunque las dos queden en null.
 */
export async function registrarFallo(
  env: Env,
  mensaje: MensajeAviso,
  motivo: string,
  intentos: number,
): Promise<void> {
  const base = {
    tipo: mensaje.aviso.tipo,
    motivo,
    intentos,
    resumen: resumirAviso(mensaje.aviso),
  };

  try {
    await db(env.DB).insert(avisosFallidos).values({
      id: uuidv7(),
      reservaId: mensaje.reservaId,
      barberoId: mensaje.barberoId,
      ...base,
    });
  } catch {
    // Segundo intento sin las referencias. Si tambien falla, que se propague:
    // ahi ya es la base la que esta rota, no un dato viejo.
    await db(env.DB).insert(avisosFallidos).values({
      id: uuidv7(),
      reservaId: null,
      barberoId: null,
      ...base,
    });
  }
}

/**
 * Procesa UN mensaje.
 *
 * Devuelve `reintentar` para que el llamador decida: la decision de reintentar
 * es del handler de la cola, no de acá.
 */
export async function procesarAviso(
  env: Env,
  mensaje: MensajeAviso,
  intentos: number,
  descifrar?: (v: string) => Promise<string | null>,
): Promise<{ ok: boolean; reintentar: boolean; motivo?: string }> {
  const destino = await destinoDelBarbero(env, mensaje.barberoId, descifrar);

  if (!destino) {
    // Un barbero sin CallMeBot configurado NO es un fallo que valga la pena
    // reintentar ni registrar: es una barberia que no uso la funcion.
    return { ok: false, reintentar: false };
  }

  const resultado: Resultado = await enviarWhatsApp(destino, armarMensaje(mensaje.aviso));
  if (resultado.ok) return { ok: true, reintentar: false };

  const ultimoIntento = intentos >= MAX_INTENTOS;

  console.warn('whatsapp: envio fallido', {
    reservaId: mensaje.reservaId,
    tipo: mensaje.aviso.tipo,
    intentos,
    // ⚠️ Los ULTIMOS 4 DIGITOS y nada mas. Ni el del cliente ni el del barbero.
    destino: enmascararTel(destino.telefono),
    motivo: resultado.motivo,
  });

  if (ultimoIntento) {
    await registrarFallo(env, mensaje, resultado.motivo, intentos);
  }

  return { ok: false, reintentar: !ultimoIntento, motivo: resultado.motivo };
}

/**
 * Handler del batch.
 *
 * `ack`/`retry` van por MENSAJE y no por batch: un aviso que falla no puede
 * arrastrar a los otros nueve del batch a reintentarse, porque esos ya se
 * enviaron y llegarian duplicados.
 */
export async function procesarBatch(
  env: Env,
  batch: MessageBatch<unknown>,
  descifrar?: (v: string) => Promise<string | null>,
): Promise<void> {
  for (const msg of batch.messages) {
    if (!esMensajeAviso(msg.body)) {
      // Un mensaje que no entendemos no mejora reintentandolo.
      console.warn('notificaciones: mensaje desconocido en la cola', { id: msg.id });
      msg.ack();
      continue;
    }

    try {
      const r = await procesarAviso(env, msg.body, msg.attempts, descifrar);
      if (r.reintentar) msg.retry();
      else msg.ack();
    } catch (e) {
      // Ni una excepcion inesperada puede dejar el batch entero colgado.
      console.error('notificaciones: excepcion procesando un aviso', {
        id: msg.id,
        error: e instanceof Error ? e.message : String(e),
      });
      msg.ack();
    }
  }
}

// ------------------------------------------------------ armado de mensajes

/** Datos minimos de una reserva para armar su aviso. */
export interface ReservaParaAviso {
  id: string;
  barberoId: string;
  nombre: string;
  telefono: string;
  servicio: string;
  fecha: string;
  hora: string;
}

export const avisoDeReserva = (
  r: ReservaParaAviso,
  tipo: TipoAviso,
  nota: string,
): MensajeAviso => ({
  clase: 'whatsapp',
  reservaId: r.id,
  barberoId: r.barberoId,
  aviso: {
    tipo,
    nombre: r.nombre,
    telefono: r.telefono,
    servicio: r.servicio,
    fecha: r.fecha,
    hora: r.hora,
    extra: nota,
  },
});

/**
 * Encola el aviso de un cambio sobre una reserva que YA existe.
 *
 * Lee los datos frescos de la base en vez de recibirlos: al reprogramar, el
 * llamador tiene los valores viejos a mano y seria facil mandar el aviso con
 * la hora anterior.
 *
 * NUNCA lanza. Se saltea los bloqueos administrativos: no son el turno de
 * nadie y no hay a quien avisarle.
 */
export async function avisarCambio(
  env: Env,
  reservaId: string,
  tipo: TipoAviso,
  nota: string,
): Promise<boolean> {
  try {
    if (!env.NOTIFICACIONES) return false;

    const filas = await db(env.DB)
      .select({
        id: reservas.id,
        barberoId: reservas.barberoId,
        nombre: reservas.nombre,
        telefono: reservas.telefono,
        servicio: reservas.servicio,
        fecha: reservas.fecha,
        hora: reservas.hora,
        tipoReserva: reservas.tipo,
      })
      .from(reservas)
      .where(eq(reservas.id, reservaId))
      .limit(1);

    const r = filas[0];
    if (!r?.barberoId || r.tipoReserva !== 'turno') return false;

    return encolarAviso(env, avisoDeReserva({ ...r, barberoId: r.barberoId }, tipo, nota));
  } catch (e) {
    console.warn('notificaciones: no se pudo armar el aviso de cambio', {
      reservaId,
      tipo,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

// ------------------------------------------------ lo que el barbero ve

/** Tope del listado: es una pantalla de diagnostico, no un historial. */
export const LIMITE_AVISOS_FALLIDOS = 100;

export interface AvisoFallido {
  id: string;
  reservaId: string | null;
  tipo: string;
  motivo: string;
  intentos: number;
  resumen: string;
  createdAt: string;
}

/**
 * Los avisos que no salieron. Scoped por rol, como todo el panel.
 *
 * Sin esto la tabla no sirve de nada: un aviso perdido seguiria siendo
 * invisible, que es exactamente el problema que vino a resolver.
 */
export async function listarAvisosFallidos(
  env: Env,
  barberoId: string | null,
): Promise<AvisoFallido[]> {
  return db(env.DB)
    .select({
      id: avisosFallidos.id,
      reservaId: avisosFallidos.reservaId,
      tipo: avisosFallidos.tipo,
      motivo: avisosFallidos.motivo,
      intentos: avisosFallidos.intentos,
      resumen: avisosFallidos.resumen,
      createdAt: avisosFallidos.createdAt,
    })
    .from(avisosFallidos)
    .where(barberoId ? and(eq(avisosFallidos.barberoId, barberoId)) : undefined)
    .orderBy(desc(avisosFallidos.createdAt))
    .limit(LIMITE_AVISOS_FALLIDOS);
}

/** Marcar como visto = borrar. Es un tablero de pendientes, no un log. */
export async function descartarAvisoFallido(
  env: Env,
  id: string,
  barberoId: string | null,
): Promise<boolean> {
  const filas = await db(env.DB)
    .select({ barberoId: avisosFallidos.barberoId })
    .from(avisosFallidos)
    .where(eq(avisosFallidos.id, id))
    .limit(1);

  const fila = filas[0];
  if (!fila) return false;
  // Un barbero solo descarta los suyos. Los huerfanos (barbero_id null,
  // porque el barbero se borro) son solo del owner.
  if (barberoId && fila.barberoId !== barberoId) return false;

  await db(env.DB).delete(avisosFallidos).where(eq(avisosFallidos.id, id));
  return true;
}
