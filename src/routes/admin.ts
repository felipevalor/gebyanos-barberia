import { Hono } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { ok, fail } from '../api';
import { sinCache } from '../middleware/cache';
import { requiereAuth, type VariablesAuth } from '../middleware/auth';
import {
  login,
  logout,
  usuarioDeSesion,
  COOKIE_SESION,
  DURACION_SESION_MS,
  ERROR_CREDENCIALES,
  ERROR_NO_AUTORIZADO,
} from '../services/auth';

/**
 * Panel de administracion. Roles `barbero` y `owner`.
 *
 * Nada de acá se cachea nunca: son datos por usuario y respuestas
 * autenticadas.
 */
export const adminRoutes = new Hono<{ Bindings: Env; Variables: VariablesAuth }>();

const noCachear = sinCache();

adminRoutes.use('*', noCachear);

/**
 * Opciones de la cookie de sesion. Las mismas en el alta y en el borrado: si
 * difieren en Path o SameSite, el navegador no la borra y la sesion "vuelve".
 */
const opcionesCookie = {
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  path: '/',
} as const;

// ------------------------------------------------------------------- login

/**
 * `POST /api/admin/auth`
 *
 * Rate limit: 10 fallos por IP en 15 min, y SOLO se consume en los fallos —
 * un login correcto no gasta cupo. Se cablea en la tarea 2.6; el punto de
 * enganche es el `return` de credenciales invalidas de mas abajo.
 */
adminRoutes.post('/auth', async (c) => {
  const cuerpo = await c.req.json().catch(() => null);
  if (!cuerpo || typeof cuerpo !== 'object') {
    return c.json(fail('Formato de solicitud inválido.'), 400);
  }

  const { usuario, password } = cuerpo as { usuario?: unknown; password?: unknown };
  const resultado = await login(
    c.env,
    typeof usuario === 'string' ? usuario : '',
    typeof password === 'string' ? password : '',
  );

  if (!resultado.ok) {
    // 🔒 SEAM 2.6: acá se consume el cupo del rate limit. Solo acá — el camino
    // de exito no pasa por este return.
    return c.json(fail(ERROR_CREDENCIALES), 401);
  }

  setCookie(c, COOKIE_SESION, resultado.token, {
    ...opcionesCookie,
    expires: resultado.expiresAt,
  });

  // El token NUNCA va en el body. Viaja solo en la cookie HttpOnly.
  return c.json(ok({ user: resultado.usuario }), 200);
});

// ------------------------------------------------------------------ logout

/**
 * `DELETE /api/admin/auth`
 *
 * Lee el token DIRECTO de la cookie, no del contexto: si la sesion ya vencio,
 * `requiereAuth` daria 401 y la fila quedaria colgada en la base para siempre.
 * Por eso esta ruta no exige auth y responde ok siempre.
 */
adminRoutes.delete('/auth', async (c) => {
  const token = getCookie(c, COOKIE_SESION);
  if (token) await logout(c.env, token);

  deleteCookie(c, COOKIE_SESION, opcionesCookie);
  return c.json(ok(null), 200);
});

// ---------------------------------------------------------------------- me

adminRoutes.get('/me', requiereAuth, async (c) => {
  const usuario = await usuarioDeSesion(c.env, c.get('sesion').barberoId);

  // La sesion existe pero el barbero se desactivo o se borro: la sesion ya no
  // vale nada.
  if (!usuario) return c.json(fail(ERROR_NO_AUTORIZADO), 401);

  return c.json(ok(usuario), 200);
});

export { DURACION_SESION_MS };
