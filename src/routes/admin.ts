import { Hono } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { ok, fail } from '../api';
import { sinCache } from '../middleware/cache';
import { requiereAuth, type VariablesAuth } from '../middleware/auth';
import { limitarFallosPorIp, type VariablesRateLimit } from '../middleware/rate-limit';
import {
  login,
  logout,
  usuarioDeSesion,
  COOKIE_SESION,
  DURACION_SESION_MS,
  ERROR_CREDENCIALES,
  ERROR_NO_AUTORIZADO,
  ERROR_PROHIBIDO,
} from '../services/auth';
import {
  resolverBarbero,
  listarAgenda,
  listarReservas,
  ERROR_AGENDA_AJENA,
  LIMITE_LISTADO_MAX,
} from '../services/agenda';
import {
  cancelarReserva,
  reprogramarReserva,
  crearBloqueo,
  importarReservas,
  MAX_FILAS_IMPORT,
  ERROR_SOLO_OWNER_IMPORT,
  ERROR_SLOT_OCUPADO,
  ERROR_RESERVA_NO_ENCONTRADA,
  ERROR_LOTE_DEMASIADO_GRANDE,
} from '../services/reservas-admin';
import { crearReserva, type EntradaReserva } from '../services/reserva';
import { esFechaValida, esHoraValida } from '../domain/dates';
import {
  listarHorarios,
  reemplazarDia,
  editarBloque,
  buscarBloque,
  validarBloque,
  esDowValido,
  ERROR_DOW,
  ERROR_BLOQUE_NO_ENCONTRADO,
  type EntradaBloque,
} from '../services/horarios';
import {
  listarFeriados,
  guardarOverride,
  buscarOverride,
  borrarOverride,
  ERROR_FERIADO_NO_ENCONTRADO,
} from '../services/feriados';
import { chequearCambioDeHorario, chequearCierreDeFecha } from '../services/conflictos';


/**
 * Panel de administracion. Roles `barbero` y `owner`.
 *
 * Nada de acá se cachea nunca: son datos por usuario y respuestas
 * autenticadas.
 */
export const adminRoutes = new Hono<{
  Bindings: Env;
  Variables: VariablesAuth & VariablesRateLimit;
}>();

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
 * Rate limit: 10 fallos por IP cada 15 min. SOLO se consume en los fallos —
 * un login correcto no gasta cupo, asi que alguien que entra diez veces al dia
 * no se autobloquea.
 */
adminRoutes.post('/auth', limitarFallosPorIp('login'), async (c) => {
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
    // El unico punto donde se gasta cupo. El camino de exito no pasa por acá.
    await c.get('registrarFallo')();
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

// ================================================================ AGENDA

/**
 * ⚠️ EL SCOPING SE RESUELVE UNA SOLA VEZ, ACA.
 *
 * Ningun handler lee `barberoId` de la query por su cuenta: `resolverBarbero`
 * devuelve el barbero objetivo ya decidido, y para un `barbero` ese valor es
 * SIEMPRE el suyo, mande lo que mande en la query.
 */
adminRoutes.get('/agenda', requiereAuth, async (c) => {
  const objetivo = resolverBarbero(c.get('sesion'), c.req.query('barberoId'));
  if (!objetivo.ok) return c.json(fail(ERROR_AGENDA_AJENA), 403);

  const desde = c.req.query('desde');
  const hasta = c.req.query('hasta');

  for (const [nombre, valor] of [['desde', desde], ['hasta', hasta]] as const) {
    if (valor && !esFechaValida(valor)) {
      return c.json(fail(`Formato de fecha inválido en ${nombre}. Usá YYYY-MM-DD.`), 400);
    }
  }

  return c.json(
    ok(await listarAgenda(c.env, { barberoId: objetivo.barberoId, desde, hasta })),
    200,
  );
});

adminRoutes.get('/reservas', requiereAuth, async (c) => {
  const objetivo = resolverBarbero(c.get('sesion'), c.req.query('barberoId'));
  if (!objetivo.ok) return c.json(fail(ERROR_AGENDA_AJENA), 403);

  const numero = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  const skip = numero(c.req.query('skip'));
  const limit = numero(c.req.query('limit'));

  // Estos dos solo los dispara un frontend con un bug, asi que dicen el rango:
  // le ahorran el viaje a la documentacion a quien esté depurando.
  if (skip !== undefined && (!Number.isFinite(skip) || skip < 0)) {
    return c.json(fail('skip inválido. Tiene que ser un número entero mayor o igual a 0.'), 400);
  }
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1 || limit > LIMITE_LISTADO_MAX)) {
    return c.json(
      fail(`limit inválido. Tiene que ser un número entre 1 y ${LIMITE_LISTADO_MAX}.`),
      400,
    );
  }

  return c.json(ok(await listarReservas(c.env, { barberoId: objetivo.barberoId, skip, limit })), 200);
});

