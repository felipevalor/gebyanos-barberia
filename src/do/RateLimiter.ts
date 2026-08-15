import { DurableObject } from 'cloudflare:workers';

/**
 * Rate limit del endpoint publico: 10 req / 15 min por IP.
 *
 * Implementacion real: Fase 2, tarea 2.6.
 */
export class RateLimiter extends DurableObject<Env> {
  override async fetch(_request: Request): Promise<Response> {
    return new Response('RateLimiter: no implementado (Fase 2, tarea 2.6)', {
      status: 501,
    });
  }
}
