import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import worker from '../../src/index';
import { uuidv7 } from '../../src/db/id';
import { hashPassword } from '../../src/services/password';
import { clientesACsv } from '../../src/services/clientes';

const OWNER = '01930000-0000-7000-8000-0000000f0001';
const ANA = '01930000-0000-7000-8000-0000000f0002';
const BETO = '01930000-0000-7000-8000-0000000f0003';
const PASS = 'la-password-de-clientes';

const ip = () => `192.0.2.55-${uuidv7()}`;

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

let cookieOwner = '';
let cookieAna = '';

async function sesion(slug: string): Promise<string> {
  const res = await pedir('/api/admin/auth', { metodo: 'POST', cuerpo: { usuario: slug, password: PASS } });
  return `admin_token=${/admin_token=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1]}`;
}

/** Cliente + una reserva que lo vincula a un barbero. */
async function sembrarCliente(o: {
  nombre: string;
  telefono: string;
  atendidoPor?: string;
  hora?: string;
}): Promise<string> {
  const id = uuidv7();
  await env.DB.prepare('INSERT INTO clientes (id, nombre, telefono) VALUES (?, ?, ?)')
    .bind(id, o.nombre, o.telefono)
    .run();

  if (o.atendidoPor) {
    await env.DB.prepare(
      `INSERT INTO reservas (id, barbero_id, cliente_id, nombre, telefono, servicio, duracion_min, fecha, hora, source)
       VALUES (?, ?, ?, ?, ?, 'Corte', 30, '2027-03-15', ?, 'web')`,
    )
      .bind(uuidv7(), o.atendidoPor, id, o.nombre, o.telefono, o.hora ?? '10:00')
      .run();
  }
  return id;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
  await env.DB.prepare('INSERT OR REPLACE INTO negocio (id) VALUES (1)').run();
  const hash = await hashPassword(PASS);

  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO barberos (id, slug, nombre, rol, password_hash) VALUES (?, 'duenio', 'Dueño', 'owner', ?)").bind(OWNER, hash),
    env.DB.prepare("INSERT OR REPLACE INTO barberos (id, slug, nombre, rol, password_hash) VALUES (?, 'anac', 'Ana', 'barbero', ?)").bind(ANA, hash),
    env.DB.prepare("INSERT OR REPLACE INTO barberos (id, slug, nombre, rol, password_hash) VALUES (?, 'betoc', 'Beto', 'barbero', ?)").bind(BETO, hash),
  ]);

  cookieOwner = await sesion('duenio');
  cookieAna = await sesion('anac');
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM reservas').run();
  await env.DB.prepare('DELETE FROM clientes').run();
});

describe('scoping de clientes', () => {
  beforeEach(async () => {
    await sembrarCliente({ nombre: 'De Ana', telefono: '3416513201', atendidoPor: ANA });
    await sembrarCliente({ nombre: 'De Beto', telefono: '3416513202', atendidoPor: BETO });
    await sembrarCliente({ nombre: 'Sin turnos', telefono: '3416513203' });
  });

  it('un barbero NO ve clientes que nunca atendio', async () => {
    const { data } = await cuerpoDe(await pedir('/api/admin/clientes', { cookie: cookieAna }));

    expect(data.items).toHaveLength(1);
    expect(data.items[0].nombre).toBe('De Ana');
    expect(data.total).toBe(1);
  });

  it('el owner ve todos, incluso los que no tienen turnos', async () => {
    const { data } = await cuerpoDe(await pedir('/api/admin/clientes', { cookie: cookieOwner }));

    expect(data.total).toBe(3);
    expect(data.items.map((c: any) => c.nombre).sort()).toEqual(['De Ana', 'De Beto', 'Sin turnos']);
  });

  it('un barbero que pide el barberoId de otro recibe 403', async () => {
    expect((await pedir(`/api/admin/clientes?barberoId=${BETO}`, { cookie: cookieAna })).status).toBe(403);
  });

  it('sin sesion, 401', async () => {
    expect((await pedir('/api/admin/clientes')).status).toBe(401);
  });
});

