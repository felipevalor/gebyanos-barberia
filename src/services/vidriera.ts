import { eq, asc } from 'drizzle-orm';
import { db } from '../db/client';
import { promos, catalogo } from '../db/schema';
import { uuidv7 } from '../db/id';

/**
 * La vidriera: promos y catalogo. Solo `owner`.
 *
 * Las dos son listas ordenadas que se muestran en el sitio y no participan de
 * ninguna regla de negocio: nadie RESERVA una promo. Por eso no tienen chequeos
 * de conflicto ni nombre unico — dos promos "2x1" en meses distintos son
 * perfectamente validas.
 *
 * `servicios` es lo reservable; esto es lo que se exhibe.
 */

export const ERROR_PROMO_NO_ENCONTRADA = 'Promo no encontrada.';
export const ERROR_ITEM_NO_ENCONTRADO = 'Ítem de catálogo no encontrado.';
export const ERROR_NOMBRE_REQUERIDO = 'El nombre es obligatorio.';
export const ERROR_PRECIO =
  'Precio inválido. Tiene que ser un número entero de centavos, sin decimales ni negativos.';

const texto = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() : undefined);

const precioValido = (v: unknown): boolean =>
  v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 0);

export type Resultado<T> = { estado: 'exito'; item: T } | { estado: 'error'; error: string };

// ------------------------------------------------------------------ promos

export interface PromoDelPanel {
  id: string;
  nombre: string;
  precioCentavos: number | null;
  unidad: string | null;
  nota: string | null;
  badge: string | null;
  activo: number;
  orden: number;
}

const colPromo = {
  id: promos.id,
  nombre: promos.nombre,
  precioCentavos: promos.precioCentavos,
  unidad: promos.unidad,
  nota: promos.nota,
  badge: promos.badge,
  activo: promos.activo,
  orden: promos.orden,
};

export async function listarPromos(env: Env): Promise<PromoDelPanel[]> {
  return db(env.DB).select(colPromo).from(promos).orderBy(asc(promos.orden), asc(promos.nombre));
}

export async function buscarPromo(env: Env, id: string): Promise<PromoDelPanel | null> {
  const filas = await db(env.DB).select(colPromo).from(promos).where(eq(promos.id, id)).limit(1);
  return filas[0] ?? null;
}

export interface EntradaPromo {
  nombre?: unknown;
  precioCentavos?: unknown;
  unidad?: unknown;
  nota?: unknown;
  badge?: unknown;
  activo?: unknown;
  orden?: unknown;
}

export async function crearPromo(
  env: Env,
  entrada: EntradaPromo,
): Promise<Resultado<PromoDelPanel>> {
  const nombre = texto(entrada.nombre) ?? '';
  if (!nombre) return { estado: 'error', error: ERROR_NOMBRE_REQUERIDO };

  const precio = entrada.precioCentavos === undefined ? null : entrada.precioCentavos;
  if (!precioValido(precio)) return { estado: 'error', error: ERROR_PRECIO };

  const id = uuidv7();
  await db(env.DB).insert(promos).values({
    id,
    nombre,
    precioCentavos: precio as number | null,
    unidad: texto(entrada.unidad) ?? null,
    nota: texto(entrada.nota) ?? null,
    badge: texto(entrada.badge) ?? null,
    activo: entrada.activo === false ? 0 : 1,
    orden: typeof entrada.orden === 'number' ? entrada.orden : 0,
  });

  const creada = await buscarPromo(env, id);
  return creada ? { estado: 'exito', item: creada } : { estado: 'error', error: ERROR_PROMO_NO_ENCONTRADA };
}

export async function actualizarPromo(
  env: Env,
  id: string,
  entrada: EntradaPromo,
): Promise<Resultado<PromoDelPanel>> {
  const cambios: Record<string, unknown> = {};

  if (entrada.nombre !== undefined) {
    const nombre = texto(entrada.nombre) ?? '';
    if (!nombre) return { estado: 'error', error: ERROR_NOMBRE_REQUERIDO };
    cambios.nombre = nombre;
  }
  if (entrada.precioCentavos !== undefined) {
    if (!precioValido(entrada.precioCentavos)) return { estado: 'error', error: ERROR_PRECIO };
    cambios.precioCentavos = entrada.precioCentavos;
  }
  if (entrada.unidad !== undefined) cambios.unidad = texto(entrada.unidad) || null;
  if (entrada.nota !== undefined) cambios.nota = texto(entrada.nota) || null;
  if (entrada.badge !== undefined) cambios.badge = texto(entrada.badge) || null;
  if (typeof entrada.activo === 'boolean') cambios.activo = entrada.activo ? 1 : 0;
  if (typeof entrada.orden === 'number') cambios.orden = entrada.orden;

  if (Object.keys(cambios).length > 0) {
    await db(env.DB).update(promos).set(cambios).where(eq(promos.id, id));
  }

  const actualizada = await buscarPromo(env, id);
  return actualizada
    ? { estado: 'exito', item: actualizada }
    : { estado: 'error', error: ERROR_PROMO_NO_ENCONTRADA };
}

