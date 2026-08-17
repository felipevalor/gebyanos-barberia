import { and, eq, gte, asc } from 'drizzle-orm';
import { db } from '../db/client';
import { clientesRecurrentes, reservas } from '../db/schema';
import { evaluarSlot } from '../domain/schedule';
import { todayArgentina, diaDeLaSemana } from '../domain/dates';
import type { Bloque } from '../domain/slots';

/**
 * Bloquear + Avisar — el patron que impide dejar turnos huerfanos.
 *
 * Cinco operaciones de configuracion pueden dejar turnos ya agendados sin
 * cobertura. En vez de aplicar el cambio y romper la agenda en silencio, se
 * devuelve 409 CON LA LISTA de turnos en conflicto.
 *
 * ⚠️ LA LISTA ES EL PUNTO, NO EL RECHAZO. Un "no se pudo" pelado deja al dueño
 * sin saber que reagendar, y termina borrando cosas a mano hasta que el boton
 * funcione.
 *
 *
 * TODAS las consultas de conflicto filtran igual:
 *
 *   fecha >= hoy AND estado = 'activa' AND tipo = 'turno'
 *
 * O sea: turno de cliente REAL, futuro y no cancelado.
 *
 * - Un turno pasado ya ocurrio: cambiar el horario de los martes no lo afecta.
 * - Una reserva cancelada no es un compromiso con nadie.
 * - Un BLOQUEO ADMINISTRATIVO no cuenta: es del propio barbero, y no tendria
 *   sentido que su propio bloqueo le impida cambiar su horario.
 */

export interface TurnoEnConflicto {
  id: string;
  fecha: string;
  hora: string;
  nombre: string;
  telefono: string;
  servicio: string;
  duracionMin: number;
}

/** Turnos de cliente, futuros y activos, de un barbero. La base de todo. */
async function turnosVigentes(
  env: Env,
  barberoId: string,
  ahora: Date,
): Promise<TurnoEnConflicto[]> {
  return db(env.DB)
    .select({
      id: reservas.id,
      fecha: reservas.fecha,
      hora: reservas.hora,
      nombre: reservas.nombre,
      telefono: reservas.telefono,
      servicio: reservas.servicio,
      duracionMin: reservas.duracionMin,
    })
    .from(reservas)
    .where(
      and(
        eq(reservas.barberoId, barberoId),
        gte(reservas.fecha, todayArgentina(ahora)),
        eq(reservas.estado, 'activa'),
        eq(reservas.tipo, 'turno'),
      ),
    )
    .orderBy(asc(reservas.fecha), asc(reservas.hora));
}

/**
 * Turnos que NO entrarian en los bloques nuevos de un dia de la semana.
 *
 * Se filtra el `dow` en memoria y no en SQL porque SQLite no tiene una funcion
 * de dia de la semana que respete la zona horaria de Argentina, y hacerlo mal
 * correria los turnos de los domingos a la noche.
 */
export async function turnosFueraDelHorario(
  env: Env,
  barberoId: string,
  dow: number,
  bloquesNuevos: Bloque[],
  ahora: Date = new Date(),
): Promise<TurnoEnConflicto[]> {
  const turnos = await turnosVigentes(env, barberoId, ahora);

  return turnos.filter((t) => {
    if (diaDeLaSemana(t.fecha) !== dow) return false;

    // Con la duracion REAL del turno: uno de 60 min puede no entrar donde
    // entraria uno de 30.
    return evaluarSlot(bloquesNuevos, null, t.hora, t.duracionMin) !== 'abierto';
  });
}

/** Turnos vigentes en una fecha puntual. Para cerrar un dia. */
export async function turnosEnFecha(
  env: Env,
  barberoId: string,
  fecha: string,
  ahora: Date = new Date(),
): Promise<TurnoEnConflicto[]> {
  const turnos = await turnosVigentes(env, barberoId, ahora);
  return turnos.filter((t) => t.fecha === fecha);
}

/** Todos los turnos vigentes. Para desactivar o borrar un barbero. */
export async function turnosFuturos(
  env: Env,
  barberoId: string,
  ahora: Date = new Date(),
): Promise<TurnoEnConflicto[]> {
  return turnosVigentes(env, barberoId, ahora);
}

