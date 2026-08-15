import { addDays } from './dates';

/**
 * Logica pura de slots. CERO I/O.
 *
 * Los algoritmos salieron del sistema en produccion y sus tests. Varios
 * detalles son contraintuitivos y son a proposito: estan comentados donde
 * aparecen.
 */

/** Bloque de atencion. `inicio` y `fin` son horas enteras (9, 20). */
export interface Bloque {
  inicio: number;
  fin: number;
}

/** Un turno ya tomado, para el chequeo de solapamiento. */
export interface TurnoExistente {
  hora: string;
  duracionMin: number;
}

export interface ResultadoOverlap {
  overlap: boolean;
  conflicto: string | null;
}

export interface EventTimes {
  startIso: string;
  endIso: string;
}

/** Argentina no usa horario de verano desde 2009: el offset es fijo. */
const OFFSET_ARGENTINA = '-03:00';
const MINUTOS_POR_DIA = 1440;

const pad = (n: number): string => String(n).padStart(2, '0');

/** "HH:mm" a minutos desde medianoche. */
export function horaAMinutos(hora: string): number {
  const [hh, mm] = hora.split(':').map(Number) as [number, number];
  return hh * 60 + mm;
}

/** Minutos desde medianoche a "HH:mm". No hace roll-over de dia. */
export function minutosAHora(minutos: number): string {
  return `${pad(Math.floor(minutos / 60))}:${pad(minutos % 60)}`;
}

/**
 * Horas de inicio candidatas dentro de un bloque.
 *
 * Tres detalles que no hay que "arreglar":
 *
 *  - `horaFin` es EXCLUSIVO a nivel de hora: generateSlots(10, 12) da
 *    ["10:00","10:30","11:00","11:30"], sin "12:00".
 *  - El minuto se REINICIA a 0 en cada hora. Si `slotDuracionMin` no divide 60
 *    (ej. 40), no hay acarreo entre horas. Es intencional.
 *  - Si `horaFin <= horaInicio`, devuelve [].
 */
export function generateSlots(
  horaInicio: number,
  horaFin: number,
  slotDuracionMin = 30,
): string[] {
  const slots: string[] = [];
  for (let h = horaInicio; h < horaFin; h++) {
    for (let m = 0; m < 60; m += slotDuracionMin) {
      slots.push(`${pad(h)}:${pad(m)}`);
    }
  }
  return slots;
}

/**
 * Slots de varios bloques (ej. manana y tarde), ordenados y sin duplicados.
 *
 * 🐛 El original NO deduplica: con [(9,13),(12,15)] emite "12:00" dos veces.
 * Acá se deduplica. Como los bloques se ordenan por `inicio` antes de
 * concatenar, quedarse con la primera aparicion preserva el orden ascendente.
 */
export function generateSlotsFromBlocks(bloques: Bloque[], slotDuracionMin = 30): string[] {
  const ordenados = [...bloques].sort((a, b) => a.inicio - b.inicio);

  const vistos = new Set<string>();
  for (const { inicio, fin } of ordenados) {
    for (const slot of generateSlots(inicio, fin, slotDuracionMin)) {
      vistos.add(slot);
    }
  }
  return [...vistos];
}

/**
 * Interseccion de intervalos semiabiertos [start, end).
 *
 * Los comparadores ESTRICTOS son deliberados: turnos contiguos NO solapan. Un
 * turno que termina 10:30 y otro que empieza 10:30 conviven. Con <= / >= se
 * rompe la agenda entera.
 *
 * Devuelve el PRIMER conflicto en orden de iteracion, sin ordenar antes.
 */
export function checkOverlap(
  hora: string,
  durMin: number,
  existentes: TurnoExistente[],
): ResultadoOverlap {
  const newStart = horaAMinutos(hora);
  const newEnd = newStart + durMin;

  for (const r of existentes) {
    const rStart = horaAMinutos(r.hora);
    const rEnd = rStart + r.duracionMin;

    if (newStart < rEnd && newEnd > rStart) {
      return { overlap: true, conflicto: r.hora };
    }
  }
  return { overlap: false, conflicto: null };
}

/**
 * Inicio y fin del turno en ISO-8601 con offset de Argentina, para Google
 * Calendar.
 *
 * 🐛 El original genera horas invalidas tipo "25:30" si el turno cruza
 * medianoche, sin incrementar la fecha. Acá el excedente se pasa al dia
 * siguiente. Con turnos de 30-60 min y cierre a las 20:00 no se dispara, pero
 * el dato queda bien formado igual.
 */
export function buildEventTimes(fecha: string, hora: string, duracionMin: number): EventTimes {
  const inicio = horaAMinutos(hora);
  const fin = inicio + duracionMin;

  const diasExtra = Math.floor(fin / MINUTOS_POR_DIA);
  const fechaFin = diasExtra > 0 ? addDays(fecha, diasExtra) : fecha;
  const finEnDia = fin % MINUTOS_POR_DIA;

  return {
    startIso: `${fecha}T${minutosAHora(inicio)}:00${OFFSET_ARGENTINA}`,
    endIso: `${fechaFin}T${minutosAHora(finEnDia)}:00${OFFSET_ARGENTINA}`,
  };
}
