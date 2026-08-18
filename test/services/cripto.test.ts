import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import worker from '../../src/index';
import { uuidv7 } from '../../src/db/id';
import { hashPassword } from '../../src/services/password';
import {
  cifrar,
  descifrar,
  claveMaestra,
  pistaDeApikey,
  hayClaveMaestra,
  VERSION,
  ERROR_SIN_CLAVE_MAESTRA,
} from '../../src/services/cripto';
import { leerConfig, guardarConfig, probarEnvio, apikeyDe } from '../../src/services/callmebot';

const OWNER = '01930000-0000-7000-8000-0000000b0001';
const ANA = '01930000-0000-7000-8000-0000000b0002';
const PASS = 'la-password-de-cripto';

const CLAVE = 'clave-maestra-de-prueba';

const ip = () => `192.0.2.99-${uuidv7()}`;

async function pedir(
  ruta: string,
  o: { metodo?: string; cuerpo?: unknown; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'cf-connecting-ip': ip() };
  if (o.cuerpo !== undefined) headers['content-type'] = 'application/json';
  if (o.cookie) headers['cookie'] = o.cookie;

  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://localhost${ruta}`, {
      method: o.metodo ?? 'GET',
      headers,
      ...(o.cuerpo !== undefined ? { body: JSON.stringify(o.cuerpo) } : {}),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const cuerpoDe = async (res: Response) =>
  (await res.json()) as { ok: boolean; data?: any; error?: string };

let cookieAna = '';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
  const hash = await hashPassword(PASS);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO barberos (id, slug, nombre, rol, password_hash) VALUES (?, 'jefe', 'Jefe', 'owner', ?)",
    ).bind(OWNER, hash),
    env.DB.prepare(
      "INSERT OR REPLACE INTO barberos (id, slug, nombre, rol, password_hash) VALUES (?, 'anacr', 'Ana', 'barbero', ?)",
    ).bind(ANA, hash),
  ]);

  const res = await pedir('/api/admin/auth', {
    metodo: 'POST',
    cuerpo: { usuario: 'anacr', password: PASS },
  });
  cookieAna = `admin_token=${/admin_token=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1]}`;
});

