import type { Bloque } from './slots';

/**
 * Logica pura de horarios y disponibilidad. CERO I/O.
 */

export type Disponibilidad = 'abierto' | 'diaCerrado' | 'feriado' | 'fueraDeHorario';

/**
 * Decide si un slot esta disponible.
 *
 * EL ORDEN DE EVALUACION ES LA REGLA DE NEGOCIO. No reordenar.
 *
 * @param bloquesActivos bloques del dia de la semana que corresponda, ya filtrados por `activo`
 * @param overrideTrabaja override de `feriados_override` para esa fecha, o null si no hay
 * @param hora            "HH:mm" de inicio del turno
 * @param durMin          duracion del SERVICIO elegido, no la global
 */
export function evaluarSlot(
  bloquesActivos: Bloque[],
  overrideTrabaja: boolean | null,
  hora: string,
  durMin: number,
): Disponibilidad {
  // 1. El override negativo gana sobre TODO. Ni se miran los bloques.
  if (overrideTrabaja === false) return 'feriado';

  // 2. Sin bloques activos ese dia de la semana, cerrado.
  //
  //    Ojo: un override POSITIVO no llega hasta acá a "abrir" nada. El override
  //    es un booleano, no trae horas: solo evita que un false cierre el dia.
  //    Un domingo sin horario configurado sigue dando diaCerrado aunque tenga
  //    trabaja = true. Es contraintuitivo y es a proposito.
  if (bloquesActivos.length === 0) return 'diaCerrado';

  // 3. El turno COMPLETO tiene que caber dentro de algun bloque.
  //    Ambos limites inclusivos: un turno puede terminar exactamente a la hora
  //    de cierre.
  const [hh, mm] = hora.split(':').map(Number) as [number, number];
  const start = hh * 60 + mm;
  const end = start + durMin;

  for (const { inicio, fin } of bloquesActivos) {
    if (start >= inicio * 60 && end <= fin * 60) return 'abierto';
  }

  // Un hueco entre bloques cae acá, no en diaCerrado.
  return 'fueraDeHorario';
}

/**
 * Anticipacion minima para reservar.
 *
 * Comparacion INCLUSIVA: un slot exactamente en el limite cumple.
 */
export const cumpleAnticipacion = (slotMs: number, ahoraMs: number, minutos: number): boolean =>
  slotMs >= ahoraMs + minutos * 60_000;

/**
 * Mensaje para el cliente.
 *
 * TRANSCRIPCION TEXTUAL del sistema en produccion. Son contrato de UX: el
 * frontend y los tests dependen de estos strings. No reescribir.
 */
export function mensajeCliente(estado: Disponibilidad): string {
  switch (estado) {
    case 'diaCerrado':
      return 'La barbería no atiende ese día.';
    case 'feriado':
      return 'La barbería no atiende esa fecha (feriado o cierre).';
    case 'fueraDeHorario':
      return 'El horario elegido está fuera del horario de atención.';
    default:
      return 'Turno no disponible.';
  }
}

/**
 * Combina overrides duplicados para una misma fecha: "cerrado gana".
 *
 * AND logico arrancando en null. Con el UNIQUE (barbero_id, fecha) no deberia
 * haber duplicados, pero la defensa es barata.
 */
export function combinarOverrides(overrides: { trabaja: boolean }[]): boolean | null {
  let r: boolean | null = null;
  for (const o of overrides) r = (r ?? true) && o.trabaja;
  return r;
}
