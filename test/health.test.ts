import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

describe('GET /health', () => {
  it('responde ok con la version desplegada', async () => {
    const request = new Request('http://localhost/health');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    // ⚠️ El SHA es lo que convierte a /health en una sonda de DRIFT y no solo
    // de vida. En los tests no hay `--define`, asi que vale 'desconocido' —
    // pero el CAMPO tiene que estar, porque el smoke check lo compara contra
    // el commit que se desplego.
    expect(await response.json()).toEqual({
      ok: true,
      version: 'desconocido',
      deployedAt: 'desconocido',
    });
  });
});

describe('ruta inexistente', () => {
  it('responde 404 con el contrato de error', async () => {
    const request = new Request('http://localhost/no-existe');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: 'No encontrado.' });
  });
});

/**
 * Afirmaciones de docs/contrato-api.md que no tenian test propio.
 * Si esto cambia, el contrato queda mintiendo.
 */
describe('routers montados pero vacios', () => {
  // `/api/mi-turno` YA NO esta acá: desde la tarea 5.1 tiene rutas propias y
  // un GET sin token responde 401, no 404.
  for (const ruta of ['/api/admin', '/api/admin/auth', '/api/mi-turno/abc']) {
    it(`${ruta} responde 404 con el sobre de error`, async () => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`http://localhost${ruta}`), env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: 'No encontrado.' });
    });
  }
});
