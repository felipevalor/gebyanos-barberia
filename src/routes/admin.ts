import { Hono } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { ok, fail } from '../api';
import { sinCache } from '../middleware/cache';
import { requiereAuth, requiereOwner, type VariablesAuth } from '../middleware/auth';
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
import {
  listarClientes,
  clientesParaExportar,
  buscarCliente,
  historialDeCliente,
  crearCliente,
  importarClientes,
  clientesACsv,
  LIMITE_LISTADO as LIMITE_LISTADO_CLIENTES,
  MAX_FILAS_IMPORT_CLIENTES,
  ERROR_CLIENTE_NO_ENCONTRADO,
  ERROR_SOLO_OWNER_CLIENTES,
  ERROR_SOLO_OWNER_IMPORT_CLIENTES,
  ERROR_LOTE_CLIENTES,
} from '../services/clientes';
import {
  listarBarberos,
  buscarBarbero,
  crearBarbero,
  actualizarBarbero,
  borrarBarbero,
  esUltimoOwner,
  type EntradaBarbero,
  ERROR_BARBERO_NO_ENCONTRADO,
  ERROR_SLUG_DUPLICADO,
  ERROR_ULTIMO_OWNER_DESACTIVAR,
  ERROR_ULTIMO_OWNER_BORRAR,
  ERROR_ULTIMO_OWNER_ROL,
} from '../services/barberos';
import {
  listarServicios,
  buscarServicio,
  crearServicio,
  actualizarServicio,
  borrarServicio,
  type EntradaServicio,
  ERROR_SERVICIO_NO_ENCONTRADO,
  ERROR_SERVICIO_DUPLICADO,
  AVISO_DURACION_CAMBIADA,
} from '../services/servicios';
import {
  listarPromos,
  buscarPromo,
  crearPromo,
  actualizarPromo,
  borrarPromo,
  listarCatalogo,
  buscarItemCatalogo,
  crearItemCatalogo,
  actualizarItemCatalogo,
  borrarItemCatalogo,
  type EntradaPromo,
  type EntradaCatalogo,
  ERROR_PROMO_NO_ENCONTRADA,
  ERROR_ITEM_NO_ENCONTRADO,
} from '../services/vidriera';
import {
  leerNegocio,
  actualizarNegocio,
  type EntradaNegocio,
  ERROR_SIN_CONFIGURACION,
  AVISO_SLOT_CAMBIADO,
} from '../services/negocio';
import { calcularStats } from '../services/stats';
import {
  listarAvisosFallidos,
  descartarAvisoFallido,
} from '../services/notificaciones';
import {
  leerConfig,
  guardarConfig,
  probarEnvio,
  type EntradaCallmebot,
  ERROR_BARBERO_NO_ENCONTRADO as ERROR_BARBERO_CALLMEBOT,
  ERROR_SIN_CONFIGURACION as ERROR_CALLMEBOT_SIN_CONFIG,
} from '../services/callmebot';
import { chequearDesactivarBarbero, chequearBorrarBarbero } from '../services/conflictos';
import { todayArgentina } from '../domain/dates';


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

// ========================================================= CLIENTES (3.3)

adminRoutes.get('/clientes', requiereAuth, async (c) => {
  const objetivo = resolverBarbero(c.get('sesion'), c.req.query('barberoId'));
  if (!objetivo.ok) return c.json(fail(ERROR_AGENDA_AJENA), 403);

  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  const skip = num(c.req.query('skip'));
  const limit = num(c.req.query('limit'));

  if (skip !== undefined && (!Number.isFinite(skip) || skip < 0)) {
    return c.json(fail('skip inválido. Tiene que ser un número entero mayor o igual a 0.'), 400);
  }
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1 || limit > LIMITE_LISTADO_CLIENTES)) {
    return c.json(
      fail(`limit inválido. Tiene que ser un número entre 1 y ${LIMITE_LISTADO_CLIENTES}.`),
      400,
    );
  }

  return c.json(ok(await listarClientes(c.env, { barberoId: objetivo.barberoId, skip, limit })), 200);
});

/**
 * Export CSV. Va ANTES de `/clientes/:id` — si no, Hono matchearia "exportar"
 * como un id.
 */
