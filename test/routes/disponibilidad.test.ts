import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../../src/index';
import { uuidv7 } from '../../src/db/id';
import { todayArgentina, addDays } from '../../src/domain/dates';

const BARBERO = '01930000-0000-7000-8000-0000000000d1';
const SERVICIO = '01930000-0000-7000-8000-0000000000d2';
/** Los tests que llegan a la reserva no pueden inyectar `ahora`. */
const DENTRO_DE_VENTANA = addDays(todayArgentina(), 7);

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
  await env.DB.prepare("INSERT OR IGNORE INTO servicios (id, nombre, duracion_min) VALUES (?, 'Corte', 30)")
    .bind(SERVICIO)
    .run();
  for (let dow = 0; dow <= 6; dow++) {
    await env.DB.prepare(
      'INSERT INTO barbero_horarios (id, barbero_id, dow, hora_inicio, hora_fin) VALUES (?, ?, ?, 9, 13)',
    )
      .bind(uuidv7(), BARBERO, dow)
      .run();
  }
});

/**
 * Cuenta los `prepare` del binding. El criterio de la 2.3 habla de queries del
 * ENDPOINT, no del servicio, asi que se mide acá.
 */
function contando(d1: D1Database) {
  let n = 0;
  const proxy = new Proxy(d1, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r) as unknown;
      if (p === 'prepare' && typeof v === 'function') {
        return (...a: unknown[]) => {
          n += 1;
          return (v as (...x: unknown[]) => unknown).apply(t, a);
        };
      }
      if (typeof v === 'function') return (v as () => unknown).bind(t);
      return v;
    },
  });
  return { d1: proxy as D1Database, queries: () => n };
}

describe('costo del endpoint de mes', () => {
  const medir = async (url: string) => {
    const { d1, queries } = contando(env.DB);
    const ctx = createExecutionContext();
    await worker.fetch(new Request(`http://localhost${url}`), { ...env, DB: d1 }, ctx);
    await waitOnExecutionContext(ctx);
    return queries();
  };

  it('CON servicioId: 6 queries', async () => {
    // ⚠️ El criterio de la 2.3 decia 5, medido a nivel SERVICIO. La validacion
    // del barbero, agregada despues en la ruta, suma una. Sigue siendo
    // constante: no depende de los dias del mes, que es lo que el criterio
    // protegia — 31 llamadas al endpoint de dia daban 107.
    expect(
      await medir(`/api/disponibilidad/mes?barberoId=${BARBERO}&anio=2027&mes=3&servicioId=${SERVICIO}`),
    ).toBe(6);
  });

  it('SIN servicioId: 5 queries, se saltea la de la duracion', async () => {
    expect(await medir(`/api/disponibilidad/mes?barberoId=${BARBERO}&anio=2027&mes=3`)).toBe(5);
  });

  it('un mes de 31 dias cuesta lo mismo que uno de 28', async () => {
    const marzo = await medir(`/api/disponibilidad/mes?barberoId=${BARBERO}&anio=2027&mes=3`);
    const febrero = await medir(`/api/disponibilidad/mes?barberoId=${BARBERO}&anio=2027&mes=2`);
    expect(marzo).toBe(febrero);
  });
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
    [`/api/disponibilidad/mes?barberoId=${BARBERO}&anio=2027&mes=13`, 'Mes inválido. Usá 1 a 12.'],
    [`/api/disponibilidad/mes?barberoId=${BARBERO}&anio=2027&mes=0`, 'Mes inválido. Usá 1 a 12.'],
    [`/api/disponibilidad/mes?barberoId=${BARBERO}&anio=2027`, 'Mes inválido. Usá 1 a 12.'],
  ];

  for (const [url, error] of casos) {
    it(`${url.split('?')[1]} → 400 "${error}"`, async () => {
      const res = await get(url);
      expect(res.status).toBe(400);
      expect(await cuerpo(res)).toEqual({ ok: false, error });
    });
  }
});

describe('validacion del barbero', () => {
  it('un barberoId inexistente da 400 "Barbero inválido.", no una lista vacia', async () => {
    // Sin esto, un ID mal escrito devolvia slots: [] con 200, indistinguible
    // de "el dia esta lleno", y ademas se contradecia con la reserva, que sí
    // lo rechaza.
    const res = await get(`/api/disponibilidad?barberoId=${uuidv7()}&fecha=2027-03-15`);

    expect(res.status).toBe(400);
    expect((await cuerpo(res)).error).toBe('Barbero inválido.');
  });

  it('lo mismo en el endpoint de mes', async () => {
    const res = await get(`/api/disponibilidad/mes?barberoId=${uuidv7()}&anio=2027&mes=3`);

    expect(res.status).toBe(400);
    expect((await cuerpo(res)).error).toBe('Barbero inválido.');
  });

  it('un barbero desactivado tambien', async () => {
    const inactivo = uuidv7();
    await env.DB.prepare(
      "INSERT INTO barberos (id, slug, nombre, activo) VALUES (?, ?, 'De baja', 0)",
    )
      .bind(inactivo, 's' + inactivo)
      .run();

    const res = await get(`/api/disponibilidad?barberoId=${inactivo}&fecha=2027-03-15`);
    expect(res.status).toBe(400);
    expect((await cuerpo(res)).error).toBe('Barbero inválido.');
  });

  it('mismo mensaje que la reserva: las dos respuestas no se contradicen', async () => {
    const fantasma = uuidv7();
    const dispo = await get(`/api/disponibilidad?barberoId=${fantasma}&fecha=${DENTRO_DE_VENTANA}`);

    const ctx = createExecutionContext();
    const reserva = await worker.fetch(
      new Request('http://localhost/api/reservas', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          barberoId: fantasma,
          servicioId: uuidv7(),
          fecha: DENTRO_DE_VENTANA,
          hora: '10:00',
          clienteNombre: 'Juan',
          clienteTelefono: '3416513207',
        }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect((await cuerpo(dispo)).error).toBe((await cuerpo(reserva)).error);
  });
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

  it('un dia sin horarios devuelve 200 con lista vacia, no un error', async () => {
    // La lista vacia sigue siendo una respuesta valida: lo que ya NO puede
    // pasar es que un barberoId invalido se confunda con un dia lleno.
    const sinHorario = uuidv7();
    await env.DB.prepare("INSERT INTO barberos (id, slug, nombre) VALUES (?, ?, 'Sin horario')")
      .bind(sinHorario, 's' + sinHorario)
      .run();

    const res = await get(`/api/disponibilidad?barberoId=${sinHorario}&fecha=2027-03-15`);

    expect(res.status).toBe(200);
    expect((await cuerpo(res)).data).toMatchObject({ slots: [] });
  });
});