// ============================================================== ESCRITURAS

/**
 * Alta desde el panel. `source = 'admin'` y SIN anticipacion minima ni maxima:
 * el barbero carga un turno para dentro de 5 minutos todo el tiempo.
 *
 * El solapamiento si se valida — sale del Durable Object y no se saltea nunca.
 */
adminRoutes.post('/reservas', requiereAuth, async (c) => {
  const cuerpo = await c.req.json().catch(() => null);
  if (!cuerpo || typeof cuerpo !== 'object') {
    return c.json(fail('Formato de solicitud inválido.'), 400);
  }

  const objetivo = resolverBarbero(c.get('sesion'), (cuerpo as { barberoId?: string }).barberoId);
  if (!objetivo.ok) return c.json(fail(ERROR_AGENDA_AJENA), 403);
  const barberoId = objetivo.barberoId ?? c.get('sesion').barberoId;

  const resultado = await crearReserva(c.env, cuerpo as EntradaReserva, {
    modo: 'admin',
    barberoIdForzado: barberoId,
  });

  if (resultado.estado === 'exito') {
    return c.json(ok({ cancelToken: resultado.cancelToken, mensaje: resultado.mensaje }), 200);
  }
  return c.json(fail(resultado.error), 400);
});

adminRoutes.put('/reservas/:id', requiereAuth, async (c) => {
  const cuerpo = await c.req.json().catch(() => null);
  if (!cuerpo || typeof cuerpo !== 'object') {
    return c.json(fail('Formato de solicitud inválido.'), 400);
  }

  const { fecha, hora, servicioId } = cuerpo as {
    fecha?: string;
    hora?: string;
    servicioId?: string;
  };
  if (!fecha || !esFechaValida(fecha)) return c.json(fail('Formato de fecha inválido.'), 400);
  if (!hora) return c.json(fail('Formato de hora inválido. Usá HH:mm.'), 400);

  const r = await reprogramarReserva(c.env, c.get('sesion'), c.req.param('id'), {
    fecha,
    hora,
    ...(servicioId ? { servicioId } : {}),
  });

  switch (r.estado) {
    case 'exito':
      return c.json(ok(null), 200);
    case 'noEncontrada':
      return c.json(fail(ERROR_RESERVA_NO_ENCONTRADA), 404);
    case 'prohibido':
      return c.json(fail(ERROR_PROHIBIDO), 403);
    default:
      return c.json(fail(r.error), 400);
  }
});

adminRoutes.delete('/reservas/:id', requiereAuth, async (c) => {
  const r = await cancelarReserva(c.env, c.get('sesion'), c.req.param('id'));

  if (r.estado === 'noEncontrada') return c.json(fail(ERROR_RESERVA_NO_ENCONTRADA), 404);
  if (r.estado === 'prohibido') return c.json(fail(ERROR_PROHIBIDO), 403);
  return c.json(ok(null), 200);
});

/**
 * Import masivo. Solo `owner`.
 *
 * No usa `requiereOwner`: la spec define un mensaje propio para este caso, mas
 * util que el `Prohibido` generico porque dice QUE hace falta.
 */
adminRoutes.post('/reservas/importar', requiereAuth, async (c) => {
  if (c.get('sesion').rol !== 'owner') {
    return c.json(fail(ERROR_SOLO_OWNER_IMPORT), 403);
  }

  const cuerpo = await c.req.json().catch(() => null);
  const filas = Array.isArray(cuerpo)
    ? cuerpo
    : (cuerpo as { filas?: unknown[] } | null)?.filas;

  if (!Array.isArray(filas)) return c.json(fail('Se esperaba una lista de reservas.'), 400);
  if (filas.length > MAX_FILAS_IMPORT) return c.json(fail(ERROR_LOTE_DEMASIADO_GRANDE), 400);

  return c.json(ok(await importarReservas(c.env, filas)), 200);
});

