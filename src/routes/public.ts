import { Hono } from 'hono';
import { ok, fail } from '../api';
import { cachear, CACHE_CATALOGO_SEG } from '../middleware/cache';
import {
  getNegocio,
  listarBarberos,
  listarServicios,
  listarPromos,
  listarCatalogo,
} from '../services/publico';

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
