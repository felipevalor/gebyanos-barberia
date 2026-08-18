import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import worker from '../../src/index';
import { uuidv7 } from '../../src/db/id';
import { addDays, todayArgentina } from '../../src/domain/dates';
import {
  emitirToken,
  validarToken,
  revocarTokensDe,
  validarClave,
  claveConfigurada,
  ttlMinutos,
  ERRORES,
  LARGO_MIN_CLAVE,
} from '../../src/services/magic-link';

const BARBERO = '01930000-0000-7000-8000-00000009f001';
/**
 * ⚠️ EN LA BASE VA LA FORMA CANONICA: 10 digitos, sin +54, sin el 9 y sin el
 * 15. Sembrar "+5493416513207" —como hice la primera vez— deja un turno que
 * la busqueda nunca encuentra, porque `normalizeTel` compara contra esto.
 */
const TEL = '3416513207';
const OTRO_TEL = '3415559999';
const CLAVE = 'una-clave-de-firma-de-al-menos-32-caracteres';

let FUTURO = '';

const ip = () => `192.0.2.150-${uuidv7()}`;

async function pedir(
  ruta: string,
  o: { metodo?: string; cuerpo?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'cf-connecting-ip': ip() };
  if (o.cuerpo !== undefined) headers['content-type'] = 'application/json';

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

async function sembrarTurno(o: { fecha?: string; hora?: string; telefono?: string } = {}) {
  const id = uuidv7();
  await env.DB.prepare(
    `INSERT INTO reservas (id, barbero_id, nombre, telefono, servicio, duracion_min, fecha, hora, cancel_token)
     VALUES (?, ?, 'Juan Pérez', ?, 'Corte', 30, ?, ?, ?)`,
  )
    .bind(id, BARBERO, o.telefono ?? TEL, o.fecha ?? FUTURO, o.hora ?? '10:00', uuidv7())
    .run();
  return id;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
  await env.DB.prepare('INSERT OR REPLACE INTO negocio (id) VALUES (1)').run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO barberos (id, slug, nombre) VALUES (?, 'magic', 'Magic')",
  )
    .bind(BARBERO)
    .run();

  // Horario amplio para que reprogramar no choque contra el horario.
  const filas = [0, 1, 2, 3, 4, 5, 6].map((dow) =>
    env.DB.prepare(
      'INSERT INTO barbero_horarios (id, barbero_id, dow, activo, hora_inicio, hora_fin) VALUES (?, ?, ?, 1, 8, 22)',
    ).bind(uuidv7(), BARBERO, dow),
  );
  await env.DB.batch(filas);
});