adminRoutes.post('/bloqueos', requiereAuth, async (c) => {
  const cuerpo = await c.req.json().catch(() => null);
  if (!cuerpo || typeof cuerpo !== 'object') {
    return c.json(fail('Formato de solicitud inválido.'), 400);
  }

  const { fecha, hora, motivo, duracionMin } = cuerpo as {
    fecha?: string;
    hora?: string;
    motivo?: string;
    duracionMin?: number;
  };
  if (!fecha || !esFechaValida(fecha)) return c.json(fail('Formato de fecha inválido.'), 400);
  if (!hora || !esHoraValida(hora)) return c.json(fail('Formato de hora inválido. Usá HH:mm.'), 400);

  const objetivo = resolverBarbero(c.get('sesion'), (cuerpo as { barberoId?: string }).barberoId);
  if (!objetivo.ok) return c.json(fail(ERROR_AGENDA_AJENA), 403);
  const barberoId = objetivo.barberoId ?? c.get('sesion').barberoId;

  const r = await crearBloqueo(c.env, barberoId, {
    fecha,
    hora,
    ...(motivo ? { motivo } : {}),
    ...(typeof duracionMin === 'number' ? { duracionMin } : {}),
  });

  if (r.estado === 'ocupado') return c.json(fail(ERROR_SLOT_OCUPADO), 400);
  if (r.estado === 'error') throw new Error(r.detalle);
  return c.json(ok(null), 200);
});

// ========================================================= HORARIOS (3.1)

/**
 * Cuerpo del 409 de Bloquear+Avisar: el mensaje MAS la lista de turnos.
 *
 * La lista es el punto — un "no se pudo" pelado deja al dueño sin saber qué
 * reagendar.
 */
const cuerpo409 = (chequeo: { mensaje: string; turnos: unknown[] }) =>
  fail(chequeo.mensaje, chequeo.turnos);

adminRoutes.get('/horarios', requiereAuth, async (c) => {
  const objetivo = resolverBarbero(c.get('sesion'), c.req.query('barberoId'));
  if (!objetivo.ok) return c.json(fail(ERROR_AGENDA_AJENA), 403);

  const barberoId = objetivo.barberoId ?? c.get('sesion').barberoId;
  return c.json(ok(await listarHorarios(c.env, barberoId)), 200);
});

/**
 * Reemplaza TODOS los bloques de un dia. Bloquear+Avisar: si algun turno
 * futuro de ese `dow` no entra en los bloques nuevos, 409 con la lista.
 */
adminRoutes.put('/horarios/dia/:dow', requiereAuth, async (c) => {
  const dow = Number(c.req.param('dow'));
  if (!esDowValido(dow)) return c.json(fail(ERROR_DOW), 400);

  const cuerpo = await c.req.json().catch(() => null);
  const bloques = Array.isArray(cuerpo) ? cuerpo : (cuerpo as { bloques?: unknown[] } | null)?.bloques;
  if (!Array.isArray(bloques)) return c.json(fail('Se esperaba una lista de bloques.'), 400);

  for (const b of bloques) {
    const error = validarBloque(b as EntradaBloque);
    if (error) return c.json(fail(error), 400);
  }

  const objetivo = resolverBarbero(c.get('sesion'), (cuerpo as { barberoId?: string })?.barberoId);
  if (!objetivo.ok) return c.json(fail(ERROR_AGENDA_AJENA), 403);
  const barberoId = objetivo.barberoId ?? c.get('sesion').barberoId;

  // Solo cuentan los bloques que quedan ACTIVOS: uno desactivado no cubre nada.
  const activos = (bloques as EntradaBloque[])
    .filter((b) => b.activo !== false)
    .map((b) => ({ inicio: b.horaInicio, fin: b.horaFin }));

  const chequeo = await chequearCambioDeHorario(c.env, barberoId, dow, activos);
  if (chequeo.hayConflicto) return c.json(cuerpo409(chequeo), 409);

  await reemplazarDia(c.env, barberoId, dow, bloques as EntradaBloque[]);
  return c.json(ok(await listarHorarios(c.env, barberoId)), 200);
});

