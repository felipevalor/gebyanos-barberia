import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { crearReserva, MENSAJE_EXITO, type EntradaReserva } from '../../src/services/reserva';
import { MENSAJE_OVERLAP } from '../../src/do/BarberoAgenda';
import type { HooksReserva } from '../../src/services/hooks-reserva';
import { uuidv7 } from '../../src/db/id';
import { slotAMs } from '../../src/domain/dates';

const BARBERO = '01930000-0000-7000-8000-0000000000e1';
const INACTIVO = '01930000-0000-7000-8000-0000000000e2';
const SERVICIO = '01930000-0000-7000-8000-0000000000f1';
const SERVICIO_60 = '01930000-0000-7000-8000-0000000000f2';

const HOY = '2027-03-10';
const FUTURO = '2027-03-15';
/** Instante de hoy a las 08:00 de Argentina. */
const AHORA = new Date(slotAMs(HOY, '08:00'));

/** Hooks que no hacen nada: los reales se prueban aparte. */
const hooksMudos: HooksReserva = { async ejecutar() {} };

function entrada(over: Partial<EntradaReserva> = {}): EntradaReserva {
  return {
    barberoId: BARBERO,
    servicioId: SERVICIO,
    fecha: FUTURO,
    hora: '10:00',
    clienteNombre: 'Juan Pérez',
    clienteTelefono: '3416513207',
    ...over,
  };
}

const reservar = (over: Partial<EntradaReserva> = {}, ahora = AHORA) =>
  crearReserva(env, entrada(over), { ahora, hooks: hooksMudos });

/** Devuelve el mensaje de error, o null si salio bien. */
const errorDe = (r: Awaited<ReturnType<typeof reservar>>) =>
  r.estado === 'exito' ? null : r.error;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
  await env.DB.prepare('INSERT OR REPLACE INTO negocio (id) VALUES (1)').run();

  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO barberos (id, slug, nombre) VALUES (?, 'act', 'Activo')").bind(BARBERO),
    env.DB.prepare("INSERT OR IGNORE INTO barberos (id, slug, nombre, activo) VALUES (?, 'inact', 'Inactivo', 0)").bind(INACTIVO),
    env.DB.prepare("INSERT OR IGNORE INTO servicios (id, nombre, duracion_min) VALUES (?, 'Corte', 30)").bind(SERVICIO),
    env.DB.prepare("INSERT OR IGNORE INTO servicios (id, nombre, duracion_min) VALUES (?, 'Corte y barba', 60)").bind(SERVICIO_60),
  ]);

  // Horario 9-13 y 16-20 todos los dias, para los dos barberos.
  for (const barbero of [BARBERO, INACTIVO]) {
    for (let dow = 0; dow <= 6; dow++) {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO barbero_horarios (id, barbero_id, dow, hora_inicio, hora_fin) VALUES (?, ?, ?, 9, 13)').bind(uuidv7(), barbero, dow),
        env.DB.prepare('INSERT INTO barbero_horarios (id, barbero_id, dow, hora_inicio, hora_fin) VALUES (?, ?, ?, 16, 20)').bind(uuidv7(), barbero, dow),
      ]);
    }
  }
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM reservas').run();
  await env.DB.prepare('DELETE FROM clientes').run();
  await env.DB.prepare('DELETE FROM feriados_override').run();
});

// ------------------------------------------------------- validacion de forma

describe('validacion de forma — mensajes textuales', () => {
  const casos: [string, Partial<EntradaReserva>, string][] = [
    ['sin barberoId', { barberoId: '' }, 'barberoId es obligatorio.'],
    ['sin servicioId', { servicioId: '' }, 'servicioId es obligatorio.'],
    ['sin fecha', { fecha: '' }, 'fecha es obligatoria.'],
    ['sin hora', { hora: '' }, 'Formato de hora inválido. Usá HH:mm.'],
    ['hora sin padding', { hora: '9:00' }, 'Formato de hora inválido. Usá HH:mm.'],
    ['hora con formato raro', { hora: '10.00' }, 'Formato de hora inválido. Usá HH:mm.'],
    ['sin nombre', { clienteNombre: '' }, 'clienteNombre es obligatorio.'],
    ['nombre de 101', { clienteNombre: 'a'.repeat(101) }, 'El nombre no puede superar los 100 caracteres.'],
    ['sin telefono', { clienteTelefono: '' }, 'clienteTelefono es obligatorio.'],
    ['telefono de 21', { clienteTelefono: '1'.repeat(21) }, 'El teléfono no puede superar los 20 caracteres.'],
    ['mensaje de 501', { mensaje: 'a'.repeat(501) }, 'El mensaje no puede superar los 500 caracteres.'],
  ];

  for (const [nombre, over, error] of casos) {
    it(`${nombre} → "${error}"`, async () => {
      const r = await reservar(over);
      expect(r.estado).toBe('datosInvalidos');
      expect(errorDe(r)).toBe(error);
    });
  }

  it('el nombre de exactamente 100 y el mensaje de 500 pasan', async () => {
    const r = await reservar({ clienteNombre: 'a'.repeat(100), mensaje: 'b'.repeat(500) });
    expect(r.estado).toBe('exito');
  });

  it('un cuerpo sin campos falla por el primero, no por todos juntos', async () => {
    const r = await crearReserva(env, {}, { ahora: AHORA, hooks: hooksMudos });
    expect(errorDe(r)).toBe('barberoId es obligatorio.');
  });
});

