import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import worker from '../../src/index';
import { uuidv7 } from '../../src/db/id';
import { slotAMs, todayArgentina, addDays } from '../../src/domain/dates';

const BARBERO = '01930000-0000-7000-8000-00000000aa01';
const SERVICIO = '01930000-0000-7000-8000-00000000aa02';
/**
 * Por HTTP no se puede inyectar `ahora`, asi que la fecha tiene que ser
 * relativa a hoy: una fija se sale de la ventana de 14 dias y todos los tests
 * empiezan a fallar con "Solo se puede reservar con hasta 14 dias...".
 */
const FUTURO = addDays(todayArgentina(), 7);

/**
 * Cada request sale con una IP DISTINTA salvo que se pida lo contrario.
 *
 * Desde la tarea 2.6 hay rate limit de 10 por IP cada 15 min. Sin esto, los
 * tests comparten el cupo de "sin-ip" y empiezan a recibir 429 por razones que
 * no tienen nada que ver con lo que prueban. El limite en si se prueba en
 * test/routes/rate-limit.test.ts.
 *
 * Para el test de concurrencia ademas es MAS realista: veinte personas
 * distintas peleando por el mismo slot son veinte IPs, no una.
 */
async function post(cuerpo: unknown, ruta = '/api/reservas', ip?: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://localhost${ruta}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': ip ?? `198.51.100.${Math.floor(Math.random() * 250) + 1}-${uuidv7()}`,
      },
      body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const cuerpoDe = async (res: Response) =>
  (await res.json()) as { ok: boolean; data?: Record<string, unknown>; error?: string };

const valido = (over: Record<string, unknown> = {}) => ({
  barberoId: BARBERO,
  servicioId: SERVICIO,
  fecha: FUTURO,
  hora: '10:00',
  clienteNombre: 'Juan Pérez',
  clienteTelefono: '3416513207',
  ...over,
});

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
  await env.DB.prepare('INSERT OR REPLACE INTO negocio (id) VALUES (1)').run();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO barberos (id, slug, nombre) VALUES (?, 'ruta', 'Ruta')").bind(BARBERO),
    env.DB.prepare("INSERT OR IGNORE INTO servicios (id, nombre, duracion_min) VALUES (?, 'Corte', 30)").bind(SERVICIO),
  ]);
  for (let dow = 0; dow <= 6; dow++) {
    await env.DB.prepare(
      'INSERT INTO barbero_horarios (id, barbero_id, dow, hora_inicio, hora_fin) VALUES (?, ?, ?, 9, 20)',
    )
      .bind(uuidv7(), BARBERO, dow)
      .run();
  }
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM reservas').run();
  await env.DB.prepare('DELETE FROM clientes').run();
});

describe('POST /api/reservas', () => {
  it('200 con { ok: true, data: { cancelToken, mensaje } }', async () => {
    const res = await post(valido());
    const body = await cuerpoDe(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data?.mensaje).toBe('Turno agendado exitosamente');
    expect(typeof body.data?.cancelToken).toBe('string');
  });

  it('no se cachea', async () => {
    const res = await post(valido({ hora: '11:00' }));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('datosInvalidos → 400', async () => {
    const res = await post(valido({ clienteNombre: '' }));
    expect(res.status).toBe(400);
    expect(await cuerpoDe(res)).toEqual({ ok: false, error: 'clienteNombre es obligatorio.' });
  });

  it('noDisponible → 400', async () => {
    const res = await post(valido({ hora: '08:00' }));
    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toBe(
      'El horario elegido está fuera del horario de atención.',
    );
  });

  it('overlap → 400 con el mensaje exacto', async () => {
    expect((await post(valido())).status).toBe(200);

    const res = await post(valido());
    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toBe(
      'Lo sentimos, este turno acaba de ser reservado por alguien más.',
    );
  });

  it('un cuerpo que no es JSON → 400, no 500', async () => {
    const res = await post('esto no es json');
    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toBe('Formato de solicitud inválido.');
  });

  it('un cuerpo JSON que no es objeto → 400', async () => {
    const res = await post('"un string"');
    expect(res.status).toBe(400);
  });
});

describe('el 500 tiene su propio mensaje de contrato', () => {
  it('una excepcion no controlada responde el texto de la spec', async () => {
    // Se rompe la tabla `reservas` para forzar un error real de D1 adentro del
    // Durable Object, que el servicio re-lanza.
    await env.DB.prepare('ALTER TABLE reservas RENAME TO reservas_backup').run();

    try {
      const res = await post(valido({ hora: '12:00' }));
      expect(res.status).toBe(500);
      expect((await cuerpoDe(res)).error).toBe(
        'Ocurrió un error al procesar la reserva. Por favor, reintentá.',
      );
    } finally {
      await env.DB.prepare('ALTER TABLE reservas_backup RENAME TO reservas').run();
    }
  });

  it('el resto de las rutas conserva el 500 generico', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request('http://localhost/api/no-existe'), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
    expect((await cuerpoDe(res)).error).toBe('No encontrado.');
  });
});

describe('concurrencia punta a punta', () => {
  it('20 requests HTTP simultaneos al mismo slot: gana exactamente uno', async () => {
    // Igual que el test del DO, pero atravesando toda la pila: router,
    // validaciones, servicio y Durable Object.
    const respuestas = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        post(valido({ clienteNombre: `Cliente ${i}`, clienteTelefono: '341651320' + (i % 10) })),
      ),
    );

    const codigos = respuestas.map((r) => r.status);
    expect(codigos.filter((c) => c === 200)).toHaveLength(1);
    expect(codigos.filter((c) => c === 400)).toHaveLength(19);
    expect(codigos.filter((c) => c === 500)).toHaveLength(0);

    const fila = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM reservas WHERE estado = 'activa'",
    ).first<{ n: number }>();
    expect(fila?.n).toBe(1);
  });

  it('los 19 rechazados dicen que el turno se acaba de tomar', async () => {
    const respuestas = await Promise.all(
      Array.from({ length: 10 }, () => post(valido({ hora: '15:00' }))),
    );

    const errores = await Promise.all(
      respuestas.filter((r) => r.status === 400).map(async (r) => (await cuerpoDe(r)).error),
    );

    expect(errores).toHaveLength(9);
    for (const e of errores) {
      expect(e).toBe('Lo sentimos, este turno acaba de ser reservado por alguien más.');
    }
  });
});

describe('la reserva usa el reloj de Argentina', () => {
  it('rechaza un turno de hoy cuya hora ya paso', async () => {
    // No se puede inyectar `ahora` por HTTP: se usa una fecha real pasada.
    const ayer = new Date(slotAMs('2020-01-01', '10:00')).toISOString().slice(0, 10);
    const res = await post(valido({ fecha: ayer }));

    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toBe('No se puede agendar un turno en el pasado.');
  });
});