beforeEach(async () => {
  env.ENCRYPTION_KEY = CLAVE;
  await env.DB.prepare(
    'UPDATE barberos SET callmebot_phone = NULL, callmebot_apikey = NULL',
  ).run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ==========================================================================

describe('🔴 un IV nuevo por cada cifrado', () => {
  it('el mismo texto cifrado dos veces da resultados DISTINTOS', async () => {
    // Reusar el IV con AES-GCM no debilita el cifrado: lo ROMPE. El XOR de dos
    // ciphertexts con el mismo IV es el XOR de los plaintexts.
    const clave = await claveMaestra(env);

    const a = await cifrar('la-misma-key', clave);
    const b = await cifrar('la-misma-key', clave);

    expect(a).not.toBe(b);
    // Y la diferencia está en el IV, no solo en el ciphertext.
    expect(a.split(':')[1]).not.toBe(b.split(':')[1]);
  });

  it('cien cifrados dan cien IV distintos', async () => {
    const clave = await claveMaestra(env);
    const ivs = new Set<string>();

    for (let i = 0; i < 100; i++) {
      ivs.add((await cifrar('x', clave)).split(':')[1]!);
    }

    expect(ivs.size).toBe(100);
  });

  it('los dos descifran al mismo texto', async () => {
    const clave = await claveMaestra(env);
    const a = await cifrar('la-misma-key', clave);
    const b = await cifrar('la-misma-key', clave);

    expect(await descifrar(a, clave)).toBe('la-misma-key');
    expect(await descifrar(b, clave)).toBe('la-misma-key');
  });

  it('el IV es de 12 bytes: es lo que AES-GCM asume', async () => {
    const clave = await claveMaestra(env);
    const iv = (await cifrar('x', clave)).split(':')[1]!;

    expect(atob(iv)).toHaveLength(12);
  });
});

describe('🔴 el prefijo de versión', () => {
  it('el formato es v1:iv:ciphertext', async () => {
    const guardado = await cifrar('secreto', await claveMaestra(env));
    const partes = guardado.split(':');

    expect(partes).toHaveLength(3);
    expect(partes[0]).toBe(VERSION);
    expect(partes[0]).toBe('v1');
  });

  it('una versión desconocida devuelve null en vez de intentar descifrarla', async () => {
    // Es lo que permite rotar sin migrar todo de golpe: el día que exista v2,
    // esta rama es la que evita que un v2 se lea con el descifrador de v1.
    const clave = await claveMaestra(env);
    const guardado = await cifrar('secreto', clave);
    const comoV2 = guardado.replace(/^v1:/, 'v2:');

    expect(await descifrar(comoV2, clave)).toBeNull();
  });

  it('un valor con formato roto devuelve null, no lanza', async () => {
    const clave = await claveMaestra(env);

    for (const basura of ['', 'sin-dos-puntos', 'v1:solo-dos', 'v1:a:b:c', 'v1:!!!:???']) {
      await expect(descifrar(basura, clave)).resolves.toBeNull();
    }
  });

  it('🔴 un dato alterado NO se descifra: GCM autentica', async () => {
    const clave = await claveMaestra(env);
    const guardado = await cifrar('key-original', clave);
    const [v, iv, ct] = guardado.split(':') as [string, string, string];

    // Se le cambia un byte al ciphertext.
    const bytes = Uint8Array.from(atob(ct), (c) => c.charCodeAt(0));
    bytes[0] = bytes[0]! ^ 0xff;
    const alterado = `${v}:${iv}:${btoa(String.fromCharCode(...bytes))}`;

    expect(await descifrar(alterado, clave)).toBeNull();
  });

  it('otra clave maestra no lo descifra', async () => {
    const guardado = await cifrar('secreto', await claveMaestra(env));

    env.ENCRYPTION_KEY = 'otra-clave-maestra-distinta';
    expect(await descifrar(guardado, await claveMaestra(env))).toBeNull();
  });
});

describe('🔴 sin clave maestra, el fallo es ruidoso', () => {
  it('`claveMaestra` lanza con un mensaje que dice qué hacer', async () => {
    env.ENCRYPTION_KEY = '';

    await expect(claveMaestra(env)).rejects.toThrow(ERROR_SIN_CLAVE_MAESTRA);
    await expect(claveMaestra(env)).rejects.toThrow('wrangler secret put ENCRYPTION_KEY');
    expect(hayClaveMaestra(env)).toBe(false);
  });

  it('🔴 NO cifra con una clave vacía: eso produce datos que parecen cifrados', async () => {
    // Es el modo de fallo peligroso: la alternativa a lanzar es una base entera
    // "cifrada" con la clave vacía, que se descubre tarde.
    env.ENCRYPTION_KEY = '   ';

    const res = await pedir('/api/admin/callmebot', {
      metodo: 'PUT',
      cuerpo: { telefono: '+5493416513207', apikey: 'k-123456' },
      cookie: cookieAna,
    });

    expect(res.status).toBe(500);

    const fila = await env.DB.prepare('SELECT callmebot_apikey FROM barberos WHERE id = ?')
      .bind(ANA)
      .first<{ callmebot_apikey: string | null }>();
    expect(fila?.callmebot_apikey).toBeNull();
  });
});

describe('🔴 la key nunca sale en una respuesta', () => {
  const guardarKey = () =>
    pedir('/api/admin/callmebot', {
      metodo: 'PUT',
      cuerpo: { telefono: '+5493416513207', apikey: 'k-super-secreta-9876' },
      cookie: cookieAna,
    });

  it('el PUT devuelve la config sin la key', async () => {
    const { data } = await cuerpoDe(await guardarKey());

    expect(JSON.stringify(data)).not.toContain('k-super-secreta-9876');
    expect(data.apikey).toBeUndefined();
    expect(data.tieneApikey).toBe(true);
  });

  it('el GET tampoco', async () => {
    await guardarKey();
    const { data } = await cuerpoDe(await pedir('/api/admin/callmebot', { cookie: cookieAna }));

    expect(JSON.stringify(data)).not.toContain('k-super-secreta-9876');
    expect(data.tieneApikey).toBe(true);
    // Cuatro caracteres: alcanzan para reconocerla, no para usarla.
    expect(data.pistaApikey).toBe('••••9876');
  });

  it('🔴 un SELECT no la muestra en claro', async () => {
    await guardarKey();

    const fila = await env.DB.prepare('SELECT callmebot_apikey FROM barberos WHERE id = ?')
      .bind(ANA)
      .first<{ callmebot_apikey: string }>();

    expect(fila?.callmebot_apikey).not.toContain('k-super-secreta-9876');
    expect(fila?.callmebot_apikey).toMatch(/^v1:/);
  });

  it('y se descifra bien al usarla', async () => {
    await guardarKey();
    const fila = await env.DB.prepare('SELECT callmebot_apikey FROM barberos WHERE id = ?')
      .bind(ANA)
      .first<{ callmebot_apikey: string }>();

    expect(await apikeyDe(env, fila!.callmebot_apikey)).toBe('k-super-secreta-9876');
  });

  it('la pista sale de la key en claro, no del ciphertext', async () => {
    // Los últimos caracteres del ciphertext cambian en cada guardado —el IV es
    // nuevo siempre— así que no identificarían nada.
    await guardarKey();
    const uno = (await cuerpoDe(await pedir('/api/admin/callmebot', { cookie: cookieAna }))).data;

    await guardarKey();
    const dos = (await cuerpoDe(await pedir('/api/admin/callmebot', { cookie: cookieAna }))).data;

    expect(uno.pistaApikey).toBe(dos.pistaApikey);
  });

  it('pistaDeApikey no filtra nada de una key corta', () => {
    expect(pistaDeApikey('1234')).toBe('••••');
    expect(pistaDeApikey('ab')).toBe('••••');
    expect(pistaDeApikey(null)).toBeNull();
  });
});

describe('la configuración', () => {
  it('el PUT es parcial: cambiar el teléfono no borra la key', async () => {
    await pedir('/api/admin/callmebot', {
      metodo: 'PUT',
      cuerpo: { telefono: '+5493416513207', apikey: 'k-1234' },
      cookie: cookieAna,
    });

    const { data } = await cuerpoDe(
      await pedir('/api/admin/callmebot', {
        metodo: 'PUT',
        cuerpo: { telefono: '+5493415559999' },
        cookie: cookieAna,
      }),
    );

    expect(data.telefono).toBe('+5493415559999');
    // El panel no tiene la key —nunca se la devolvimos— así que no puede
    // reenviarla: si el PUT parcial la borrara, sería imposible editar el
    // teléfono sin perderla.
    expect(data.tieneApikey).toBe(true);
  });

  it('mandar apikey null la borra', async () => {
    await pedir('/api/admin/callmebot', {
      metodo: 'PUT',
      cuerpo: { telefono: '+5493416513207', apikey: 'k-1234' },
      cookie: cookieAna,
    });

    const { data } = await cuerpoDe(
      await pedir('/api/admin/callmebot', {
        metodo: 'PUT',
        cuerpo: { apikey: null },
        cookie: cookieAna,
      }),
    );

    expect(data.tieneApikey).toBe(false);
    expect(data.pistaApikey).toBeNull();
  });

  it('un teléfono que no es internacional se rechaza', async () => {
    const res = await pedir('/api/admin/callmebot', {
      metodo: 'PUT',
      cuerpo: { telefono: '341 651-3207' },
      cookie: cookieAna,
    });

    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toContain('formato internacional');
  });

  it('un barbero no puede ver ni tocar la config de otro', async () => {
    for (const o of [
      { ruta: `/api/admin/callmebot?barberoId=${OWNER}`, metodo: 'GET' },
      { ruta: '/api/admin/callmebot', metodo: 'PUT', cuerpo: { barberoId: OWNER, telefono: '+5491100000000' } },
      { ruta: `/api/admin/callmebot/test?barberoId=${OWNER}`, metodo: 'POST' },
    ]) {
      const res = await pedir(o.ruta, { metodo: o.metodo, cuerpo: o.cuerpo, cookie: cookieAna });
      expect(res.status, o.ruta).toBe(403);
    }
  });
});

describe('🔴 el test de envío devuelve el error REAL', () => {
  const configurar = () =>
    pedir('/api/admin/callmebot', {
      metodo: 'PUT',
      cuerpo: { telefono: '+5493416513207', apikey: 'k-1234' },
      cookie: cookieAna,
    });

  it('cuando CallMeBot rechaza la key, el barbero lee POR QUÉ', async () => {
    // Es la herramienta de diagnóstico: "no se pudo enviar" no le dice si
    // renovar la key o registrar el número en el bot.
    await configurar();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<b>APIKey is invalid.</b> Create a new one')));

    const res = await pedir('/api/admin/callmebot/test', { metodo: 'POST', cookie: cookieAna });
    const { data } = await cuerpoDe(res);

    // 200: la operación de diagnóstico funcionó; lo que falló es el envío.
    expect(res.status).toBe(200);
    expect(data.enviado).toBe(false);
    expect(data.motivo).toContain('APIKey is invalid');
  });

  it('el motivo del test tampoco lleva la key', async () => {
    await configurar();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ERROR: apikey=k-1234 no sirve')),
    );

    const { data } = await cuerpoDe(
      await pedir('/api/admin/callmebot/test', { metodo: 'POST', cookie: cookieAna }),
    );

    expect(data.motivo).not.toContain('k-1234');
  });

  it('un envío exitoso lo dice', async () => {
    await configurar();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Message queued')));

    const { data } = await cuerpoDe(
      await pedir('/api/admin/callmebot/test', { metodo: 'POST', cookie: cookieAna }),
    );

    expect(data.enviado).toBe(true);
  });

  it('sin configurar, no dispara ningún request', async () => {
    const fetchFalso = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchFalso);

    const res = await pedir('/api/admin/callmebot/test', { metodo: 'POST', cookie: cookieAna });

    expect(res.status).toBe(400);
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it('con la clave maestra ausente, no se puede usar la key guardada', async () => {
    await configurar();
    env.ENCRYPTION_KEY = '';

    const fetchFalso = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchFalso);

    // Degrada a "sin configurar": no se manda nada con una key que no se pudo
    // descifrar, y no explota.
    expect((await probarEnvio(env, ANA)).estado).toBe('sinConfigurar');
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it('leerConfig no explota si falta la clave maestra', async () => {
    await configurar();
    env.ENCRYPTION_KEY = '';

    const config = await leerConfig(env, ANA);
    expect(config?.tieneApikey).toBe(true);
    // Sin clave no hay pista, pero la respuesta sale igual.
    expect(config?.pistaApikey).toBeNull();
  });

  it('guardarConfig sobre un barbero inexistente da noEncontrado', async () => {
    expect((await guardarConfig(env, uuidv7(), { telefono: '+5491100000000' })).estado).toBe(
      'noEncontrado',
    );
  });
});
