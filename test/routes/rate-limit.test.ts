import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../../src/index';
import { uuidv7 } from '../../src/db/id';
import { hashPassword } from '../../src/services/password';
import { todayArgentina, addDays } from '../../src/domain/dates';
import { LIMITE_POR_VENTANA, VENTANA_MS } from '../../src/middleware/rate-limit';

const BARBERO = '01930000-0000-7000-8000-00000000c001';
const SERVICIO = '01930000-0000-7000-8000-00000000c002';
const PASS = 'la-password-del-owner';
const FUTURO = addDays(todayArgentina(), 7);

/**
 * Cada test usa su propia IP para no compartir contador con los demas.
 *
 * El UUID va ENTERO: `slice(0, 8)` son los bits de timestamp del v7, iguales
 * para todas las llamadas del mismo milisegundo, y dos tests colisionaban.
 */
const ipUnica = () => `203.0.113.1-${uuidv7()}`;

async function pedir(
  ruta: string,
  opciones: { metodo?: string; cuerpo?: unknown; ip?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opciones.cuerpo !== undefined) headers['content-type'] = 'application/json';
  if (opciones.ip) headers['cf-connecting-ip'] = opciones.ip;

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
  (await res.json()) as { ok: boolean; error?: string };

const reservaValida = (over: Record<string, unknown> = {}) => ({
  barberoId: BARBERO,
  servicioId: SERVICIO,
  fecha: FUTURO,
  hora: '10:00',
  clienteNombre: 'Juan',
  clienteTelefono: '3416513207',
  ...over,
});

const loginMalo = (ip: string) =>
  pedir('/api/admin/auth', {
    metodo: 'POST',
    ip,
    cuerpo: { usuario: 'rl-owner', password: 'incorrecta' },
  });

const loginBueno = (ip: string) =>
  pedir('/api/admin/auth', {
    metodo: 'POST',
    ip,
    cuerpo: { usuario: 'rl-owner', password: PASS },
  });

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
  await env.DB.prepare('INSERT OR REPLACE INTO negocio (id) VALUES (1)').run();

  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO barberos (id, slug, nombre, rol, password_hash) VALUES (?, 'rl-owner', 'RL', 'owner', ?)",
    ).bind(BARBERO, await hashPassword(PASS)),
    env.DB.prepare(
      "INSERT OR IGNORE INTO servicios (id, nombre, duracion_min) VALUES (?, 'Corte', 30)",
    ).bind(SERVICIO),
  ]);

  for (let dow = 0; dow <= 6; dow++) {
    await env.DB.prepare(
      'INSERT INTO barbero_horarios (id, barbero_id, dow, hora_inicio, hora_fin) VALUES (?, ?, ?, 9, 20)',
    )
      .bind(uuidv7(), BARBERO, dow)
      .run();
  }
});

// ------------------------------------------------- criterios de aceptacion

describe('POST /api/reservas — consume en cada request', () => {
  it('el request 11 en la ventana da 429', async () => {
    const ip = ipUnica();

    // Los 10 primeros no dan 429. Van a slots distintos para que el limite sea
    // lo unico que los pueda frenar.
    const horas = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30'];
    for (const hora of horas) {
      const res = await pedir('/api/reservas', {
        metodo: 'POST',
        ip,
        cuerpo: reservaValida({ hora }),
      });
      expect(res.status).not.toBe(429);
    }

    const onceavo = await pedir('/api/reservas', {
      metodo: 'POST',
      ip,
      cuerpo: reservaValida({ hora: '14:00' }),
    });

    expect(onceavo.status).toBe(429);
    expect((await cuerpoDe(onceavo)).error).toBe('Demasiados intentos. Intentá más tarde.');
  });

  it('los requests RECHAZADOS tambien consumen cupo', async () => {
    // Si no consumieran, un atacante mandaria basura invalida gratis.
    const ip = ipUnica();

    for (let i = 0; i < LIMITE_POR_VENTANA; i++) {
      const res = await pedir('/api/reservas', {
        metodo: 'POST',
        ip,
        cuerpo: reservaValida({ clienteNombre: '' }), // siempre 400
      });
      expect(res.status).toBe(400);
    }

    expect((await pedir('/api/reservas', { metodo: 'POST', ip, cuerpo: reservaValida() })).status).toBe(429);
  });

  it('dos IPs distintas tienen contadores independientes', async () => {
    const ipA = ipUnica();
    const ipB = ipUnica();

    for (let i = 0; i < LIMITE_POR_VENTANA + 1; i++) {
      await pedir('/api/reservas', { metodo: 'POST', ip: ipA, cuerpo: reservaValida({ clienteNombre: '' }) });
    }
    expect((await pedir('/api/reservas', { metodo: 'POST', ip: ipA, cuerpo: reservaValida() })).status).toBe(429);

    // La otra IP no se entero de nada.
    const res = await pedir('/api/reservas', { metodo: 'POST', ip: ipB, cuerpo: reservaValida({ clienteNombre: '' }) });
    expect(res.status).toBe(400);
  });

  it('el 429 trae Retry-After en segundos', async () => {
    const ip = ipUnica();
    for (let i = 0; i < LIMITE_POR_VENTANA + 1; i++) {
      await pedir('/api/reservas', { metodo: 'POST', ip, cuerpo: reservaValida({ clienteNombre: '' }) });
    }

    const res = await pedir('/api/reservas', { metodo: 'POST', ip, cuerpo: reservaValida() });
    expect(res.status).toBe(429);

    const segundos = Number(res.headers.get('Retry-After'));
    expect(segundos).toBeGreaterThan(0);
    expect(segundos).toBeLessThanOrEqual(VENTANA_MS / 1000);
  });
});