describe('historial de un cliente', () => {
  it('un barbero ve solo los turnos SUYOS con ese cliente', async () => {
    const id = await sembrarCliente({ nombre: 'Compartido', telefono: '3416513207', atendidoPor: ANA, hora: '10:00' });
    // El mismo cliente, atendido tambien por Beto.
    await env.DB.prepare(
      `INSERT INTO reservas (id, barbero_id, cliente_id, nombre, telefono, servicio, duracion_min, fecha, hora, source)
       VALUES (?, ?, ?, 'Compartido', '3416513207', 'Corte', 30, '2027-03-16', '11:00', 'web')`,
    )
      .bind(uuidv7(), BETO, id)
      .run();

    const deAna = await cuerpoDe(await pedir(`/api/admin/clientes/${id}/historial`, { cookie: cookieAna }));
    expect(deAna.data.total).toBe(1);
    expect(deAna.data.items[0].barberoId).toBe(ANA);

    const delOwner = await cuerpoDe(await pedir(`/api/admin/clientes/${id}/historial`, { cookie: cookieOwner }));
    expect(delOwner.data.total).toBe(2);
  });

  it('devuelve el total en el payload, no solo la pagina', async () => {
    const id = await sembrarCliente({ nombre: 'Fiel', telefono: '3416513207', atendidoPor: ANA, hora: '09:00' });
    for (const hora of ['10:00', '11:00', '12:00']) {
      await env.DB.prepare(
        `INSERT INTO reservas (id, barbero_id, cliente_id, nombre, telefono, servicio, duracion_min, fecha, hora, source)
         VALUES (?, ?, ?, 'Fiel', '3416513207', 'Corte', 30, '2027-03-15', ?, 'web')`,
      )
        .bind(uuidv7(), ANA, id, hora)
        .run();
    }

    const { data } = await cuerpoDe(
      await pedir(`/api/admin/clientes/${id}/historial?limit=2`, { cookie: cookieAna }),
    );

    expect(data.items).toHaveLength(2);
    expect(data.total).toBe(4);
  });

  it('el historial de un cliente que el barbero no atendio da 404', async () => {
    const id = await sembrarCliente({ nombre: 'De Beto', telefono: '3416513207', atendidoPor: BETO });

    const res = await pedir(`/api/admin/clientes/${id}/historial`, { cookie: cookieAna });
    expect(res.status).toBe(404);
    expect((await cuerpoDe(res)).error).toBe('Cliente no encontrado.');
  });

  it('excluye los bloqueos administrativos', async () => {
    const id = await sembrarCliente({ nombre: 'Normal', telefono: '3416513207', atendidoPor: ANA });
    await env.DB.prepare(
      `INSERT INTO reservas (id, barbero_id, cliente_id, nombre, telefono, servicio, duracion_min, fecha, hora, tipo, source)
       VALUES (?, ?, ?, '', '', 'Bloqueo', 30, '2027-03-15', '15:00', 'bloqueo', 'admin')`,
    )
      .bind(uuidv7(), ANA, id)
      .run();

    const { data } = await cuerpoDe(await pedir(`/api/admin/clientes/${id}/historial`, { cookie: cookieAna }));
    expect(data.total).toBe(1);
  });
});

