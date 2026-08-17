import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { reservas, clientesRecurrentes } from '../db/schema';
import { todayArgentina, addDays, diaDeLaSemana } from '../domain/dates';

/**
 * Contadores del panel. SCOPED POR ROL: un `barbero` cuenta lo suyo, un `owner`
 * cuenta todo.
 *
 * Que se cuenta: turnos ACTIVOS de cliente. Ni cancelados —no son un
 * compromiso con nadie— ni bloqueos administrativos, que son huecos que el
 * barbero se reserva y contarlos inflaria el numero del dia.
 *
 * ⚠️ "LA SEMANA" ES LA SEMANA CALENDARIO, de lunes a domingo, no los proximos
 * siete dias. La spec dice "de la semana" sin definirlo. Se eligio calendario
 * porque es lo que el dueño ve en su cabeza cuando mira el panel un jueves:
 * quiere saber como viene ESTA semana, incluidos el lunes y el martes que ya
 * pasaron. Con "proximos 7 dias" el numero baja todos los dias sin que pase
 * nada, y no significa lo mismo dos dias seguidos.
 */

export interface Stats {
  hoy: number;
  semana: number;
  mes: number;
  recurrentesActivos: number;
  /** Los limites usados, para que el panel pueda mostrarlos sin recalcularlos. */
  rango: { hoy: string; semanaDesde: string; semanaHasta: string; mesDesde: string; mesHasta: string };
}

/** Lunes de la semana que contiene `fecha`. `diaDeLaSemana` da 0 = domingo. */
export function lunesDeLaSemana(fecha: string): string {
  const dow = diaDeLaSemana(fecha);
  // Domingo (0) pertenece a la semana que arranco el lunes anterior: -6.
  return addDays(fecha, dow === 0 ? -6 : 1 - dow);
}

export async function calcularStats(env: Env, barberoId: string | null, ahora = new Date()): Promise<Stats> {
  const hoy = todayArgentina(ahora);
  const semanaDesde = lunesDeLaSemana(hoy);
  const semanaHasta = addDays(semanaDesde, 6);

  /**
   * El mes se acota lexicograficamente: las fechas son "YYYY-MM-DD", asi que
   * ninguna cadena de otro mes cae entre "YYYY-MM-01" y "YYYY-MM-31". Evita
   * calcular el ultimo dia real del mes, que es donde entra febrero a molestar.
   */
  const mesDesde = `${hoy.slice(0, 7)}-01`;
  const mesHasta = `${hoy.slice(0, 7)}-31`;

  const delBarbero = barberoId ? eq(reservas.barberoId, barberoId) : undefined;

  /**
   * Los tres conteos en UNA query con sumas condicionales.
   *
   * Tres `count(*)` separados serian tres viajes a D1 para leer el mismo
   * conjunto de filas, y el panel se abre en cada carga.
   */
  const filas = await db(env.DB)
    .select({
      hoy: sql<number>`sum(case when ${reservas.fecha} = ${hoy} then 1 else 0 end)`,
      semana: sql<number>`sum(case when ${reservas.fecha} between ${semanaDesde} and ${semanaHasta} then 1 else 0 end)`,
      mes: sql<number>`sum(case when ${reservas.fecha} between ${mesDesde} and ${mesHasta} then 1 else 0 end)`,
    })
    .from(reservas)
    .where(and(eq(reservas.estado, 'activa'), eq(reservas.tipo, 'turno'), delBarbero));

  const recurrentes = await db(env.DB)
    .select({ n: sql<number>`count(*)` })
    .from(clientesRecurrentes)
    .where(
      and(
        eq(clientesRecurrentes.activo, 1),
        barberoId ? eq(clientesRecurrentes.barberoId, barberoId) : undefined,
      ),
    );

  const fila = filas[0];

  return {
    // `sum` sobre cero filas devuelve NULL, no 0: sin esto el panel muestra
    // "null turnos" el dia que la barberia esta vacia.
    hoy: fila?.hoy ?? 0,
    semana: fila?.semana ?? 0,
    mes: fila?.mes ?? 0,
    recurrentesActivos: recurrentes[0]?.n ?? 0,
    rango: { hoy, semanaDesde, semanaHasta, mesDesde, mesHasta },
  };
}
