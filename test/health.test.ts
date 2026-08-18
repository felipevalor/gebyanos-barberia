import {
  env,
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
  await env.DB.prepare('INSERT OR REPLACE INTO negocio (id) VALUES (1)').run();
});

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

describe('🔴 Cache-Control: lo que no declara nada, no se cachea', () => {
  const pedir = async (ruta: string) => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`http://localhost${ruta}`), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };

  it('🔴 /health sale no-store: es el detector de drift', async () => {
    // Salía SIN Cache-Control, y se lo vio servir cacheado desde otra IP con el
    // body de antes del deploy. O sea que el endpoint hecho para avisar que
    // algo no se desplegó devolvía justo la respuesta que hace creer eso.
    expect((await pedir('/health')).headers.get('cache-control')).toBe('no-store');
  });

  it('🔴 el 404 también: un CDN puede cachear un 404 y romper la landing', async () => {
    const res = await pedir('/ruta-que-no-existe');

    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('🔴 y los catálogos SIGUEN cacheándose: el arreglo no los pisó', async () => {
    /**
     * ⚠️ Este test necesita las migraciones y la fila de `negocio`. Sin ellas
     * `/api/negocio` devuelve 500 y `cachear()` pone `no-store` en los errores
     * —correctamente—, asi que el test fallaba por el fixture y no por el
     * codigo. Me llevo a diagnosticar mal el arreglo dos veces.
     */
    const res = await pedir('/api/negocio');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('ninguna respuesta sale sin Cache-Control', async () => {
    for (const ruta of ['/health', '/api/negocio', '/api/barberos', '/api/admin/me', '/nada']) {
      expect((await pedir(ruta)).headers.get('cache-control'), ruta).toBeTruthy();
    }
  });
});
