import { and, eq, gte, lte, asc } from 'drizzle-orm';
import { db } from '../db/client';
import { feriadosOverride } from '../db/schema';
import { uuidv7 } from '../db/id';
import { type FeriadoNacional } from '../integrations/feriados-nacionales';
import { feriadosDelAnio } from './cron';

/**
 * Feriados: dos cosas distintas que el panel muestra juntas.
 *
 *   NACIONALES → informativos. No cierran nada. Vienen de una API externa.
 *   OVERRIDES  → filas propias. `trabaja = 0` cierra la fecha.
 *
 * ⚠️ LO QUE CIERRA LA BARBERIA ES EL OVERRIDE, NO EL FERIADO NACIONAL. El
 * panel muestra los nacionales para que el barbero decida, no para decidir por
 * él.
 *
 * Y la regla contraintuitiva de `evaluarSlot` sigue valiendo: un override con
 * `trabaja = 1` NO abre un dia sin horario configurado. Solo evita que un
 * `trabaja = 0` lo cierre.
 */

export const ERROR_FERIADO_NO_ENCONTRADO = 'Feriado no encontrado.';

export interface OverridePropio {
  id: string;
  fecha: string;
  trabaja: number;
  motivo: string | null;
}

export interface FeriadosDelAnio {
  anio: number;
  nacionales: FeriadoNacional[];
  propios: OverridePropio[];
}

export async function listarOverrides(
  env: Env,
  barberoId: string,
  anio: number,
): Promise<OverridePropio[]> {
  return db(env.DB)
    .select({
      id: feriadosOverride.id,
      fecha: feriadosOverride.fecha,
      trabaja: feriadosOverride.trabaja,
      motivo: feriadosOverride.motivo,
    })
    .from(feriadosOverride)
    .where(
      and(
        eq(feriadosOverride.barberoId, barberoId),
        gte(feriadosOverride.fecha, `${anio}-01-01`),
        lte(feriadosOverride.fecha, `${anio}-12-31`),
      ),
    )
    .orderBy(asc(feriadosOverride.fecha));
}

/**
 * Los dos juntos, pero SEPARADOS en el payload.
 *
 * No se mezclan en una sola lista: el frontend tiene que poder mostrar "es
 * feriado nacional pero abrimos" y "cerramos aunque no sea feriado", que son
 * estados distintos y los dos ocurren.
 */
export async function listarFeriados(
  env: Env,
  barberoId: string,
  anio: number,
): Promise<FeriadosDelAnio> {
  // Pasa por KV: sin el cache, cada apertura de la pantalla de feriados
  // dispara un request a un servicio de terceros, y si ese servicio esta caido
  // la pantalla aparece vacia aunque tengamos la copia del mes pasado.
  const [cache, propios] = await Promise.all([
    feriadosDelAnio(env, anio),
    listarOverrides(env, barberoId, anio),
  ]);

  return { anio, nacionales: cache.feriados, propios };
}

/**
 * Upsert por `(barbero_id, fecha)`.
 *
 * Hay un UNIQUE sobre ese par, asi que un INSERT a secas fallaria al segundo
 * intento con el mismo dia. Se busca primero y se actualiza si existe: el
 * panel manda "cerrar el 25" dos veces sin que sea un error.
 */
export async function guardarOverride(
  env: Env,
  barberoId: string,
  datos: { fecha: string; trabaja: boolean; motivo?: string | undefined },
): Promise<OverridePropio> {
  const cliente = db(env.DB);
  const trabaja = datos.trabaja ? 1 : 0;
  const motivo = datos.motivo?.trim() || null;

  const existentes = await cliente
    .select({ id: feriadosOverride.id })
    .from(feriadosOverride)
    .where(
      and(eq(feriadosOverride.barberoId, barberoId), eq(feriadosOverride.fecha, datos.fecha)),
    )
    .limit(1);

  const existente = existentes[0];

  if (existente) {
    await cliente
      .update(feriadosOverride)
      .set({ trabaja, motivo })
      .where(eq(feriadosOverride.id, existente.id));

    return { id: existente.id, fecha: datos.fecha, trabaja, motivo };
  }

  const id = uuidv7();
  await cliente
    .insert(feriadosOverride)
    .values({ id, barberoId, fecha: datos.fecha, trabaja, motivo });

  return { id, fecha: datos.fecha, trabaja, motivo };
}

export async function buscarOverride(
  env: Env,
  id: string,
): Promise<(OverridePropio & { barberoId: string }) | null> {
  const filas = await db(env.DB)
    .select({
      id: feriadosOverride.id,
      barberoId: feriadosOverride.barberoId,
      fecha: feriadosOverride.fecha,
      trabaja: feriadosOverride.trabaja,
      motivo: feriadosOverride.motivo,
    })
    .from(feriadosOverride)
    .where(eq(feriadosOverride.id, id))
    .limit(1);

  return filas[0] ?? null;
}

/**
 * Borra un override. NO pasa por Bloquear+Avisar.
 *
 * Borrar un override solo puede ABRIR un dia que estaba cerrado, o sacar una
 * excepcion positiva. Ninguna de las dos cosas deja turnos huerfanos.
 */
export async function borrarOverride(env: Env, id: string): Promise<void> {
  await db(env.DB).delete(feriadosOverride).where(eq(feriadosOverride.id, id));
}