// -------------------------------------------- las once validaciones, en orden

describe('las once validaciones de negocio', () => {
  it('1. fecha no parseable', async () => {
    expect(errorDe(await reservar({ fecha: '15/3/2027' }))).toBe('Formato de fecha inválido.');
    expect(errorDe(await reservar({ fecha: '2027-02-30' }))).toBe('Formato de fecha inválido.');
  });

  it('2. fecha en el pasado', async () => {
    expect(errorDe(await reservar({ fecha: '2027-03-09' }))).toBe(
      'No se puede agendar un turno en el pasado.',
    );
  });

  it('3. mas alla de la ventana de anticipacion', async () => {
    expect(errorDe(await reservar({ fecha: '2027-03-25' }))).toBe(
      'Solo se puede reservar con hasta 14 días de anticipación.',
    );
    // El dia 14 exacto entra.
    expect((await reservar({ fecha: '2027-03-24' })).estado).toBe('exito');
  });

  it('3. el mensaje usa el valor configurado, no un 14 hardcodeado', async () => {
    await env.DB.prepare('UPDATE negocio SET dias_max_anticipacion = 7 WHERE id = 1').run();
    try {
      expect(errorDe(await reservar({ fecha: '2027-03-20' }))).toBe(
        'Solo se puede reservar con hasta 7 días de anticipación.',
      );
    } finally {
      await env.DB.prepare('UPDATE negocio SET dias_max_anticipacion = 14 WHERE id = 1').run();
    }
  });

  it('4. hoy, con la hora ya pasada', async () => {
    const ahora = new Date(slotAMs(HOY, '11:00'));
    expect(errorDe(await reservar({ fecha: HOY, hora: '10:00' }, ahora))).toBe(
      'No se puede agendar un turno en un horario que ya pasó.',
    );
  });

  it('5. telefono que no es argentino', async () => {
    // El unico mensaje inventado del endpoint: la spec no lo define.
    expect(errorDe(await reservar({ clienteTelefono: '+1 212 555 1234' }))).toBe(
      'Revisá el teléfono. Tiene que ser un número argentino válido con código de área.',
    );
    // normalizeTel sola devolveria "123" y lo guardaria corrupto.
    expect(errorDe(await reservar({ clienteTelefono: '123' }))).toBe(
      'Revisá el teléfono. Tiene que ser un número argentino válido con código de área.',
    );
  });

  it('6. barbero inexistente o desactivado', async () => {
    expect(errorDe(await reservar({ barberoId: uuidv7() }))).toBe('Barbero inválido.');
    expect(errorDe(await reservar({ barberoId: INACTIVO }))).toBe('Barbero inválido.');
  });

  it('7. servicio inexistente NO rechaza: usa el default', async () => {
    const r = await reservar({ servicioId: uuidv7() });
    expect(r.estado).toBe('exito');

    const fila = await env.DB.prepare(
      'SELECT servicio, duracion_min, servicio_id FROM reservas',
    ).first<{ servicio: string; duracion_min: number; servicio_id: string | null }>();

    expect(fila?.servicio).toBe('Servicio');
    expect(fila?.duracion_min).toBe(30);
    expect(fila?.servicio_id).toBeNull();
  });

  it('7. servicio DESACTIVADO tampoco rechaza, pero no impone su duracion', async () => {
    const discontinuado = uuidv7();
    await env.DB.prepare(
      "INSERT INTO servicios (id, nombre, duracion_min, activo) VALUES (?, 'Discontinuado', 90, 0)",
    )
      .bind(discontinuado)
      .run();

    const r = await reservar({ servicioId: discontinuado });
    expect(r.estado).toBe('exito');

    const fila = await env.DB.prepare(
      'SELECT servicio, duracion_min, servicio_id FROM reservas',
    ).first<{ servicio: string; duracion_min: number; servicio_id: string | null }>();

    // Se cae al default: NO usa el nombre ni los 90 min del servicio de baja.
    expect(fila?.servicio).toBe('Servicio');
    expect(fila?.duracion_min).toBe(30);
    expect(fila?.servicio_id).toBeNull();
  });

  it('8. dia cerrado, feriado y fuera de horario usan mensajeCliente()', async () => {
    // Fuera del bloque.
    expect(errorDe(await reservar({ hora: '14:00' }))).toBe(
      'El horario elegido está fuera del horario de atención.',
    );

    // Feriado.
    await env.DB.prepare(
      'INSERT INTO feriados_override (id, barbero_id, fecha, trabaja) VALUES (?, ?, ?, 0)',
    )
      .bind(uuidv7(), BARBERO, FUTURO)
      .run();
    expect(errorDe(await reservar({}))).toBe(
      'La barbería no atiende esa fecha (feriado o cierre).',
    );
  });

  it('8. dia sin horario configurado', async () => {
    const sinHorario = uuidv7();
    await env.DB.prepare("INSERT INTO barberos (id, slug, nombre) VALUES (?, ?, 'Sin')")
      .bind(sinHorario, 's' + sinHorario)
      .run();

    expect(errorDe(await reservar({ barberoId: sinHorario }))).toBe(
      'La barbería no atiende ese día.',
    );
  });

  it('8. un servicio de 60 min no entra donde uno de 30 sí', async () => {
    expect((await reservar({ hora: '12:30' })).estado).toBe('exito');
    expect(errorDe(await reservar({ hora: '12:30', servicioId: SERVICIO_60 }))).toBe(
      'El horario elegido está fuera del horario de atención.',
    );
  });

  it('9. anticipacion minima', async () => {
    const ahora = new Date(slotAMs(HOY, '09:50'));
    expect(errorDe(await reservar({ fecha: HOY, hora: '10:00' }, ahora))).toBe(
      'Debés reservar con al menos 30 minutos de anticipación.',
    );
    // 30 minutos exactos: el limite es inclusivo.
    expect(
      (await reservar({ fecha: HOY, hora: '10:00' }, new Date(slotAMs(HOY, '09:30')))).estado,
    ).toBe('exito');
  });

  it('10. las horas imposibles las ataja la validacion de forma', async () => {
    // El regex de forma es estricto (^([01]\d|2[0-3]):[0-5]\d$), asi que
    // "99:99" y "24:00" se rechazan con el mensaje preciso en vez de caer en
    // el paso 8 y salir como "fuera del horario de atención".
    //
    // El paso 10 queda como defensa en profundidad INALCANZABLE, y esta bien
    // que lo sea. Ver docs/pendientes.md.
    for (const hora of ['99:99', '24:00', '10:60', '23:99']) {
      expect(errorDe(await reservar({ hora }))).toBe('Formato de hora inválido. Usá HH:mm.');
    }
  });

  it('11. solapamiento via el Durable Object', async () => {
    expect((await reservar({})).estado).toBe('exito');

    const segunda = await reservar({});
    expect(segunda.estado).toBe('overlap');
    expect(errorDe(segunda)).toBe(MENSAJE_OVERLAP);
    expect(errorDe(segunda)).toBe('Lo sentimos, este turno acaba de ser reservado por alguien más.');
  });
});

