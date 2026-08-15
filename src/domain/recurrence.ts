import { addDays, diffDias } from './dates';
import type { Disponibilidad } from './schedule';

/**
 * Calculo de la proxima fecha de un turno recurrente. CERO I/O.
 *
 * La disponibilidad se recibe como funcion por parametro (`evaluarFecha`), no
 * se consulta a la DB: asi la funcion se mantiene pura y testeable con un mock.
 */

/** Ciclos que se prueban antes de darse por vencido. No configurable. */
export const CICLOS_MAX = 5;

export interface RecurrenteConfig {
  /** Fija la cadencia. Sin esto no se puede calcular nada. */
  fechaAncla: string | null;
  ultimoTurnoFecha: string | null;
  frecuenciaDias: number;
  horaPreferida: string;
}

export type ResultadoProximaFecha = { fecha: string } | { error: string };

export const ERROR_SIN_ANCLA =
  'No se pudo calcular la fecha. Configurá la fecha ancla en el cliente.';

export const ERROR_FRECUENCIA_INVALIDA =
  'No se pudo calcular la fecha. La frecuencia tiene que ser un número entero de días mayor a 0.';

/** Etiqueta corta de cada motivo, para la lista de fechas intentadas del error. */
export function motivoCorto(disponibilidad: Disponibilidad): string {
  switch (disponibilidad) {
    case 'abierto':
      return 'abierto';
    case 'diaCerrado':
      return 'cerrado';
    case 'feriado':
      return 'feriado';
    case 'fueraDeHorario':
      return 'fuera de horario';
  }
}

/**
 * Proxima fecha del recurrente, o el motivo por el que no se pudo calcular.
 *
 * @param rc            configuracion del cliente recurrente
 * @param hoy           "YYYY-MM-DD" de hoy en Argentina
 * @param evaluarFecha  consulta de disponibilidad, inyectada. El llamador le
 *                      captura la duracion del SERVICIO en la closure: la
 *                      evaluacion depende del servicio, no del slot global.
 */
export function calcularProximaFecha(
  rc: RecurrenteConfig,
  hoy: string,
  evaluarFecha: (fecha: string) => Disponibilidad,
): ResultadoProximaFecha {
  if (!rc.fechaAncla) {
    return { error: ERROR_SIN_ANCLA };
  }

  // ⚠️ La spec original avanza el cursor con
  //      while (cursor <= base) cursor = addDays(cursor, rc.frecuenciaDias);
  //    que con frecuenciaDias <= 0 no termina NUNCA. En Workers eso agota los
  //    10 ms de CPU y mata el request; en el cron se lleva puesta la
  //    generacion de todos los recurrentes.
  //
  //    Se valida la entrada Y se reemplaza el bucle por aritmetica O(1), asi
  //    el bucle no existe y no hay nada que pueda colgarse.
  if (!Number.isInteger(rc.frecuenciaDias) || rc.frecuenciaDias <= 0) {
    return { error: ERROR_FRECUENCIA_INVALIDA };
  }

  // La base es hoy, salvo que el ultimo turno generado sea todavia futuro.
  // Evita generar dos turnos para el mismo ciclo.
  let base = hoy;
  if (rc.ultimoTurnoFecha && rc.ultimoTurnoFecha > hoy) base = rc.ultimoTurnoFecha;

  // El cursor arranca en la FECHA ANCLA, no en el ultimo turno: asi se
  // preserva la cadencia. Si el ancla es un martes y la frecuencia 14, siempre
  // cae martes.
  //
  // Cuantos ciclos hay que saltar para pasar la base. El +1 hace que el
  // resultado quede ESTRICTAMENTE despues de la base, igual que el `<=` del
  // bucle original. Si el ancla ya es futura, no se salta nada.
  const dias = diffDias(rc.fechaAncla, base);
  const ciclos = dias < 0 ? 0 : Math.floor(dias / rc.frecuenciaDias) + 1;

  let cursor = addDays(rc.fechaAncla, ciclos * rc.frecuenciaDias);

  const intentadas: string[] = [];
  for (let i = 0; i < CICLOS_MAX; i++) {
    const disp = evaluarFecha(cursor);
    intentadas.push(`${cursor}(${motivoCorto(disp)})`);

    if (disp === 'abierto') return { fecha: cursor };

    cursor = addDays(cursor, rc.frecuenciaDias);
  }

  // El error lista cada fecha intentada con su motivo: es lo que le permite al
  // operador entender por que fallo.
  return {
    error: `No se pudo calcular la fecha. ${CICLOS_MAX} ciclos cerrados — hora ${rc.horaPreferida}: ${intentadas.join(', ')}`,
  };
}
