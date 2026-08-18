import { and, eq, gt } from 'drizzle-orm';
import { db } from '../db/client';
import { adminSessions, barberos } from '../db/schema';
import { verificarPassword } from './password';

/**
 * Autenticacion del panel. Los BARBEROS son los usuarios: no hay tabla de
 * usuarios aparte, se loguean con su `slug`.
 */

/** 24 h. No configurable. */
export const DURACION_SESION_MS = 24 * 60 * 60 * 1000;

/** 16 bytes de aleatoriedad real, NO un UUID. */
const LARGO_TOKEN_BYTES = 16;

export const COOKIE_SESION = 'admin_token';

export const ERROR_CREDENCIALES = 'Usuario o contraseña incorrectos';
export const ERROR_NO_AUTORIZADO = 'No autorizado';
export const ERROR_PROHIBIDO = 'Prohibido';

export type Rol = 'barbero' | 'owner';

export interface UsuarioAutenticado {
  id: string;
  slug: string;
  nombre: string;
  rol: Rol;
}

export interface SesionActiva {
  sessionId: string;
  barberoId: string;
  rol: Rol;
}

export type ResultadoLogin =
  | { ok: true; token: string; expiresAt: Date; usuario: UsuarioAutenticado }
  | { ok: false };

/**
 * Token de sesion: 16 bytes de `crypto.getRandomValues` en hex.
 *
 * NO es un UUID. Un UUID v4 tiene 122 bits de entropia pero un formato
 * reconocible, y el v7 que usamos para las PKs lleva el timestamp adentro: es
 * parcialmente predecible, que es exactamente lo que no se quiere en un token
 * de sesion.
 */
export function generarToken(): string {
  const bytes = new Uint8Array(LARGO_TOKEN_BYTES);
  crypto.getRandomValues(bytes);

  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Valida credenciales y abre sesion.
 *
 * ANTI-ENUMERACION: un usuario inexistente, un usuario sin hash y una password
 * incorrecta devuelven exactamente el mismo `{ ok: false }`. El llamador no
 * puede distinguirlos ni siquiera por accidente, porque no hay nada que
 * distinguir en el valor de retorno.
 */
export async function login(
  env: Env,
  usuario: string,
  password: string,
  ahora: Date = new Date(),
): Promise<ResultadoLogin> {
  const slug = usuario.trim().toLowerCase();
  if (!slug || !password) return { ok: false };

  const cliente = db(env.DB);

  const filas = await cliente
    .select({
      id: barberos.id,
      slug: barberos.slug,
      nombre: barberos.nombre,
      rol: barberos.rol,
      passwordHash: barberos.passwordHash,
    })
    .from(barberos)
    .where(and(eq(barberos.slug, slug), eq(barberos.activo, 1)))
    .limit(1);

  const barbero = filas[0];

  // Ojo: se llama a `verificarPassword` incluso sin barbero, con un hash nulo.
  // Devuelve false sin derivar nada, asi que NO iguala los tiempos — la
  // defensa contra enumeracion es la respuesta identica, no el timing. Un
  // atacante que mida tiempos puede inferir si el usuario existe; para eso
  // esta el rate limit de la 2.6.
  const valida = await verificarPassword(password, barbero?.passwordHash, barbero?.id);
  if (!barbero || !valida) return { ok: false };

  const token = generarToken();
  const expiresAt = new Date(ahora.getTime() + DURACION_SESION_MS);

  await cliente.insert(adminSessions).values({
    id: token,
    barberoId: barbero.id,
    role: barbero.rol,
    createdAt: ahora.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });

  return {
    ok: true,
    token,
    expiresAt,
    usuario: {
      id: barbero.id,
      slug: barbero.slug,
      nombre: barbero.nombre,
      rol: barbero.rol as Rol,
    },
  };
}

/** Sesion vigente por token, o null si no existe o vencio. */
export async function buscarSesion(
  env: Env,
  token: string,
  ahora: Date = new Date(),
): Promise<SesionActiva | null> {
  if (!token) return null;

  const filas = await db(env.DB)
    .select({
      sessionId: adminSessions.id,
      barberoId: adminSessions.barberoId,
      rol: adminSessions.role,
    })
    .from(adminSessions)
    .where(
      and(eq(adminSessions.id, token), gt(adminSessions.expiresAt, ahora.toISOString())),
    )
    .limit(1);

  const fila = filas[0];
  return fila ? { ...fila, rol: fila.rol as Rol } : null;
}

/** Datos publicos del barbero autenticado. */
export async function usuarioDeSesion(
  env: Env,
  barberoId: string,
): Promise<UsuarioAutenticado | null> {
  const filas = await db(env.DB)
    .select({
      id: barberos.id,
      slug: barberos.slug,
      nombre: barberos.nombre,
      rol: barberos.rol,
    })
    .from(barberos)
    .where(and(eq(barberos.id, barberoId), eq(barberos.activo, 1)))
    .limit(1);

  const fila = filas[0];
  return fila ? { ...fila, rol: fila.rol as Rol } : null;
}

/**
 * Cierra la sesion borrando la fila.
 *
 * Borrar la cookie sola no alcanza: el token seguiria siendo valido para
 * cualquiera que lo tenga.
 */
export async function logout(env: Env, token: string): Promise<void> {
  if (!token) return;
  await db(env.DB).delete(adminSessions).where(eq(adminSessions.id, token));
}