describe('el ORDEN de las validaciones', () => {
  it('fecha pasada gana sobre barbero invalido', async () => {
    expect(errorDe(await reservar({ fecha: '2027-03-09', barberoId: uuidv7() }))).toBe(
      'No se puede agendar un turno en el pasado.',
    );
  });

  it('la ventana de anticipacion gana sobre el barbero invalido', async () => {
    expect(errorDe(await reservar({ fecha: '2027-03-25', barberoId: uuidv7() }))).toBe(
      'Solo se puede reservar con hasta 14 días de anticipación.',
    );
  });

  it('el telefono invalido gana sobre el barbero invalido', async () => {
    expect(errorDe(await reservar({ clienteTelefono: '123', barberoId: uuidv7() }))).toBe(
      'Revisá el teléfono. Tiene que ser un número argentino válido con código de área.',
    );
  });

  it('el barbero invalido gana sobre el horario cerrado', async () => {
    expect(errorDe(await reservar({ barberoId: uuidv7(), hora: '14:00' }))).toBe(
      'Barbero inválido.',
    );
  });

  it('la disponibilidad gana sobre la anticipacion', async () => {
    // Hoy 09:50, turno hoy 14:00: esta fuera de horario Y ya paso la
    // anticipacion. Tiene que ganar el paso 8.
    const ahora = new Date(slotAMs(HOY, '09:50'));
    expect(errorDe(await reservar({ fecha: HOY, hora: '14:00' }, ahora))).toBe(
      'El horario elegido está fuera del horario de atención.',
    );
  });

  it('la forma gana sobre todo lo demas', async () => {
    expect(
      errorDe(await reservar({ clienteNombre: '', fecha: '2027-03-09', barberoId: '' })),
    ).toBe('barberoId es obligatorio.');
  });
});

