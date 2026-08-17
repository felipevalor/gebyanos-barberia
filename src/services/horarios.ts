import { and, eq, asc } from 'drizzle-orm';
import { db } from '../db/client';
import { barberoHorarios } from '../db/schema';
import { uuidv7 } from '../db/id';
import type { Bloque } from '../domain/slots';

/**
 * Horarios semanales del barbero.
 *
 * Varios bloques por `dow` = horario cortado. `hora_inicio` y `hora_fin` son
 * ENTEROS (9, 20), no strings "HH:mm".
 */

/** Horario que se siembra al crear un barbero: 9 a 20. */
export const HORARIO_INICIAL = { horaInicio: 9, horaFin: 20 };

/**
 * Se siembran los SIETE dias, con domingo `activo = 0`.
 *
 * Funcionalmente da igual que omitir el domingo — sin bloques activos el dia
 * esta cerrado de las dos formas. La diferencia es de usabilidad:
 *
 *   - una fila inactiva YA LLEVA las horas, asi que prender el domingo desde
 *     el panel deja 9 a 20 en vez de un formulario vacio;
 *   - el frontend renderiza los siete dias que recibe, en vez de sintetizar
 *     los que faltan para dibujar la semana completa.
 */
export const DIAS_LABORABLES = [1, 2, 3, 4, 5, 6];
export const DIA_INACTIVO_INICIAL = 0;

export interface BloqueHorario {
  id: string;
  dow: number;
  activo: number;
  horaInicio: number;
  horaFin: number;
}

export interface EntradaBloque {
  horaInicio: number;
  horaFin: number;
  activo?: boolean;
}

export const ERROR_DOW = 'Día de la semana inválido. Usá 0 (domingo) a 6 (sábado).';
export const ERROR_RANGO =
  'Horario inválido. La hora de fin tiene que ser mayor que la de inicio, y las dos entre 0 y 24.';
export const ERROR_BLOQUE_NO_ENCONTRADO = 'Bloque de horario no encontrado.';

export const esDowValido = (dow: number): boolean =>
  Number.isInteger(dow) && dow >= 0 && dow <= 6;

/**
 * Valida un bloque. Devuelve el mensaje de rechazo o null.
 *
 * `hora_fin > hora_inicio` estricto: un bloque de 9 a 9 no existe.
 */
export function validarBloque(b: EntradaBloque): string | null {
  const { horaInicio, horaFin } = b;

  if (!Number.isInteger(horaInicio) || !Number.isInteger(horaFin)) return ERROR_RANGO;
  if (horaInicio < 0 || horaInicio > 24 || horaFin < 0 || horaFin > 24) return ERROR_RANGO;
  if (horaFin <= horaInicio) return ERROR_RANGO;

  return null;
}

/**
 * Los bloques del barbero, todos los dias.
 *
 * NO inventa nada: devuelve lo que hay en la base. Un barbero sin horarios
 * devuelve una lista vacia, y eso se ve en el panel como "sin configurar", que
 * es un estado comprensible.
 */
export async function listarHorarios(env: Env, barberoId: string): Promise<BloqueHorario[]> {
  return db(env.DB)
    .select({
      id: barberoHorarios.id,
      dow: barberoHorarios.dow,
      activo: barberoHorarios.activo,
      horaInicio: barberoHorarios.horaInicio,
      horaFin: barberoHorarios.horaFin,
    })
    .from(barberoHorarios)
    .where(eq(barberoHorarios.barberoId, barberoId))
    .orderBy(asc(barberoHorarios.dow), asc(barberoHorarios.horaInicio));
}

/** Bloques ACTIVOS de un dia, en la forma que espera `evaluarSlot`. */
export async function bloquesActivosDelDia(
  env: Env,
  barberoId: string,
  dow: number,
): Promise<Bloque[]> {
  const filas = await db(env.DB)
    .select({ inicio: barberoHorarios.horaInicio, fin: barberoHorarios.horaFin })
    .from(barberoHorarios)
    .where(
      and(
        eq(barberoHorarios.barberoId, barberoId),
        eq(barberoHorarios.dow, dow),
        eq(barberoHorarios.activo, 1),
      ),
    );

  return filas;
}

