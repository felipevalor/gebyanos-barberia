import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { uuidv7 } from '../../src/db/id';

const BARBERO = '01920000-0000-7000-8000-000000000001';

/** Inserta una reserva minima. Devuelve la promesa sin await para poder testear el rechazo. */
function reservar(opts: { fecha: string; hora: string; estado?: string; token?: string | null }) {
  return env.DB.prepare(
    `INSERT INTO reservas (id, barbero_id, nombre, telefono, servicio, duracion_min, fecha, hora, estado, cancel_token)
     VALUES (?, ?, 'Juan', '3416513207', 'Corte', 30, ?, ?, ?, ?)`,
  )
    .bind(uuidv7(), BARBERO, opts.fecha, opts.hora, opts.estado ?? 'activa', opts.token ?? null)
    .run();
}

describe('schema', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.MIGRATIONS);
  });

  it('crea las 13 tablas', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
    ).all<{ name: string }>();

    expect(results.map((r) => r.name).sort()).toEqual([
      'admin_sessions',
      'barbero_horarios',
      'barberos',
      'catalogo',
      'clientes',
      'clientes_recurrentes',
      'feriados_override',
      'magic_link_tokens',
      'negocio',
      'promos',
      'reservas',
      'servicios',
      'servicios_barbero',
    ]);
  });

  it('crea los 11 indices declarados', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'",
    ).all<{ name: string }>();

    expect(results.map((r) => r.name).sort()).toEqual([
      'idx_barbero_horarios',
      'idx_barberos_slug',
      'idx_feriados',
      'idx_magic_expires',
      'idx_reservas_cancel_token',
      'idx_reservas_fecha',
      'idx_reservas_slot',
      'idx_reservas_telefono',
      'idx_servicios_barbero',
      'idx_servicios_nombre',
      'idx_sessions_expires',
    ]);
  });

  it('el indice de barbero_horarios NO es unico: entran dos bloques el mismo dia', async () => {
    const barberoId = uuidv7();
    await env.DB.prepare("INSERT INTO barberos (id, slug, nombre) VALUES (?, ?, 'Cortado')")
      .bind(barberoId, 'slug-' + barberoId)
      .run();

    // Horario cortado: manana y tarde del mismo dow. Si el indice fuera unico,
    // el segundo insert explotaria.
    await env.DB.prepare(
      'INSERT INTO barbero_horarios (id, barbero_id, dow, hora_inicio, hora_fin) VALUES (?, ?, 1, 9, 13)',
    )
      .bind(uuidv7(), barberoId)
      .run();

    await expect(
      env.DB.prepare(
        'INSERT INTO barbero_horarios (id, barbero_id, dow, hora_inicio, hora_fin) VALUES (?, ?, 1, 16, 20)',
      )
        .bind(uuidv7(), barberoId)
        .run(),
    ).resolves.toBeDefined();

    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM barbero_horarios WHERE barbero_id = ? AND dow = 1',
    )
      .bind(barberoId)
      .first<{ n: number }>();
    expect(row?.n).toBe(2);
  });
});

describe('anti-doble-reserva', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.MIGRATIONS);
    await env.DB.prepare('DELETE FROM reservas').run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO barberos (id, slug, nombre, rol) VALUES (?, 'gaby', 'Gaby', 'owner')",
    )
      .bind(BARBERO)
      .run();
  });

  it('dos reservas activas en el mismo slot: la segunda falla', async () => {
    await reservar({ fecha: '2026-09-01', hora: '10:00' });

    await expect(reservar({ fecha: '2026-09-01', hora: '10:00' })).rejects.toThrowError(
      /UNIQUE constraint failed/,
    );
  });

  it('una reserva cancelada NO bloquea el slot', async () => {
    await reservar({ fecha: '2026-09-02', hora: '11:00', estado: 'cancelada' });

    await expect(reservar({ fecha: '2026-09-02', hora: '11:00' })).resolves.toBeDefined();
  });

  it('cancel_token es unico, pero varios NULL conviven', async () => {
    await reservar({ fecha: '2026-09-03', hora: '09:00', token: 'tok-1' });

    await expect(
      reservar({ fecha: '2026-09-03', hora: '09:30', token: 'tok-1' }),
    ).rejects.toThrowError(/UNIQUE constraint failed/);

    // Dos sin token no chocan: el indice es parcial sobre IS NOT NULL.
    await reservar({ fecha: '2026-09-04', hora: '09:00' });
    await expect(reservar({ fecha: '2026-09-04', hora: '09:30' })).resolves.toBeDefined();
  });
});

