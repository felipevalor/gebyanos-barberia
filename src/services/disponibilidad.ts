import { and, eq, gte, lte } from 'drizzle-orm';
import { db } from '../db/client';
import {
  barberoHorarios,
  barberos,
  feriadosOverride,
  negocio,
  reservas,
  servicios,
  serviciosBarbero,
} from '../db/schema';
import { combinarOverrides } from '../domain/schedule';
import { slotsDisponibles, tieneDisponibilidad } from '../domain/disponibilidad';
import type { Bloque, TurnoExistente } from '../domain/slots';
import { todayArgentina, diaDeLaSemana, diasDelMes, addDays } from '../domain/dates';

/**
 * Disponibilidad de turnos. Lee D1 y delega el calculo a domain/disponibilidad.
 *
 * NO pasa por el Durable Object: es solo lectura. El DO serializa escrituras.
 *
 * La respuesta NO se cachea. Un slot se ocupa en cualquier momento.
 */

/** Defaults si la fila de `negocio` no esta cargada. */
const SLOT_DURACION_DEFAULT = 30;
const ANTICIPACION_DEFAULT = 30;
const DIAS_MAX_DEFAULT = 14;

interface ConfigNegocio {
  slotDuracionMin: number;
  minutosAnticipacion: number;
  diasMaxAnticipacion: number;
}

async function leerConfig(d1: D1Database): Promise<ConfigNegocio> {
  const filas = await db(d1)
    .select({
      slotDuracionMin: negocio.slotDuracionMin,
      minutosAnticipacion: negocio.minutosAnticipacionMin,
      diasMaxAnticipacion: negocio.diasMaxAnticipacion,
    })
    .from(negocio)
    .where(eq(negocio.id, 1))
    .limit(1);

  const fila = filas[0];
  return {
    slotDuracionMin: fila?.slotDuracionMin ?? SLOT_DURACION_DEFAULT,
    minutosAnticipacion: fila?.minutosAnticipacion ?? ANTICIPACION_DEFAULT,
    diasMaxAnticipacion: fila?.diasMaxAnticipacion ?? DIAS_MAX_DEFAULT,
  };
}

/**
 * Duracion del servicio para ESE barbero.
 *
 * El override de `servicios_barbero` gana sobre la duracion del catalogo: un
 * barbero puede tardar 45 min en lo que otro hace en 30.
 *
 * Sin `servicioId` cae al paso de grilla, que es el comportamiento de "mostrame
 * los horarios" sin haber elegido servicio.
 */
export async function duracionDelServicio(
  d1: D1Database,
  barberoId: string,
  servicioId: string | undefined,
  fallbackMin: number,
): Promise<number> {
  if (!servicioId) return fallbackMin;

  const filas = await db(d1)
    .select({
      duracion: servicios.duracionMin,
      override: serviciosBarbero.duracionMinOverride,
    })
    .from(servicios)
    .leftJoin(
      serviciosBarbero,
      and(
        eq(serviciosBarbero.servicioId, servicios.id),
        eq(serviciosBarbero.barberoId, barberoId),
      ),
    )
    .where(eq(servicios.id, servicioId))
    .limit(1);

  const fila = filas[0];
  // Servicio inexistente: no rechaza, usa el default. Un servicio borrado no
  // deberia impedir ver horarios.
  if (!fila) return fallbackMin;

  return fila.override ?? fila.duracion ?? fallbackMin;
}

// ------------------------------------------------------------------- dia

export interface DisponibilidadDia {
  fecha: string;
  slots: string[];
  duracionMin: number;
}

export async function disponibilidadDelDia(
  d1: D1Database,
  params: { barberoId: string; fecha: string; servicioId?: string | undefined },
  ahora: Date = new Date(),
): Promise<DisponibilidadDia> {
  const hoy = todayArgentina(ahora);
  const config = await leerConfig(d1);
  const duracionServicioMin = await duracionDelServicio(
    d1,
    params.barberoId,
    params.servicioId,
    config.slotDuracionMin,
  );

  const vacio = { fecha: params.fecha, slots: [], duracionMin: duracionServicioMin };

  // Corte temprano: fuera de la ventana de reserva no hace falta consultar nada.
  if (params.fecha < hoy) return vacio;
  if (params.fecha > addDays(hoy, config.diasMaxAnticipacion)) return vacio;

  const dow = diaDeLaSemana(params.fecha);
  const cliente = db(d1);

  const [bloques, overrides, ocupados] = await Promise.all([
    // El innerJoin con `barberos` es el filtro de barbero desactivado. Sin
    // el, un barbero dado de baja sigue ofreciendo horarios y la reserva de
    // la 2.4 despues rebota con "Barbero inválido.": el sistema se
    // contradice a si mismo. No cuesta una query extra.
    cliente
      .select({ inicio: barberoHorarios.horaInicio, fin: barberoHorarios.horaFin })
      .from(barberoHorarios)
      .innerJoin(barberos, eq(barberos.id, barberoHorarios.barberoId))
      .where(
        and(
          eq(barberoHorarios.barberoId, params.barberoId),
          eq(barberoHorarios.dow, dow),
          eq(barberoHorarios.activo, 1),
          eq(barberos.activo, 1),
        ),
      ),
    cliente
      .select({ trabaja: feriadosOverride.trabaja })
      .from(feriadosOverride)
      .where(
        and(
          eq(feriadosOverride.barberoId, params.barberoId),
          eq(feriadosOverride.fecha, params.fecha),
        ),
      ),
    cliente
      .select({ hora: reservas.hora, duracionMin: reservas.duracionMin })
      .from(reservas)
      .where(
        and(
          eq(reservas.barberoId, params.barberoId),
          eq(reservas.fecha, params.fecha),
          eq(reservas.estado, 'activa'),
        ),
      ),
  ]);

  const slots = slotsDisponibles({
    fecha: params.fecha,
    hoy,
    ahoraMs: ahora.getTime(),
    bloques,
    overrideTrabaja: combinarOverrides(overrides.map((o) => ({ trabaja: o.trabaja === 1 }))),
    // Los bloqueos administrativos entran acá igual que los turnos: ocupan.
    reservas: ocupados,
    slotDuracionMin: config.slotDuracionMin,
    duracionServicioMin,
    minutosAnticipacion: config.minutosAnticipacion,
  });

  return { fecha: params.fecha, slots, duracionMin: duracionServicioMin };
}