/** Edita un bloque puntual, recalculando el dia entero con el cambio. */
adminRoutes.put('/horarios/:id', requiereAuth, async (c) => {
  const cuerpo = await c.req.json().catch(() => null);
  if (!cuerpo || typeof cuerpo !== 'object') {
    return c.json(fail('Formato de solicitud inválido.'), 400);
  }

  const cambios = cuerpo as EntradaBloque;
  const error = validarBloque(cambios);
  if (error) return c.json(fail(error), 400);

  const bloque = await buscarBloque(c.env, c.req.param('id'));
  if (!bloque) return c.json(fail(ERROR_BLOQUE_NO_ENCONTRADO), 404);

  const sesion = c.get('sesion');
  if (sesion.rol !== 'owner' && bloque.barberoId !== sesion.barberoId) {
    return c.json(fail(ERROR_AGENDA_AJENA), 403);
  }

  // El dia entero DESPUES del cambio: los otros bloques siguen cubriendo.
  const delDia = await listarHorarios(c.env, bloque.barberoId);
  const resultantes = delDia
    .filter((b) => b.dow === bloque.dow)
    .map((b) =>
      b.id === bloque.id
        ? { inicio: cambios.horaInicio, fin: cambios.horaFin, activo: cambios.activo !== false }
        : { inicio: b.horaInicio, fin: b.horaFin, activo: b.activo === 1 },
    )
    .filter((b) => b.activo)
    .map(({ inicio, fin }) => ({ inicio, fin }));

  const chequeo = await chequearCambioDeHorario(c.env, bloque.barberoId, bloque.dow, resultantes);
  if (chequeo.hayConflicto) return c.json(cuerpo409(chequeo), 409);

  await editarBloque(c.env, bloque.id, cambios);
  return c.json(ok(await listarHorarios(c.env, bloque.barberoId)), 200);
});

// ========================================================= FERIADOS (3.1)

adminRoutes.get('/feriados', requiereAuth, async (c) => {
  const anio = Number(c.req.query('anio') ?? new Date().getFullYear());
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) {
    return c.json(fail('Año inválido. Usá un año entre 2000 y 2100.'), 400);
  }

  const objetivo = resolverBarbero(c.get('sesion'), c.req.query('barberoId'));
  if (!objetivo.ok) return c.json(fail(ERROR_AGENDA_AJENA), 403);
  const barberoId = objetivo.barberoId ?? c.get('sesion').barberoId;

  return c.json(ok(await listarFeriados(c.env, barberoId, anio)), 200);
});

/**
 * Upsert de override. Bloquear+Avisar solo al CERRAR: abrir una fecha no deja
 * ningun turno huerfano.
 */
adminRoutes.post('/feriados', requiereAuth, async (c) => {
  const cuerpo = await c.req.json().catch(() => null);
  if (!cuerpo || typeof cuerpo !== 'object') {
    return c.json(fail('Formato de solicitud inválido.'), 400);
  }

  const { fecha, trabaja, motivo } = cuerpo as {
    fecha?: string;
    trabaja?: boolean;
    motivo?: string;
  };
  if (!fecha || !esFechaValida(fecha)) {
    return c.json(fail('Formato de fecha inválido. Usá YYYY-MM-DD.'), 400);
  }
  if (typeof trabaja !== 'boolean') {
    return c.json(fail('trabaja es obligatorio y tiene que ser true o false.'), 400);
  }

  const objetivo = resolverBarbero(c.get('sesion'), (cuerpo as { barberoId?: string }).barberoId);
  if (!objetivo.ok) return c.json(fail(ERROR_AGENDA_AJENA), 403);
  const barberoId = objetivo.barberoId ?? c.get('sesion').barberoId;

  if (!trabaja) {
    const chequeo = await chequearCierreDeFecha(c.env, barberoId, fecha);
    if (chequeo.hayConflicto) return c.json(cuerpo409(chequeo), 409);
  }

  return c.json(
    ok(await guardarOverride(c.env, barberoId, { fecha, trabaja, motivo })),
    200,
  );
});

adminRoutes.delete('/feriados/:id', requiereAuth, async (c) => {
  const override = await buscarOverride(c.env, c.req.param('id'));
  if (!override) return c.json(fail(ERROR_FERIADO_NO_ENCONTRADO), 404);

  const sesion = c.get('sesion');
  if (sesion.rol !== 'owner' && override.barberoId !== sesion.barberoId) {
    return c.json(fail(ERROR_AGENDA_AJENA), 403);
  }

  await borrarOverride(c.env, override.id);
  return c.json(ok(null), 200);
});

export { DURACION_SESION_MS };
