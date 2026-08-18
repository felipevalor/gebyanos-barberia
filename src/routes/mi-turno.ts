import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { reservas } from '../db/schema';
import { ok, fail } from '../api';
import { sinCache } from '../middleware/cache';
import { limitarPorIp } from '../middleware/rate-limit';
import { emitirToken, validarToken, revocarTokensDe, ERRORES } from '../services/magic-link';
import {
  buscarPorTelefono,
  buscarTurno,
  esDuenioDelTurno,
  ERROR_TELEFONO_REQUERIDO,
  ERROR_NO_AUTORIZADO,
  ERROR_TURNO_NO_ENCONTRADO,
  ERROR_CANCELAR_PASADO,
  ERROR_EDITAR_PASADO,
  ERROR_FECHA_PASADA,
  ERROR_SLOT_OCUPADO,
} from '../services/mi-turno';
import { esFechaValida, esHoraValida, todayArgentina } from '../domain/dates';
import { sincronizarCancelacion, sincronizarReprogramacion, sinRomper } from '../services/calendario-reservas';
import { avisarCambio } from '../services/notificaciones';
import { NOTAS } from '../services/whatsapp';

/**
 * Autogestion del cliente sin cuenta, via magic link firmado. Tarea 5.1.
 *
 * ⚠️ LOS RATE LIMITS DE ACA NO SON UN EXTRA: SON LA DEFENSA PRINCIPAL.
 *
 * El telefono es toda la credencial, asi que lo unico que impide probar
 * numeros a escala es el cupo por IP. Los limites por endpoint salen de la
 * spec y estan calibrados por lo que cuesta el abuso, no por comodidad:
 * consultar (30) es barato, emitir un link (20) revela si un telefono tiene
 * turno, y cancelar (10) es irreversible.
 */
export const miTurnoRoutes = new Hono<{ Bindings: Env }>();

miTurnoRoutes.use('*', sinCache());

/** El 401 de un token invalido, con el motivo exacto del paso que fallo. */
const rechazo = (motivo: string) => fail(motivo);

// ------------------------------------------------------------- buscar

miTurnoRoutes.post('/buscar', limitarPorIp('mi-turno-buscar', 10), async (c) => {
  const cuerpo = await c.req.json().catch(() => null);
  const telefono = (cuerpo as { telefono?: unknown } | null)?.telefono;

  if (typeof telefono !== 'string' || telefono.trim() === '') {
    return c.json(fail(ERROR_TELEFONO_REQUERIDO), 400);
  }

  // Devuelve SOLO lo necesario para identificar el turno y pedir el link.
  // Nunca el cancel_token: ver el docstring de `TurnoDelCliente`.
  return c.json(ok(await buscarPorTelefono(c.env, telefono)), 200);
});

// -------------------------------------------------------- access-link

miTurnoRoutes.post('/access-link', limitarPorIp('mi-turno-link', 20), async (c) => {
  const cuerpo = await c.req.json().catch(() => null);
  const { reservaId, telefono } = (cuerpo ?? {}) as { reservaId?: unknown; telefono?: unknown };

  if (typeof telefono !== 'string' || telefono.trim() === '') {
    return c.json(fail(ERROR_TELEFONO_REQUERIDO), 400);
  }
  if (typeof reservaId !== 'string' || reservaId.trim() === '') {
    return c.json(fail(ERROR_TURNO_NO_ENCONTRADO), 404);
  }

  /**
   * ⚠️ El mismo 401 para "no es tuyo" y para "no existe".
   *
   * Distinguirlos convertiria este endpoint en un oraculo de qué reservas
   * existen. Con el telefono como unica credencial, esa diferencia es
   * justamente lo que no se puede regalar.
   */
  if (!(await esDuenioDelTurno(c.env, reservaId, telefono))) {
    return c.json(fail(ERROR_NO_AUTORIZADO), 401);
  }

  const emitido = await emitirToken(c.env, reservaId, 'access');
  return c.json(ok({ token: emitido.token, expiraEn: emitido.expiraEn.toISOString() }), 200);
});

// ----------------------------------------------------------- ver turno

miTurnoRoutes.get('/', limitarPorIp('mi-turno-ver', 30), async (c) => {
  // MULTI-USO: el cliente tiene que poder refrescar la pantalla sin quemar
  // el link.
  const v = await validarToken(c.env, c.req.query('token'));
  if (!v.ok) return c.json(rechazo(v.motivo), 401);

  const turno = await buscarTurno(c.env, v.payload.rid);
  if (!turno) return c.json(fail(ERROR_TURNO_NO_ENCONTRADO), 404);

  return c.json(ok(turno), 200);
});

