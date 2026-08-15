/**
 * Fechas en hora de Argentina. CERO I/O.
 *
 * Un solo formato en todo el sistema: "YYYY-MM-DD". El sistema viejo arrastra
 * un formato legacy "d/M/yyyy" en paralelo y un parser de tres formatos; no se
 * replica.
 *
 * REGLA: "hoy" y "ahora" nunca se leen del reloj UTC directo. Un turno a las
 * 21:00 hora Argentina es "maniana" en UTC.
 */

export const TZ = 'America/Argentina/Buenos_Aires';

/** Argentina no usa horario de verano desde 2009: el offset es fijo. */
export const OFFSET_ARGENTINA = '-03:00';

const MS_POR_DIA = 86_400_000;

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "YYYY-MM-DD" de hoy en Argentina. */
export function todayArgentina(now: Date = new Date()): string {
  // en-CA formatea directamente como YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** "HH:mm" de ahora en Argentina. */
export function timeNowArgentina(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
}

/** Suma `n` dias a una fecha "YYYY-MM-DD". Acepta `n` negativo. */
export function addDays(fecha: string, n: number): string {
  const [y, m, d] = fecha.split('-').map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, d) + n * MS_POR_DIA;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Dias enteros de `desde` a `hasta`. Negativo si `hasta` es anterior. */
export function diffDias(desde: string, hasta: string): number {
  const aMs = (f: string) => {
    const [y, m, d] = f.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((aMs(hasta) - aMs(desde)) / MS_POR_DIA);
}

/**
 * Instante en epoch ms de un slot expresado en hora de Argentina.
 *
 * Es lo que se le pasa a `cumpleAnticipacion`. Se construye con el offset fijo
 * -03:00 en vez de dejar que el runtime interprete la fecha en su zona local.
 */
export function slotAMs(fecha: string, hora: string): number {
  return Date.parse(`${fecha}T${hora}:00${OFFSET_ARGENTINA}`);
}

/** Dia de la semana de una fecha "YYYY-MM-DD". 0 = domingo ... 6 = sabado. */
export function diaDeLaSemana(fecha: string): number {
  const [y, m, d] = fecha.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Valida el formato Y que la fecha exista de verdad.
 *
 * "2026-02-30" tiene formato correcto pero no es una fecha: el round-trip la
 * descarta.
 */
export function esFechaValida(fecha: string): boolean {
  if (!RE_FECHA.test(fecha)) return false;
  return addDays(fecha, 0) === fecha;
}

/** Valida el formato "HH:mm" con padding y rango horario real. */
export function esHoraValida(hora: string): boolean {
  return RE_HORA.test(hora);
}

/**
 * Compara dos fechas "YYYY-MM-DD". Negativo si a < b, 0 si iguales, positivo
 * si a > b.
 *
 * El formato ISO ordena lexicograficamente, asi que alcanza con comparar los
 * strings. La funcion existe para que la intencion quede explicita en el
 * llamador.
 */
export function compararFechas(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