export async function borrarPromo(env: Env, id: string): Promise<void> {
  await db(env.DB).delete(promos).where(eq(promos.id, id));
}

// ---------------------------------------------------------------- catalogo

export interface ItemCatalogo {
  id: string;
  nombre: string;
  incluye: string;
  precioCentavos: number | null;
  activo: number;
  orden: number;
}

const colCatalogo = {
  id: catalogo.id,
  nombre: catalogo.nombre,
  incluye: catalogo.incluye,
  precioCentavos: catalogo.precioCentavos,
  activo: catalogo.activo,
  orden: catalogo.orden,
};

export async function listarCatalogo(env: Env): Promise<ItemCatalogo[]> {
  return db(env.DB)
    .select(colCatalogo)
    .from(catalogo)
    .orderBy(asc(catalogo.orden), asc(catalogo.nombre));
}

export async function buscarItemCatalogo(env: Env, id: string): Promise<ItemCatalogo | null> {
  const filas = await db(env.DB).select(colCatalogo).from(catalogo).where(eq(catalogo.id, id)).limit(1);
  return filas[0] ?? null;
}

export interface EntradaCatalogo {
  nombre?: unknown;
  incluye?: unknown;
  precioCentavos?: unknown;
  activo?: unknown;
  orden?: unknown;
}

export async function crearItemCatalogo(
  env: Env,
  entrada: EntradaCatalogo,
): Promise<Resultado<ItemCatalogo>> {
  const nombre = texto(entrada.nombre) ?? '';
  if (!nombre) return { estado: 'error', error: ERROR_NOMBRE_REQUERIDO };

  const precio = entrada.precioCentavos === undefined ? null : entrada.precioCentavos;
  if (!precioValido(precio)) return { estado: 'error', error: ERROR_PRECIO };

  const id = uuidv7();
  await db(env.DB).insert(catalogo).values({
    id,
    nombre,
    incluye: texto(entrada.incluye) ?? '',
    precioCentavos: precio as number | null,
    activo: entrada.activo === false ? 0 : 1,
    orden: typeof entrada.orden === 'number' ? entrada.orden : 0,
  });

  const creado = await buscarItemCatalogo(env, id);
  return creado ? { estado: 'exito', item: creado } : { estado: 'error', error: ERROR_ITEM_NO_ENCONTRADO };
}

export async function actualizarItemCatalogo(
  env: Env,
  id: string,
  entrada: EntradaCatalogo,
): Promise<Resultado<ItemCatalogo>> {
  const cambios: Record<string, unknown> = {};

  if (entrada.nombre !== undefined) {
    const nombre = texto(entrada.nombre) ?? '';
    if (!nombre) return { estado: 'error', error: ERROR_NOMBRE_REQUERIDO };
    cambios.nombre = nombre;
  }
  if (entrada.precioCentavos !== undefined) {
    if (!precioValido(entrada.precioCentavos)) return { estado: 'error', error: ERROR_PRECIO };
    cambios.precioCentavos = entrada.precioCentavos;
  }
  // Cadena vacia, NO null: la columna es NOT NULL con default ''.
  if (entrada.incluye !== undefined) cambios.incluye = texto(entrada.incluye) ?? '';
  if (typeof entrada.activo === 'boolean') cambios.activo = entrada.activo ? 1 : 0;
  if (typeof entrada.orden === 'number') cambios.orden = entrada.orden;

  if (Object.keys(cambios).length > 0) {
    await db(env.DB).update(catalogo).set(cambios).where(eq(catalogo.id, id));
  }

  const actualizado = await buscarItemCatalogo(env, id);
  return actualizado
    ? { estado: 'exito', item: actualizado }
    : { estado: 'error', error: ERROR_ITEM_NO_ENCONTRADO };
}

export async function borrarItemCatalogo(env: Env, id: string): Promise<void> {
  await db(env.DB).delete(catalogo).where(eq(catalogo.id, id));
}
