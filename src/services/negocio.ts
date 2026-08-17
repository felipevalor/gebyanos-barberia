import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { negocio } from '../db/schema';

/**
 * Configuracion del negocio. Fila unica, `id = 1`.
 *
 * Leerla puede cualquier usuario autenticado; escribirla, solo `owner`.
 *
 * ⚠️ `timezone` NO ES PARTE DE ESTA CONFIGURACION, a proposito.
 *
 * La columna existe en la base pero es INFORMATIVA: no se lee acá, no se
 * escribe, y no sale en ninguna respuesta. La zona horaria del sistema esta
 * fija en `domain/dates.ts`.
 *
 * Si se expusiera, alguien la cambiaria, la veria guardada y creeria que hizo
 * algo — y los turnos se seguirian calculando en hora de Argentina. Un campo
 * que se guarda y no hace nada invita a confiar en él.
 *
 * Cablearla de verdad significa sacar el offset fijo `-03:00` de todo el
 * sistema para soportar horario de verano: mucho riesgo en la parte mas
 * sensible del codigo, para un problema que una barberia argentina no tiene.
 */

export const ID_NEGOCIO = 1;

export const ERROR_SIN_CONFIGURACION = 'La configuración del negocio no está inicializada.';
export const ERROR_NOMBRE_REQUERIDO = 'El nombre del negocio es obligatorio.';

/**
 * Rangos de la spec. Los mensajes nombran el parametro y su rango porque el
 * unico que los ve es quien esta depurando el frontend.
 */
export const RANGOS = {
  slotDuracionMin: { min: 5, max: 240 },
  minutosAnticipacionMin: { min: 0, max: 10_080 },
  diasMaxAnticipacion: { min: 1, max: 365 },
} as const;

export const ERROR_SLOT = `slot_duracion_min inválido. Tiene que ser un número entero entre ${RANGOS.slotDuracionMin.min} y ${RANGOS.slotDuracionMin.max}.`;
export const ERROR_ANTICIPACION = `minutos_anticipacion_min inválido. Tiene que ser un número entero entre ${RANGOS.minutosAnticipacionMin.min} y ${RANGOS.minutosAnticipacionMin.max}.`;
export const ERROR_DIAS_MAX = `dias_max_anticipacion inválido. Tiene que ser un número entero entre ${RANGOS.diasMaxAnticipacion.min} y ${RANGOS.diasMaxAnticipacion.max}.`;
/** Se responde esto si alguien la manda igual: mejor un 400 que un silencio. */
export const ERROR_TIMEZONE_NO_CONFIGURABLE =
  'La zona horaria no es configurable: el sistema opera siempre en hora de Argentina.';

/**
 * ⚠️ EL AVISO DE LA GRILLA.
 *
 * Cambiar el paso de la grilla NO mueve los turnos ya agendados: uno de las
 * 10:15 sigue a las 10:15 aunque la grilla pase a ser de 30 minutos. No es un
 * error —el turno vale igual y el solapamiento se sigue respetando— pero deja
 * huecos raros en el panel y conviene que quien lo cambia lo sepa.
 */
export const AVISO_SLOT_CAMBIADO =
  'El nuevo paso de la grilla se aplica a los turnos nuevos. Los ya agendados conservan su horario, aunque no coincida con la grilla nueva.';

export interface ConfiguracionNegocio {
  id: number;
  nombreNegocio: string;
  slotDuracionMin: number;
  minutosAnticipacionMin: number;
  diasMaxAnticipacion: number;
  logoUrl: string | null;
  colorPrimario: string | null;
  colorSecundario: string | null;
}

/**
 * Columnas EXPLICITAS y no `select()`: un `select()` pelado arrastraria
 * `timezone` de vuelta a la respuesta la proxima vez que alguien lea esto.
 */
