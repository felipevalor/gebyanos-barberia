import { and, eq, ne, asc, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { barberos } from '../db/schema';
import { uuidv7 } from '../db/id';
import { esViolacionDeUnicoEn } from '../db/errores';
import { hashPassword, validarLargoPassword } from './password';
import { sembrarHorarioInicial } from './horarios';
import type { Rol } from './auth';

/**
 * ABM de barberos. Solo `owner`.
 *
 * Los barberos son tambien los USUARIOS del panel: el `slug` es el nombre de
 * usuario del login. Por eso el alta pide password y por eso borrar un barbero
 * es borrar una cuenta.
 *
 * ⚠️ ESTE LISTADO NO FILTRA `activo = 1`, Y ES LA EXCEPCION A LA REGLA.
 *
 * El resto del sistema filtra `activo = 1` siempre. Acá no: el panel es
 * justamente donde se reactiva a un barbero desactivado, y si el listado lo
 * escondiera no habria forma de volver a darlo de alta sin tocar la base.
 * Lo publico (`services/publico.ts`) sí filtra.
 */

export const ERROR_BARBERO_NO_ENCONTRADO = 'Barbero no encontrado.';
export const ERROR_SLUG_DUPLICADO = 'Ya existe un barbero con ese usuario. Elegí otro.';
export const ERROR_SLUG_INVALIDO =
  'El usuario solo puede tener letras, números y guiones, y al menos 3 caracteres.';
export const ERROR_NOMBRE_REQUERIDO = 'El nombre es obligatorio.';
export const ERROR_ROL_INVALIDO = 'Rol inválido. Usá barbero o owner.';

/**
 * Los tres casos del ultimo dueño.
 *
 * Son el mismo problema con tres puertas: si el unico owner activo deja de
 * serlo, nadie puede volver a entrar al panel a arreglarlo. La spec nombra
 * desactivar y borrar; DEGRADAR el rol tiene exactamente el mismo efecto y no
 * estaba contemplado.
 */
const FINAL_ULTIMO_OWNER = ' Nombrá dueño a otro barbero antes.';

export const ERROR_ULTIMO_OWNER_DESACTIVAR =
  'No se puede desactivar: es el único dueño y el panel quedaría sin acceso.' + FINAL_ULTIMO_OWNER;
export const ERROR_ULTIMO_OWNER_BORRAR =
  'No se puede borrar: es el único dueño y el panel quedaría sin acceso.' + FINAL_ULTIMO_OWNER;
export const ERROR_ULTIMO_OWNER_ROL =
  'No se puede quitarle el rol de dueño: es el único que queda y el panel quedaría sin acceso.' +
  FINAL_ULTIMO_OWNER;

export interface BarberoDelPanel {
  id: string;
  slug: string;
  nombre: string;
  tel: string | null;
  rol: string;
  activo: number;
  orden: number;
  /** Derivado, NUNCA el hash: el panel solo necesita saber si puede loguearse. */
  tienePassword: boolean;
  createdAt: string;
}

const columnas = {
  id: barberos.id,
  slug: barberos.slug,
  nombre: barberos.nombre,
  tel: barberos.tel,
  rol: barberos.rol,
  activo: barberos.activo,
  orden: barberos.orden,
  passwordHash: barberos.passwordHash,
  createdAt: barberos.createdAt,
};

const sinHash = ({ passwordHash, ...resto }: {
  passwordHash: string | null;
} & Omit<BarberoDelPanel, 'tienePassword'>): BarberoDelPanel => ({
  ...resto,
  tienePassword: Boolean(passwordHash),
});

export async function listarBarberos(env: Env): Promise<BarberoDelPanel[]> {
  const filas = await db(env.DB)
    .select(columnas)
    .from(barberos)
    .orderBy(asc(barberos.orden), asc(barberos.nombre));

  return filas.map(sinHash);
}

export async function buscarBarbero(env: Env, id: string): Promise<BarberoDelPanel | null> {
  const filas = await db(env.DB).select(columnas).from(barberos).where(eq(barberos.id, id)).limit(1);
  const fila = filas[0];

  return fila ? sinHash(fila) : null;
}

/**
 * ¿Es el ultimo owner ACTIVO?
 *
 * Cuenta los otros: si no queda ninguno, este es el ultimo. Un owner
 * desactivado no cuenta — no puede loguearse, asi que no salva a nadie.
 */
export async function esUltimoOwner(env: Env, id: string): Promise<boolean> {
  const actual = await buscarBarbero(env, id);
  if (!actual || actual.rol !== 'owner' || actual.activo !== 1) return false;

  const otros = await db(env.DB)
    .select({ id: barberos.id })
    .from(barberos)
    .where(and(eq(barberos.rol, 'owner'), eq(barberos.activo, 1), ne(barberos.id, id)))
    .limit(1);

  return otros.length === 0;
}

// ------------------------------------------------------------- validacion

/** Minusculas, sin espacios: es lo que se tipea en el login. */
export const normalizarSlug = (v: string): string => v.trim().toLowerCase();

const SLUG_VALIDO = /^[a-z0-9-]{3,40}$/;

export interface EntradaBarbero {
  slug?: unknown;
  nombre?: unknown;
  tel?: unknown;
  rol?: unknown;
  orden?: unknown;
  activo?: unknown;
  password?: unknown;
}

const texto = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() : undefined);