beforeEach(async () => {
  env.MAGIC_LINK_SECRET = CLAVE;
  env.MAGIC_LINK_TTL_MIN = '15';
  FUTURO = addDays(todayArgentina(), 10);

  await env.DB.batch([
    env.DB.prepare('DELETE FROM magic_link_tokens'),
    env.DB.prepare('DELETE FROM reservas'),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ==========================================================================

describe('🔴 la clave de firma', () => {
  it('sin clave o con menos de 32 caracteres, falla ruidosamente', () => {
    // Una clave débil no rompe nada visible: el sistema anda y cualquiera
    // puede forjar tokens. Es el tipo de mala configuración que llega a
    // producción sin que nadie la note.
    for (const mala of ['', '   ', 'a'.repeat(LARGO_MIN_CLAVE - 1)]) {
      env.MAGIC_LINK_SECRET = mala;
      expect(claveConfigurada(env), JSON.stringify(mala)).toBe(false);
      expect(() => validarClave(env)).toThrow(/MAGIC_LINK_SECRET/);
    }
  });

  it('el mensaje dice cómo arreglarlo', () => {
    env.MAGIC_LINK_SECRET = '';
    expect(() => validarClave(env)).toThrow('wrangler secret put MAGIC_LINK_SECRET');
  });

  it('con 32 caracteres exactos alcanza', () => {
    env.MAGIC_LINK_SECRET = 'a'.repeat(LARGO_MIN_CLAVE);
    expect(claveConfigurada(env)).toBe(true);
    expect(() => validarClave(env)).not.toThrow();
  });

  it('el TTL sale del entorno, con default de 15 y topes sanos', () => {
    env.MAGIC_LINK_TTL_MIN = '30';
    expect(ttlMinutos(env)).toBe(30);

    for (const malo of ['', 'abc', '0', '-5', '99999']) {
      env.MAGIC_LINK_TTL_MIN = malo;
      expect(ttlMinutos(env), malo).toBe(15);
    }
  });
});

describe('🔴 los diez pasos, en orden', () => {
  it('1. token vacío', async () => {
    expect(await validarToken(env, '')).toEqual({ ok: false, motivo: ERRORES.vacio });
    expect(await validarToken(env, undefined)).toEqual({ ok: false, motivo: ERRORES.vacio });
  });

  it('2. formato: un solo punto, ninguna mitad vacía', async () => {
    for (const malo of ['sinpunto', 'a.b.c', '.firma', 'payload.']) {
      expect(await validarToken(env, malo), malo).toEqual({ ok: false, motivo: ERRORES.formato });
    }
  });

  it('🔴 3. LA FIRMA SE VERIFICA ANTES DE TOCAR LA BASE', async () => {
    // Es lo más importante de la función. Si el orden fuera al revés, los
    // tiempos de respuesta permitirían sondear qué jti existen: uno real
    // tardaría distinto que uno inventado, y se enumera la tabla sin conocer
    // un solo teléfono.
    const id = await sembrarTurno();
    const { token } = await emitirToken(env, id);

    const [payload] = token.split('.');
    const forjado = `${payload}.${'A'.repeat(43)}`;

    // Se espía la base ENTERA: si el chequeo de firma llegara después, acá
    // habría al menos una query.
    const espia = vi.spyOn(env.DB, 'prepare');

    const r = await validarToken(env, forjado);

    expect(r).toEqual({ ok: false, motivo: ERRORES.firma });
    expect(espia).not.toHaveBeenCalled();
  });

  it('3b. un payload alterado invalida la firma', async () => {
    const id = await sembrarTurno();
    const { token } = await emitirToken(env, id);
    const [, firma] = token.split('.');

    const otroPayload = btoa(JSON.stringify({ jti: uuidv7(), rid: id, exp: 9999999999, purpose: 'access' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    expect(await validarToken(env, `${otroPayload}.${firma}`)).toEqual({
      ok: false,
      motivo: ERRORES.firma,
    });
  });

  it('3c. otra clave de firma no valida', async () => {
    const id = await sembrarTurno();
    const { token } = await emitirToken(env, id);

    env.MAGIC_LINK_SECRET = 'otra-clave-completamente-distinta-de-32+';
    expect(await validarToken(env, token)).toEqual({ ok: false, motivo: ERRORES.firma });
  });

  it('5. expirado por el `exp` del payload', async () => {
    const id = await sembrarTurno();
    const emitido = await emitirToken(env, id);
    const dentroDeUnaHora = new Date(Date.now() + 60 * 60 * 1000);

    expect(await validarToken(env, emitido.token, { ahora: dentroDeUnaHora })).toEqual({
      ok: false,
      motivo: ERRORES.expirado,
    });
  });

  it('6. token no encontrado: firma válida pero sin fila', async () => {
    const id = await sembrarTurno();
    const emitido = await emitirToken(env, id);

    await env.DB.prepare('DELETE FROM magic_link_tokens WHERE jti = ?').bind(emitido.jti).run();

    expect(await validarToken(env, emitido.token)).toEqual({
      ok: false,
      motivo: ERRORES.noEncontrado,
    });
  });

  it('7. token revocado', async () => {
    const id = await sembrarTurno();
    const emitido = await emitirToken(env, id);
    await revocarTokensDe(env, id);

    expect(await validarToken(env, emitido.token)).toEqual({
      ok: false,
      motivo: ERRORES.revocado,
    });
  });

  it('🔴 8. expirado por la FILA, aunque el payload diga que vale', async () => {
    // Los pasos 5 y 8 chequean lo mismo a propósito: defensa en profundidad.
    // La firma prueba autoría; la fila es la fuente de verdad final.
    const id = await sembrarTurno();
    const emitido = await emitirToken(env, id);

    await env.DB.prepare('UPDATE magic_link_tokens SET expires_at = ? WHERE jti = ?')
      .bind('2020-01-01T00:00:00.000Z', emitido.jti)
      .run();

    expect(await validarToken(env, emitido.token)).toEqual({
      ok: false,
      motivo: ERRORES.expirado,
    });
  });

  it('9 y 10. single-use: la segunda vez da "ya utilizado"', async () => {
    const id = await sembrarTurno();
    const emitido = await emitirToken(env, id, 'cancel');

    expect((await validarToken(env, emitido.token, { consumir: true })).ok).toBe(true);
    expect(await validarToken(env, emitido.token, { consumir: true })).toEqual({
      ok: false,
      motivo: ERRORES.usado,
    });
  });

  it('🔴 9. un token ya usado se rechaza SIN escribir en la base', async () => {
    // El paso 9 es redundante con el compare-and-set del paso 10 —una mutación
    // que lo borraba sobrevivía— pero no es equivalente: sin él, cada
    // validación de un token ya quemado dispara un UPDATE inútil. En D1 free
    // las escrituras se cuentan, y este es el camino que recorre cualquiera
    // que recargue la página de cancelación.
    const id = await sembrarTurno();
    const emitido = await emitirToken(env, id, 'cancel');
    await validarToken(env, emitido.token, { consumir: true });

    const sentencias: string[] = [];
    const original = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      sentencias.push(sql);
      return original(sql);
    });

    const r = await validarToken(env, emitido.token, { consumir: true });

    expect(r).toEqual({ ok: false, motivo: ERRORES.usado });
    expect(sentencias.some((q) => /update/i.test(q))).toBe(false);
  });

  it('multi-uso: sin consumir, se puede validar muchas veces', async () => {
    const id = await sembrarTurno();
    const emitido = await emitirToken(env, id);

    for (let i = 0; i < 3; i++) {
      expect((await validarToken(env, emitido.token)).ok, `intento ${i}`).toBe(true);
    }
  });

  it('🔴 dos consumos SIMULTÁNEOS: solo uno gana', async () => {
    // Los dos pasan el chequeo del paso 9 —leen antes de que el otro escriba—
    // así que la garantía real es el `used_at IS NULL` del WHERE del UPDATE.
    const id = await sembrarTurno();
    const emitido = await emitirToken(env, id, 'cancel');

    const [a, b] = await Promise.all([
      validarToken(env, emitido.token, { consumir: true }),
      validarToken(env, emitido.token, { consumir: true }),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });
});

describe('buscar por teléfono', () => {
  it('🔴 NO devuelve el cancel_token', async () => {
    // El sistema viejo lo devuelve, y eso convierte la búsqueda en una puerta
    // trasera: con un teléfono alcanzaría para cancelar sin pasar por el link.
    await sembrarTurno();

    const res = await pedir('/api/mi-turno/buscar', { metodo: 'POST', cuerpo: { telefono: TEL } });
    const cuerpo = await res.text();

    expect(res.status).toBe(200);
    expect(cuerpo).not.toContain('cancelToken');
    expect(cuerpo).not.toContain('cancel_token');
  });

  it('normaliza el teléfono: el cliente escribe como quiere', async () => {
    await sembrarTurno();

    for (const forma of ['0341 15 651-3207', '+54 9 341 651 3207', '3416513207']) {
      const { data } = await cuerpoDe(
        await pedir('/api/mi-turno/buscar', { metodo: 'POST', cuerpo: { telefono: forma } }),
      );
      expect(data.length, forma).toBe(1);
    }
  });

  it('solo turnos activos y futuros', async () => {
    await sembrarTurno({ fecha: '2020-01-01' });
    await sembrarTurno({ fecha: FUTURO, hora: '11:00' });

    const id = await sembrarTurno({ fecha: FUTURO, hora: '12:00' });
    await env.DB.prepare("UPDATE reservas SET estado = 'cancelada' WHERE id = ?").bind(id).run();

    const { data } = await cuerpoDe(
      await pedir('/api/mi-turno/buscar', { metodo: 'POST', cuerpo: { telefono: TEL } }),
    );
    expect(data).toHaveLength(1);
    expect(data[0].hora).toBe('11:00');
  });

  it('sin teléfono da el mensaje exacto', async () => {
    const res = await pedir('/api/mi-turno/buscar', { metodo: 'POST', cuerpo: {} });

    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toBe('El teléfono es obligatorio.');
  });
});

describe('🔴 el control de ownership', () => {
  it('pedir un link con el teléfono de otro da 401', async () => {
    const id = await sembrarTurno();

    const res = await pedir('/api/mi-turno/access-link', {
      metodo: 'POST',
      cuerpo: { reservaId: id, telefono: OTRO_TEL },
    });

    expect(res.status).toBe(401);
    expect((await cuerpoDe(res)).error).toBe('No autorizado.');
  });

  it('🔴 una reserva inexistente da el MISMO 401, no un 404', async () => {
    // Distinguirlos convertiría el endpoint en un oráculo de qué reservas
    // existen, que es justo lo que no se puede regalar cuando el teléfono es
    // toda la credencial.
    const res = await pedir('/api/mi-turno/access-link', {
      metodo: 'POST',
      cuerpo: { reservaId: uuidv7(), telefono: TEL },
    });

    expect(res.status).toBe(401);
    expect((await cuerpoDe(res)).error).toBe('No autorizado.');
  });

  it('con el teléfono correcto emite el token', async () => {
    const id = await sembrarTurno();

    const { data } = await cuerpoDe(
      await pedir('/api/mi-turno/access-link', {
        metodo: 'POST',
        cuerpo: { reservaId: id, telefono: TEL },
      }),
    );

    expect(data.token.split('.')).toHaveLength(2);
    expect(new Date(data.expiraEn).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('el flujo completo del cliente', () => {
  const linkDe = async (id: string) => {
    const { data } = await cuerpoDe(
      await pedir('/api/mi-turno/access-link', {
        metodo: 'POST',
        cuerpo: { reservaId: id, telefono: TEL },
      }),
    );
    return data.token as string;
  };

  it('ver el turno dos veces con el mismo token funciona', async () => {
    const id = await sembrarTurno();
    const token = await linkDe(id);

    for (let i = 0; i < 2; i++) {
      const res = await pedir(`/api/mi-turno?token=${encodeURIComponent(token)}`);
      expect(res.status, `intento ${i}`).toBe(200);
      expect((await cuerpoDe(res)).data.hora).toBe('10:00');
    }
  });

  it('🔴 reprogramar al MISMO horario no choca consigo mismo', async () => {
    // Es donde se equivoca todo el mundo: sin excluir la reserva que se está
    // moviendo, el cliente ve "ese horario ya está ocupado" señalando su
    // propio turno.
    const id = await sembrarTurno();
    const token = await linkDe(id);

    const res = await pedir(`/api/mi-turno?token=${encodeURIComponent(token)}`, {
      metodo: 'PUT',
      cuerpo: { fecha: FUTURO, hora: '10:00' },
    });

    expect(res.status).toBe(200);
  });

  it('reprogramar mueve el turno y conserva el id', async () => {
    const id = await sembrarTurno();
    const token = await linkDe(id);

    const { data } = await cuerpoDe(
      await pedir(`/api/mi-turno?token=${encodeURIComponent(token)}`, {
        metodo: 'PUT',
        cuerpo: { fecha: FUTURO, hora: '15:30' },
      }),
    );

    expect(data.id).toBe(id);
    expect(data.hora).toBe('15:30');
  });

  it('reprogramar a un slot ocupado da 409', async () => {
    const id = await sembrarTurno();
    await sembrarTurno({ hora: '16:00', telefono: OTRO_TEL });
    const token = await linkDe(id);

    const res = await pedir(`/api/mi-turno?token=${encodeURIComponent(token)}`, {
      metodo: 'PUT',
      cuerpo: { fecha: FUTURO, hora: '16:00' },
    });

    expect(res.status).toBe(409);
    expect((await cuerpoDe(res)).error).toBe('Ese horario ya está ocupado. Elegí otro.');
  });

  it('no se puede mover a una fecha pasada', async () => {
    const id = await sembrarTurno();
    const token = await linkDe(id);

    const res = await pedir(`/api/mi-turno?token=${encodeURIComponent(token)}`, {
      metodo: 'PUT',
      cuerpo: { fecha: '2020-01-01', hora: '10:00' },
    });

    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toBe('No se puede agendar un turno en el pasado.');
  });

  it('cancelar deja la fila y libera el slot', async () => {
    const id = await sembrarTurno();
    const token = await linkDe(id);

    expect((await pedir(`/api/mi-turno/cancel?token=${encodeURIComponent(token)}`, { metodo: 'POST' })).status).toBe(200);

    const fila = await env.DB.prepare('SELECT estado, cancelada_at FROM reservas WHERE id = ?')
      .bind(id)
      .first<{ estado: string; cancelada_at: string }>();

    // SOFT DELETE: la fila sigue.
    expect(fila?.estado).toBe('cancelada');
    expect(fila?.cancelada_at).toBeTruthy();

    // Y el slot se libera: el índice único parcial solo mira las activas.
    const nuevo = await sembrarTurno({ hora: '10:00', telefono: OTRO_TEL });
    expect(nuevo).toBeTruthy();
  });

  it('cancelar dos veces: la segunda da "Token ya utilizado"', async () => {
    const id = await sembrarTurno();
    const token = await linkDe(id);
    const url = `/api/mi-turno/cancel?token=${encodeURIComponent(token)}`;

    expect((await pedir(url, { metodo: 'POST' })).status).toBe(200);

    const segunda = await pedir(url, { metodo: 'POST' });
    expect(segunda.status).toBe(401);
    expect((await cuerpoDe(segunda)).error).toBe(ERRORES.usado);
  });

  it('🔴 después de cancelar, un link emitido ANTES queda revocado', async () => {
    // Sin esto, un link viejo en el historial del browser sigue mostrando un
    // turno que ya no existe.
    const id = await sembrarTurno();
    const viejo = await linkDe(id);
    const conElQueCancela = await linkDe(id);

    await pedir(`/api/mi-turno/cancel?token=${encodeURIComponent(conElQueCancela)}`, {
      metodo: 'POST',
    });

    const res = await pedir(`/api/mi-turno?token=${encodeURIComponent(viejo)}`);
    expect(res.status).toBe(401);
    expect((await cuerpoDe(res)).error).toBe(ERRORES.revocado);
  });

  it('no se puede cancelar un turno pasado', async () => {
    const id = await sembrarTurno();
    const token = await linkDe(id);
    await env.DB.prepare("UPDATE reservas SET fecha = '2020-01-01' WHERE id = ?").bind(id).run();

    const res = await pedir(`/api/mi-turno/cancel?token=${encodeURIComponent(token)}`, {
      metodo: 'POST',
    });

    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toBe('No se puede cancelar un turno pasado.');
  });

  it('un token sin firma válida no llega a ningún endpoint', async () => {
    for (const ruta of ['/api/mi-turno?token=basura', '/api/mi-turno/cancel?token=basura']) {
      const res = await pedir(ruta, { metodo: ruta.includes('cancel') ? 'POST' : 'GET' });
      expect(res.status, ruta).toBe(401);
    }
  });
});
