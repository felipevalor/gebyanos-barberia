import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { fail } from '../api';
import {
  buscarSesion,
  COOKIE_SESION,
  ERROR_NO_AUTORIZADO,
  ERROR_PROHIBIDO,
  type Rol,
  type SesionActiva,
} from '../services/auth';

/**
 * Autenticacion del panel.
 *
 * ⚠️ LEE SOLO LA COOKIE. El header `Authorization: Bearer` se ignora A
 * PROPOSITO — no es un olvido, es la mitigacion de XSS del disenio:
 *
 *   - la cookie es HttpOnly, asi que un script inyectado no puede leerla;
 *   - y aunque consiguiera el token por otra via, no puede reenviarlo como
 *     header porque el backend no acepta esa vuelta.
 *
 * Aceptar Bearer "por comodidad" anula las dos mitades de esa proteccion.
 */

export interface VariablesAuth {
  sesion: SesionActiva;
}

/** Exige sesion valida. Deja `sesion` en el contexto. */
export const requiereAuth = createMiddleware<{
  Bindings: Env;
  Variables: VariablesAuth;
}>(async (c, next) => {
  const token = getCookie(c, COOKIE_SESION);

  const sesion = token ? await buscarSesion(c.env, token) : null;
  if (!sesion) return c.json(fail(ERROR_NO_AUTORIZADO), 401);

  c.set('sesion', sesion);
  await next();
});

/**
 * Exige rol `owner`. Va DESPUES de `requiereAuth`.
 *
 * 🐛 El sistema viejo devuelve 401 en los chequeos de "solo owner", que es
 * incorrecto: el usuario esta autenticado, lo que le falta es permiso. Va 403.
 */
export const requiereOwner = createMiddleware<{
  Bindings: Env;
  Variables: VariablesAuth;
}>(async (c, next) => {
  const sesion = c.get('sesion') as SesionActiva | undefined;

  if (!sesion) return c.json(fail(ERROR_NO_AUTORIZADO), 401);
  if (sesion.rol !== ('owner' satisfies Rol)) return c.json(fail(ERROR_PROHIBIDO), 403);

  await next();
});
