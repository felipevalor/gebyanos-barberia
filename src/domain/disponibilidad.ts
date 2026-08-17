import { generateSlotsFromBlocks, checkOverlap, type Bloque, type TurnoExistente } from './slots';
import { evaluarSlot, cumpleAnticipacion } from './schedule';
import { slotAMs } from './dates';

/**
 * Calculo de slots libres. CERO I/O.
 *
 * El endpoint de dia y el de mes usan ESTA funcion, no dos copias: si la
 * logica viviera duplicada, el calendario del mes y la grilla del dia se
 * desincronizan y el cliente ve un dia pintado como disponible que despues no
 * le ofrece ningun horario.
 */

export interface EntradaDisponibilidad {
  /** Fecha a evaluar, "YYYY-MM-DD". */
  fecha: string;
  /** Hoy en Argentina, "YYYY-MM-DD". */
  hoy: string;
  /** Instante actual en epoch ms. */
  ahoraMs: number;

  /** Bloques del `dow` de esa fecha, ya filtrados por `activo = 1`. */
  bloques: Bloque[];
  /** Resultado de `combinarOverrides` para esa fecha, o null si no hay. */
  overrideTrabaja: boolean | null;
  /** Turnos y bloqueos activos de ese barbero y fecha. */
  reservas: TurnoExistente[];

  /**
   * 🐛 Paso de la grilla. Es `negocio.slot_duracion_min`, NO 30 fijo: el
   * original hardcodea 30 acá mientras usa el valor configurado para el
   * solapamiento, y con otra configuracion las dos mitades no coinciden.
   */
  slotDuracionMin: number;

  /**
   * 🐛 Duracion del SERVICIO elegido, con el override de `servicios_barbero`
   * si existe. NO la global: el original valida el solapamiento con la global
   * y con un servicio de 60 min ofrece slots que pisan el siguiente turno o
   * se pasan del cierre.
   */
  duracionServicioMin: number;

  minutosAnticipacion: number;
}

/**
 * Horarios de inicio libres para esa fecha, en orden ascendente.
 *
 * Devuelve [] cuando la fecha es pasada, el dia no tiene horario configurado,
 * hay un feriado, o ningun slot sobrevive los filtros.
 */
export function slotsDisponibles(e: EntradaDisponibilidad): string[] {
  // 1. Fecha pasada: no se ofrece nada.
  if (e.fecha < e.hoy) return [];

  // 2 y 3. Sin bloques activos ese dia de la semana, no hay grilla que generar.
  if (e.bloques.length === 0) return [];

  // 4. El override negativo cierra el dia aunque haya horario configurado.
  if (e.overrideTrabaja === false) return [];

  // 6. Grilla con el paso CONFIGURADO.
  const candidatos = generateSlotsFromBlocks(e.bloques, e.slotDuracionMin);

  return candidatos.filter((hora) => {
    // El turno COMPLETO tiene que entrar en algun bloque. Con la duracion del
    // servicio: un servicio de 60 min no entra donde uno de 30 sí.
    if (evaluarSlot(e.bloques, e.overrideTrabaja, hora, e.duracionServicioMin) !== 'abierto') {
      return false;
    }

    // 8a. La anticipacion solo aplica si la fecha es hoy. Un slot de las 09:00
    // de la semana que viene no tiene que cumplir "30 minutos desde ahora".
    if (e.fecha === e.hoy) {
      if (!cumpleAnticipacion(slotAMs(e.fecha, hora), e.ahoraMs, e.minutosAnticipacion)) {
        return false;
      }
    }

    // 8b. Sin pisar turnos ni bloqueos existentes.
    return !checkOverlap(hora, e.duracionServicioMin, e.reservas).overlap;
  });
}

/** True si la fecha tiene al menos un slot libre. Para pintar el calendario. */
export function tieneDisponibilidad(e: EntradaDisponibilidad): boolean {
  return slotsDisponibles(e).length > 0;
}
