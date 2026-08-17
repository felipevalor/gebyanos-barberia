import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../../src/index';
import { uuidv7 } from '../../src/db/id';

const BARBERO = '01930000-0000-7000-8000-0000000000d1';

async function get(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://localhost${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const cuerpo = async (res: Response) =>
  (await res.json()) as { ok: boolean; data?: unknown; error?: string };

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
  await env.DB.prepare('INSERT OR REPLACE INTO negocio (id) VALUES (1)').run();
  await env.DB.prepare("INSERT OR IGNORE INTO barberos (id, slug, nombre) VALUES (?, 'dispo', 'Dispo')")
    .bind(BARBERO)
    .run();
  for (let dow = 0; dow <= 6; dow++) {
    await env.DB.prepare(
      'INSERT INTO barbero_horarios (id, barbero_id, dow, hora_inicio, hora_fin) VALUES (?, ?, ?, 9, 13)',
    )
      .bind(uuidv7(), BARBERO, dow)
      .run();
  }
});

describe('la disponibilidad NO se cachea', () => {
  it('GET /api/disponibilidad manda no-store', async () => {
    const res = await get(`/api/disponibilidad?barberoId=${BARBERO}&fecha=2027-03-15`);

    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Cache-Control')).not.toContain('max-age');
  });

  it('GET /api/disponibilidad/mes manda no-store', async () => {
    const res = await get(`/api/disponibilidad/mes?barberoId=${BARBERO}&anio=2027&mes=3`);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('los catalogos siguen cacheados: el no-store no se derramo', async () => {
    expect((await get('/api/servicios')).headers.get('Cache-Control')).toBe('public, max-age=300');
  });
});

describe('validacion de parametros', () => {
  const casos: [string, string][] = [
    ['/api/disponibilidad?fecha=2027-03-15', 'barberoId es obligatorio.'],
    [`/api/disponibilidad?barberoId=${BARBERO}`, 'fecha es obligatoria.'],
    [`/api/disponibilidad?barberoId=${BARBERO}&fecha=15/3/2027`, 'Formato de fecha inválido.'],
    [`/api/disponibilidad?barberoId=${BARBERO}&fecha=2027-02-30`, 'Formato de fecha inválido.'],
    [`/api/disponibilidad?barberoId=${BARBERO}&fecha=2027-3-15`, 'Formato de fecha inválido.'],
    ['/api/disponibilidad/mes?anio=2027&mes=3', 'barberoId es obligatorio.'],
    [`/api/disponibilidad/mes?barberoId=${BARBERO}&mes=3`, 'Año inválido.'],
    [`/api/disponibilidad/mes?barberoId=${BARBERO}&anio=2027&mes=13`, 'Mes inválido. Use 1 a 12.'],
    [`/api/disponibilidad/mes?barberoId=${BARBERO}&anio=2027&mes=0`, 'Mes inválido. Use 1 a 12.'],
    [`/api/disponibilidad/mes?barberoId=${BARBERO}&anio=2027`, 'Mes inválido. Use 1 a 12.'],
  ];

  for (const [url, error] of casos) {
    it(`${url.split('?')[1]} → 400 "${error}"`, async () => {
      const res = await get(url);
      expect(res.status).toBe(400);
      expect(await cuerpo(res)).toEqual({ ok: false, error });
    });
  }
});

describe('respuestas', () => {
  it('el dia devuelve fecha, slots y la duracion usada', async () => {
    const res = await get(`/api/disponibilidad?barberoId=${BARBERO}&fecha=2027-03-15`);
    const body = await cuerpo(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({ fecha: '2027-03-15', duracionMin: 30 });
    expect(Array.isArray((body.data as { slots: string[] }).slots)).toBe(true);
  });

  it('el mes devuelve anio, mes y los dias disponibles', async () => {
    const res = await get(`/api/disponibilidad/mes?barberoId=${BARBERO}&anio=2027&mes=3`);
    const body = await cuerpo(res);

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ anio: 2027, mes: 3 });
    expect(Array.isArray((body.data as { diasDisponibles: string[] }).diasDisponibles)).toBe(true);
  });

  it('un barbero inexistente devuelve 200 con lista vacia, no un error', async () => {
    // No filtra si el barbero existe: no es una consulta de identidad.
    const res = await get(`/api/disponibilidad?barberoId=${uuidv7()}&fecha=2027-03-15`);

    expect(res.status).toBe(200);
    expect((await cuerpo(res)).data).toMatchObject({ slots: [] });
  });
});