const columnas = {
  id: negocio.id,
  nombreNegocio: negocio.nombreNegocio,
  slotDuracionMin: negocio.slotDuracionMin,
  minutosAnticipacionMin: negocio.minutosAnticipacionMin,
  diasMaxAnticipacion: negocio.diasMaxAnticipacion,
  logoUrl: negocio.logoUrl,
  colorPrimario: negocio.colorPrimario,
  colorSecundario: negocio.colorSecundario,
};

export async function leerNegocio(env: Env): Promise<ConfiguracionNegocio | null> {
  const filas = await db(env.DB).select(columnas).from(negocio).where(eq(negocio.id, ID_NEGOCIO)).limit(1);
  return filas[0] ?? null;
}

export interface EntradaNegocio {
  nombreNegocio?: unknown;
  /** Solo para RECHAZARLA con un mensaje claro. No se guarda. */
  timezone?: unknown;
  slotDuracionMin?: unknown;
  minutosAnticipacionMin?: unknown;
  diasMaxAnticipacion?: unknown;
  logoUrl?: unknown;
  colorPrimario?: unknown;
  colorSecundario?: unknown;
}

const texto = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() : undefined);

const enteroEnRango = (v: unknown, r: { min: number; max: number }): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= r.min && v <= r.max;

export type ResultadoNegocio =
  | { estado: 'exito'; negocio: ConfiguracionNegocio; slotCambiado: boolean }
  | { estado: 'error'; error: string };

export async function actualizarNegocio(
  env: Env,
  entrada: EntradaNegocio,
): Promise<ResultadoNegocio> {
  const previo = await leerNegocio(env);
  if (!previo) return { estado: 'error', error: ERROR_SIN_CONFIGURACION };

  const cambios: Record<string, unknown> = {};

  if (entrada.nombreNegocio !== undefined) {
    const nombre = texto(entrada.nombreNegocio) ?? '';
    if (!nombre) return { estado: 'error', error: ERROR_NOMBRE_REQUERIDO };
    cambios.nombreNegocio = nombre;
  }
  // No se ignora en silencio: quien la mande se tiene que enterar de que el
  // campo no hace nada, no creer que quedo guardado.
  if (entrada.timezone !== undefined) {
    return { estado: 'error', error: ERROR_TIMEZONE_NO_CONFIGURABLE };
  }
  if (entrada.slotDuracionMin !== undefined) {
    if (!enteroEnRango(entrada.slotDuracionMin, RANGOS.slotDuracionMin)) {
      return { estado: 'error', error: ERROR_SLOT };
    }
    cambios.slotDuracionMin = entrada.slotDuracionMin;
  }
  if (entrada.minutosAnticipacionMin !== undefined) {
    if (!enteroEnRango(entrada.minutosAnticipacionMin, RANGOS.minutosAnticipacionMin)) {
      return { estado: 'error', error: ERROR_ANTICIPACION };
    }
    cambios.minutosAnticipacionMin = entrada.minutosAnticipacionMin;
  }
  if (entrada.diasMaxAnticipacion !== undefined) {
    if (!enteroEnRango(entrada.diasMaxAnticipacion, RANGOS.diasMaxAnticipacion)) {
      return { estado: 'error', error: ERROR_DIAS_MAX };
    }
    cambios.diasMaxAnticipacion = entrada.diasMaxAnticipacion;
  }

  for (const campo of ['logoUrl', 'colorPrimario', 'colorSecundario'] as const) {
    if (entrada[campo] !== undefined) cambios[campo] = texto(entrada[campo]) || null;
  }

  if (Object.keys(cambios).length > 0) {
    await db(env.DB).update(negocio).set(cambios).where(eq(negocio.id, ID_NEGOCIO));
  }

  const actualizado = await leerNegocio(env);
  if (!actualizado) return { estado: 'error', error: ERROR_SIN_CONFIGURACION };

  return {
    estado: 'exito',
    negocio: actualizado,
    slotCambiado: actualizado.slotDuracionMin !== previo.slotDuracionMin,
  };
}
