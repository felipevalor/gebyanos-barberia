import { eq, asc } from 'drizzle-orm';
import { db } from '../db/client';
import { servicios } from '../db/schema';
import { uuidv7 } from '../db/id';
import { esViolacionDeUnicoEn } from '../db/errores';

/**
 * ABM de servicios (lo RESERVABLE). Solo `owner`.
 *
 * No confundir con `catalogo`, que es la vidriera de precios: ahi puede haber
 * cosas que no se reservan online.
 *
 * Igual que el listado de barberos, este NO filtra `activo = 1`: el panel es
 * donde se reactiva un servicio dado de baja. Lo publico sí filtra.
 */

export const ERROR_SERVICIO_NO_ENCONTRADO = 'Servicio no encontrado.';
export const ERROR_SERVICIO_DUPLICADO = 'Ya existe un servicio con ese nombre. Elegí otro.';
export const ERROR_NOMBRE_REQUERIDO = 'El nombre es obligatorio.';
export const ERROR_DURACION =
  'Duración inválida. Tiene que ser un número entero de minutos entre 5 y 480.';
export const ERROR_PRECIO = 'Precio inválido. Tiene que ser un número entero de centavos, sin decimales ni negativos.';

/**
 * ⚠️ EL AVISO QUE HAY QUE MOSTRAR SI O SI.
 *
 * `reservas.duracion_min` es un SNAPSHOT tomado al crear el turno, asi que
 * cambiar la duracion del servicio no mueve ni un turno ya agendado. Es lo
 * correcto —nadie quiere que le corran los turnos de la semana por editar un
 * precio— pero NO es obvio: quien alarga el corte de 30 a 45 minutos espera
 * que la agenda de mañana se reacomode sola, y no pasa.
 *
 * Viaja en el campo `warning` del sobre, que existe justamente para esto.
 */
export const AVISO_DURACION_CAMBIADA =
  'La nueva duración se aplica solo a los turnos que se creen de ahora en adelante. Los turnos ya agendados conservan la duración con la que se reservaron.';

/** Rango sano: menos de 5 min no es un servicio, mas de 8 h no entra en un dia. */
const DURACION_MIN = 5;
const DURACION_MAX = 480;

export interface ServicioDelPanel {
  id: string;
  nombre: string;
  duracionMin: number;
  precioCentavos: number | null;
  incluye: string | null;
  activo: number;
  orden: number;
}

const columnas = {
  id: servicios.id,
  nombre: servicios.nombre,
  duracionMin: servicios.duracionMin,
  precioCentavos: servicios.precioCentavos,
  incluye: servicios.incluye,
  activo: servicios.activo,
  orden: servicios.orden,
};

export async function listarServicios(env: Env): Promise<ServicioDelPanel[]> {
  return db(env.DB)
    .select(columnas)
    .from(servicios)
    .orderBy(asc(servicios.orden), asc(servicios.nombre));
}

export async function buscarServicio(env: Env, id: string): Promise<ServicioDelPanel | null> {
  const filas = await db(env.DB).select(columnas).from(servicios).where(eq(servicios.id, id)).limit(1);
  return filas[0] ?? null;
}

export interface EntradaServicio {
  nombre?: unknown;
  duracionMin?: unknown;
  precioCentavos?: unknown;
  incluye?: unknown;
  activo?: unknown;
  orden?: unknown;
}

const texto = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() : undefined);

const duracionValida = (v: unknown): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= DURACION_MIN && v <= DURACION_MAX;

/** Centavos: entero y no negativo. Un precio con decimales es un bug del frontend. */
const precioValido = (v: unknown): boolean =>
  v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 0);

export type ResultadoServicio =
  | { estado: 'exito'; servicio: ServicioDelPanel; duracionCambiada: boolean }
  | { estado: 'error'; error: string }
  | { estado: 'duplicado' };

export async function crearServicio(
  env: Env,
  entrada: EntradaServicio,
): Promise<ResultadoServicio> {
  const nombre = texto(entrada.nombre) ?? '';
  if (!nombre) return { estado: 'error', error: ERROR_NOMBRE_REQUERIDO };

  const duracionMin = entrada.duracionMin === undefined ? 30 : entrada.duracionMin;
  if (!duracionValida(duracionMin)) return { estado: 'error', error: ERROR_DURACION };

  const precio = entrada.precioCentavos === undefined ? null : entrada.precioCentavos;
  if (!precioValido(precio)) return { estado: 'error', error: ERROR_PRECIO };

  const id = uuidv7();
  try {
    await db(env.DB).insert(servicios).values({
      id,
      nombre,
      duracionMin: duracionMin as number,
      precioCentavos: precio as number | null,
      incluye: texto(entrada.incluye) ?? null,
      activo: entrada.activo === false ? 0 : 1,
      orden: typeof entrada.orden === 'number' ? entrada.orden : 0,
    });
  } catch (e) {
    if (esViolacionDeUnicoEn(e, 'servicios')) return { estado: 'duplicado' };
    throw e;
  }

  const creado = await buscarServicio(env, id);
  return creado
    ? { estado: 'exito', servicio: creado, duracionCambiada: false }
    : { estado: 'error', error: ERROR_SERVICIO_NO_ENCONTRADO };
}

export async function actualizarServicio(
  env: Env,
  id: string,
  entrada: EntradaServicio,
): Promise<ResultadoServicio> {
  const previo = await buscarServicio(env, id);
  if (!previo) return { estado: 'error', error: ERROR_SERVICIO_NO_ENCONTRADO };

  const cambios: Record<string, unknown> = {};

  if (entrada.nombre !== undefined) {
    const nombre = texto(entrada.nombre) ?? '';
    if (!nombre) return { estado: 'error', error: ERROR_NOMBRE_REQUERIDO };
    cambios.nombre = nombre;
  }
  if (entrada.duracionMin !== undefined) {
    if (!duracionValida(entrada.duracionMin)) return { estado: 'error', error: ERROR_DURACION };
    cambios.duracionMin = entrada.duracionMin;
  }
  if (entrada.precioCentavos !== undefined) {
    if (!precioValido(entrada.precioCentavos)) return { estado: 'error', error: ERROR_PRECIO };
    cambios.precioCentavos = entrada.precioCentavos;
  }
  if (entrada.incluye !== undefined) cambios.incluye = texto(entrada.incluye) || null;
  if (typeof entrada.activo === 'boolean') cambios.activo = entrada.activo ? 1 : 0;
  if (typeof entrada.orden === 'number') cambios.orden = entrada.orden;

  if (Object.keys(cambios).length > 0) {
    try {
      await db(env.DB).update(servicios).set(cambios).where(eq(servicios.id, id));
    } catch (e) {
      if (esViolacionDeUnicoEn(e, 'servicios')) return { estado: 'duplicado' };
      throw e;
    }
  }

  const actualizado = await buscarServicio(env, id);
  if (!actualizado) return { estado: 'error', error: ERROR_SERVICIO_NO_ENCONTRADO };

  return {
    estado: 'exito',
    servicio: actualizado,
    // Solo si REALMENTE cambio: reenviar la misma duracion no amerita el aviso.
    duracionCambiada: actualizado.duracionMin !== previo.duracionMin,
  };
}

/**
 * Borrado fisico. `reservas.servicio_id` es SET NULL y el nombre del servicio
 * quedo copiado en `reservas.servicio`, asi que el historial se lee igual.
 */
export async function borrarServicio(env: Env, id: string): Promise<void> {
  await db(env.DB).delete(servicios).where(eq(servicios.id, id));
}
