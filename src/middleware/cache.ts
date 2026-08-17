import { createMiddleware } from 'hono/factory';

/**
 * Cache-Control por ruta, declarado explicitamente en cada handler.
 *
 * A proposito NO es un `use('*')` sobre el router: un middleware global que
 * cachea "todos los GET" hace que cualquier ruta nueva herede cache sin que
 * nadie lo decida. En este router conviven catalogos (que cambian poco) con
 * disponibilidad (que cambia cada vez que alguien reserva): cachear
 * disponibilidad 5 minutos le muestra al cliente slots que se ocuparon hace
 * cuatro.
 *
 * Con opt-in, lo que no declara cache no se cachea. El default es el seguro.
 */
export const cachear = (segundos: number) =>
  createMiddleware(async (c, next) => {
    await next();

    if (c.req.method === 'GET' && c.res.ok) {
      c.res.headers.set('Cache-Control', `public, max-age=${segundos}`);
      return;
    }

    // Las respuestas de error NO pueden quedar sin Cache-Control: un CDN que
    // no ve el header aplica su propia heuristica y puede cachear un 404. Si
    // eso pasa con `/api/negocio` durante un despliegue a medias, la landing
    // queda rota para todos hasta que expire un TTL que nadie eligio.
    c.res.headers.set('Cache-Control', 'no-store');
  });

/**
 * Datos de catalogo: negocio, barberos, servicios, promos, catalogo.
 * Cambian cuando el owner toca el panel, o sea casi nunca.
 */
export const CACHE_CATALOGO_SEG = 300;

/**
 * Marca explicita para lo que NO se puede cachear: disponibilidad y
 * escrituras. Sirve para que la intencion quede escrita en la ruta, y para
 * que un proxy intermedio no invente su propia politica.
 */
export const sinCache = () =>
  createMiddleware(async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });
