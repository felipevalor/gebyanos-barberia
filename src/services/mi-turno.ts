import { and, eq, gte, asc } from 'drizzle-orm';
import { db } from '../db/client';
import { reservas } from '../db/schema';
import { normalizeTel } from '../domain/phone';
import { todayArgentina } from '../domain/dates';

/**
 * Autogestion del cliente. La logica; los tokens viven en `magic-link.ts`.
 */

export const ERROR_TELEFONO_REQUERIDO = 'El teléfono es obligatorio.';
export const ERROR_NO_AUTORIZADO = 'No autorizado.';
export const ERROR_TURNO_NO_ENCONTRADO = 'Turno no encontrado.';
export const ERROR_CANCELAR_PASADO = 'No se puede cancelar un turno pasado.';
export const ERROR_EDITAR_PASADO = 'No se puede editar un turno pasado.';
export const ERROR_FECHA_PASADA = 'No se puede agendar un turno en el pasado.';
export const ERROR_SLOT_OCUPADO = 'Ese horario ya está ocupado. Elegí otro.';

/**
 * Lo que el cliente ve de su propio turno.
 *
 * ⚠️ SIN `cancel_token`, Y ES EL PUNTO DE TODO ESTO.
 *
 * El sistema viejo lo devuelve en la busqueda por telefono, y eso convierte a
 * la busqueda en una puerta trasera: con un telefono y un nombre alcanzaria
 * para cancelar el turno de cualquiera, sin pasar nunca por el magic link.
 * Toda la ceremonia de firmar, revocar y consumir tokens no valdria nada.
 */
export interface TurnoDelCliente {
  id: string;
  fecha: string;
  hora: string;
  servicio: string;
  duracionMin: number;
  nombre: string;
  barberoId: string | null;
  estado: string;
}

const columnas = {
  id: reservas.id,
  fecha: reservas.fecha,
  hora: reservas.hora,
  servicio: reservas.servicio,
  duracionMin: reservas.duracionMin,
  nombre: reservas.nombre,
  barberoId: reservas.barberoId,
  estado: reservas.estado,
};

/**
 * Turnos activos y futuros de un telefono.
 *
 * El telefono se NORMALIZA antes de comparar: el cliente escribe
 * "0341 15 651-3207" y en la base esta la forma canonica.
 */
export async function buscarPorTelefono(
  env: Env,
  telefonoCrudo: string,
  ahora: Date = new Date(),
): Promise<TurnoDelCliente[]> {
  const telefono = normalizeTel(telefonoCrudo);
  if (!telefono) return [];

  return db(env.DB)
    .select(columnas)
    .from(reservas)
    .where(
      and(
        eq(reservas.telefono, telefono),
        gte(reservas.fecha, todayArgentina(ahora)),
        eq(reservas.estado, 'activa'),
        eq(reservas.tipo, 'turno'),
      ),
    )
    .orderBy(asc(reservas.fecha), asc(reservas.hora));
}

export async function buscarTurno(env: Env, id: string): Promise<TurnoDelCliente | null> {
  const filas = await db(env.DB).select(columnas).from(reservas).where(eq(reservas.id, id)).limit(1);
  return filas[0] ?? null;
}

/**
 * ⚠️ EL UNICO CONTROL DE ACCESO DE ESTE FLUJO.
 *
 * Se compara el telefono normalizado contra el de la reserva. No hay password
 * ni segundo factor: de ahi que el rate limit de `access-link` no sea un extra
 * sino la defensa contra probar telefonos a escala.
 */
export async function esDuenioDelTurno(
  env: Env,
  reservaId: string,
  telefonoCrudo: string,
): Promise<boolean> {
  const telefono = normalizeTel(telefonoCrudo);
  if (!telefono) return false;

  const filas = await db(env.DB)
    .select({ telefono: reservas.telefono })
    .from(reservas)
    .where(eq(reservas.id, reservaId))
    .limit(1);

  return filas[0]?.telefono === telefono;
}
