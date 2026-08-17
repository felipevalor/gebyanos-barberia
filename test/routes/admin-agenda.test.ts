import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import worker from '../../src/index';
import { uuidv7 } from '../../src/db/id';
import { hashPassword } from '../../src/services/password';
import { todayArgentina, addDays } from '../../src/domain/dates';

const OWNER = '01930000-0000-7000-8000-0000000d0001';
const BARBERO_A = '01930000-0000-7000-8000-0000000d0002';
const BARBERO_B = '01930000-0000-7000-8000-0000000d0003';
const SERVICIO = '01930000-0000-7000-8000-0000000d0010';
const PASS = 'la-password-del-panel';

const HOY = todayArgentina();
const MANANA = addDays(HOY, 1);

/** IP propia por request: desde la 2.6 hay rate limit de 10 por IP. */
const ip = () => `192.0.2.1-${uuidv7()}`;

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

async function sesionDe(slug: string): Promise<string> {
  const res = await pedir('/api/admin/auth', {
    metodo: 'POST',
    cuerpo: { usuario: slug, password: PASS },
  });
  const token = /admin_token=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
  return `admin_token=${token}`;
}

let cookieOwner = '';
let cookieA = '';
let cookieB = '';

/** Crea una reserva directamente en la base, sin pasar por la API. */
async function sembrarReserva(o: {
  barberoId: string;
  hora: string;
  fecha?: string;
  tipo?: string;
  estado?: string;
  nombre?: string;
}): Promise<string> {
  const id = uuidv7();
  await env.DB.prepare(
    `INSERT INTO reservas (id, barbero_id, servicio_id, nombre, telefono, servicio, duracion_min, fecha, hora, estado, tipo, source)
     VALUES (?, ?, ?, ?, '3416513207', 'Corte', 30, ?, ?, ?, ?, 'admin')`,
  )
    .bind(
      id,
      o.barberoId,
      SERVICIO,
      o.nombre ?? 'Cliente',
      o.fecha ?? MANANA,
      o.hora,
      o.estado ?? 'activa',
      o.tipo ?? 'turno',
    )
    .run();
  return id;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
  await env.DB.prepare('INSERT OR REPLACE INTO negocio (id) VALUES (1)').run();
  const hash = await hashPassword(PASS);

  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO barberos (id, slug, nombre, rol, password_hash) VALUES (?, 'due', 'Dueño', 'owner', ?)").bind(OWNER, hash),
    env.DB.prepare("INSERT OR REPLACE INTO barberos (id, slug, nombre, rol, password_hash) VALUES (?, 'ana', 'Ana', 'barbero', ?)").bind(BARBERO_A, hash),
    env.DB.prepare("INSERT OR REPLACE INTO barberos (id, slug, nombre, rol, password_hash) VALUES (?, 'beto', 'Beto', 'barbero', ?)").bind(BARBERO_B, hash),
    env.DB.prepare("INSERT OR IGNORE INTO servicios (id, nombre, duracion_min) VALUES (?, 'Corte', 30)").bind(SERVICIO),
  ]);

  for (const b of [OWNER, BARBERO_A, BARBERO_B]) {
    for (let dow = 0; dow <= 6; dow++) {
      await env.DB.prepare(
        'INSERT INTO barbero_horarios (id, barbero_id, dow, hora_inicio, hora_fin) VALUES (?, ?, ?, 9, 20)',
      )
        .bind(uuidv7(), b, dow)
        .run();
    }
  }

  cookieOwner = await sesionDe('due');
  cookieA = await sesionDe('ana');
  cookieB = await sesionDe('beto');
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM reservas').run();
  await env.DB.prepare('DELETE FROM clientes').run();
});

// ------------------------------------------------------------ scoping