adminRoutes.get('/clientes/exportar', requiereAuth, async (c) => {
  const objetivo = resolverBarbero(c.get('sesion'), c.req.query('barberoId'));
  if (!objetivo.ok) return c.json(fail(ERROR_AGENDA_AJENA), 403);

  const lista = await clientesParaExportar(c.env, objetivo.barberoId);
  const hoy = todayArgentina();

  return new Response(clientesACsv(lista), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="clientes-${hoy}.csv"`,
      'cache-control': 'no-store',
    },
  });
});

adminRoutes.get('/clientes/:id/historial', requiereAuth, async (c) => {
  const objetivo = resolverBarbero(c.get('sesion'), c.req.query('barberoId'));
  if (!objetivo.ok) return c.json(fail(ERROR_AGENDA_AJENA), 403);

  const cliente = await buscarCliente(c.env, c.req.param('id'), objetivo.barberoId);
  if (!cliente) return c.json(fail(ERROR_CLIENTE_NO_ENCONTRADO), 404);

  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));

  return c.json(
    ok(
      await historialDeCliente(c.env, cliente.id, {
        barberoId: objetivo.barberoId,
        skip: num(c.req.query('skip')),
        limit: num(c.req.query('limit')),
      }),
    ),
    200,
  );
});

adminRoutes.post('/clientes', requiereAuth, async (c) => {
  if (c.get('sesion').rol !== 'owner') {
    return c.json(fail(ERROR_SOLO_OWNER_CLIENTES), 403);
  }

  const cuerpo = await c.req.json().catch(() => null);
  if (!cuerpo || typeof cuerpo !== 'object') {
    return c.json(fail('Formato de solicitud inválido.'), 400);
  }

  const r = await crearCliente(c.env, cuerpo as Record<string, unknown>);
  if (r.estado === 'exito') return c.json(ok(r.cliente), 200);
  return c.json(fail(r.error), 400);
});

adminRoutes.post('/clientes/importar', requiereAuth, async (c) => {
  if (c.get('sesion').rol !== 'owner') {
    return c.json(fail(ERROR_SOLO_OWNER_IMPORT_CLIENTES), 403);
  }

  const cuerpo = await c.req.json().catch(() => null);
  const filas = Array.isArray(cuerpo) ? cuerpo : (cuerpo as { filas?: unknown[] } | null)?.filas;

  if (!Array.isArray(filas)) return c.json(fail('Se esperaba una lista de clientes.'), 400);
  if (filas.length > MAX_FILAS_IMPORT_CLIENTES) return c.json(fail(ERROR_LOTE_CLIENTES), 400);

  return c.json(ok(await importarClientes(c.env, filas)), 200);
});

// ========================================== CATALOGOS Y CONFIGURACION (3.4)

/**
 * De acá para abajo, TODO es de `owner` salvo `GET /negocio` y `GET /stats`.
 *
 * 🐛 EL CHEQUEO DEVUELVE 403, NO 401. El sistema viejo usa 401 y esta mal: el
 * usuario esta autenticado —la sesion es valida— lo que le falta es permiso.
 * Un 401 le dice al frontend "volvé a loguearte", y volver a loguearse no
 * cambia nada: el barbero sigue sin ser dueño y el panel lo manda al login en
 * loop.
 */

const cuerpoJson = async (c: { req: { json: () => Promise<unknown> } }) =>
  c.req.json().catch(() => null);

// ---------------------------------------------------------------- barberos

adminRoutes.get('/barberos', requiereAuth, requiereOwner, async (c) =>
  c.json(ok(await listarBarberos(c.env)), 200),
);

adminRoutes.post('/barberos', requiereAuth, requiereOwner, async (c) => {
  const cuerpo = await cuerpoJson(c);
  if (!cuerpo || typeof cuerpo !== 'object') {
    return c.json(fail('Formato de solicitud inválido.'), 400);
  }

  const r = await crearBarbero(c.env, cuerpo as EntradaBarbero);
  if (r.estado === 'duplicado') return c.json(fail(ERROR_SLUG_DUPLICADO), 400);
  if (r.estado === 'error') return c.json(fail(r.error), 400);

  return c.json(ok(r.barbero), 200);
});

/**
 * Edicion. Tres cosas pueden dejar el panel sin dueño y las tres se frenan acá:
 * desactivar al ultimo owner, degradarlo a barbero, y —via Bloquear+Avisar—
 * desactivar a cualquiera que tenga turnos futuros.
 */
adminRoutes.put('/barberos/:id', requiereAuth, requiereOwner, async (c) => {
  const cuerpo = await cuerpoJson(c);
  if (!cuerpo || typeof cuerpo !== 'object') {
    return c.json(fail('Formato de solicitud inválido.'), 400);
  }

  const id = c.req.param('id');
  const actual = await buscarBarbero(c.env, id);
  if (!actual) return c.json(fail(ERROR_BARBERO_NO_ENCONTRADO), 404);

  const entrada = cuerpo as EntradaBarbero;
  const desactivando = entrada.activo === false && actual.activo === 1;
  const degradando = entrada.rol !== undefined && entrada.rol !== 'owner' && actual.rol === 'owner';

  if (desactivando || degradando) {
    if (await esUltimoOwner(c.env, id)) {
      return c.json(
        fail(desactivando ? ERROR_ULTIMO_OWNER_DESACTIVAR : ERROR_ULTIMO_OWNER_ROL),
        409,
      );
    }
  }

  if (desactivando) {
    const chequeo = await chequearDesactivarBarbero(c.env, id);
    if (chequeo.hayConflicto) return c.json(cuerpo409(chequeo), 409);
  }

  const r = await actualizarBarbero(c.env, id, entrada);
  if (r.estado === 'duplicado') return c.json(fail(ERROR_SLUG_DUPLICADO), 400);
  if (r.estado === 'error') return c.json(fail(r.error), 400);

  return c.json(ok(r.barbero), 200);
});

adminRoutes.delete('/barberos/:id', requiereAuth, requiereOwner, async (c) => {
  const id = c.req.param('id');
  const actual = await buscarBarbero(c.env, id);
  if (!actual) return c.json(fail(ERROR_BARBERO_NO_ENCONTRADO), 404);

  if (await esUltimoOwner(c.env, id)) {
    return c.json(fail(ERROR_ULTIMO_OWNER_BORRAR), 409);
  }

  const chequeo = await chequearBorrarBarbero(c.env, id);
  if (chequeo.hayConflicto) return c.json(cuerpo409(chequeo), 409);

  await borrarBarbero(c.env, id);
  return c.json(ok(null), 200);
});

// --------------------------------------------------------------- servicios

adminRoutes.get('/servicios', requiereAuth, requiereOwner, async (c) =>
  c.json(ok(await listarServicios(c.env)), 200),
);

adminRoutes.post('/servicios', requiereAuth, requiereOwner, async (c) => {
  const cuerpo = await cuerpoJson(c);
  if (!cuerpo || typeof cuerpo !== 'object') {
    return c.json(fail('Formato de solicitud inválido.'), 400);
  }

  const r = await crearServicio(c.env, cuerpo as EntradaServicio);
  if (r.estado === 'duplicado') return c.json(fail(ERROR_SERVICIO_DUPLICADO), 400);
  if (r.estado === 'error') return c.json(fail(r.error), 400);

  return c.json(ok(r.servicio), 200);
});

/**
 * ⚠️ Si cambia `duracionMin`, la respuesta trae `warning`.
 *
 * Cambiar la duracion NO toca los turnos ya agendados: cada reserva guarda su
 * propia copia. El panel TIENE que mostrar ese warning — sin él, quien alarga
 * el corte de 30 a 45 minutos se queda esperando que la agenda de mañana se
 * reacomode sola, y no va a pasar.
 */
adminRoutes.put('/servicios/:id', requiereAuth, requiereOwner, async (c) => {
  const cuerpo = await cuerpoJson(c);
  if (!cuerpo || typeof cuerpo !== 'object') {
    return c.json(fail('Formato de solicitud inválido.'), 400);
  }

  const r = await actualizarServicio(c.env, c.req.param('id'), cuerpo as EntradaServicio);
  if (r.estado === 'duplicado') return c.json(fail(ERROR_SERVICIO_DUPLICADO), 400);
  if (r.estado === 'error') {
    const status = r.error === ERROR_SERVICIO_NO_ENCONTRADO ? 404 : 400;
    return c.json(fail(r.error), status);
  }

  return c.json(ok(r.servicio, r.duracionCambiada ? AVISO_DURACION_CAMBIADA : undefined), 200);
});

adminRoutes.delete('/servicios/:id', requiereAuth, requiereOwner, async (c) => {
  const id = c.req.param('id');
  if (!(await buscarServicio(c.env, id))) {
    return c.json(fail(ERROR_SERVICIO_NO_ENCONTRADO), 404);
  }

  await borrarServicio(c.env, id);
  return c.json(ok(null), 200);
});

// ------------------------------------------------------------------ promos

adminRoutes.get('/promos', requiereAuth, requiereOwner, async (c) =>
  c.json(ok(await listarPromos(c.env)), 200),
);

adminRoutes.post('/promos', requiereAuth, requiereOwner, async (c) => {
  const cuerpo = await cuerpoJson(c);
  if (!cuerpo || typeof cuerpo !== 'object') {
    return c.json(fail('Formato de solicitud inválido.'), 400);
  }

  const r = await crearPromo(c.env, cuerpo as EntradaPromo);
  return r.estado === 'exito' ? c.json(ok(r.item), 200) : c.json(fail(r.error), 400);
});

adminRoutes.put('/promos/:id', requiereAuth, requiereOwner, async (c) => {
  const cuerpo = await cuerpoJson(c);
  if (!cuerpo || typeof cuerpo !== 'object') {
    return c.json(fail('Formato de solicitud inválido.'), 400);
  }

  const id = c.req.param('id');
  if (!(await buscarPromo(c.env, id))) return c.json(fail(ERROR_PROMO_NO_ENCONTRADA), 404);

  const r = await actualizarPromo(c.env, id, cuerpo as EntradaPromo);
  return r.estado === 'exito' ? c.json(ok(r.item), 200) : c.json(fail(r.error), 400);
});

adminRoutes.delete('/promos/:id', requiereAuth, requiereOwner, async (c) => {
  const id = c.req.param('id');
  if (!(await buscarPromo(c.env, id))) return c.json(fail(ERROR_PROMO_NO_ENCONTRADA), 404);

  await borrarPromo(c.env, id);
  return c.json(ok(null), 200);
});

// ---------------------------------------------------------------- catalogo

adminRoutes.get('/catalogo', requiereAuth, requiereOwner, async (c) =>
  c.json(ok(await listarCatalogo(c.env)), 200),
);

adminRoutes.post('/catalogo', requiereAuth, requiereOwner, async (c) => {
  const cuerpo = await cuerpoJson(c);
  if (!cuerpo || typeof cuerpo !== 'object') {
    return c.json(fail('Formato de solicitud inválido.'), 400);
  }

  const r = await crearItemCatalogo(c.env, cuerpo as EntradaCatalogo);
  return r.estado === 'exito' ? c.json(ok(r.item), 200) : c.json(fail(r.error), 400);
});

adminRoutes.put('/catalogo/:id', requiereAuth, requiereOwner, async (c) => {
  const cuerpo = await cuerpoJson(c);
  if (!cuerpo || typeof cuerpo !== 'object') {
    return c.json(fail('Formato de solicitud inválido.'), 400);
  }

  const id = c.req.param('id');
  if (!(await buscarItemCatalogo(c.env, id))) return c.json(fail(ERROR_ITEM_NO_ENCONTRADO), 404);

  const r = await actualizarItemCatalogo(c.env, id, cuerpo as EntradaCatalogo);
  return r.estado === 'exito' ? c.json(ok(r.item), 200) : c.json(fail(r.error), 400);
});

adminRoutes.delete('/catalogo/:id', requiereAuth, requiereOwner, async (c) => {
  const id = c.req.param('id');
  if (!(await buscarItemCatalogo(c.env, id))) return c.json(fail(ERROR_ITEM_NO_ENCONTRADO), 404);

  await borrarItemCatalogo(c.env, id);
  return c.json(ok(null), 200);
});

// ----------------------------------------------------------------- negocio

/** Leerla la necesita CUALQUIER usuario: el panel arranca con esta config. */
adminRoutes.get('/negocio', requiereAuth, async (c) => {
  const config = await leerNegocio(c.env);
  if (!config) return c.json(fail(ERROR_SIN_CONFIGURACION), 404);

  return c.json(ok(config), 200);
});

adminRoutes.put('/negocio', requiereAuth, requiereOwner, async (c) => {
  const cuerpo = await cuerpoJson(c);
  if (!cuerpo || typeof cuerpo !== 'object') {
    return c.json(fail('Formato de solicitud inválido.'), 400);
  }

  const r = await actualizarNegocio(c.env, cuerpo as EntradaNegocio);
  if (r.estado === 'error') {
    const status = r.error === ERROR_SIN_CONFIGURACION ? 404 : 400;
    return c.json(fail(r.error), status);
  }

  return c.json(ok(r.negocio, r.slotCambiado ? AVISO_SLOT_CAMBIADO : undefined), 200);
});

// ------------------------------------------------------------------- stats

/** Scoped igual que la agenda: un `barbero` cuenta lo suyo y nada mas. */
adminRoutes.get('/stats', requiereAuth, async (c) => {
  const objetivo = resolverBarbero(c.get('sesion'), c.req.query('barberoId'));
  if (!objetivo.ok) return c.json(fail(ERROR_AGENDA_AJENA), 403);

  return c.json(ok(await calcularStats(c.env, objetivo.barberoId)), 200);
});

// ------------------------------------------------- avisos fallidos (4.2)

/**
 * Los avisos de WhatsApp que no salieron despues de agotar los reintentos.
 *
 * Es una pantalla de DIAGNOSTICO: el `motivo` es el texto crudo de CallMeBot,
 * porque "not registered" y "apikey invalid" se arreglan de maneras distintas
 * y un "falló" generico no le sirve a nadie.
 */
adminRoutes.get('/avisos-fallidos', requiereAuth, async (c) => {
  const objetivo = resolverBarbero(c.get('sesion'), c.req.query('barberoId'));
  if (!objetivo.ok) return c.json(fail(ERROR_AGENDA_AJENA), 403);

  return c.json(ok(await listarAvisosFallidos(c.env, objetivo.barberoId)), 200);
});

/** Descartar = borrar. Es un tablero de pendientes, no un historial. */
adminRoutes.delete('/avisos-fallidos/:id', requiereAuth, async (c) => {
  const sesion = c.get('sesion');
  const alcance = sesion.rol === 'owner' ? null : sesion.barberoId;

  const borrado = await descartarAvisoFallido(c.env, c.req.param('id'), alcance);
  if (!borrado) return c.json(fail('Aviso no encontrado.'), 404);

  return c.json(ok(null), 200);
});

// ------------------------------------------------------- CallMeBot (4.3)

/**
 * Configuracion de WhatsApp por barbero.
 *
 * Scoped como la agenda: un barbero configura la suya, el owner la de
 * cualquiera. ⚠️ La API KEY NUNCA sale en la respuesta — solo `tieneApikey` y
 * una pista de cuatro caracteres.
 */
adminRoutes.get('/callmebot', requiereAuth, async (c) => {
  const objetivo = resolverBarbero(c.get('sesion'), c.req.query('barberoId'));
  if (!objetivo.ok) return c.json(fail(ERROR_AGENDA_AJENA), 403);

  const barberoId = objetivo.barberoId ?? c.get('sesion').barberoId;
  const config = await leerConfig(c.env, barberoId);

  if (!config) return c.json(fail(ERROR_BARBERO_CALLMEBOT), 404);
  return c.json(ok(config), 200);
});

adminRoutes.put('/callmebot', requiereAuth, async (c) => {
  const cuerpo = await cuerpoJson(c);
  if (!cuerpo || typeof cuerpo !== 'object') {
    return c.json(fail('Formato de solicitud inválido.'), 400);
  }

  const objetivo = resolverBarbero(c.get('sesion'), (cuerpo as { barberoId?: string }).barberoId);
  if (!objetivo.ok) return c.json(fail(ERROR_AGENDA_AJENA), 403);
  const barberoId = objetivo.barberoId ?? c.get('sesion').barberoId;

  const r = await guardarConfig(c.env, barberoId, cuerpo as EntradaCallmebot);

  if (r.estado === 'noEncontrado') return c.json(fail(ERROR_BARBERO_CALLMEBOT), 404);
  if (r.estado === 'error') return c.json(fail(r.error), 400);
  return c.json(ok(r.config), 200);
});

/**
 * Manda un mensaje de prueba y devuelve el ERROR REAL de CallMeBot.
 *
 * Es la herramienta de diagnostico del barbero: tiene que poder leer
 * "APIKey is invalid" y no un "no se pudo enviar" que no le dice qué arreglar.
 */
adminRoutes.post('/callmebot/test', requiereAuth, async (c) => {
  const objetivo = resolverBarbero(c.get('sesion'), c.req.query('barberoId'));
  if (!objetivo.ok) return c.json(fail(ERROR_AGENDA_AJENA), 403);

  const barberoId = objetivo.barberoId ?? c.get('sesion').barberoId;
  const r = await probarEnvio(c.env, barberoId);

  switch (r.estado) {
    case 'enviado':
      return c.json(ok({ enviado: true }), 200);
    case 'sinConfigurar':
      return c.json(fail(ERROR_CALLMEBOT_SIN_CONFIG), 400);
    case 'noEncontrado':
      return c.json(fail(ERROR_BARBERO_CALLMEBOT), 404);
    default:
      // 200 con `enviado: false`: la operacion de diagnostico funciono, lo que
      // fallo es el envio. Un 500 haria pensar que se rompio el panel.
      return c.json(ok({ enviado: false, motivo: r.motivo }), 200);
  }
});

export { DURACION_SESION_MS };