/**
 * Reemplaza TODOS los bloques de un dia.
 *
 * Borrar e insertar en un `batch`: si el insert fallara despues de un delete
 * suelto, el barbero se quedaria sin horario ese dia.
 */
export async function reemplazarDia(
  env: Env,
  barberoId: string,
  dow: number,
  bloques: EntradaBloque[],
): Promise<void> {
  const sentencias = [
    env.DB.prepare('DELETE FROM barbero_horarios WHERE barbero_id = ? AND dow = ?').bind(
      barberoId,
      dow,
    ),
    ...bloques.map((b) =>
      env.DB.prepare(
        'INSERT INTO barbero_horarios (id, barbero_id, dow, activo, hora_inicio, hora_fin) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(uuidv7(), barberoId, dow, b.activo === false ? 0 : 1, b.horaInicio, b.horaFin),
    ),
  ];

  await env.DB.batch(sentencias);
}

/** Un bloque puntual, para saber a que barbero y dia pertenece. */
export async function buscarBloque(
  env: Env,
  id: string,
): Promise<(BloqueHorario & { barberoId: string }) | null> {
  const filas = await db(env.DB)
    .select({
      id: barberoHorarios.id,
      barberoId: barberoHorarios.barberoId,
      dow: barberoHorarios.dow,
      activo: barberoHorarios.activo,
      horaInicio: barberoHorarios.horaInicio,
      horaFin: barberoHorarios.horaFin,
    })
    .from(barberoHorarios)
    .where(eq(barberoHorarios.id, id))
    .limit(1);

  return filas[0] ?? null;
}

export async function editarBloque(
  env: Env,
  id: string,
  cambios: EntradaBloque,
): Promise<void> {
  await db(env.DB)
    .update(barberoHorarios)
    .set({
      horaInicio: cambios.horaInicio,
      horaFin: cambios.horaFin,
      activo: cambios.activo === false ? 0 : 1,
    })
    .where(eq(barberoHorarios.id, id));
}

/**
 * Siembra el horario inicial de un barbero: los siete dias de 9 a 20, con el
 * domingo inactivo.
 *
 * ⚠️ POR QUE ESTO EXISTE, Y POR QUE `evaluarSlot` NO SE TOCA
 *
 * `evaluarSlot` devuelve `diaCerrado` cuando no hay bloques, asi que un barbero
 * recien creado no puede recibir ninguna reserva y nadie entiende por que.
 *
 * El sistema viejo lo parchea al reves: si el barbero no tiene NINGUNA fila de
 * horario, devuelve `abierto` sin evaluar nada — o sea que un barbero sin
 * configurar queda ABIERTO 24/7. Es peor que el problema que resuelve: alguien
 * reserva a las 4 de la mañana y el barbero se entera el dia del turno.
 *
 * Acá se resuelve en el alta: el barbero nace con horario. `evaluarSlot`
 * mantiene su regla sin excepciones, que es lo que hace que sus tests valgan
 * algo — una funcion pura con un caso especial escondido no se puede razonar.
 *
 * Es idempotente: si ya tiene bloques, no toca nada.
 */
export async function sembrarHorarioInicial(env: Env, barberoId: string): Promise<boolean> {
  const existentes = await listarHorarios(env, barberoId);
  if (existentes.length > 0) return false;

  const filas = [0, 1, 2, 3, 4, 5, 6].map((dow) =>
    env.DB.prepare(
      'INSERT INTO barbero_horarios (id, barbero_id, dow, activo, hora_inicio, hora_fin) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(
      uuidv7(),
      barberoId,
      dow,
      dow === DIA_INACTIVO_INICIAL ? 0 : 1,
      HORARIO_INICIAL.horaInicio,
      HORARIO_INICIAL.horaFin,
    ),
  );

  await env.DB.batch(filas);
  return true;
}
