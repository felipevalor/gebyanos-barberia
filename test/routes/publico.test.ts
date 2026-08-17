import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../../src/index';
import { uuidv7 } from '../../src/db/id';
import seedSql from '../../src/db/seed.sql?raw';
import { BarberoAgenda } from '../../src/do/BarberoAgenda';
import { publicRoutes } from '../../src/routes/public';
import { ok } from '../../src/api';

async function get(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://localhost${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Devuelve `data` si la respuesta es ok, o tira con el error. */
async function data<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { ok: boolean; data?: T; error?: string };
  if (!body.ok) throw new Error(`respuesta con error: ${body.error}`);
  return body.data as T;
}

const RUTAS = ['/api/negocio', '/api/barberos', '/api/servicios', '/api/promos', '/api/catalogo'];

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);

  const sentencias = seedSql
    .split(';')
    .map((s) => s.replace(/--[^\n]*/g, '').trim())
    .filter((s) => s.length > 0);
  await env.DB.batch(sentencias.map((s) => env.DB.prepare(s)));

  // ⚠️ TODO lo de acá se inserta EN ORDEN INVERSO al de la columna `orden`.
  //
  // Si se siembra en el mismo orden que `orden`, SQLite los devuelve bien por
  // orden de rowid aunque no haya ORDER BY, y el test pasa con el orderBy
  // borrado: no prueba nada. Sembrando al reves, el ORDER BY es la unica razon
  // por la que pueden salir ordenados.
  //
  // Verificado por mutacion: sin los orderBy de services/publico.ts, los tests
  // de orden fallan.

  // --- barberos. El seed ya dejo a Gaby con orden 0.
  await env.DB.prepare(
    "INSERT INTO barberos (id, slug, nombre, activo, orden) VALUES (?, 'nico', 'Nico', 1, 2)",
  )
    .bind(uuidv7())
    .run();
  await env.DB.prepare(
    "INSERT INTO barberos (id, slug, nombre, activo, orden) VALUES (?, 'ale', 'Ale', 1, 1)",
  )
    .bind(uuidv7())
    .run();
  await env.DB.prepare(
    "INSERT INTO barberos (id, slug, nombre, activo, orden) VALUES (?, 'inactivo', 'Ex barbero', 0, 0)",
  )
    .bind(uuidv7())
    .run();

  // --- servicios. El seed dejo Corte(0), Corte y barba(1), Barba(2).
  // Estos dos van adelante y se insertan al reves entre si.
  await env.DB.prepare(
    "INSERT INTO servicios (id, nombre, duracion_min, precio_centavos, activo, orden) VALUES (?, 'Afeitado', 30, 600000, 1, -1)",
  )
    .bind(uuidv7())
    .run();
  await env.DB.prepare(
    "INSERT INTO servicios (id, nombre, duracion_min, precio_centavos, activo, orden) VALUES (?, 'Alisado', 45, 1500000, 1, -2)",
  )
    .bind(uuidv7())
    .run();
  await env.DB.prepare(
    "INSERT INTO servicios (id, nombre, activo, orden) VALUES (?, 'Servicio discontinuado', 0, -3)",
  )
    .bind(uuidv7())
    .run();

  // --- promos: el seed no las carga.
  await env.DB.prepare(
    "INSERT INTO promos (id, nombre, precio_centavos, activo, orden) VALUES (?, 'Combo padre e hijo', 1400000, 1, 2)",
  )
    .bind(uuidv7())
    .run();
  await env.DB.prepare(
    "INSERT INTO promos (id, nombre, precio_centavos, activo, orden) VALUES (?, 'Martes de barba', 500000, 1, 1)",
  )
    .bind(uuidv7())
    .run();
  await env.DB.prepare(
    "INSERT INTO promos (id, nombre, activo, orden) VALUES (?, 'Promo vieja', 0, 0)",
  )
    .bind(uuidv7())
    .run();

  // --- catalogo. Los dos ultimos comparten `orden` para ejercitar el
  // desempate por nombre, y se insertan al reves alfabeticamente.
  await env.DB.prepare(
    "INSERT INTO catalogo (id, nombre, incluye, precio_centavos, activo, orden) VALUES (?, 'Corte clásico', 'Lavado', 800000, 1, 2)",
  )
    .bind(uuidv7())
    .run();
  await env.DB.prepare(
    "INSERT INTO catalogo (id, nombre, incluye, activo, orden) VALUES (?, 'Zeta empate', 'Nada', 1, 1)",
  )
    .bind(uuidv7())
    .run();
  await env.DB.prepare(
    "INSERT INTO catalogo (id, nombre, incluye, activo, orden) VALUES (?, 'Alfa empate', 'Nada', 1, 1)",
  )
    .bind(uuidv7())
    .run();
  await env.DB.prepare(
    "INSERT INTO catalogo (id, nombre, activo, orden) VALUES (?, 'Item oculto', 0, 0)",
  )
    .bind(uuidv7())
    .run();
});