// ------------------------------------------------------------------- mes

export interface DisponibilidadMes {
  anio: number;
  mes: number;
  /** Fechas "YYYY-MM-DD" con al menos un slot libre. */
  diasDisponibles: string[];
}

/**
 * Que dias del mes tienen al menos un horario libre.
 *
 * ⚠️ EXACTAMENTE 5 QUERIES A D1, sin importar cuantos dias tenga el mes.
 * Llamar 31 veces a `disponibilidadDelDia` serian ~155 queries y varios
 * segundos: se traen los bloques, los overrides y las reservas del mes entero
 * de una y se calcula en memoria.
 *
 *   1. negocio
 *   2. duracion del servicio
 *   3. bloques del barbero (todos los dow de una)
 *   4. overrides del mes
 *   5. reservas activas del mes
 */
export async function disponibilidadDelMes(
  d1: D1Database,
  params: { barberoId: string; anio: number; mes: number; servicioId?: string | undefined },
  ahora: Date = new Date(),
): Promise<DisponibilidadMes> {
  const hoy = todayArgentina(ahora);
  const fechas = diasDelMes(params.anio, params.mes);
  if (fechas.length === 0) {
    return { anio: params.anio, mes: params.mes, diasDisponibles: [] };
  }

  const config = await leerConfig(d1); // query 1
  const duracionServicioMin = await duracionDelServicio( // query 2
    d1,
    params.barberoId,
    params.servicioId,
    config.slotDuracionMin,
  );

  const primero = fechas[0]!;
  const ultimo = fechas[fechas.length - 1]!;
  const cliente = db(d1);

  const [horarios, overridesDelMes, reservasDelMes] = await Promise.all([
    // query 3: todos los dow de una, se agrupan en memoria
    cliente
      .select({
        dow: barberoHorarios.dow,
        inicio: barberoHorarios.horaInicio,
        fin: barberoHorarios.horaFin,
      })
      .from(barberoHorarios)
      .innerJoin(barberos, eq(barberos.id, barberoHorarios.barberoId))
      .where(
        and(
          eq(barberoHorarios.barberoId, params.barberoId),
          eq(barberoHorarios.activo, 1),
          eq(barberos.activo, 1),
        ),
      ),
    // query 4: overrides del rango
    cliente
      .select({ fecha: feriadosOverride.fecha, trabaja: feriadosOverride.trabaja })
      .from(feriadosOverride)
      .where(
        and(
          eq(feriadosOverride.barberoId, params.barberoId),
          gte(feriadosOverride.fecha, primero),
          lte(feriadosOverride.fecha, ultimo),
        ),
      ),
    // query 5: reservas activas del rango
    cliente
      .select({
        fecha: reservas.fecha,
        hora: reservas.hora,
        duracionMin: reservas.duracionMin,
      })
      .from(reservas)
      .where(
        and(
          eq(reservas.barberoId, params.barberoId),
          eq(reservas.estado, 'activa'),
          gte(reservas.fecha, primero),
          lte(reservas.fecha, ultimo),
        ),
      ),
  ]);

  // Indices en memoria: de acá para abajo no se toca D1.
  const bloquesPorDow = new Map<number, Bloque[]>();
  for (const h of horarios) {
    const lista = bloquesPorDow.get(h.dow) ?? [];
    lista.push({ inicio: h.inicio, fin: h.fin });
    bloquesPorDow.set(h.dow, lista);
  }

  const overridesPorFecha = new Map<string, { trabaja: boolean }[]>();
  for (const o of overridesDelMes) {
    const lista = overridesPorFecha.get(o.fecha) ?? [];
    lista.push({ trabaja: o.trabaja === 1 });
    overridesPorFecha.set(o.fecha, lista);
  }

  const reservasPorFecha = new Map<string, TurnoExistente[]>();
  for (const r of reservasDelMes) {
    const lista = reservasPorFecha.get(r.fecha) ?? [];
    lista.push({ hora: r.hora, duracionMin: r.duracionMin });
    reservasPorFecha.set(r.fecha, lista);
  }

  const limite = addDays(hoy, config.diasMaxAnticipacion);
  const ahoraMs = ahora.getTime();

  const diasDisponibles = fechas.filter((fecha) => {
    // La ventana de anticipacion maxima cierra el dia aunque el horario abra.
    if (fecha > limite) return false;

    return tieneDisponibilidad({
      fecha,
      hoy,
      ahoraMs,
      bloques: bloquesPorDow.get(diaDeLaSemana(fecha)) ?? [],
      overrideTrabaja: combinarOverrides(overridesPorFecha.get(fecha) ?? []),
      reservas: reservasPorFecha.get(fecha) ?? [],
      slotDuracionMin: config.slotDuracionMin,
      duracionServicioMin,
      minutosAnticipacion: config.minutosAnticipacion,
    });
  });

  return { anio: params.anio, mes: params.mes, diasDisponibles };
}
