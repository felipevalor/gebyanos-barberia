import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';
import { uuidv7 } from '../src/db/id';
import {
  limpiarVencidos,
  refrescarFeriadosForzado,
  feriadosDelAnio,
  aniosACachear,
  FRESCURA_MS,
} from '../src/services/cron';

/**
 * Un unico cron horario despacha los cuatro jobs. Ver src/index.ts.
 * Los Cron Triggers son 5 por cuenta en el plan Free.
 */

const BARBERO = '01930000-0000-7000-8000-0000000a0001';
const AHORA = new Date('2027-06-15T12:00:00Z');

async function correrCron(isoUtc: string): Promise<string[]> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
    logs.push(String(msg));
  });
  const err = vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
    logs.push(`ERROR ${String(msg)}`);
  });

  const ctx = createExecutionContext();
  await worker.scheduled(
    { cron: '0 * * * *', scheduledTime: Date.parse(isoUtc), noRetry: () => {} },
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);

  spy.mockRestore();
  err.mockRestore();
  return logs;
}

/** Evita pegarle a la API real: estos tests no dependen de un tercero. */
function apiFeriados(respuesta: () => Response) {
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url).includes('argentinadatos')) return respuesta();
    return original(url as never, init);
  });
}

const feriadosOk = (n = 2) =>
  new Response(
    JSON.stringify(
      Array.from({ length: n }, (_, i) => ({
        fecha: `2027-01-0${i + 1}`,
        nombre: `Feriado ${i + 1}`,
        tipo: 'inamovible',
      })),
    ),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO barberos (id, slug, nombre) VALUES (?, 'croner', 'Cron')",
  )
    .bind(BARBERO)
    .run();
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_sessions'),
    env.DB.prepare('DELETE FROM magic_link_tokens'),
  ]);
  for (const anio of aniosACachear(AHORA)) await env.CACHE.delete(`feriados:${anio}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ==========================================================================

describe('limpieza de vencidos', () => {
  const sembrarSesion = (expiresAt: string) =>
    env.DB.prepare(
      'INSERT INTO admin_sessions (id, barbero_id, role, expires_at) VALUES (?, ?, ?, ?)',
    ).bind(uuidv7(), BARBERO, 'barbero', expiresAt);

  const sembrarMagic = (expiresAt: string) =>
    env.DB.prepare('INSERT INTO magic_link_tokens (jti, purpose, expires_at) VALUES (?, ?, ?)').bind(
      uuidv7(),
      'access',
      expiresAt,
    );

  it('borra las vencidas y deja las vigentes', async () => {
    await env.DB.batch([
      sembrarSesion('2027-06-15T11:00:00.000Z'), // vencida
      sembrarSesion('2027-06-14T00:00:00.000Z'), // vencida
      sembrarSesion('2027-06-15T13:00:00.000Z'), // vigente
      sembrarMagic('2027-06-15T10:00:00.000Z'), // vencido
      sembrarMagic('2027-06-16T00:00:00.000Z'), // vigente
    ]);

    const r = await limpiarVencidos(env, AHORA);

    expect(r).toEqual({ sesiones: 2, magicLinks: 1 });

    const sesiones = await env.DB.prepare('SELECT id FROM admin_sessions').all();
    const magic = await env.DB.prepare('SELECT jti FROM magic_link_tokens').all();
    expect(sesiones.results).toHaveLength(1);
    expect(magic.results).toHaveLength(1);
  });

  it('🔴 el corte es estricto: una sesión que vence EXACTAMENTE ahora sobrevive', async () => {
    // `buscarSesion` usa `expires_at > ahora`. Si acá se usara `<=`, habría un
    // instante en que la sesión no vale para el login y tampoco se limpia — o
    // peor, se borra una que el login todavía considera buena.
    await sembrarSesion(AHORA.toISOString()).run();

    const r = await limpiarVencidos(env, AHORA);

    expect(r.sesiones).toBe(0);
    expect((await env.DB.prepare('SELECT id FROM admin_sessions').all()).results).toHaveLength(1);
  });

  it('sin nada vencido devuelve ceros y no rompe', async () => {
    await expect(limpiarVencidos(env, AHORA)).resolves.toEqual({ sesiones: 0, magicLinks: 0 });
  });

  it('es borrado FÍSICO: no quedan filas marcadas', async () => {
    await sembrarSesion('2020-01-01T00:00:00.000Z').run();
    await limpiarVencidos(env, AHORA);

    const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_sessions').all<{
      n: number;
    }>();
    expect(results[0]?.n).toBe(0);
  });
});

describe('caché de feriados', () => {
  it('cachea el año actual y el siguiente', async () => {
    // En diciembre la gente reserva para enero: sin el año siguiente, el panel
    // aparece vacío justo en la única época en que se mira.
    expect(aniosACachear(AHORA)).toEqual([2027, 2028]);
    expect(aniosACachear(new Date('2027-12-31T23:00:00Z'))).toEqual([2027, 2028]);
  });

  it('🔴 el año sale de la hora de Argentina, no de UTC', async () => {
    // 2028-01-01T02:00Z son las 23:00 del 31/12 en Argentina: todavía 2027.
    expect(aniosACachear(new Date('2028-01-01T02:00:00Z'))).toEqual([2027, 2028]);
  });

  it('el job trae de la API y guarda en KV', async () => {
    apiFeriados(() => feriadosOk(3));

    const r = await refrescarFeriadosForzado(env, AHORA);

    expect(r).toEqual([
      { anio: 2027, origen: 'api', cantidad: 3 },
      { anio: 2028, origen: 'api', cantidad: 3 },
    ]);

    const guardado = await env.CACHE.get('feriados:2027', 'json');
    expect(guardado).toMatchObject({ anio: 2027 });
  });

  it('un segundo pedido sale del caché, sin tocar la API', async () => {
    let llamadas = 0;
    apiFeriados(() => {
      llamadas++;
      return feriadosOk();
    });

    await feriadosDelAnio(env, 2027, AHORA);
    expect(llamadas).toBe(1);

    const segundo = await feriadosDelAnio(env, 2027, AHORA);
    expect(segundo.origen).toBe('cache');
    expect(llamadas).toBe(1);
  });

  it('pasadas las 24 h de frescura, se reintenta la API', async () => {
    apiFeriados(() => feriadosOk());
    await feriadosDelAnio(env, 2027, AHORA);

    const masTarde = new Date(AHORA.getTime() + FRESCURA_MS + 1);
    apiFeriados(() => feriadosOk(5));

    const r = await feriadosDelAnio(env, 2027, masTarde);
    expect(r.origen).toBe('api');
    expect(r.feriados).toHaveLength(5);
  });

  it('🔴 con la API caída se sirve el caché VENCIDO', async () => {
    // "Es mejor un feriado desactualizado que un panel roto". Es el escalón
    // que la spec pide y el que se pierde si el TTL de KV fuera de 24 h.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    apiFeriados(() => feriadosOk(4));
    await feriadosDelAnio(env, 2027, AHORA);

    // Un mes después, con la API caída.
    const mesQueViene = new Date(AHORA.getTime() + 30 * FRESCURA_MS);
    apiFeriados(() => {
      throw new Error('la API se cayó');
    });

    const r = await feriadosDelAnio(env, 2027, mesQueViene);

    expect(r.origen).toBe('cache-vencido');
    expect(r.feriados).toHaveLength(4);
  });

  it('🔴 el TTL con el que se guarda supera largamente la frescura', async () => {
    // No se puede probar esperando 24 h, así que se prueba la LLAMADA: lo que
    // importa es la relación entre los dos números. Con `expirationTtl` igual
    // a la frescura, KV borraría la entrada justo cuando el fallback la
    // necesita, y ningún test que corra en milisegundos lo notaría.
    const puestos: (KVNamespacePutOptions | undefined)[] = [];
    const original = env.CACHE.put.bind(env.CACHE);
    vi.spyOn(env.CACHE, 'put').mockImplementation(async (k, v, o) => {
      puestos.push(o);
      return original(k as string, v as string, o);
    });

    apiFeriados(() => feriadosOk());
    await feriadosDelAnio(env, 2027, AHORA);

    const ttlSeg = puestos[0]?.expirationTtl ?? 0;
    const frescuraSeg = FRESCURA_MS / 1000;

    expect(ttlSeg).toBeGreaterThan(frescuraSeg * 7);
  });

  it('el dato guardado sigue disponible pasada la ventana de frescura', async () => {
    apiFeriados(() => feriadosOk());
    await feriadosDelAnio(env, 2027, AHORA);

    const guardado = (await env.CACHE.get('feriados:2027', 'json')) as {
      frescoHastaMs: number;
    } | null;

    expect(guardado?.frescoHastaMs).toBe(AHORA.getTime() + FRESCURA_MS);

    // Y la entrada sigue estando después de la ventana de frescura.
    const despues = new Date(AHORA.getTime() + FRESCURA_MS + 1);
    expect(await env.CACHE.get('feriados:2027')).not.toBeNull();
    expect((await feriadosDelAnio(env, 2027, despues)).feriados.length).toBeGreaterThan(0);
  });

  it('sin caché y con la API caída, devuelve vacío sin explotar', async () => {
    apiFeriados(() => {
      throw new Error('caída');
    });

    const r = await feriadosDelAnio(env, 2027, AHORA);
    expect(r).toEqual({ feriados: [], origen: 'vacio' });
  });

  it('🔴 el job FUERZA el refresco: si respetara la frescura no refrescaría nunca', async () => {
    // Corre una vez por día y encontraría el caché fresco por unos minutos.
    let llamadas = 0;
    apiFeriados(() => {
      llamadas++;
      return feriadosOk();
    });

    await feriadosDelAnio(env, 2027, AHORA);
    expect(llamadas).toBe(1);

    await refrescarFeriadosForzado(env, AHORA);
    expect(llamadas).toBeGreaterThan(1);
  });
});

describe('despacho del cron horario', () => {
  it('corre la limpieza en toda hora', async () => {
    const logs = await correrCron('2027-06-15T13:00:00Z');

    expect(logs.some((l) => l.includes('limpieza'))).toBe(true);
    expect(logs.some((l) => l.includes('feriados'))).toBe(false);
    expect(logs.some((l) => l.includes('recordatorios'))).toBe(false);
    expect(logs.some((l) => l.includes('recurrentes'))).toBe(false);
  });

  it('corre los feriados a las 06:00 UTC (03:00 ART)', async () => {
    apiFeriados(() => feriadosOk());
    const logs = await correrCron('2027-06-15T06:00:00Z');

    expect(logs.some((l) => l.includes('feriados'))).toBe(true);
    expect(logs.some((l) => l.includes('limpieza'))).toBe(true);
  });

  it('corre los recordatorios a las 00:00 UTC (21:00 ART)', async () => {
    const logs = await correrCron('2027-06-15T00:00:00Z');
    expect(logs.some((l) => l.includes('recordatorios'))).toBe(true);
    expect(logs.some((l) => l.includes('limpieza'))).toBe(true);
  });

  it('corre los recurrentes a las 09:00 UTC (06:00 ART)', async () => {
    const logs = await correrCron('2027-06-15T09:00:00Z');
    expect(logs.some((l) => l.includes('recurrentes'))).toBe(true);
    expect(logs.some((l) => l.includes('limpieza'))).toBe(true);
  });

  it('🔴 un job que falla NO impide que corran los otros', async () => {
    // Si el cron se cayera entero por un error en la limpieza, dejaría de
    // refrescar los feriados sin que nadie relacione las dos cosas.
    //
    // ⚠️ Se rompe `env.DB.prepare` y no `env.DB.batch`: `limpiarVencidos` usa
    // Drizzle, que por debajo llama a `prepare`. La primera versión de este
    // test mockeaba `batch` — que la limpieza no toca — así que pasaba sin
    // ejercitar nada. Lo detectó una mutación que borraba el try/catch y
    // seguía en verde.
    apiFeriados(() => feriadosOk());
    const romper = vi.spyOn(env.DB, 'prepare').mockImplementation(() => {
      throw new Error('D1 caída');
    });

    const logs = await correrCron('2027-06-15T06:00:00Z');
    romper.mockRestore();

    // La limpieza falló y quedó registrada...
    expect(logs.some((l) => l.startsWith('ERROR') && l.includes('limpieza'))).toBe(true);
    // ...pero los feriados corrieron igual.
    expect(logs.some((l) => l.includes('cron: feriados'))).toBe(true);
  });

  it('el cron deja rastro de QUÉ hizo, no solo de que corrió', async () => {
    const logs: unknown[][] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a));
    apiFeriados(() => feriadosOk());

    await env.DB.prepare(
      'INSERT INTO admin_sessions (id, barbero_id, role, expires_at) VALUES (?, ?, ?, ?)',
    )
      .bind(uuidv7(), BARBERO, 'barbero', '2020-01-01T00:00:00.000Z')
      .run();

    const ctx = createExecutionContext();
    await worker.scheduled(
      { cron: '0 * * * *', scheduledTime: Date.parse('2027-06-15T06:00:00Z'), noRetry: () => {} },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const limpieza = logs.find((l) => String(l[0]).includes('limpieza'));
    expect(limpieza?.[1]).toMatchObject({ sesiones: 1 });

    const feriados = logs.find((l) => String(l[0]).includes('feriados'));
    expect(feriados?.[1]).toEqual([
      { anio: 2027, origen: 'api', cantidad: 2 },
      { anio: 2028, origen: 'api', cantidad: 2 },
    ]);
  });
});
