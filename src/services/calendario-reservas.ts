import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { barberos, reservas } from '../db/schema';
import { enmascararTel } from '../domain/phone';
import {
  crearEvento,
  borrarEvento,
  calendarHabilitado,
  tituloEvento,
  descripcionEvento,
} from './gcal';

/**
 * El puente entre las reservas y Google Calendar.
 *
 * `gcal.ts` no sabe que existe una base de datos; esto sí. Acá vive el
 * "de donde sale el calendarId", el "donde se guarda el eventId" y las tres
 * razones por las que la sincronizacion se saltea sin que sea un error.
 *
 * ⚠️ TODO ES BEST-EFFORT Y NADA LANZA. Cuando esto corre, la reserva ya esta
 * confirmada.
 */

interface DatosCalendario {
  calendarId: string | null;
  calendarEventId: string | null;
  fecha: string;
  hora: string;
  duracionMin: number;
  servicio: string;
  nombre: string;
  telefono: string;
  turnoAutoIso: string | null;
}

/** Reserva + calendario del barbero, en una sola query. */
async function datosDe(env: Env, reservaId: string): Promise<DatosCalendario | null> {
  const filas = await db(env.DB)
    .select({
      calendarId: barberos.calendarId,
      calendarEventId: reservas.calendarEventId,
      fecha: reservas.fecha,
      hora: reservas.hora,
      duracionMin: reservas.duracionMin,
      servicio: reservas.servicio,
      nombre: reservas.nombre,
      telefono: reservas.telefono,
      turnoAutoIso: reservas.turnoAutoIso,
    })
    .from(reservas)
    .leftJoin(barberos, eq(reservas.barberoId, barberos.id))
    .where(eq(reservas.id, reservaId))
    .limit(1);

  return filas[0] ?? null;
}

const guardarEventId = (env: Env, reservaId: string, eventId: string | null) =>
  db(env.DB).update(reservas).set({ calendarEventId: eventId }).where(eq(reservas.id, reservaId));

/**
 * ⚠️ LOS TRES MOTIVOS PARA NO SINCRONIZAR, Y NINGUNO ES UN ERROR:
 *
 *   1. no hay credenciales               → la integracion esta apagada
 *   2. la reserva no existe              → carrera con un borrado
 *   3. el barbero no tiene `calendar_id` → no configuro el suyo
 *
 * Los tres son estados normales y salen en silencio. Solo se loguea cuando
 * Google contesta mal, que es lo unico que alguien puede llegar a arreglar.
 *
 * Devuelve los datos CON el `calendarId` ya garantizado no-nulo, en vez de un
 * booleano: si devolviera un motivo, cada llamador tendria que repetir
 * `!datos?.calendarId` para convencer a TypeScript, y esa repeticion vuelve
 * inerte al chequeo de acá — verificado por mutacion: borrarlo no rompia nada
 * porque los tres llamadores ya lo estaban re-chequeando.
 */
type DatosSincronizables = DatosCalendario & { calendarId: string };

async function datosSincronizables(
  env: Env,
  reservaId: string,
): Promise<DatosSincronizables | null> {
  if (!calendarHabilitado(env)) return null;

  const datos = await datosDe(env, reservaId);
  if (!datos?.calendarId) return null;

  return datos as DatosSincronizables;
}

/** Crea el evento de una reserva recien confirmada y guarda su `eventId`. */
export async function sincronizarAlta(env: Env, reservaId: string): Promise<string | null> {
  const datos = await datosSincronizables(env, reservaId);
  if (!datos) return null;

  // `turno_auto_iso` marca los generados por el cron de recurrentes (Fase 5):
  // llevan "(R)" en el titulo para que el barbero los distinga de un vistazo.
  const recurrente = datos.turnoAutoIso !== null;

  const eventId = await crearEvento(env, {
    calendarId: datos.calendarId,
    summary: tituloEvento(datos.nombre, datos.servicio, recurrente),
    description: descripcionEvento(datos.telefono, recurrente),
    fecha: datos.fecha,
    hora: datos.hora,
    duracionMin: datos.duracionMin,
  });

  if (eventId) await guardarEventId(env, reservaId, eventId);
  return eventId;
}

/**
 * Borra el evento de una reserva cancelada.
 *
 * El `calendar_event_id` se limpia SOLO si Google confirmo el borrado. Si
 * falla, la columna queda: es el unico rastro de que hay un evento huerfano en
 * el calendario del barbero, y borrarla lo volveria invisible.
 */
export async function sincronizarCancelacion(env: Env, reservaId: string): Promise<boolean> {
  const datos = await datosSincronizables(env, reservaId);
  if (!datos?.calendarEventId) return false;

  const borrado = await borrarEvento(env, datos.calendarId, datos.calendarEventId);
  if (borrado) await guardarEventId(env, reservaId, null);

  return borrado;
}

/**
 * Mueve el evento: borra el viejo y crea uno nuevo.
 *
 * Se llama DESPUES del UPDATE, asi que `datosDe` ya trae la fecha y hora
 * nuevas — pero el `calendar_event_id` sigue siendo el del evento viejo, que
 * es justo lo que hace falta para borrarlo.
 */
export async function sincronizarReprogramacion(
  env: Env,
  reservaId: string,
): Promise<string | null> {
  const datos = await datosSincronizables(env, reservaId);
  if (!datos) return null;

  if (datos.calendarEventId) {
    await borrarEvento(env, datos.calendarId, datos.calendarEventId);
  }

  const eventId = await crearEvento(env, {
    calendarId: datos.calendarId,
    summary: tituloEvento(datos.nombre, datos.servicio, datos.turnoAutoIso !== null),
    description: descripcionEvento(datos.telefono, datos.turnoAutoIso !== null),
    fecha: datos.fecha,
    hora: datos.hora,
    duracionMin: datos.duracionMin,
  });

  // Aunque `crearEvento` falle se guarda `null`: el evento viejo ya no existe,
  // y dejar su id apuntaria a algo borrado.
  await guardarEventId(env, reservaId, eventId);
  return eventId;
}

/**
 * Envoltorio para los llamadores que NO pueden fallar.
 *
 * `cancelarReserva` y `reprogramarReserva` ya devolvieron exito cuando esto
 * corre: una excepcion acá volveria 500 una operacion que salio bien.
 */
export async function sinRomper(
  operacion: string,
  reservaId: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.warn(`calendario: ${operacion} fallo, la reserva sigue bien`, {
      reservaId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Re-export para que los llamadores no importen `phone` solo para loguear. */
export { enmascararTel };