// ---------------------------------------------------------------- persistencia

describe('lo que queda guardado', () => {
  it('el telefono se guarda normalizado a 10 digitos', async () => {
    expect((await reservar({ clienteTelefono: '0341 15 6513207' })).estado).toBe('exito');

    const reserva = await env.DB.prepare('SELECT telefono FROM reservas').first<{ telefono: string }>();
    const cliente = await env.DB.prepare('SELECT telefono FROM clientes').first<{ telefono: string }>();

    expect(reserva?.telefono).toBe('3416513207');
    expect(cliente?.telefono).toBe('3416513207');
  });

  it('guarda los snapshots, el estado, el tipo, el source y el cancel_token', async () => {
    const r = await reservar({ servicioId: SERVICIO_60, hora: '09:00' });
    expect(r.estado).toBe('exito');

    const fila = await env.DB.prepare('SELECT * FROM reservas').first<Record<string, unknown>>();

    expect(fila?.nombre).toBe('Juan Pérez');
    expect(fila?.servicio).toBe('Corte y barba');
    expect(fila?.duracion_min).toBe(60);
    expect(fila?.estado).toBe('activa');
    expect(fila?.tipo).toBe('turno');
    expect(fila?.source).toBe('web');
    expect(fila?.cancel_token).toBe(r.estado === 'exito' ? r.cancelToken : null);
  });

  it('el mensaje por defecto describe el turno', async () => {
    await reservar({});
    const fila = await env.DB.prepare('SELECT mensaje FROM reservas').first<{ mensaje: string }>();
    expect(fila?.mensaje).toBe('Corte el 2027-03-15 a las 10:00');
  });

  it('un mensaje propio no se pisa', async () => {
    await reservar({ mensaje: 'Vengo con mi hijo' });
    const fila = await env.DB.prepare('SELECT mensaje FROM reservas').first<{ mensaje: string }>();
    expect(fila?.mensaje).toBe('Vengo con mi hijo');
  });

  it('la respuesta trae cancelToken y el mensaje de exito', async () => {
    const r = await reservar({});
    expect(r).toMatchObject({ estado: 'exito', mensaje: MENSAJE_EXITO });
    expect(r.estado === 'exito' && r.cancelToken).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('upsert del cliente', () => {
  it('crea el cliente la primera vez', async () => {
    await reservar({});
    const filas = await env.DB.prepare('SELECT nombre, telefono FROM clientes').all<{ nombre: string }>();
    expect(filas.results).toHaveLength(1);
    expect(filas.results[0]?.nombre).toBe('Juan Pérez');
  });

  it('reusa el cliente y le actualiza el nombre', async () => {
    await reservar({ hora: '09:00' });
    await reservar({ hora: '10:00', clienteNombre: 'Juan Manuel Pérez' });

    const filas = await env.DB.prepare('SELECT nombre FROM clientes').all<{ nombre: string }>();
    expect(filas.results).toHaveLength(1);
    expect(filas.results[0]?.nombre).toBe('Juan Manuel Pérez');
  });

  it('lo reconoce aunque el telefono venga escrito distinto', async () => {
    await reservar({ hora: '09:00', clienteTelefono: '3416513207' });
    await reservar({ hora: '10:00', clienteTelefono: '+54 9 341 651-3207' });

    const filas = await env.DB.prepare('SELECT id FROM clientes').all();
    expect(filas.results).toHaveLength(1);
  });

  it('la reserva queda vinculada al cliente', async () => {
    await reservar({});
    const fila = await env.DB.prepare(
      'SELECT r.cliente_id, c.id FROM reservas r JOIN clientes c ON c.id = r.cliente_id',
    ).first<{ cliente_id: string }>();
    expect(fila?.cliente_id).toBeTruthy();
  });

  it('dos reservas simultaneas, mismo telefono, barberos DISTINTOS: un solo cliente', async () => {
    // El Durable Object se direcciona con idFromName(barberoId), asi que estas
    // dos reservas son DOS instancias que no se ven entre si: las dos leen
    // "el cliente no existe" y las dos intentan insertarlo.
    //
    // Lo unico que puede evitar el duplicado es el indice unico parcial sobre
    // clientes.telefono, mas el manejo del choque en el upsert.
    const otro = uuidv7();
    await env.DB.prepare("INSERT INTO barberos (id, slug, nombre) VALUES (?, ?, 'Otro')")
      .bind(otro, 's' + otro)
      .run();
    for (let dow = 0; dow <= 6; dow++) {
      await env.DB.prepare(
        'INSERT INTO barbero_horarios (id, barbero_id, dow, hora_inicio, hora_fin) VALUES (?, ?, ?, 9, 13)',
      )
        .bind(uuidv7(), otro, dow)
        .run();
    }

    const [a, b] = await Promise.all([
      reservar({ barberoId: BARBERO, hora: '10:00', clienteTelefono: '3416513207' }),
      reservar({ barberoId: otro, hora: '10:00', clienteTelefono: '3416513207' }),
    ]);

    // Las dos reservas son validas: son barberos distintos.
    expect(a.estado).toBe('exito');
    expect(b.estado).toBe('exito');

    const clientes = await env.DB.prepare('SELECT id FROM clientes WHERE telefono = ?')
      .bind('3416513207')
      .all();
    expect(clientes.results).toHaveLength(1);

    // Y las dos reservas apuntan al MISMO cliente.
    const reservas = await env.DB.prepare(
      'SELECT DISTINCT cliente_id FROM reservas WHERE cliente_id IS NOT NULL',
    ).all();
    expect(reservas.results).toHaveLength(1);
  });

  it('el indice unico de telefono rechaza un duplicado insertado a mano', async () => {
    await reservar({});

    await expect(
      env.DB.prepare("INSERT INTO clientes (id, nombre, telefono) VALUES (?, 'Colado', ?)")
        .bind(uuidv7(), '3416513207')
        .run(),
    ).rejects.toThrowError(/UNIQUE constraint failed/);
  });

  it('varios clientes SIN telefono conviven: el unico es parcial', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO clientes (id, nombre) VALUES (?, 'Sin tel 1')").bind(uuidv7()),
      env.DB.prepare("INSERT INTO clientes (id, nombre) VALUES (?, 'Sin tel 2')").bind(uuidv7()),
    ]);

    const filas = await env.DB.prepare('SELECT id FROM clientes WHERE telefono IS NULL').all();
    expect(filas.results).toHaveLength(2);
  });

  it('un intento rechazado por overlap NO crea cliente', async () => {
    await reservar({});
    const antes = await env.DB.prepare('SELECT COUNT(*) AS n FROM clientes').first<{ n: number }>();

    const r = await reservar({ clienteTelefono: '1123456789', clienteNombre: 'Otro' });
    expect(r.estado).toBe('overlap');

    const despues = await env.DB.prepare('SELECT COUNT(*) AS n FROM clientes').first<{ n: number }>();
    expect(despues?.n).toBe(antes?.n);
  });
});

// --------------------------------------------------------------------- hooks

describe('hooks post-commit, best-effort', () => {
  it('si el hook tira excepcion, la reserva IGUAL queda confirmada', async () => {
    const hooksRotos: HooksReserva = {
      async ejecutar() {
        throw new Error('Google Calendar caido');
      },
    };

    // El servicio no puede dejar escapar esa excepcion.
    const r = await crearReserva(env, entrada(), { ahora: AHORA, hooks: hooksRotos }).catch(
      (e: unknown) => e as Error,
    );

    expect(r).not.toBeInstanceOf(Error);
    expect((r as { estado: string }).estado).toBe('exito');

    const fila = await env.DB.prepare("SELECT COUNT(*) AS n FROM reservas WHERE estado = 'activa'").first<{ n: number }>();
    expect(fila?.n).toBe(1);
  });

  it('los hooks reciben los datos de la reserva, con el telefono enmascarado', async () => {
    let recibido: Record<string, unknown> | null = null;
    const espia: HooksReserva = {
      async ejecutar(_env, datos) {
        recibido = datos as unknown as Record<string, unknown>;
      },
    };

    await crearReserva(env, entrada(), { ahora: AHORA, hooks: espia });

    expect(recibido).toMatchObject({
      fecha: FUTURO,
      hora: '10:00',
      servicio: 'Corte',
      telefono: '3416513207',
      telefonoEnmascarado: '******3207',
    });
  });
});

// ================================================ modos: publico, admin, import

describe('modo admin: sin anticipacion minima ni maxima', () => {
  const desdeElPanel = (over: Partial<EntradaReserva> = {}, ahora = AHORA) =>
    crearReserva(env, entrada(over), { ahora, hooks: hooksMudos, modo: 'admin' });

  it('acepta un turno para dentro de 10 minutos; el publico lo rechaza', async () => {
    // Son las 09:50. El turno es a las 10:00: faltan 10 min, y el minimo es 30.
    const ahora = new Date(slotAMs(HOY, '09:50'));
    const args = { fecha: HOY, hora: '10:00' };

    expect(errorDe(await reservar(args, ahora))).toBe(
      'Debés reservar con al menos 30 minutos de anticipación.',
    );
    expect((await desdeElPanel(args, ahora)).estado).toBe('exito');
  });

  it('acepta un turno a 90 dias; el publico lo rechaza', async () => {
    const args = { fecha: '2027-06-08' };

    expect(errorDe(await reservar(args))).toBe(
      'Solo se puede reservar con hasta 14 días de anticipación.',
    );
    expect((await desdeElPanel(args)).estado).toBe('exito');
  });

  it('SIGUE aplicando el horario de atencion', async () => {
    // Lo que se saltea es la anticipacion, no la disponibilidad.
    expect(errorDe(await desdeElPanel({ hora: '14:00' }))).toBe(
      'El horario elegido está fuera del horario de atención.',
    );
  });

  it('SIGUE rechazando el pasado', async () => {
    expect(errorDe(await desdeElPanel({ fecha: '2027-03-09' }))).toBe(
      'No se puede agendar un turno en el pasado.',
    );
  });

  it('guarda source = admin', async () => {
    await desdeElPanel({ hora: '11:00' });
    const f = await env.DB.prepare('SELECT source FROM reservas').first<{ source: string }>();
    expect(f?.source).toBe('admin');
  });
});

describe('modo import: ademas sin fecha pasada ni horario', () => {
  const importar = (over: Partial<EntradaReserva> = {}) =>
    crearReserva(env, entrada(over), { ahora: AHORA, hooks: hooksMudos, modo: 'import' });

  it('acepta fechas pasadas', async () => {
    expect((await importar({ fecha: '2020-06-15' })).estado).toBe('exito');
  });

  it('acepta horarios fuera del horario de atencion', async () => {
    expect((await importar({ fecha: '2020-06-15', hora: '23:30' })).estado).toBe('exito');
  });

  it('el modo admin NO acepta esas dos cosas: los modos son distintos', async () => {
    const admin = (over: Partial<EntradaReserva>) =>
      crearReserva(env, entrada(over), { ahora: AHORA, hooks: hooksMudos, modo: 'admin' });

    expect((await admin({ fecha: '2020-06-15' })).estado).toBe('datosInvalidos');
    expect((await admin({ hora: '23:30' })).estado).toBe('noDisponible');
  });

  it('SIGUE validando el solapamiento', async () => {
    expect((await importar({ hora: '12:00' })).estado).toBe('exito');
    expect((await importar({ hora: '12:00' })).estado).toBe('overlap');
  });

  it('SIGUE validando el telefono', async () => {
    expect((await importar({ clienteTelefono: '+1 212 555 1234' })).estado).toBe('datosInvalidos');
  });

  it('NO ejecuta los hooks post-commit', async () => {
    let llamado = false;
    const espia: HooksReserva = { async ejecutar() { llamado = true; } };

    await crearReserva(env, entrada({ hora: '11:30' }), { ahora: AHORA, hooks: espia, modo: 'import' });
    expect(llamado).toBe(false);

    // Control: en modo publico si se ejecutan.
    await crearReserva(env, entrada({ hora: '12:30' }), { ahora: AHORA, hooks: espia });
    expect(llamado).toBe(true);
  });

  it('guarda source = import', async () => {
    await importar({ hora: '09:30' });
    const f = await env.DB.prepare('SELECT source FROM reservas').first<{ source: string }>();
    expect(f?.source).toBe('import');
  });
});