/**
 * Cuantos clientes recurrentes ACTIVOS tiene el barbero.
 *
 * ⚠️ Esto existe por una asimetria del schema que no se ve al leer el codigo:
 *
 *   reservas.barbero_id            → SET NULL  (preserva el historial)
 *   clientes_recurrentes.barbero_id → CASCADE   (se borran en silencio)
 *
 * O sea que borrar un barbero se lleva puestos sus recurrentes sin avisar. Por
 * eso el chequeo del borrado mira las dos cosas y no solo los turnos.
 */
export async function contarRecurrentes(env: Env, barberoId: string): Promise<number> {
  const filas = await db(env.DB)
    .select({ id: clientesRecurrentes.id })
    .from(clientesRecurrentes)
    .where(
      and(eq(clientesRecurrentes.barberoId, barberoId), eq(clientesRecurrentes.activo, 1)),
    );

  return filas.length;
}

// ------------------------------------------------------------- mensajes

/**
 * Transcripcion textual. El `{n}` va interpolado y el plural queda como
 * "turno(s)" a proposito: es lo que dice la spec.
 */
export const mensajeFueraDeHorario = (n: number): string =>
  `Hay ${n} turno(s) que quedarían fuera del nuevo horario. Reagendalos o cancelalos antes de cambiar el horario.`;

export const mensajeDiaConTurnos = (n: number): string =>
  `Hay ${n} turno(s) ese día. Reagendalos o cancelalos antes de marcarlo como cerrado.`;

export const mensajeNoSePuedeDesactivar = (n: number): string =>
  `No se puede desactivar: el barbero tiene ${n} turno(s) futuro(s). Reagendalos o cancelalos antes de desactivarlo.`;

/** El agregado de recurrentes se CONCATENA, con el espacio adelante. */
export const mensajeNoSePuedeBorrar = (n: number, conRecurrentes: boolean): string =>
  `No se puede borrar: el barbero tiene ${n} turno(s) futuro(s). Reasignalos o cancelalos antes de borrarlo.` +
  (conRecurrentes ? ' Además tiene clientes recurrentes asociados que se perderían.' : '');

export const mensajeRecurrenteConTurnos = (n: number): string =>
  `El recurrente fue eliminado pero quedan ${n} turno(s) futuro(s) agendado(s) que no se cancelaron automáticamente.`;

// --------------------------------------------------- chequeos compuestos

export type Chequeo =
  | { hayConflicto: false }
  | { hayConflicto: true; mensaje: string; turnos: TurnoEnConflicto[] };

export async function chequearCambioDeHorario(
  env: Env,
  barberoId: string,
  dow: number,
  bloquesNuevos: Bloque[],
  ahora: Date = new Date(),
): Promise<Chequeo> {
  const turnos = await turnosFueraDelHorario(env, barberoId, dow, bloquesNuevos, ahora);
  if (turnos.length === 0) return { hayConflicto: false };

  return { hayConflicto: true, mensaje: mensajeFueraDeHorario(turnos.length), turnos };
}

export async function chequearCierreDeFecha(
  env: Env,
  barberoId: string,
  fecha: string,
  ahora: Date = new Date(),
): Promise<Chequeo> {
  const turnos = await turnosEnFecha(env, barberoId, fecha, ahora);
  if (turnos.length === 0) return { hayConflicto: false };

  return { hayConflicto: true, mensaje: mensajeDiaConTurnos(turnos.length), turnos };
}

export async function chequearDesactivarBarbero(
  env: Env,
  barberoId: string,
  ahora: Date = new Date(),
): Promise<Chequeo> {
  const turnos = await turnosFuturos(env, barberoId, ahora);
  if (turnos.length === 0) return { hayConflicto: false };

  return { hayConflicto: true, mensaje: mensajeNoSePuedeDesactivar(turnos.length), turnos };
}

/**
 * Borrar un barbero.
 *
 * A diferencia de desactivar, ACA los recurrentes tambien importan: el CASCADE
 * los borraria sin dejar rastro. Si hay turnos, el mensaje los menciona; si no
 * hay turnos pero sí recurrentes, igual se bloquea.
 */
export async function chequearBorrarBarbero(
  env: Env,
  barberoId: string,
  ahora: Date = new Date(),
): Promise<Chequeo> {
  const [turnos, recurrentes] = await Promise.all([
    turnosFuturos(env, barberoId, ahora),
    contarRecurrentes(env, barberoId),
  ]);

  if (turnos.length === 0 && recurrentes === 0) return { hayConflicto: false };

  return {
    hayConflicto: true,
    mensaje: mensajeNoSePuedeBorrar(turnos.length, recurrentes > 0),
    turnos,
  };
}