// --------------------------------------------------------- reprogramar

miTurnoRoutes.put('/', limitarPorIp('mi-turno-editar', 10), async (c) => {
  const v = await validarToken(c.env, c.req.query('token'));
  if (!v.ok) return c.json(rechazo(v.motivo), 401);

  const cuerpo = await c.req.json().catch(() => null);
  const { fecha, hora } = (cuerpo ?? {}) as { fecha?: unknown; hora?: unknown };

  if (typeof fecha !== 'string' || !esFechaValida(fecha)) {
    return c.json(fail('Formato de fecha inválido.'), 400);
  }
  if (typeof hora !== 'string' || !esHoraValida(hora)) {
    return c.json(fail('Formato de hora inválido. Usá HH:mm.'), 400);
  }

  const turno = await buscarTurno(c.env, v.payload.rid);
  if (!turno || turno.estado !== 'activa') return c.json(fail(ERROR_TURNO_NO_ENCONTRADO), 404);

  const hoy = todayArgentina();
  if (fecha < hoy) return c.json(fail(ERROR_FECHA_PASADA), 400);
  if (turno.fecha < hoy) return c.json(fail(ERROR_EDITAR_PASADO), 400);
  if (!turno.barberoId) return c.json(fail(ERROR_TURNO_NO_ENCONTRADO), 404);

  /**
   * ⚠️ EL DURABLE OBJECT EXCLUYE LA PROPIA RESERVA DEL CHEQUEO.
   *
   * Es donde se equivoca todo el mundo: sin excluirla, mover un turno a su
   * mismo horario —o a uno solapado consigo mismo— choca contra el turno que
   * se esta moviendo, y el cliente ve "ese horario ya esta ocupado" señalando
   * su propio turno.
   */
  const agenda = c.env.BARBERO_AGENDA.get(c.env.BARBERO_AGENDA.idFromName(turno.barberoId));
  const r = await agenda.reprogramar({
    reservaId: turno.id,
    barberoId: turno.barberoId,
    fecha,
    hora,
    duracionMin: turno.duracionMin,
  });

  if (r.estado === 'overlap') return c.json(fail(ERROR_SLOT_OCUPADO), 409);
  if (r.estado !== 'exito') return c.json(fail(ERROR_TURNO_NO_ENCONTRADO), 404);

  await sinRomper('mi-turno-calendario', turno.id, () =>
    sincronizarReprogramacion(c.env, turno.id),
  );
  await sinRomper('mi-turno-aviso', turno.id, () =>
    avisarCambio(c.env, turno.id, 'modificada', NOTAS.reagendadaCliente),
  );

  return c.json(ok(await buscarTurno(c.env, turno.id)), 200);
});

// ------------------------------------------------------------ cancelar

miTurnoRoutes.post('/cancel', limitarPorIp('mi-turno-cancelar', 10), async (c) => {
  // SINGLE-USE: cancelar es irreversible, asi que el token se quema.
  const v = await validarToken(c.env, c.req.query('token'), { consumir: true });
  if (!v.ok) return c.json(rechazo(v.motivo), 401);

  const turno = await buscarTurno(c.env, v.payload.rid);
  if (!turno || turno.estado !== 'activa') return c.json(fail(ERROR_TURNO_NO_ENCONTRADO), 404);

  if (turno.fecha < todayArgentina()) return c.json(fail(ERROR_CANCELAR_PASADO), 400);

  const ahora = new Date();

  await sinRomper('mi-turno-calendario', turno.id, () => sincronizarCancelacion(c.env, turno.id));

  // Todos los tokens de la reserva MENOS el que se acaba de consumir: un link
  // viejo en el historial del browser seguiria mostrando un turno que ya no
  // existe, y el que usaste tiene que seguir diciendo "ya utilizado" y no
  // "revocado". Ver el docstring de `revocarTokensDe`.
  await revocarTokensDe(c.env, turno.id, ahora, v.payload.jti);

  // SOFT DELETE. La fila queda: es historial, y el indice unico parcial solo
  // mira las activas, asi que el slot se libera solo.
  await db(c.env.DB)
    .update(reservas)
    .set({ estado: 'cancelada', canceladaAt: ahora.toISOString() })
    .where(eq(reservas.id, turno.id));

  await sinRomper('mi-turno-aviso', turno.id, () =>
    avisarCambio(c.env, turno.id, 'cancelada', NOTAS.canceladaCliente),
  );

  return c.json(ok(null), 200);
});

export { ERRORES };
