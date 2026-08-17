import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { reservas } from '../db/schema';
import { crearReserva, type EntradaReserva, type ResultadoReserva } from './reserva';
import { buscarReserva } from './agenda';
import { MENSAJE_OVERLAP } from '../do/BarberoAgenda';
import type { Rol } from './auth';

/**
 * Escrituras del panel: cancelar, reprogramar, bloquear e importar.
 */

export const MAX_FILAS_IMPORT = 500;

export const ERROR_SOLO_OWNER_IMPORT = 'Solo los dueños pueden importar reservas.';
export const ERROR_SLOT_OCUPADO = 'Ya existe una reserva en ese horario.';
export const ERROR_RESERVA_NO_ENCONTRADA = 'Reserva no encontrada.';
export const ERROR_LOTE_DEMASIADO_GRANDE = `No se pueden importar más de ${MAX_FILAS_IMPORT} filas por vez.`;

/**
 * Permiso sobre una reserva puntual.
 *
 * Un `barbero` solo toca las suyas; el `owner` todas. Va aparte del scoping de
 * los listados porque acá el recurso ya existe y hay que compararlo, no
 * filtrar.
 */
export function puedeTocar(
  sesion: { barberoId: string; rol: Rol },
  reserva: { barberoId: string | null },
): boolean {
  return sesion.rol === 'owner' || reserva.barberoId === sesion.barberoId;
}

// ------------------------------------------------------------- cancelacion

export type ResultadoCancelacion =
  | { estado: 'exito' }
  | { estado: 'noEncontrada' }
  | { estado: 'prohibido' };

/**
 * SOFT DELETE. Nunca `DELETE` fisico.
 *
 * Marca `estado = 'cancelada'` y sella `cancelada_at`. La fila queda: es
 * historial, y ademas el indice unico parcial solo mira las activas, asi que
 * el slot se libera solo.
 */
export async function cancelarReserva(
  env: Env,
  sesion: { barberoId: string; rol: Rol },
  id: string,
  ahora: Date = new Date(),
): Promise<ResultadoCancelacion> {
  const reserva = await buscarReserva(env, id);
  if (!reserva) return { estado: 'noEncontrada' };
  if (!puedeTocar(sesion, reserva)) return { estado: 'prohibido' };

  await db(env.DB)
    .update(reservas)
    .set({ estado: 'cancelada', canceladaAt: ahora.toISOString() })
    .where(eq(reservas.id, id));

  return { estado: 'exito' };
}

// ---------------------------------------------------------- reprogramacion

export type ResultadoEdicion =
  | { estado: 'exito' }
  | { estado: 'noEncontrada' }
  | { estado: 'prohibido' }
  | { estado: 'overlap'; error: string }
  | { estado: 'datosInvalidos'; error: string };

/**
 * Mueve una reserva de fecha y hora.
 *
 * ⚠️ Se cancela la vieja y se crea una nueva EN VEZ de un UPDATE, y no es
 * capricho: un UPDATE de `fecha`/`hora` no pasa por el Durable Object, asi que
 * dos reprogramaciones simultaneas al mismo slot entrarian las dos. El indice
 * unico las atajaria solo si coinciden exacto; un solapamiento parcial no.
 *
 * Como efecto, el turno reprogramado tiene id y cancel_token nuevos, y el
 * viejo queda en el historial con estado 'cancelada'.
 */
export async function reprogramarReserva(
  env: Env,
  sesion: { barberoId: string; rol: Rol },
  id: string,
  cambios: { fecha: string; hora: string; servicioId?: string },
  ahora: Date = new Date(),
): Promise<ResultadoEdicion> {
  const reserva = await buscarReserva(env, id);
  if (!reserva) return { estado: 'noEncontrada' };
  if (!puedeTocar(sesion, reserva)) return { estado: 'prohibido' };

  const original = await db(env.DB)
    .select({
      barberoId: reservas.barberoId,
      servicioId: reservas.servicioId,
      nombre: reservas.nombre,
      telefono: reservas.telefono,
      mensaje: reservas.mensaje,
    })
    .from(reservas)
    .where(eq(reservas.id, id))
    .limit(1);

  const vieja = original[0];
  if (!vieja || !vieja.barberoId) return { estado: 'noEncontrada' };

  // Se libera el slot viejo ANTES de pedir el nuevo: si no, mover un turno de
  // las 10:00 a las 10:00 del mismo dia chocaria consigo mismo.
  await db(env.DB)
    .update(reservas)
    .set({ estado: 'cancelada', canceladaAt: ahora.toISOString() })
    .where(eq(reservas.id, id));

  const entrada: EntradaReserva = {
    barberoId: vieja.barberoId,
    servicioId: cambios.servicioId ?? vieja.servicioId ?? '',
    fecha: cambios.fecha,
    hora: cambios.hora,
    clienteNombre: vieja.nombre,
    clienteTelefono: vieja.telefono,
    mensaje: vieja.mensaje ?? '',
  };

  const creada = await crearReserva(env, entrada, { ahora, modo: 'admin' });

  if (creada.estado !== 'exito') {
    // Revertir: la reserva original vuelve a estar activa.
    await db(env.DB)
      .update(reservas)
      .set({ estado: 'activa', canceladaAt: null })
      .where(eq(reservas.id, id));

    return creada.estado === 'overlap'
      ? { estado: 'overlap', error: creada.error }
      : { estado: 'datosInvalidos', error: creada.error };
  }

  return { estado: 'exito' };
}