describe('scoping por rol', () => {
  beforeEach(async () => {
    await sembrarReserva({ barberoId: BARBERO_A, hora: '10:00', nombre: 'De Ana' });
    await sembrarReserva({ barberoId: BARBERO_B, hora: '11:00', nombre: 'De Beto' });
  });

  it('un barbero que pasa ?barberoId= de OTRO sigue viendo solo lo suyo', async () => {
    const res = await pedir(`/api/admin/agenda?barberoId=${BARBERO_B}`, { cookie: cookieA });
    const { data } = await cuerpoDe(res);

    expect(res.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(data[0].nombre).toBe('De Ana');
    expect(data.map((t: any) => t.barberoId)).not.toContain(BARBERO_B);
  });

  it('un owner SIN ?barberoId= ve las reservas de todos', async () => {
    const { data } = await cuerpoDe(await pedir('/api/admin/agenda', { cookie: cookieOwner }));

    expect(data).toHaveLength(2);
    expect(data.map((t: any) => t.nombre).sort()).toEqual(['De Ana', 'De Beto']);
  });

  it('un owner CON ?barberoId= filtra por ese', async () => {
    const { data } = await cuerpoDe(
      await pedir(`/api/admin/agenda?barberoId=${BARBERO_B}`, { cookie: cookieOwner }),
    );

    expect(data).toHaveLength(1);
    expect(data[0].nombre).toBe('De Beto');
  });

  it('el listado de reservas tiene el mismo scoping', async () => {
    const deAna = await cuerpoDe(
      await pedir(`/api/admin/reservas?barberoId=${BARBERO_B}`, { cookie: cookieA }),
    );
    expect(deAna.data.items).toHaveLength(1);
    expect(deAna.data.items[0].nombre).toBe('De Ana');

    const delOwner = await cuerpoDe(await pedir('/api/admin/reservas', { cookie: cookieOwner }));
    expect(delOwner.data.total).toBe(2);
  });

  it('sin sesion, 401 en todos los endpoints del panel', async () => {
    for (const ruta of ['/api/admin/agenda', '/api/admin/reservas']) {
      expect((await pedir(ruta)).status).toBe(401);
    }
  });

  it('el scoping es simetrico: Beto tampoco ve lo de Ana', async () => {
    // Que Ana no vea lo de Beto podria ser casualidad del orden de los datos.
    const { data } = await cuerpoDe(
      await pedir(`/api/admin/agenda?barberoId=${BARBERO_A}`, { cookie: cookieB }),
    );

    expect(data).toHaveLength(1);
    expect(data[0].nombre).toBe('De Beto');
  });
});

// ------------------------------------------------------- editar y borrar

describe('permisos sobre una reserva puntual', () => {
  it('un barbero NO puede cancelar la reserva de otro (403)', async () => {
    const id = await sembrarReserva({ barberoId: BARBERO_B, hora: '10:00' });

    const res = await pedir(`/api/admin/reservas/${id}`, { metodo: 'DELETE', cookie: cookieA });
    expect(res.status).toBe(403);
    expect((await cuerpoDe(res)).error).toBe('Prohibido');

    const fila = await env.DB.prepare('SELECT estado FROM reservas WHERE id = ?').bind(id).first<{ estado: string }>();
    expect(fila?.estado).toBe('activa');
  });

  it('un barbero NO puede reprogramar la de otro (403)', async () => {
    const id = await sembrarReserva({ barberoId: BARBERO_B, hora: '10:00' });

    const res = await pedir(`/api/admin/reservas/${id}`, {
      metodo: 'PUT',
      cookie: cookieA,
      cuerpo: { fecha: MANANA, hora: '12:00' },
    });
    expect(res.status).toBe(403);
  });

  it('el owner si puede tocar la de cualquiera', async () => {
    const id = await sembrarReserva({ barberoId: BARBERO_A, hora: '10:00' });

    expect((await pedir(`/api/admin/reservas/${id}`, { metodo: 'DELETE', cookie: cookieOwner })).status).toBe(200);
  });

  it('una reserva inexistente da 404', async () => {
    const res = await pedir(`/api/admin/reservas/${uuidv7()}`, { metodo: 'DELETE', cookie: cookieOwner });
    expect(res.status).toBe(404);
    expect((await cuerpoDe(res)).error).toBe('Reserva no encontrada.');
  });
});

describe('cancelacion: soft delete', () => {
  it('deja estado = cancelada y la fila sigue en la base', async () => {
    const id = await sembrarReserva({ barberoId: BARBERO_A, hora: '10:00' });

    expect((await pedir(`/api/admin/reservas/${id}`, { metodo: 'DELETE', cookie: cookieA })).status).toBe(200);

    const fila = await env.DB.prepare('SELECT estado, cancelada_at, nombre FROM reservas WHERE id = ?')
      .bind(id)
      .first<{ estado: string; cancelada_at: string | null; nombre: string }>();

    expect(fila).not.toBeNull();
    expect(fila?.estado).toBe('cancelada');
    expect(fila?.cancelada_at).toBeTruthy();
    expect(fila?.nombre).toBe('Cliente');
  });

  it('un slot con reserva cancelada vuelve a estar disponible', async () => {
    const id = await sembrarReserva({ barberoId: BARBERO_A, hora: '10:00' });

    const antes = await cuerpoDe(
      await pedir(`/api/disponibilidad?barberoId=${BARBERO_A}&fecha=${MANANA}`),
    );
    expect(antes.data.slots).not.toContain('10:00');

    await pedir(`/api/admin/reservas/${id}`, { metodo: 'DELETE', cookie: cookieA });

    const despues = await cuerpoDe(
      await pedir(`/api/disponibilidad?barberoId=${BARBERO_A}&fecha=${MANANA}`),
    );
    expect(despues.data.slots).toContain('10:00');
  });
});

// ------------------------------------------------------------- bloqueos

describe('bloqueos administrativos', () => {
  it('ocupa el slot en el endpoint de disponibilidad', async () => {
    const res = await pedir('/api/admin/bloqueos', {
      metodo: 'POST',
      cookie: cookieA,
      cuerpo: { fecha: MANANA, hora: '15:00', motivo: 'Turno médico' },
    });
    expect(res.status).toBe(200);

    const { data } = await cuerpoDe(
      await pedir(`/api/disponibilidad?barberoId=${BARBERO_A}&fecha=${MANANA}`),
    );
    expect(data.slots).not.toContain('15:00');
  });

  it('NO aparece en el listado de turnos de clientes', async () => {
    await pedir('/api/admin/bloqueos', {
      metodo: 'POST',
      cookie: cookieA,
      cuerpo: { fecha: MANANA, hora: '15:00', motivo: 'Turno médico' },
    });
    await sembrarReserva({ barberoId: BARBERO_A, hora: '16:00', nombre: 'Cliente real' });

    const { data } = await cuerpoDe(await pedir('/api/admin/reservas', { cookie: cookieA }));

    expect(data.total).toBe(1);
    expect(data.items[0].nombre).toBe('Cliente real');
  });

  it('SI aparece en la agenda: el barbero tiene que verlo', async () => {
    await pedir('/api/admin/bloqueos', {
      metodo: 'POST',
      cookie: cookieA,
      cuerpo: { fecha: MANANA, hora: '15:00', motivo: 'Turno médico' },
    });

    const { data } = await cuerpoDe(await pedir('/api/admin/agenda', { cookie: cookieA }));
    expect(data).toHaveLength(1);
    expect(data[0].tipo).toBe('bloqueo');
  });

  it('usa la columna tipo, no un string magico', async () => {
    await pedir('/api/admin/bloqueos', {
      metodo: 'POST',
      cookie: cookieA,
      cuerpo: { fecha: MANANA, hora: '15:00' },
    });

    const fila = await env.DB.prepare("SELECT tipo, nombre, servicio, source FROM reservas").first<{
      tipo: string; nombre: string; servicio: string; source: string;
    }>();

    expect(fila?.tipo).toBe('bloqueo');
    expect(fila?.source).toBe('admin');
    // El sistema viejo ponia "BLOQUEDAO" y "Bloqueo Administrativo".
    expect(fila?.nombre).not.toContain('BLOQUEDAO');
    expect(fila?.servicio).not.toBe('Bloqueo Administrativo');
  });

  it('sobre un slot ocupado da el mensaje exacto', async () => {
    await sembrarReserva({ barberoId: BARBERO_A, hora: '15:00' });

    const res = await pedir('/api/admin/bloqueos', {
      metodo: 'POST',
      cookie: cookieA,
      cuerpo: { fecha: MANANA, hora: '15:00' },
    });

    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toBe('Ya existe una reserva en ese horario.');
  });
});

// -------------------------------------------------- alta desde el panel

describe('crear reserva desde el panel', () => {
  const nueva = (over: Record<string, unknown> = {}) => ({
    servicioId: SERVICIO,
    fecha: MANANA,
    hora: '10:00',
    clienteNombre: 'Cliente del panel',
    clienteTelefono: '3416513207',
    ...over,
  });

  it('NO aplica la anticipacion maxima: acepta a 3 meses', async () => {
    const res = await pedir('/api/admin/reservas', {
      metodo: 'POST',
      cookie: cookieA,
      cuerpo: nueva({ fecha: addDays(HOY, 90) }),
    });

    expect(res.status).toBe(200);
  });

  it('la publica SI rechaza a 90 dias: la diferencia es real', async () => {
    const res = await pedir('/api/reservas', {
      metodo: 'POST',
      cuerpo: { ...nueva({ fecha: addDays(HOY, 90) }), barberoId: BARBERO_A },
    });

    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toContain('días de anticipación');
  });

  it('guarda source = admin', async () => {
    await pedir('/api/admin/reservas', { metodo: 'POST', cookie: cookieA, cuerpo: nueva() });

    const fila = await env.DB.prepare('SELECT source, barbero_id FROM reservas').first<{
      source: string; barbero_id: string;
    }>();
    expect(fila?.source).toBe('admin');
    expect(fila?.barbero_id).toBe(BARBERO_A);
  });

  it('el solapamiento SI se valida', async () => {
    await pedir('/api/admin/reservas', { metodo: 'POST', cookie: cookieA, cuerpo: nueva() });

    const res = await pedir('/api/admin/reservas', { metodo: 'POST', cookie: cookieA, cuerpo: nueva() });
    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toBe('Lo sentimos, este turno acaba de ser reservado por alguien más.');
  });

  it('un barbero no puede cargar un turno en la agenda de otro', async () => {
    await pedir('/api/admin/reservas', {
      metodo: 'POST',
      cookie: cookieA,
      cuerpo: { ...nueva(), barberoId: BARBERO_B },
    });

    const fila = await env.DB.prepare('SELECT barbero_id FROM reservas').first<{ barbero_id: string }>();
    expect(fila?.barbero_id).toBe(BARBERO_A);
  });
});

// ------------------------------------------------------------- reprogramar

describe('reprogramar', () => {
  it('mueve el turno y libera el slot viejo', async () => {
    const id = await sembrarReserva({ barberoId: BARBERO_A, hora: '10:00' });

    const res = await pedir(`/api/admin/reservas/${id}`, {
      metodo: 'PUT',
      cookie: cookieA,
      cuerpo: { fecha: MANANA, hora: '12:00' },
    });
    expect(res.status).toBe(200);

    const { data } = await cuerpoDe(
      await pedir(`/api/disponibilidad?barberoId=${BARBERO_A}&fecha=${MANANA}`),
    );
    expect(data.slots).toContain('10:00');
    expect(data.slots).not.toContain('12:00');
  });

  it('si el destino esta ocupado, la original queda intacta', async () => {
    const id = await sembrarReserva({ barberoId: BARBERO_A, hora: '10:00' });
    await sembrarReserva({ barberoId: BARBERO_A, hora: '12:00' });

    const res = await pedir(`/api/admin/reservas/${id}`, {
      metodo: 'PUT',
      cookie: cookieA,
      cuerpo: { fecha: MANANA, hora: '12:00' },
    });
    expect(res.status).toBe(400);

    // La reserva original NO puede haber quedado cancelada por un intento fallido.
    const fila = await env.DB.prepare('SELECT estado FROM reservas WHERE id = ?').bind(id).first<{ estado: string }>();
    expect(fila?.estado).toBe('activa');
  });
});

// ---------------------------------------------------------------- import

describe('import masivo', () => {
  const fila = (over: Record<string, unknown> = {}) => ({
    barberoId: BARBERO_A,
    servicioId: SERVICIO,
    fecha: MANANA,
    hora: '10:00',
    clienteNombre: 'Importado',
    clienteTelefono: '3416513207',
    ...over,
  });

  it('un barbero que intenta importar recibe 403', async () => {
    const res = await pedir('/api/admin/reservas/importar', {
      metodo: 'POST',
      cookie: cookieA,
      cuerpo: { filas: [fila()] },
    });

    expect(res.status).toBe(403);
    expect((await cuerpoDe(res)).error).toBe('Prohibido');
  });

  it('501 filas se rechazan', async () => {
    const filas = Array.from({ length: 501 }, (_, i) => fila({ hora: `10:${String(i % 60).padStart(2, '0')}` }));

    const res = await pedir('/api/admin/reservas/importar', {
      metodo: 'POST',
      cookie: cookieOwner,
      cuerpo: { filas },
    });

    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toBe('No se pueden importar más de 500 filas por vez.');
  });

  it('500 filas exactas se aceptan', async () => {
    const filas = Array.from({ length: 500 }, () => fila({ clienteNombre: '' })); // todas invalidas, rapido
    const res = await pedir('/api/admin/reservas/importar', {
      metodo: 'POST',
      cookie: cookieOwner,
      cuerpo: { filas },
    });
    expect(res.status).toBe(200);
  });

  it('las que chocan se reportan con su motivo y las demas entran', async () => {
    const filas = [
      fila({ hora: '09:00' }),
      fila({ hora: '09:30' }),
      fila({ hora: '09:00' }), // choca con la 1
      fila({ hora: '10:00' }),
      fila({ hora: '09:30' }), // choca con la 2
      fila({ hora: '10:00' }), // choca con la 4
    ];

    const { data } = await cuerpoDe(
      await pedir('/api/admin/reservas/importar', {
        metodo: 'POST',
        cookie: cookieOwner,
        cuerpo: { filas },
      }),
    );

    expect(data.importadas).toBe(3);
    expect(data.salteadas).toBe(3);
    expect(data.errores).toHaveLength(3);
    // El numero de fila permite ubicar el problema en el archivo original.
    expect(data.errores.map((e: any) => e.fila)).toEqual([3, 5, 6]);
    for (const e of data.errores) {
      expect(e.motivo).toBe('Lo sentimos, este turno acaba de ser reservado por alguien más.');
    }
  });

  it('acepta fechas pasadas: son datos historicos', async () => {
    const { data } = await cuerpoDe(
      await pedir('/api/admin/reservas/importar', {
        metodo: 'POST',
        cookie: cookieOwner,
        cuerpo: { filas: [fila({ fecha: '2020-06-15', hora: '10:00' })] },
      }),
    );

    expect(data.importadas).toBe(1);
  });

  it('acepta horarios fuera del horario de atencion actual', async () => {
    // El horario de hace un anio no es el de hoy.
    const { data } = await cuerpoDe(
      await pedir('/api/admin/reservas/importar', {
        metodo: 'POST',
        cookie: cookieOwner,
        cuerpo: { filas: [fila({ fecha: '2020-06-15', hora: '23:30' })] },
      }),
    );

    expect(data.importadas).toBe(1);
  });

  it('marca source = import', async () => {
    await pedir('/api/admin/reservas/importar', {
      metodo: 'POST',
      cookie: cookieOwner,
      cuerpo: { filas: [fila()] },
    });

    const f = await env.DB.prepare('SELECT source FROM reservas').first<{ source: string }>();
    expect(f?.source).toBe('import');
  });

  it('NO dispara Calendar ni WhatsApp', async () => {
    // El barbero tiene calendar_id, o sea que el hook se dispararia si el
    // import usara el camino normal.
    await env.DB.prepare("UPDATE barberos SET calendar_id = 'cal-de-prueba' WHERE id = ?")
      .bind(BARBERO_A)
      .run();

    const logs: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => logs.push(a.join(' '));

    try {
      const { data } = await cuerpoDe(
        await pedir('/api/admin/reservas/importar', {
          metodo: 'POST',
          cookie: cookieOwner,
          cuerpo: { filas: [fila({ hora: '11:00' })] },
        }),
      );
      expect(data.importadas).toBe(1);
      expect(logs.filter((l) => l.includes('hook'))).toEqual([]);
    } finally {
      console.error = original;
      await env.DB.prepare('UPDATE barberos SET calendar_id = NULL WHERE id = ?').bind(BARBERO_A).run();
    }
  });

  it('un cuerpo que no es lista se rechaza', async () => {
    const res = await pedir('/api/admin/reservas/importar', {
      metodo: 'POST',
      cookie: cookieOwner,
      cuerpo: { filas: 'no soy una lista' },
    });
    expect(res.status).toBe(400);
  });
});

// ------------------------------------------------------------- paginado

describe('paginado del listado', () => {
  beforeEach(async () => {
    for (let i = 0; i < 5; i++) {
      await sembrarReserva({ barberoId: BARBERO_A, hora: `1${i}:00`, nombre: `Cliente ${i}` });
    }
  });

  it('respeta skip y limit, y devuelve el total sin paginar', async () => {
    const { data } = await cuerpoDe(
      await pedir('/api/admin/reservas?skip=2&limit=2', { cookie: cookieA }),
    );

    expect(data.items).toHaveLength(2);
    expect(data.total).toBe(5);
    expect(data.skip).toBe(2);
    expect(data.limit).toBe(2);
  });

  it('rechaza skip y limit invalidos', async () => {
    expect((await pedir('/api/admin/reservas?skip=-1', { cookie: cookieA })).status).toBe(400);
    expect((await pedir('/api/admin/reservas?limit=0', { cookie: cookieA })).status).toBe(400);
  });
});