describe('alta de cliente', () => {
  it('un barbero recibe 403, no 401', async () => {
    const res = await pedir('/api/admin/clientes', {
      metodo: 'POST', cookie: cookieAna,
      cuerpo: { nombre: 'Nuevo', telefono: '3416513207' },
    });

    expect(res.status).toBe(403);
    expect((await cuerpoDe(res)).error).toBe('Solo los dueños pueden crear clientes.');
  });

  it('el owner puede, y el telefono queda normalizado', async () => {
    const res = await pedir('/api/admin/clientes', {
      metodo: 'POST', cookie: cookieOwner,
      cuerpo: { nombre: 'Juan Pérez', telefono: '0341 15 6513207', email: 'j@x.com' },
    });

    expect(res.status).toBe(200);
    expect((await cuerpoDe(res)).data.telefono).toBe('3416513207');
  });

  it('rechaza un telefono que no es argentino', async () => {
    const res = await pedir('/api/admin/clientes', {
      metodo: 'POST', cookie: cookieOwner,
      cuerpo: { nombre: 'Turista', telefono: '+1 212 555 1234' },
    });
    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toContain('número argentino válido');
  });

  it('acepta un cliente SIN telefono', async () => {
    const res = await pedir('/api/admin/clientes', {
      metodo: 'POST', cookie: cookieOwner, cuerpo: { nombre: 'Sin tel' },
    });
    expect(res.status).toBe(200);
    expect((await cuerpoDe(res)).data.telefono).toBeNull();
  });

  it('un telefono ya usado da un mensaje claro, no un 500', async () => {
    await sembrarCliente({ nombre: 'Primero', telefono: '3416513207' });

    const res = await pedir('/api/admin/clientes', {
      metodo: 'POST', cookie: cookieOwner,
      cuerpo: { nombre: 'Segundo', telefono: '3416513207' },
    });

    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toBe('Ya existe un cliente con ese teléfono.');
  });

  it('exige nombre', async () => {
    const res = await pedir('/api/admin/clientes', {
      metodo: 'POST', cookie: cookieOwner, cuerpo: { telefono: '3416513207' },
    });
    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toBe('El nombre es obligatorio.');
  });
});

describe('import de clientes', () => {
  const fila = (n: number, tel: string) => ({ nombre: `Cliente ${n}`, telefono: tel });

  it('un barbero recibe 403', async () => {
    const res = await pedir('/api/admin/clientes/importar', {
      metodo: 'POST', cookie: cookieAna, cuerpo: { filas: [fila(1, '3416513207')] },
    });
    expect(res.status).toBe(403);
    expect((await cuerpoDe(res)).error).toBe('Solo los dueños pueden importar clientes.');
  });

  it('1001 registros se rechazan', async () => {
    const filas = Array.from({ length: 1001 }, (_, i) => fila(i, `34165${String(i).padStart(5, '0')}`));

    const res = await pedir('/api/admin/clientes/importar', {
      metodo: 'POST', cookie: cookieOwner, cuerpo: { filas },
    });
    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toBe('No se pueden importar más de 1000 clientes por vez.');
  });

  it('1000 exactos se aceptan', async () => {
    const filas = Array.from({ length: 1000 }, (_, i) => fila(i, `34165${String(i).padStart(5, '0')}`));

    const res = await pedir('/api/admin/clientes/importar', {
      metodo: 'POST', cookie: cookieOwner, cuerpo: { filas },
    });
    expect(res.status).toBe(200);
  });

  it('saltea los duplicados por telefono NORMALIZADO y los cuenta', async () => {
    await sembrarCliente({ nombre: 'Ya estaba', telefono: '3416513207' });

    const { data } = await cuerpoDe(
      await pedir('/api/admin/clientes/importar', {
        metodo: 'POST', cookie: cookieOwner,
        cuerpo: {
          filas: [
            { nombre: 'Nuevo', telefono: '3416513200' },
            // Los tres siguientes son EL MISMO numero escrito distinto.
            { nombre: 'Repetido crudo', telefono: '3416513207' },
            { nombre: 'Repetido con 0 y 15', telefono: '0341 15 6513207' },
            { nombre: 'Repetido E.164', telefono: '+54 9 341 651-3207' },
          ],
        },
      }),
    );

    expect(data.importados).toBe(1);
    expect(data.salteados).toBe(3);
    expect(data.errores).toEqual([]);

    const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM clientes').first<{ n: number }>();
    expect(total?.n).toBe(2);
  });

  it('deduplica DENTRO del mismo lote', async () => {
    const { data } = await cuerpoDe(
      await pedir('/api/admin/clientes/importar', {
        metodo: 'POST', cookie: cookieOwner,
        cuerpo: {
          filas: [
            { nombre: 'A', telefono: '3416513207' },
            { nombre: 'B', telefono: '0341 15 6513207' },
          ],
        },
      }),
    );

    expect(data.importados).toBe(1);
    expect(data.salteados).toBe(1);
  });

  it('las filas invalidas se reportan con su numero, sin abortar el lote', async () => {
    const { data } = await cuerpoDe(
      await pedir('/api/admin/clientes/importar', {
        metodo: 'POST', cookie: cookieOwner,
        cuerpo: {
          filas: [
            { nombre: 'Bien', telefono: '3416513200' },
            { nombre: '', telefono: '3416513201' },
            { nombre: 'Turista', telefono: '+1 212 555 1234' },
            { nombre: 'Bien 2', telefono: '3416513202' },
          ],
        },
      }),
    );

    expect(data.importados).toBe(2);
    expect(data.errores).toHaveLength(2);
    expect(data.errores.map((e: any) => e.fila)).toEqual([2, 3]);
  });
});

