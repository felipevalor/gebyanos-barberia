import { Hono } from 'hono';
import { ok, fail } from '../api';
import { cachear, sinCache, CACHE_CATALOGO_SEG } from '../middleware/cache';
import {
  getNegocio,
  listarBarberos,
  listarServicios,
  listarPromos,
  listarCatalogo,
} from '../services/publico';
import {
  disponibilidadDelDia,
  disponibilidadDelMes,
  barberoValido,
} from '../services/disponibilidad';
import { esFechaValida } from '../domain/dates';
import { crearReserva, type EntradaReserva } from '../services/reserva';
import { limitarPorIp } from '../middleware/rate-limit';

/**
 * Rutas publicas (cliente anonimo).
 *
 * Lectura de catalogos: tarea 2.2. Disponibilidad y reserva llegan en las
 * tareas 2.3 y 2.4.
 *
 * EL CACHE ES OPT-IN, RUTA POR RUTA. No hay `use('*')` que cachee todos los
 * GET: en este mismo router va a vivir la disponibilidad, que es un GET y NO
 * se puede cachear (un slot se ocupa en cualquier momento). Una ruta nueva
 * arranca sin cache salvo que lo pida.
 */
export const publicRoutes = new Hono<{ Bindings: Env }>();

const cacheCatalogo = cachear(CACHE_CATALOGO_SEG);

publicRoutes.get('/negocio', cacheCatalogo, async (c) => {
  const negocio = await getNegocio(c.env.DB);
  if (!negocio) return c.json(fail('No encontrado.'), 404);
  return c.json(ok(negocio));
});

publicRoutes.get('/barberos', cacheCatalogo, async (c) =>
  c.json(ok(await listarBarberos(c.env.DB))),
);

publicRoutes.get('/servicios', cacheCatalogo, async (c) =>
  c.json(ok(await listarServicios(c.env.DB))),
);

publicRoutes.get('/promos', cacheCatalogo, async (c) => c.json(ok(await listarPromos(c.env.DB))));

publicRoutes.get('/catalogo', cacheCatalogo, async (c) =>
  c.json(ok(await listarCatalogo(c.env.DB))),
);

// --------------------------------------------------------- disponibilidad

/**
 * `sinCache()` explicito, no por omision: un slot se ocupa en cualquier
 * momento, y un proxy intermedio que invente su propia politica le muestra al
 * cliente horarios que ya no existen.
 */
const noCachear = sinCache();

publicRoutes.get('/disponibilidad', noCachear, async (c) => {
  const barberoId = c.req.query('barberoId');
  const fecha = c.req.query('fecha');

  if (!barberoId) return c.json(fail('barberoId es obligatorio.'), 400);
  if (!fecha) return c.json(fail('fecha es obligatoria.'), 400);
  if (!esFechaValida(fecha)) return c.json(fail('Formato de fecha inválido.'), 400);

  // Mismo mensaje y mismo codigo que la reserva: un barberoId mal escrito se
  // rechaza acá, no devuelve una lista vacia que parece "dia lleno".
  if (!(await barberoValido(c.env.DB, barberoId))) {
    return c.json(fail('Barbero inválido.'), 400);
  }

  return c.json(
    ok(
      await disponibilidadDelDia(c.env.DB, {
        barberoId,
        fecha,
        servicioId: c.req.query('servicioId'),
      }),
    ),
  );
});

// ----------------------------------------------------------------- reserva

/**
 * Rate limit: 10 por IP cada 15 min. Consume cupo en CADA request, no solo en
 * los rechazados — acá el request en si es el costo que se quiere acotar.
 */
publicRoutes.post('/reservas', noCachear, limitarPorIp('reservas'), async (c) => {
  const cuerpo = await c.req.json().catch(() => null);
  if (!cuerpo || typeof cuerpo !== 'object') {
    return c.json(fail('Formato de solicitud inválido.'), 400);
  }

  const resultado = await crearReserva(c.env, cuerpo as EntradaReserva);

  if (resultado.estado === 'exito') {
    return c.json(ok({ cancelToken: resultado.cancelToken, mensaje: resultado.mensaje }), 200);
  }

  // datosInvalidos | noDisponible | overlap → 400. Una excepcion no controlada
  // sube al onError de src/index.ts, que responde 500.
  return c.json(fail(resultado.error), 400);
});

publicRoutes.get('/disponibilidad/mes', noCachear, async (c) => {
  const barberoId = c.req.query('barberoId');
  const anio = Number(c.req.query('anio'));
  const mes = Number(c.req.query('mes'));

  if (!barberoId) return c.json(fail('barberoId es obligatorio.'), 400);
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) {
    return c.json(fail('Año inválido.'), 400);
  }
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) {
    return c.json(fail('Mes inválido. Usá 1 a 12.'), 400);
  }
  if (!(await barberoValido(c.env.DB, barberoId))) {
    return c.json(fail('Barbero inválido.'), 400);
  }

  return c.json(
    ok(
      await disponibilidadDelMes(c.env.DB, {
        barberoId,
        anio,
        mes,
        servicioId: c.req.query('servicioId'),
      }),
    ),
  );
});
