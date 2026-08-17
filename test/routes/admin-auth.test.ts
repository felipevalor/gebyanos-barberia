import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import worker from '../../src/index';
import { hashPassword } from '../../src/services/password';
import { DURACION_SESION_MS } from '../../src/services/auth';

const OWNER = '01930000-0000-7000-8000-00000000ba01';
const BARBERO = '01930000-0000-7000-8000-00000000ba02';
const DE_BAJA = '01930000-0000-7000-8000-00000000ba03';
const SIN_HASH = '01930000-0000-7000-8000-00000000ba04';

const PASS = 'la-password-del-owner';

async function pedir(
  ruta: string,
  opciones: { metodo?: string; cuerpo?: unknown; cookie?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...opciones.headers };
  if (opciones.cuerpo !== undefined) headers['content-type'] = 'application/json';
  if (opciones.cookie) headers['cookie'] = opciones.cookie;

  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://localhost${ruta}`, {
      method: opciones.metodo ?? 'GET',
      headers,
      ...(opciones.cuerpo !== undefined ? { body: JSON.stringify(opciones.cuerpo) } : {}),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const cuerpoDe = async (res: Response) =>
  (await res.json()) as { ok: boolean; data?: Record<string, unknown>; error?: string };

/** Extrae el valor del token del Set-Cookie. */
function tokenDe(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  const m = raw?.match(/admin_token=([^;]+)/);
  return m?.[1] ?? null;
}

async function loguearse(usuario = 'gaby-owner', password = PASS) {
  const res = await pedir('/api/admin/auth', {
    metodo: 'POST',
    cuerpo: { usuario, password },
  });
  return { res, token: tokenDe(res) };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
  const hash = await hashPassword(PASS);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO barberos (id, slug, nombre, rol, password_hash) VALUES (?, 'gaby-owner', 'Gaby', 'owner', ?)",
    ).bind(OWNER, hash),
    env.DB.prepare(
      "INSERT OR REPLACE INTO barberos (id, slug, nombre, rol, password_hash) VALUES (?, 'nico', 'Nico', 'barbero', ?)",
    ).bind(BARBERO, hash),
    env.DB.prepare(
      "INSERT OR REPLACE INTO barberos (id, slug, nombre, rol, password_hash, activo) VALUES (?, 'exbarbero', 'Ex', 'barbero', ?, 0)",
    ).bind(DE_BAJA, hash),
    env.DB.prepare(
      "INSERT OR REPLACE INTO barberos (id, slug, nombre, rol, password_hash) VALUES (?, 'sinhash', 'Sin hash', 'barbero', NULL)",
    ).bind(SIN_HASH),
  ]);
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM admin_sessions').run();
});

// ------------------------------------------------------------------- login

describe('POST /api/admin/auth', () => {
  it('login correcto devuelve el usuario, sin token en el body', async () => {
    const { res } = await loguearse();
    const body = await cuerpoDe(res);

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      user: { id: OWNER, slug: 'gaby-owner', nombre: 'Gaby', rol: 'owner' },
    });

    // EL TOKEN NUNCA VA EN EL BODY.
    const crudo = JSON.stringify(body);
    expect(crudo).not.toContain(tokenDe(res));
    expect(crudo.toLowerCase()).not.toContain('token');
  });

  it('la cookie lleva los cinco atributos exactos', async () => {
    const { res } = await loguearse();
    const cookie = res.headers.get('set-cookie') ?? '';

    expect(cookie).toContain('admin_token=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toMatch(/Expires=/);
  });

  it('la cookie expira en 24 h', async () => {
    const antes = Date.now();
    const { res } = await loguearse();

    const expires = /Expires=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
    const delta = Date.parse(expires!) - antes;

    // Un minuto de tolerancia por el tiempo del propio request.
    expect(Math.abs(delta - DURACION_SESION_MS)).toBeLessThan(60_000);
  });

  it('el token son 32 caracteres hex: 16 bytes, no un UUID', async () => {
    const { token } = await loguearse();

    expect(token).toMatch(/^[0-9a-f]{32}$/);
    // Un UUID tendria guiones y el v7 llevaria el timestamp adentro.
    expect(token).not.toContain('-');
  });

  it('dos logins dan tokens distintos', async () => {
    const a = await loguearse();
    const b = await loguearse();
    expect(a.token).not.toBe(b.token);
  });

  it('normaliza el usuario: espacios y mayusculas', async () => {
    expect((await loguearse('  GABY-Owner  ')).res.status).toBe(200);
  });

  it('guarda la sesion en la base', async () => {
    const { token } = await loguearse();

    const fila = await env.DB.prepare('SELECT barbero_id, role FROM admin_sessions WHERE id = ?')
      .bind(token)
      .first<{ barbero_id: string; role: string }>();

    expect(fila?.barbero_id).toBe(OWNER);
    expect(fila?.role).toBe('owner');
  });
});