describe('export CSV', () => {
  it('los headers son de descarga', async () => {
    await sembrarCliente({ nombre: 'Uno', telefono: '3416513207', atendidoPor: ANA });

    const res = await pedir('/api/admin/clientes/exportar', { cookie: cookieAna });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="clientes-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('respeta el scoping', async () => {
    await sembrarCliente({ nombre: 'De Ana', telefono: '3416513201', atendidoPor: ANA });
    await sembrarCliente({ nombre: 'De Beto', telefono: '3416513202', atendidoPor: BETO });

    const csv = await (await pedir('/api/admin/clientes/exportar', { cookie: cookieAna })).text();

    expect(csv).toContain('De Ana');
    expect(csv).not.toContain('De Beto');
  });

  it('"exportar" no se confunde con un id de cliente', async () => {
    // La ruta /clientes/exportar tiene que ganarle a /clientes/:id.
    const res = await pedir('/api/admin/clientes/exportar', { cookie: cookieAna });
    expect(res.headers.get('content-type')).toContain('text/csv');
  });
});

describe('el CSV abre bien en Excel', () => {
  const lista = [
    { id: '1', nombre: 'Pérez, Juan', telefono: '3416513207', email: null, notas: 'Dijo "corto"', createdAt: '2026-08-17T10:00:00.000Z' },
    { id: '2', nombre: 'Ñandú', telefono: null, email: 'a@b.com', notas: null, createdAt: '2026-08-17T10:00:00.000Z' },
  ];

  it('empieza con BOM UTF-8', () => {
    // Sin BOM, Excel en Windows muestra "PÃ©rez" en vez de "Pérez".
    const csv = clientesACsv(lista);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('usa punto y coma, no coma', () => {
    // Excel en español espera `;`. Con coma mete todo en una columna.
    // El BOM va pegado al primer campo, por eso se saca antes de comparar.
    const csv = clientesACsv(lista).replace(/^\ufeff/, '');
    expect(csv.split('\r\n')[0]).toBe('"Nombre";"Teléfono";"Email";"Notas";"Alta"');
  });

  it('un nombre con coma no rompe las columnas', () => {
    const csv = clientesACsv(lista);
    const fila = csv.split('\r\n')[1]!;

    expect(fila).toContain('"Pérez, Juan"');
    // Cinco campos: cuatro separadores fuera de las comillas.
    expect(fila.split('";"')).toHaveLength(5);
  });

  it('las comillas internas se duplican', () => {
    expect(clientesACsv(lista)).toContain('"Dijo ""corto"""');
  });

  it('los nulos salen como campo vacio, no como "null"', () => {
    const csv = clientesACsv(lista);
    expect(csv).not.toContain('null');
    expect(csv.split('\r\n')[2]).toContain('"Ñandú";"";"a@b.com";""');
  });

  it('termina cada linea con CRLF', () => {
    expect(clientesACsv(lista)).toMatch(/\r\n$/);
  });

  it('la fecha va como YYYY-MM-DD, no como timestamp', () => {
    expect(clientesACsv(lista)).toContain('"2026-08-17"');
    expect(clientesACsv(lista)).not.toContain('T10:00:00');
  });
});