describe('POST /api/admin/auth — consume SOLO en los fallos', () => {
  it('10 logins CORRECTOS no gastan cupo', async () => {
    // Es la diferencia con el de reservas: alguien que entra al panel diez
    // veces en un dia no se puede autobloquear.
    const ip = ipUnica();

    for (let i = 0; i < 10; i++) {
      expect((await loginBueno(ip)).status).toBe(200);
    }

    // El onceavo tambien entra.
    expect((await loginBueno(ip)).status).toBe(200);
  });

  it('10 fallos bloquean el onceavo intento', async () => {
    const ip = ipUnica();

    for (let i = 0; i < LIMITE_POR_VENTANA; i++) {
      expect((await loginMalo(ip)).status).toBe(401);
    }

    const bloqueado = await loginMalo(ip);
    expect(bloqueado.status).toBe(429);
    expect((await cuerpoDe(bloqueado)).error).toBe('Demasiados intentos. Intentá más tarde.');
  });

  it('una vez bloqueado, ni siquiera la password CORRECTA entra', async () => {
    // El chequeo va antes de verificar la password: no se gastan 3,8 ms de CPU
    // en alguien que ya se paso del limite.
    const ip = ipUnica();
    for (let i = 0; i < LIMITE_POR_VENTANA; i++) await loginMalo(ip);

    const res = await loginBueno(ip);
    expect(res.status).toBe(429);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('los logins correctos entre fallos no reponen cupo', async () => {
    const ip = ipUnica();

    for (let i = 0; i < LIMITE_POR_VENTANA; i++) {
      await loginMalo(ip);
      await loginBueno(ip); // no suma ni resta
    }

    expect((await loginMalo(ip)).status).toBe(429);
  });

  it('dos IPs distintas tienen contadores independientes', async () => {
    const ipA = ipUnica();
    const ipB = ipUnica();

    for (let i = 0; i < LIMITE_POR_VENTANA + 1; i++) await loginMalo(ipA);
    expect((await loginMalo(ipA)).status).toBe(429);
    expect((await loginMalo(ipB)).status).toBe(401);
  });
});

describe('los contadores son por endpoint', () => {
  it('agotar el de reservas NO bloquea el login de la misma IP', async () => {
    const ip = ipUnica();

    for (let i = 0; i < LIMITE_POR_VENTANA + 1; i++) {
      await pedir('/api/reservas', { metodo: 'POST', ip, cuerpo: reservaValida({ clienteNombre: '' }) });
    }
    expect((await pedir('/api/reservas', { metodo: 'POST', ip, cuerpo: reservaValida() })).status).toBe(429);

    // El panel sigue accesible: un ataque a un endpoint no puede dejar sin
    // servicio al otro.
    expect((await loginBueno(ip)).status).toBe(200);
  });

  it('agotar el del login NO bloquea las reservas de la misma IP', async () => {
    const ip = ipUnica();

    for (let i = 0; i < LIMITE_POR_VENTANA + 1; i++) await loginMalo(ip);
    expect((await loginMalo(ip)).status).toBe(429);

    const res = await pedir('/api/reservas', {
      metodo: 'POST',
      ip,
      cuerpo: reservaValida({ hora: '16:00' }),
    });
    expect(res.status).not.toBe(429);
  });
});

describe('sin header de IP', () => {
  it('las requests sin CF-Connecting-IP comparten un unico cupo', async () => {
    // Preferible a que cada una tenga cupo propio y el limite no exista.
    for (let i = 0; i < LIMITE_POR_VENTANA + 2; i++) {
      await pedir('/api/admin/auth', {
        metodo: 'POST',
        cuerpo: { usuario: 'rl-owner', password: 'mala' },
      });
    }

    const res = await pedir('/api/admin/auth', {
      metodo: 'POST',
      cuerpo: { usuario: 'rl-owner', password: 'mala' },
    });
    expect(res.status).toBe(429);
  });
});

describe('lo que NO tiene rate limit', () => {
  it('los catalogos no se limitan: son lecturas cacheables', async () => {
    const ip = ipUnica();
    for (let i = 0; i < LIMITE_POR_VENTANA + 5; i++) {
      expect((await pedir('/api/servicios', { ip })).status).toBe(200);
    }
  });

  it('la disponibilidad tampoco', async () => {
    const ip = ipUnica();
    for (let i = 0; i < LIMITE_POR_VENTANA + 5; i++) {
      const res = await pedir(`/api/disponibilidad?barberoId=${BARBERO}&fecha=${FUTURO}`, { ip });
      expect(res.status).toBe(200);
    }
  });
});