describe('anti-enumeracion', () => {
  it('usuario inexistente y password incorrecta dan LA MISMA respuesta', async () => {
    const inexistente = await pedir('/api/admin/auth', {
      metodo: 'POST',
      cuerpo: { usuario: 'no-existe-nadie', password: PASS },
    });
    const passwordMala = await pedir('/api/admin/auth', {
      metodo: 'POST',
      cuerpo: { usuario: 'gaby-owner', password: 'incorrecta' },
    });

    const cuerpoA = await cuerpoDe(inexistente);
    const cuerpoB = await cuerpoDe(passwordMala);

    expect(inexistente.status).toBe(passwordMala.status);
    expect(inexistente.status).toBe(401);
    expect(cuerpoA).toEqual(cuerpoB);
    expect(cuerpoA.error).toBe('Usuario o contraseña incorrectos');

    // Ni siquiera los headers pueden delatar cual de los dos casos fue.
    expect(inexistente.headers.get('set-cookie')).toBe(passwordMala.headers.get('set-cookie'));
  });

  it('un barbero sin hash da la misma respuesta que uno inexistente', async () => {
    const sinHash = await pedir('/api/admin/auth', {
      metodo: 'POST',
      cuerpo: { usuario: 'sinhash', password: PASS },
    });
    const inexistente = await pedir('/api/admin/auth', {
      metodo: 'POST',
      cuerpo: { usuario: 'no-existe-nadie', password: PASS },
    });

    expect(await cuerpoDe(sinHash)).toEqual(await cuerpoDe(inexistente));
  });

  it('un barbero desactivado no puede loguearse', async () => {
    const res = await pedir('/api/admin/auth', {
      metodo: 'POST',
      cuerpo: { usuario: 'exbarbero', password: PASS },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('ninguna respuesta de fallo setea cookie', async () => {
    for (const cuerpo of [
      { usuario: 'no-existe', password: PASS },
      { usuario: 'gaby-owner', password: 'mala' },
      { usuario: '', password: '' },
    ]) {
      const res = await pedir('/api/admin/auth', { metodo: 'POST', cuerpo });
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  it('un cuerpo que no es JSON da 400', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request('http://localhost/api/admin/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'no soy json',
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(400);
  });
});

// -------------------------------------------------------------- middleware

describe('el middleware lee SOLO la cookie', () => {
  it('con cookie valida deja pasar', async () => {
    const { token } = await loguearse();
    const res = await pedir('/api/admin/me', { cookie: `admin_token=${token}` });

    expect(res.status).toBe(200);
    expect((await cuerpoDe(res)).data).toEqual({
      id: OWNER,
      slug: 'gaby-owner',
      nombre: 'Gaby',
      rol: 'owner',
    });
  });

  it('⚠️ Authorization: Bearer con un token VALIDO da 401', async () => {
    // Es la mitigacion de XSS del disenio, no un olvido: la cookie es HttpOnly
    // y ademas el backend no acepta la otra via.
    const { token } = await loguearse();

    const res = await pedir('/api/admin/me', {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(401);
    expect((await cuerpoDe(res)).error).toBe('No autorizado');
  });

  it('el mismo token funciona por cookie y no por header', async () => {
    const { token } = await loguearse();

    expect((await pedir('/api/admin/me', { cookie: `admin_token=${token}` })).status).toBe(200);
    expect(
      (await pedir('/api/admin/me', { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(401);
  });

  it('sin cookie da 401', async () => {
    const res = await pedir('/api/admin/me');
    expect(res.status).toBe(401);
    expect((await cuerpoDe(res)).error).toBe('No autorizado');
  });

  it('un token inventado da 401', async () => {
    const res = await pedir('/api/admin/me', { cookie: 'admin_token=' + 'a'.repeat(32) });
    expect(res.status).toBe(401);
  });

  it('una sesion EXPIRADA da 401 aunque la cookie exista', async () => {
    const { token } = await loguearse();

    await env.DB.prepare("UPDATE admin_sessions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?")
      .bind(token)
      .run();

    const res = await pedir('/api/admin/me', { cookie: `admin_token=${token}` });
    expect(res.status).toBe(401);
  });

  it('si el barbero se desactiva, su sesion deja de valer', async () => {
    const { token } = await loguearse();
    await env.DB.prepare('UPDATE barberos SET activo = 0 WHERE id = ?').bind(OWNER).run();

    try {
      const res = await pedir('/api/admin/me', { cookie: `admin_token=${token}` });
      expect(res.status).toBe(401);
    } finally {
      await env.DB.prepare('UPDATE barberos SET activo = 1 WHERE id = ?').bind(OWNER).run();
    }
  });
});

// ------------------------------------------------------------------ logout

describe('DELETE /api/admin/auth', () => {
  it('borra la FILA de la base, no solo la cookie', async () => {
    const { token } = await loguearse();

    const res = await pedir('/api/admin/auth', {
      metodo: 'DELETE',
      cookie: `admin_token=${token}`,
    });
    expect(res.status).toBe(200);

    const fila = await env.DB.prepare('SELECT id FROM admin_sessions WHERE id = ?')
      .bind(token)
      .first();
    expect(fila).toBeNull();
  });

  it('el token deja de servir despues del logout', async () => {
    const { token } = await loguearse();
    await pedir('/api/admin/auth', { metodo: 'DELETE', cookie: `admin_token=${token}` });

    expect((await pedir('/api/admin/me', { cookie: `admin_token=${token}` })).status).toBe(401);
  });

  it('borra la cookie con las mismas opciones que la seteo', async () => {
    const { token } = await loguearse();
    const res = await pedir('/api/admin/auth', {
      metodo: 'DELETE',
      cookie: `admin_token=${token}`,
    });

    const cookie = res.headers.get('set-cookie') ?? '';
    // Si Path o SameSite difieren, el navegador no la borra y la sesion "vuelve".
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toMatch(/admin_token=;|Max-Age=0/);
  });

  it('responde ok aunque la sesion ya haya expirado', async () => {
    const { token } = await loguearse();
    await env.DB.prepare("UPDATE admin_sessions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?")
      .bind(token)
      .run();

    const res = await pedir('/api/admin/auth', {
      metodo: 'DELETE',
      cookie: `admin_token=${token}`,
    });

    expect(res.status).toBe(200);
    // Y la fila colgada se limpia igual: por eso el logout no exige auth.
    expect(await env.DB.prepare('SELECT id FROM admin_sessions WHERE id = ?').bind(token).first()).toBeNull();
  });

  it('responde ok sin cookie', async () => {
    expect((await pedir('/api/admin/auth', { metodo: 'DELETE' })).status).toBe(200);
  });
});

// ------------------------------------------------------------------- roles

describe('roles', () => {
  it('un barbero comun se loguea y ve su propio /me', async () => {
    const { res, token } = await loguearse('nico');
    expect(res.status).toBe(200);

    const me = await pedir('/api/admin/me', { cookie: `admin_token=${token}` });
    expect((await cuerpoDe(me)).data).toMatchObject({ slug: 'nico', rol: 'barbero' });
  });
});

// ------------------------------------------------------------------- cache

describe('el panel nunca se cachea', () => {
  it('login y me responden no-store', async () => {
    const { res, token } = await loguearse();
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const me = await pedir('/api/admin/me', { cookie: `admin_token=${token}` });
    expect(me.headers.get('Cache-Control')).toBe('no-store');
  });

  it('tambien las respuestas de error', async () => {
    const res = await pedir('/api/admin/me');
    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