export type ResultadoBarbero =
  | { estado: 'exito'; barbero: BarberoDelPanel }
  | { estado: 'error'; error: string }
  | { estado: 'duplicado' };

export async function crearBarbero(env: Env, entrada: EntradaBarbero): Promise<ResultadoBarbero> {
  const slug = normalizarSlug(texto(entrada.slug) ?? '');
  const nombre = texto(entrada.nombre) ?? '';
  const rol = texto(entrada.rol) ?? 'barbero';

  if (!SLUG_VALIDO.test(slug)) return { estado: 'error', error: ERROR_SLUG_INVALIDO };
  if (!nombre) return { estado: 'error', error: ERROR_NOMBRE_REQUERIDO };
  if (rol !== 'barbero' && rol !== 'owner') return { estado: 'error', error: ERROR_ROL_INVALIDO };

  // Password OPCIONAL en el alta: se puede crear el barbero para la agenda y
  // darle acceso al panel despues (o nunca).
  const password = texto(entrada.password);
  if (password !== undefined) {
    const errorLargo = validarLargoPassword(password);
    if (errorLargo) return { estado: 'error', error: errorLargo };
  }

  const id = uuidv7();
  const valores = {
    id,
    slug,
    nombre,
    tel: texto(entrada.tel) ?? null,
    rol: rol satisfies Rol,
    orden: typeof entrada.orden === 'number' ? entrada.orden : 0,
    activo: entrada.activo === false ? 0 : 1,
    passwordHash: password ? await hashPassword(password) : null,
  };

  try {
    await db(env.DB).insert(barberos).values(valores);
  } catch (e) {
    if (esViolacionDeUnicoEn(e, 'barberos')) return { estado: 'duplicado' };
    throw e;
  }

  // El barbero NACE CON HORARIO. Ver el docstring de `sembrarHorarioInicial`:
  // sin esto queda invisible en la disponibilidad y nadie entiende por que.
  await sembrarHorarioInicial(env, id);

  const creado = await buscarBarbero(env, id);
  return creado ? { estado: 'exito', barbero: creado } : { estado: 'error', error: ERROR_BARBERO_NO_ENCONTRADO };
}

/**
 * Edicion parcial: solo toca los campos presentes en el cuerpo.
 *
 * Los chequeos de conflicto (turnos futuros, ultimo owner) NO viven acá sino en
 * la ruta, que es la que sabe devolver un 409 con la lista.
 */
export async function actualizarBarbero(
  env: Env,
  id: string,
  entrada: EntradaBarbero,
): Promise<ResultadoBarbero> {
  const cambios: Record<string, unknown> = {};

  if (entrada.slug !== undefined) {
    const slug = normalizarSlug(texto(entrada.slug) ?? '');
    if (!SLUG_VALIDO.test(slug)) return { estado: 'error', error: ERROR_SLUG_INVALIDO };
    cambios.slug = slug;
  }
  if (entrada.nombre !== undefined) {
    const nombre = texto(entrada.nombre) ?? '';
    if (!nombre) return { estado: 'error', error: ERROR_NOMBRE_REQUERIDO };
    cambios.nombre = nombre;
  }
  if (entrada.rol !== undefined) {
    const rol = texto(entrada.rol);
    if (rol !== 'barbero' && rol !== 'owner') return { estado: 'error', error: ERROR_ROL_INVALIDO };
    cambios.rol = rol;
  }
  if (entrada.tel !== undefined) cambios.tel = texto(entrada.tel) || null;
  if (typeof entrada.orden === 'number') cambios.orden = entrada.orden;
  if (typeof entrada.activo === 'boolean') cambios.activo = entrada.activo ? 1 : 0;

  if (entrada.password !== undefined) {
    const password = texto(entrada.password) ?? '';
    const errorLargo = validarLargoPassword(password);
    if (errorLargo) return { estado: 'error', error: errorLargo };
    cambios.passwordHash = await hashPassword(password);
  }

  if (Object.keys(cambios).length > 0) {
    try {
      await db(env.DB).update(barberos).set(cambios).where(eq(barberos.id, id));
    } catch (e) {
      if (esViolacionDeUnicoEn(e, 'barberos')) return { estado: 'duplicado' };
      throw e;
    }
  }

  const actualizado = await buscarBarbero(env, id);
  return actualizado
    ? { estado: 'exito', barbero: actualizado }
    : { estado: 'error', error: ERROR_BARBERO_NO_ENCONTRADO };
}

/**
 * Borrado FISICO, a diferencia de las reservas.
 *
 * Es lo correcto acá: un barbero borrado es una cuenta que se va, y el
 * historial no se pierde porque `reservas.barbero_id` es SET NULL. Los turnos
 * quedan con su snapshot de nombre, servicio y hora.
 */
export async function borrarBarbero(env: Env, id: string): Promise<void> {
  await db(env.DB).delete(barberos).where(eq(barberos.id, id));
}

/** Cuantos owners activos hay. Para que el panel esconda el boton, no para validar. */
export async function contarOwnersActivos(env: Env): Promise<number> {
  const filas = await db(env.DB)
    .select({ n: sql<number>`count(*)` })
    .from(barberos)
    .where(and(eq(barberos.rol, 'owner'), eq(barberos.activo, 1)));

  return filas[0]?.n ?? 0;
}