// ---------------------------------------------------------------- bloqueos

/**
 * Bloqueo administrativo: ocupa un slot sin ser el turno de nadie.
 *
 * 🐛 El sistema viejo lo marcaba con un string magico (`servicio = "Bloqueo
 * Administrativo"`, `nombre = "BLOQUEDAO"` con typo) y cada query de "turnos
 * reales" tenia que acordarse de excluirlo. Acá va la columna `tipo`.
 *
 * Pasa por el Durable Object igual que una reserva: un bloqueo y un turno
 * compiten por el mismo slot.
 */
export async function crearBloqueo(
  env: Env,
  barberoId: string,
  datos: { fecha: string; hora: string; motivo?: string; duracionMin?: number },
): Promise<{ estado: 'exito' } | { estado: 'ocupado' } | { estado: 'error'; detalle: string }> {
  const agenda = env.BARBERO_AGENDA.get(env.BARBERO_AGENDA.idFromName(barberoId));

  const resultado = await agenda.reservar({
    barberoId,
    fecha: datos.fecha,
    hora: datos.hora,
    duracionMin: datos.duracionMin ?? 30,
    nombre: '',
    telefono: '',
    servicio: datos.motivo?.trim() || 'Bloqueo',
    mensaje: datos.motivo?.trim() || null,
    source: 'admin',
    tipo: 'bloqueo',
  });

  if (resultado.estado === 'overlap') return { estado: 'ocupado' };
  if (resultado.estado === 'error') return { estado: 'error', detalle: resultado.detalle };
  return { estado: 'exito' };
}

// ------------------------------------------------------------------ import

export interface ErrorDeImport {
  fila: number;
  motivo: string;
}

export interface ResultadoImport {
  importadas: number;
  salteadas: number;
  errores: ErrorDeImport[];
}

/**
 * Import masivo. Solo `owner`.
 *
 * Cada fila pasa por el Durable Object igual que una reserva normal: las que
 * chocan se REPORTAN, no abortan el lote. Un "importé 340 de 500" sin decir
 * cuáles fallaron es inútil para el operador.
 *
 * No dispara Calendar ni WhatsApp — eso lo garantiza `modo: 'import'`.
 */
export async function importarReservas(
  env: Env,
  filas: unknown[],
  ahora: Date = new Date(),
): Promise<ResultadoImport> {
  const errores: ErrorDeImport[] = [];
  let importadas = 0;

  // Secuencial a proposito: en paralelo, dos filas del mismo lote que compiten
  // por el mismo slot darian un resultado que depende del orden de llegada.
  for (let i = 0; i < filas.length; i++) {
    const fila = filas[i];
    if (!fila || typeof fila !== 'object') {
      errores.push({ fila: i + 1, motivo: 'La fila no es un objeto.' });
      continue;
    }

    const resultado: ResultadoReserva = await crearReserva(env, fila as EntradaReserva, {
      ahora,
      modo: 'import',
    });

    if (resultado.estado === 'exito') {
      importadas += 1;
    } else {
      errores.push({
        fila: i + 1,
        motivo: resultado.estado === 'overlap' ? MENSAJE_OVERLAP : resultado.error,
      });
    }
  }

  return { importadas, salteadas: errores.length, errores };
}

/** Turnos de clientes de un barbero, sin bloqueos. Para los tests y la Fase 3. */
export async function contarTurnosDeClientes(env: Env, barberoId: string): Promise<number> {
  const filas = await db(env.DB)
    .select({ id: reservas.id })
    .from(reservas)
    .where(and(eq(reservas.barberoId, barberoId), eq(reservas.tipo, 'turno')));

  return filas.length;
}