/**
 * Las 10 relaciones de la tarea 1.2, una por una. Son decisiones deliberadas,
 * no defaults: un CASCADE donde iba SET NULL es perdida de historial, y al
 * reves es basura acumulada.
 */
describe('delete behaviors', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.MIGRATIONS);
  });

  /** Crea un barbero descartable y devuelve su id. */
  async function nuevoBarbero(): Promise<string> {
    const id = uuidv7();
    await env.DB.prepare("INSERT INTO barberos (id, slug, nombre) VALUES (?, ?, 'Temporal')")
      .bind(id, 'slug-' + id)
      .run();
    return id;
  }

  async function nuevoCliente(): Promise<string> {
    const id = uuidv7();
    await env.DB.prepare("INSERT INTO clientes (id, nombre) VALUES (?, 'Cliente')").bind(id).run();
    return id;
  }

  async function nuevoServicio(): Promise<string> {
    const id = uuidv7();
    await env.DB.prepare('INSERT INTO servicios (id, nombre) VALUES (?, ?)')
      .bind(id, 'Servicio ' + id)
      .run();
    return id;
  }

  async function nuevaReserva(campos: {
    barberoId?: string;
    clienteId?: string;
    servicioId?: string;
    hora?: string;
  }): Promise<string> {
    const id = uuidv7();
    await env.DB.prepare(
      `INSERT INTO reservas (id, barbero_id, cliente_id, servicio_id, nombre, telefono, servicio, fecha, hora)
       VALUES (?, ?, ?, ?, 'Juan', '3416513207', 'Corte', '2027-01-01', ?)`,
    )
      .bind(
        id,
        campos.barberoId ?? null,
        campos.clienteId ?? null,
        campos.servicioId ?? null,
        campos.hora ?? '10:00',
      )
      .run();
    return id;
  }

  const contar = async (sql: string, id: string): Promise<number> =>
    (await env.DB.prepare(sql).bind(id).first<{ n: number }>())?.n ?? -1;

  it('reservas.cliente_id → SET NULL: la reserva sobrevive al borrado del cliente', async () => {
    const clienteId = await nuevoCliente();
    const reservaId = await nuevaReserva({ clienteId, hora: '11:00' });

    await env.DB.prepare('DELETE FROM clientes WHERE id = ?').bind(clienteId).run();

    const row = await env.DB.prepare('SELECT cliente_id, nombre FROM reservas WHERE id = ?')
      .bind(reservaId)
      .first<{ cliente_id: string | null; nombre: string }>();
    expect(row?.cliente_id).toBeNull();
    expect(row?.nombre).toBe('Juan'); // el snapshot sobrevive
  });

  it('reservas.servicio_id → SET NULL: la reserva conserva el nombre del servicio', async () => {
    const servicioId = await nuevoServicio();
    const reservaId = await nuevaReserva({ servicioId, hora: '11:30' });

    await env.DB.prepare('DELETE FROM servicios WHERE id = ?').bind(servicioId).run();

    const row = await env.DB.prepare('SELECT servicio_id, servicio FROM reservas WHERE id = ?')
      .bind(reservaId)
      .first<{ servicio_id: string | null; servicio: string }>();
    expect(row?.servicio_id).toBeNull();
    expect(row?.servicio).toBe('Corte'); // el snapshot sobrevive
  });

  it('clientes_recurrentes.barbero_id → CASCADE: borrar el barbero se lleva sus recurrentes', async () => {
    // PERDIDA DE DATOS DELIBERADA: un recurrente sin barbero no tiene sentido,
    // el cron no podria generarle turno. Queda fijado para que nadie lo
    // convierta en SET NULL sin darse cuenta.
    const barberoId = await nuevoBarbero();
    const clienteId = await nuevoCliente();
    await env.DB.prepare(
      "INSERT INTO clientes_recurrentes (id, barbero_id, cliente_id, servicio) VALUES (?, ?, ?, 'Corte')",
    )
      .bind(uuidv7(), barberoId, clienteId)
      .run();

    await env.DB.prepare('DELETE FROM barberos WHERE id = ?').bind(barberoId).run();

    expect(
      await contar('SELECT COUNT(*) AS n FROM clientes_recurrentes WHERE barbero_id = ?', barberoId),
    ).toBe(0);
    // El cliente NO se va: solo el vinculo recurrente.
    expect(await contar('SELECT COUNT(*) AS n FROM clientes WHERE id = ?', clienteId)).toBe(1);
  });

  it('clientes_recurrentes.servicio_id → SET NULL: el recurrente conserva el nombre', async () => {
    const barberoId = await nuevoBarbero();
    const clienteId = await nuevoCliente();
    const servicioId = await nuevoServicio();
    const recurrenteId = uuidv7();
    await env.DB.prepare(
      "INSERT INTO clientes_recurrentes (id, barbero_id, cliente_id, servicio, servicio_id) VALUES (?, ?, ?, 'Corte', ?)",
    )
      .bind(recurrenteId, barberoId, clienteId, servicioId)
      .run();

    await env.DB.prepare('DELETE FROM servicios WHERE id = ?').bind(servicioId).run();

    const row = await env.DB.prepare(
      'SELECT servicio_id, servicio FROM clientes_recurrentes WHERE id = ?',
    )
      .bind(recurrenteId)
      .first<{ servicio_id: string | null; servicio: string }>();
    expect(row?.servicio_id).toBeNull();
    expect(row?.servicio).toBe('Corte');
  });

  it('feriados_override.barbero_id → CASCADE', async () => {
    const barberoId = await nuevoBarbero();
    await env.DB.prepare(
      "INSERT INTO feriados_override (id, barbero_id, fecha) VALUES (?, ?, '2026-12-25')",
    )
      .bind(uuidv7(), barberoId)
      .run();

    await env.DB.prepare('DELETE FROM barberos WHERE id = ?').bind(barberoId).run();

    expect(
      await contar('SELECT COUNT(*) AS n FROM feriados_override WHERE barbero_id = ?', barberoId),
    ).toBe(0);
  });

  it('admin_sessions.barbero_id → CASCADE: borrar el barbero cierra sus sesiones', async () => {
    const barberoId = await nuevoBarbero();
    await env.DB.prepare(
      "INSERT INTO admin_sessions (id, barbero_id, expires_at) VALUES (?, ?, '2027-01-01T00:00:00Z')",
    )
      .bind(uuidv7(), barberoId)
      .run();

    await env.DB.prepare('DELETE FROM barberos WHERE id = ?').bind(barberoId).run();

    expect(
      await contar('SELECT COUNT(*) AS n FROM admin_sessions WHERE barbero_id = ?', barberoId),
    ).toBe(0);
  });

  it('servicios_barbero → CASCADE por los dos lados', async () => {
    // Lado barbero.
    const barberoId = await nuevoBarbero();
    const servicioA = await nuevoServicio();
    await env.DB.prepare(
      'INSERT INTO servicios_barbero (id, barbero_id, servicio_id) VALUES (?, ?, ?)',
    )
      .bind(uuidv7(), barberoId, servicioA)
      .run();

    await env.DB.prepare('DELETE FROM barberos WHERE id = ?').bind(barberoId).run();
    expect(
      await contar('SELECT COUNT(*) AS n FROM servicios_barbero WHERE barbero_id = ?', barberoId),
    ).toBe(0);

    // Lado servicio.
    const otroBarbero = await nuevoBarbero();
    const servicioB = await nuevoServicio();
    await env.DB.prepare(
      'INSERT INTO servicios_barbero (id, barbero_id, servicio_id) VALUES (?, ?, ?)',
    )
      .bind(uuidv7(), otroBarbero, servicioB)
      .run();

    await env.DB.prepare('DELETE FROM servicios WHERE id = ?').bind(servicioB).run();
    expect(
      await contar('SELECT COUNT(*) AS n FROM servicios_barbero WHERE servicio_id = ?', servicioB),
    ).toBe(0);
  });

  it('magic_link_tokens.reserva_id → SET NULL: el token sobrevive a la reserva', async () => {
    const reservaId = await nuevaReserva({ hora: '12:00' });
    const jti = uuidv7();
    await env.DB.prepare(
      "INSERT INTO magic_link_tokens (jti, reserva_id, expires_at) VALUES (?, ?, '2027-01-01T00:00:00Z')",
    )
      .bind(jti, reservaId)
      .run();

    await env.DB.prepare('DELETE FROM reservas WHERE id = ?').bind(reservaId).run();

    const row = await env.DB.prepare('SELECT reserva_id FROM magic_link_tokens WHERE jti = ?')
      .bind(jti)
      .first<{ reserva_id: string | null }>();
    expect(row).not.toBeNull(); // el token no se borra
    expect(row?.reserva_id).toBeNull();
  });

  it('borrar un barbero preserva la reserva con barbero_id en NULL', async () => {
    const barberoId = uuidv7();
    const reservaId = uuidv7();
    await env.DB.prepare(
      "INSERT INTO barberos (id, slug, nombre) VALUES (?, ?, 'Temporal')",
    )
      .bind(barberoId, 'temp-' + barberoId)
      .run();
    await env.DB.prepare(
      `INSERT INTO reservas (id, barbero_id, nombre, telefono, servicio, fecha, hora)
       VALUES (?, ?, 'Juan', '3416513207', 'Corte', '2027-01-01', '10:00')`,
    )
      .bind(reservaId, barberoId)
      .run();

    await env.DB.prepare('DELETE FROM barberos WHERE id = ?').bind(barberoId).run();

    const row = await env.DB.prepare('SELECT barbero_id, nombre FROM reservas WHERE id = ?')
      .bind(reservaId)
      .first<{ barbero_id: string | null; nombre: string }>();

    expect(row).not.toBeNull();
    expect(row?.barbero_id).toBeNull();
    expect(row?.nombre).toBe('Juan'); // el snapshot sobrevive
  });

  it('no se puede borrar un cliente con recurrentes (RESTRICT)', async () => {
    const barberoId = uuidv7();
    const clienteId = uuidv7();
    await env.DB.prepare("INSERT INTO barberos (id, slug, nombre) VALUES (?, ?, 'Temporal')")
      .bind(barberoId, 'temp-' + barberoId)
      .run();
    await env.DB.prepare("INSERT INTO clientes (id, nombre) VALUES (?, 'Recurrente')")
      .bind(clienteId)
      .run();
    await env.DB.prepare(
      "INSERT INTO clientes_recurrentes (id, barbero_id, cliente_id, servicio) VALUES (?, ?, ?, 'Corte')",
    )
      .bind(uuidv7(), barberoId, clienteId)
      .run();

    await expect(
      env.DB.prepare('DELETE FROM clientes WHERE id = ?').bind(clienteId).run(),
    ).rejects.toThrowError(/FOREIGN KEY constraint failed/);
  });

  it('borrar un barbero arrastra sus horarios (CASCADE)', async () => {
    const barberoId = uuidv7();
    await env.DB.prepare("INSERT INTO barberos (id, slug, nombre) VALUES (?, ?, 'Temporal')")
      .bind(barberoId, 'temp-' + barberoId)
      .run();
    await env.DB.prepare(
      'INSERT INTO barbero_horarios (id, barbero_id, dow) VALUES (?, ?, 1)',
    )
      .bind(uuidv7(), barberoId)
      .run();

    await env.DB.prepare('DELETE FROM barberos WHERE id = ?').bind(barberoId).run();

    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM barbero_horarios WHERE barbero_id = ?',
    )
      .bind(barberoId)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

describe('uuidv7', () => {
  it('genera IDs ordenables por tiempo', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_001_000);
    expect(a < b).toBe(true);
  });

  it('tiene la version 7 y la variante RFC 4122', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