describe('contrato comun', () => {
  for (const ruta of RUTAS) {
    it(`${ruta} responde 200 con el sobre { ok: true, data }`, async () => {
      const res = await get(ruta);
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body).toHaveProperty('data');
      expect(body).not.toHaveProperty('error');
    });

    it(`${ruta} manda Cache-Control de 300 s`, async () => {
      const res = await get(ruta);
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    });
  }
});

describe('el cache es opt-in, no global', () => {
  it('una ruta nueva del router real NO hereda el cache de los catalogos', async () => {
    // Se registra sobre publicRoutes, el router de produccion, no sobre uno
    // nuevo: la pregunta es si ESE router impone cache a todo lo que cuelga.
    //
    // Simula lo que va a ser /api/disponibilidad en la 2.3: un GET en el mismo
    // router. Con un use('*') saldria con max-age=300 y el cliente veria slots
    // que se ocuparon hace cuatro minutos.
    publicRoutes.get('/__sonda_sin_cache', (c) => c.json(ok({ slots: [] })));

    const res = await publicRoutes.request('/__sonda_sin_cache', {}, env);

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBeNull();
  });

  it('una respuesta de ERROR nunca sale sin Cache-Control', async () => {
    // Un CDN que no ve el header aplica su propia heuristica y puede cachear
    // un 404. Si eso pasa con /api/negocio durante un despliegue a medias, la
    // landing queda rota hasta que expire un TTL que nadie eligio.
    await env.DB.prepare('DELETE FROM negocio').run();

    try {
      const res = await get('/api/negocio');
      expect(res.status).toBe(404);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    } finally {
      await env.DB.prepare('INSERT OR REPLACE INTO negocio (id) VALUES (1)').run();
    }
  });

  it('las 5 rutas de catalogo declaran su cache una por una', async () => {
    for (const ruta of RUTAS) {
      expect(await (await get(ruta)).headers.get('Cache-Control')).toBe('public, max-age=300');
    }
  });
});

describe('GET /api/negocio', () => {
  it('devuelve la configuracion con timezone IANA', async () => {
    const negocio = await data<Record<string, unknown>>(await get('/api/negocio'));

    expect(negocio.nombreNegocio).toBe('Barbería Gebyanos');
    expect(negocio.timezone).toBe('America/Argentina/Buenos_Aires');
    expect(negocio.slotDuracionMin).toBe(30);
    expect(negocio.minutosAnticipacionMin).toBe(30);
    expect(negocio.diasMaxAnticipacion).toBe(14);
  });
});

describe('GET /api/barberos', () => {
  it('devuelve solo los activos', async () => {
    const lista = await data<{ slug: string }[]>(await get('/api/barberos'));

    expect(lista).toHaveLength(3);
    expect(lista.map((b) => b.slug)).not.toContain('inactivo');
  });

  it('ordena por `orden`, no por orden de insercion', async () => {
    // Sembrados: Nico(2), Ale(1). Gaby(0) venia del seed.
    const lista = await data<{ slug: string; orden: number }[]>(await get('/api/barberos'));

    expect(lista.map((b) => b.slug)).toEqual(['gaby', 'ale', 'nico']);
    expect(lista.map((b) => b.orden)).toEqual([0, 1, 2]);
  });

  it('NO filtra datos privados del barbero', async () => {
    const res = await get('/api/barberos');
    const crudo = await res.text();

    // Sobre el JSON crudo: si en el futuro alguien devuelve el row entero,
    // esto lo agarra aunque el tipo del DTO diga otra cosa.
    for (const campo of [
      'password_hash',
      'passwordHash',
      'callmebot_apikey',
      'callmebotApikey',
      'callmebot_phone',
      'calendar_id',
      'calendarId',
      '"tel"',
    ]) {
      expect(crudo).not.toContain(campo);
    }
  });
});

