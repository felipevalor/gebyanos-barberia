import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { negocio } from '../db/schema';

/**
 * Configuracion del negocio. Fila unica, `id = 1`.
 *
 * Leerla puede cualquier usuario autenticado; escribirla, solo `owner`.
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
export const ERROR_TIMEZONE =
  'Zona horaria inválida. Usá un identificador IANA, por ejemplo America/Argentina/Buenos_Aires.';

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
  timezone: string;
  slotDuracionMin: number;
  minutosAnticipacionMin: number;
  diasMaxAnticipacion: number;
  logoUrl: string | null;
  colorPrimario: string | null;
  colorSecundario: string | null;
}

export async function leerNegocio(env: Env): Promise<ConfiguracionNegocio | null> {
  const filas = await db(env.DB).select().from(negocio).where(eq(negocio.id, ID_NEGOCIO)).limit(1);
  return filas[0] ?? null;
}

/**
 * ⚠️ HOY `timezone` NO CAMBIA EL COMPORTAMIENTO DEL SISTEMA.
 *
 * `domain/dates.ts` tiene la zona HARDCODEADA (`TZ` y un offset fijo `-03:00`),
 * asi que guardar "Europe/Madrid" acá valida, se persiste, se muestra en el
 * panel y en `/api/negocio`... y los turnos se siguen calculando en hora de
 * Argentina. El campo es informativo, no operativo.
 *
 * Se valida igual —guardar basura no ayuda a nadie— pero el panel NO deberia
 * ofrecerlo como si fuera una perilla que hace algo. Anotado en
 * docs/pendientes.md: o se conecta a `dates.ts`, o se saca de la interfaz.
 */

/**
 * Valida un identificador IANA.
 *
 * Se prueba CONSTRUYENDO un formateador, no comparando contra una lista:
 * `Intl.supportedValuesOf` no esta garantizado en todos los runtimes y, donde
 * existe, su lista puede quedar corta respecto de lo que el propio motor
 * acepta. Un `RangeError` del motor es la respuesta autoritativa.
 *
 * El caso que importa: el sistema viejo guarda el nombre de Windows
 * ("Argentina Standard Time"), que no es IANA y tiene que rebotar.
 */
export function esTimezoneValida(tz: unknown): boolean {
  if (typeof tz !== 'string' || tz.trim() === '') return false;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface EntradaNegocio {
  nombreNegocio?: unknown;
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
  if (entrada.timezone !== undefined) {
    const tz = texto(entrada.timezone);
    if (!esTimezoneValida(tz)) return { estado: 'error', error: ERROR_TIMEZONE };
    cambios.timezone = tz;
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
