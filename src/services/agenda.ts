import { and, eq, gte, lte, desc, asc, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { barberos, reservas, servicios } from '../db/schema';
import { todayArgentina, addDays } from '../domain/dates';
import type { Rol } from './auth';

/**
 * Lecturas del panel: agenda y listado de reservas.
 *
 * EL SCOPING POR ROL ES LA REGLA QUE MAS SE OLVIDA, asi que se resuelve UNA
 * vez, al principio del handler, con `resolverBarbero`. Ningun handler debe
 * leer `barberoId` de la query por su cuenta.
 */

/** Rango por defecto de la agenda: −30/+60 dias. */
export const DIAS_ATRAS = 30;
export const DIAS_ADELANTE = 60;
export const LIMITE_AGENDA = 500;
export const LIMITE_LISTADO = 50;
export const LIMITE_LISTADO_MAX = 200;

/**
 * Barbero sobre el que opera el request.
 *
 * - `barbero`: SIEMPRE el suyo. Un `?barberoId=` de otro se ignora en vez de
 *   dar error: filtrar es más seguro que confiar en que el handler chequee.
 * - `owner`: el que pida, o `null` = todos.
 */
export function resolverBarbero(
  sesion: { barberoId: string; rol: Rol },
  pedido: string | undefined,
): string | null {
  if (sesion.rol !== 'owner') return sesion.barberoId;
  return pedido && pedido.trim() ? pedido.trim() : null;
}

export interface TurnoDelPanel {
  id: string;
  barberoId: string | null;
  barberoNombre: string | null;
  fecha: string;
  hora: string;
  duracionMin: number;
  nombre: string;
  telefono: string;
  servicio: string;
  estado: string;
  tipo: string;
  mensaje: string | null;
  source: string;
  createdAt: string;
}

const columnas = {
  id: reservas.id,
  barberoId: reservas.barberoId,
  barberoNombre: barberos.nombre,
  fecha: reservas.fecha,
  hora: reservas.hora,
  duracionMin: reservas.duracionMin,
  nombre: reservas.nombre,
  telefono: reservas.telefono,
  servicio: reservas.servicio,
  estado: reservas.estado,
  tipo: reservas.tipo,
  mensaje: reservas.mensaje,
  source: reservas.source,
  createdAt: reservas.createdAt,
};

export interface FiltrosAgenda {
  barberoId: string | null;
  desde?: string | undefined;
  hasta?: string | undefined;
  /** Si es false, trae tambien las canceladas. Por defecto solo activas. */
  soloActivas?: boolean;
}

/**
 * Turnos y bloqueos en un rango de fechas.
 *
 * Incluye los bloqueos (`tipo = 'bloqueo'`): la agenda del barbero tiene que
 * mostrarlos, porque ocupan lugar. Lo que los excluye es el listado de turnos
 * de clientes, no esto.
 */
export async function listarAgenda(
  env: Env,
  filtros: FiltrosAgenda,
  ahora: Date = new Date(),
): Promise<TurnoDelPanel[]> {
  const hoy = todayArgentina(ahora);
  const desde = filtros.desde ?? addDays(hoy, -DIAS_ATRAS);
  const hasta = filtros.hasta ?? addDays(hoy, DIAS_ADELANTE);

  const condiciones = [gte(reservas.fecha, desde), lte(reservas.fecha, hasta)];
  if (filtros.barberoId) condiciones.push(eq(reservas.barberoId, filtros.barberoId));
  if (filtros.soloActivas !== false) condiciones.push(eq(reservas.estado, 'activa'));

  return db(env.DB)
    .select(columnas)
    .from(reservas)
    .leftJoin(barberos, eq(barberos.id, reservas.barberoId))
    .where(and(...condiciones))
    .orderBy(asc(reservas.fecha), asc(reservas.hora))
    .limit(LIMITE_AGENDA);
}

export interface FiltrosListado {
  barberoId: string | null;
  skip?: number | undefined;
  limit?: number | undefined;
}

export interface ListadoReservas {
  items: TurnoDelPanel[];
  total: number;
  skip: number;
  limit: number;
}

/**
 * Listado paginado de TURNOS DE CLIENTES.
 *
 * 🐛 Filtra `tipo = 'turno'`: los bloqueos administrativos no son turnos de
 * nadie y no tienen que aparecer acá. El sistema viejo los marcaba con un
 * string magico en `servicio` y cada query tenia que acordarse de excluirlo;
 * con la columna `tipo` el filtro es explicito.
 */
export async function listarReservas(
  env: Env,
  filtros: FiltrosListado,
): Promise<ListadoReservas> {
  const skip = Math.max(0, Math.trunc(filtros.skip ?? 0));
  const limit = Math.min(LIMITE_LISTADO_MAX, Math.max(1, Math.trunc(filtros.limit ?? LIMITE_LISTADO)));

  const condiciones = [eq(reservas.tipo, 'turno')];
  if (filtros.barberoId) condiciones.push(eq(reservas.barberoId, filtros.barberoId));
  const donde = and(...condiciones);

  const cliente = db(env.DB);

  const [items, conteo] = await Promise.all([
    cliente
      .select(columnas)
      .from(reservas)
      .leftJoin(barberos, eq(barberos.id, reservas.barberoId))
      .where(donde)
      .orderBy(desc(reservas.fecha), desc(reservas.hora))
      .limit(limit)
      .offset(skip),
    cliente.select({ n: sql<number>`count(*)` }).from(reservas).where(donde),
  ]);

  return { items, total: conteo[0]?.n ?? 0, skip, limit };
}

/** Una reserva puntual, con lo necesario para decidir permisos. */
export async function buscarReserva(
  env: Env,
  id: string,
): Promise<{ id: string; barberoId: string | null; estado: string; tipo: string } | null> {
  const filas = await db(env.DB)
    .select({
      id: reservas.id,
      barberoId: reservas.barberoId,
      estado: reservas.estado,
      tipo: reservas.tipo,
    })
    .from(reservas)
    .where(eq(reservas.id, id))
    .limit(1);

  return filas[0] ?? null;
}

/** Nombre y duracion de un servicio activo, para el alta desde el panel. */
export async function buscarServicio(
  env: Env,
  servicioId: string,
): Promise<{ nombre: string; duracionMin: number } | null> {
  const filas = await db(env.DB)
    .select({ nombre: servicios.nombre, duracionMin: servicios.duracionMin })
    .from(servicios)
    .where(and(eq(servicios.id, servicioId), eq(servicios.activo, 1)))
    .limit(1);

  return filas[0] ?? null;
}