describe('GET /api/servicios', () => {
  it('devuelve solo los activos', async () => {
    const lista = await data<{ nombre: string }[]>(await get('/api/servicios'));

    expect(lista).toHaveLength(5);
    expect(lista.map((s) => s.nombre)).not.toContain('Servicio discontinuado');
  });

  it('ordena por `orden`, no por orden de insercion', async () => {
    // Insertados: Afeitado(-1) y despues Alisado(-2). Si mandara el rowid,
    // Afeitado saldria antes que Alisado.
    const lista = await data<{ nombre: string; orden: number }[]>(await get('/api/servicios'));

    expect(lista.map((s) => s.nombre)).toEqual([
      'Alisado',
      'Afeitado',
      'Corte',
      'Corte y barba',
      'Barba',
    ]);
    expect(lista.map((s) => s.orden)).toEqual([-2, -1, 0, 1, 2]);
  });

  it('expone el precio en centavos, como entero', async () => {
    const lista = await data<{ nombre: string; precioCentavos: number }[]>(
      await get('/api/servicios'),
    );

    const corte = lista.find((s) => s.nombre === 'Corte');
    expect(corte?.precioCentavos).toBe(800000);
    for (const s of lista) expect(Number.isInteger(s.precioCentavos)).toBe(true);
  });

  it('incluye la duracion de cada servicio', async () => {
    const lista = await data<{ nombre: string; duracionMin: number }[]>(
      await get('/api/servicios'),
    );
    expect(lista.find((s) => s.nombre === 'Corte y barba')?.duracionMin).toBe(60);
  });
});

describe('GET /api/promos', () => {
  it('devuelve solo las activas', async () => {
    const lista = await data<{ nombre: string }[]>(await get('/api/promos'));

    expect(lista).toHaveLength(2);
    expect(lista.map((p) => p.nombre)).not.toContain('Promo vieja');
  });

  it('ordena por `orden`, no por orden de insercion', async () => {
    // Insertadas: Combo(2) y despues Martes(1).
    const lista = await data<{ nombre: string; precioCentavos: number | null }[]>(
      await get('/api/promos'),
    );

    expect(lista.map((p) => p.nombre)).toEqual(['Martes de barba', 'Combo padre e hijo']);
    expect(lista[1]?.precioCentavos).toBe(1400000);
  });
});

describe('GET /api/catalogo', () => {
  it('devuelve solo los activos', async () => {
    const lista = await data<{ nombre: string }[]>(await get('/api/catalogo'));

    expect(lista).toHaveLength(3);
    expect(lista.map((c) => c.nombre)).not.toContain('Item oculto');
  });

  it('ordena por `orden` y desempata por nombre', async () => {
    // Insertados: Corte clásico(2), Zeta empate(1), Alfa empate(1).
    // El desempate por nombre tiene que dar vuelta los dos ultimos.
    const lista = await data<{ nombre: string }[]>(await get('/api/catalogo'));

    expect(lista.map((c) => c.nombre)).toEqual(['Alfa empate', 'Zeta empate', 'Corte clásico']);
  });
});

describe('estas lecturas NO pasan por el Durable Object', () => {
  it('responden aunque el DO del barbero nunca se haya instanciado', async () => {
    // Si el router las mandara por BarberoAgenda, harian falta un barberoId y
    // una instancia del DO. Que respondan sin nada de eso es la verificacion.
    for (const ruta of RUTAS) {
      expect((await get(ruta)).status).toBe(200);
    }
  });

  it('el DO expone solo ESCRITURAS: nada de lecturas publicas', () => {
    // Los metodos privados (#) no aparecen acá. Si alguien agrega una lectura
    // publica al DO, este test se rompe y hay que justificarla.
    const metodos = Object.getOwnPropertyNames(BarberoAgenda.prototype)
      .filter((m) => m !== 'constructor')
      .sort();

    expect(metodos).toEqual(['reprogramar', 'reservar']);
  });
});
