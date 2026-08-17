import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import worker from '../../src/index';
import { uuidv7 } from '../../src/db/id';
import { hashPassword } from '../../src/services/password';
import { todayArgentina, addDays } from '../../src/domain/dates';
import { calcularStats, lunesDeLaSemana } from '../../src/services/stats';
import { esTimezoneValida } from '../../src/services/negocio';
import { AVISO_DURACION_CAMBIADA } from '../../src/services/servicios';
import {
  ERROR_SLUG_DUPLICADO,
  ERROR_ULTIMO_OWNER_DESACTIVAR,
  ERROR_ULTIMO_OWNER_BORRAR,
  ERROR_ULTIMO_OWNER_ROL,
} from '../../src/services/barberos';
import { ERROR_SERVICIO_DUPLICADO } from '../../src/services/servicios';
import { ERROR_PROHIBIDO } from '../../src/services/auth';

const OWNER = '01930000-0000-7000-8000-0000000c0001';
const ANA = '01930000-0000-7000-8000-0000000c0002';
const PASS = 'la-password-de-catalogos';

const ip = () => `192.0.2.77-${uuidv7()}`;

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
  (await res.json()) as { ok: boolean; data?: any; error?: string; warning?: string };

let cookieOwner = '';
let cookieAna = '';

async function sesion(slug: string): Promise<string> {
  const res = await pedir('/api/admin/auth', {
    metodo: 'POST',
    cuerpo: { usuario: slug, password: PASS },
  });
  return `admin_token=${/admin_token=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1]}`;
}

/** Slug siempre nuevo: el indice unico de `barberos.slug` no perdona. */
const slugNuevo = () => `b${uuidv7().replace(/-/g, '').slice(-12)}`;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
  await env.DB.prepare('INSERT OR REPLACE INTO negocio (id) VALUES (1)').run();

  const hash = await hashPassword(PASS);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO barberos (id, slug, nombre, rol, password_hash) VALUES (?, 'jefa', 'Jefa', 'owner', ?)",
    ).bind(OWNER, hash),
    env.DB.prepare(
      "INSERT OR REPLACE INTO barberos (id, slug, nombre, rol, password_hash) VALUES (?, 'anac', 'Ana', 'barbero', ?)",
    ).bind(ANA, hash),
  ]);

  cookieOwner = await sesion('jefa');
  cookieAna = await sesion('anac');
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM reservas'),
    env.DB.prepare('DELETE FROM clientes_recurrentes'),
    env.DB.prepare('DELETE FROM servicios'),
    env.DB.prepare('DELETE FROM promos'),
    env.DB.prepare('DELETE FROM catalogo'),
    env.DB.prepare('DELETE FROM barberos WHERE id NOT IN (?, ?)').bind(OWNER, ANA),
    env.DB.prepare("UPDATE barberos SET activo = 1, rol = 'owner' WHERE id = ?").bind(OWNER),
    env.DB.prepare('INSERT OR REPLACE INTO negocio (id) VALUES (1)'),
  ]);
});

// ==========================================================================

describe('🐛 los chequeos de owner devuelven 403, no 401', () => {
  /**
   * El bug del sistema viejo. Un 401 le dice al frontend "volvé a loguearte", y
   * volver a loguearse no cambia nada: el barbero sigue sin ser dueño. El panel
   * queda en loop de login.
   */
  const soloOwner = [
    ['GET', '/api/admin/barberos'],
    ['POST', '/api/admin/barberos'],
    ['PUT', '/api/admin/barberos/x'],
    ['DELETE', '/api/admin/barberos/x'],
    ['GET', '/api/admin/servicios'],
    ['POST', '/api/admin/servicios'],
    ['PUT', '/api/admin/servicios/x'],
    ['DELETE', '/api/admin/servicios/x'],
    ['GET', '/api/admin/promos'],
    ['POST', '/api/admin/promos'],
    ['PUT', '/api/admin/promos/x'],
    ['DELETE', '/api/admin/promos/x'],
    ['GET', '/api/admin/catalogo'],
    ['POST', '/api/admin/catalogo'],
    ['PUT', '/api/admin/catalogo/x'],
    ['DELETE', '/api/admin/catalogo/x'],
    ['PUT', '/api/admin/negocio'],
  ] as const;

  for (const [metodo, ruta] of soloOwner) {
    it(`${metodo} ${ruta} da 403 para un barbero`, async () => {
      const res = await pedir(ruta, {
        metodo,
        ...(metodo === 'GET' || metodo === 'DELETE' ? {} : { cuerpo: {} }),
        cookie: cookieAna,
      });

      expect(res.status).toBe(403);
      expect((await cuerpoDe(res)).error).toBe(ERROR_PROHIBIDO);
    });
  }

  it('sin sesion siguen siendo 401: ahi si falta autenticarse', async () => {
    const res = await pedir('/api/admin/barberos');
    expect(res.status).toBe(401);
  });

  it('GET /negocio y GET /stats los puede leer cualquier autenticado', async () => {
    for (const ruta of ['/api/admin/negocio', '/api/admin/stats']) {
      expect((await pedir(ruta, { cookie: cookieAna })).status).toBe(200);
    }
  });
});

describe('barberos', () => {
  it('el alta devuelve el barbero sin el hash de la password', async () => {
    const slug = slugNuevo();
    const res = await pedir('/api/admin/barberos', {
      metodo: 'POST',
      cuerpo: { slug, nombre: 'Nuevo', password: 'password-larguisima' },
      cookie: cookieOwner,
    });

    expect(res.status).toBe(200);
    const { data } = await cuerpoDe(res);
    expect(data.slug).toBe(slug);
    expect(data.tienePassword).toBe(true);
    // El hash no sale NUNCA, ni siquiera al owner.
    expect(JSON.stringify(data)).not.toContain('pbkdf2');
    expect(data.passwordHash).toBeUndefined();
  });

  it('un barbero nuevo NACE CON HORARIO: 7 días, domingo inactivo', async () => {
    // Sin esto no aparece en la disponibilidad y nadie entiende por que.
    const res = await pedir('/api/admin/barberos', {
      metodo: 'POST',
      cuerpo: { slug: slugNuevo(), nombre: 'Con horario' },
      cookie: cookieOwner,
    });
    const { data } = await cuerpoDe(res);

    const filas = await env.DB.prepare(
      'SELECT dow, activo FROM barbero_horarios WHERE barbero_id = ? ORDER BY dow',
    )
      .bind(data.id)
      .all<{ dow: number; activo: number }>();

    expect(filas.results.map((f) => f.dow)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(filas.results.find((f) => f.dow === 0)?.activo).toBe(0);
    expect(filas.results.filter((f) => f.activo === 1)).toHaveLength(6);
  });

  it('slug duplicado da 400 con mensaje claro, NO 500', async () => {
    const slug = slugNuevo();
    const cuerpo = { slug, nombre: 'Primero' };

    expect((await pedir('/api/admin/barberos', { metodo: 'POST', cuerpo, cookie: cookieOwner })).status).toBe(200);

    const res = await pedir('/api/admin/barberos', {
      metodo: 'POST',
      cuerpo: { ...cuerpo, nombre: 'Segundo' },
      cookie: cookieOwner,
    });

    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toBe(ERROR_SLUG_DUPLICADO);
  });

  it('el slug se normaliza a minúsculas: es lo que se tipea en el login', async () => {
    const slug = slugNuevo();
    const res = await pedir('/api/admin/barberos', {
      metodo: 'POST',
      cuerpo: { slug: `  ${slug.toUpperCase()} `, nombre: 'Mayus' },
      cookie: cookieOwner,
    });

    expect((await cuerpoDe(res)).data.slug).toBe(slug);
  });

  it('un slug con espacios o símbolos se rechaza', async () => {
    for (const slug of ['con espacio', 'ab', 'con.punto', '']) {
      const res = await pedir('/api/admin/barberos', {
        metodo: 'POST',
        cuerpo: { slug, nombre: 'X' },
        cookie: cookieOwner,
      });
      expect(res.status).toBe(400);
    }
  });

  it('una password corta se rechaza también en el alta de barbero', async () => {
    const res = await pedir('/api/admin/barberos', {
      metodo: 'POST',
      cuerpo: { slug: slugNuevo(), nombre: 'Corta', password: 'corta' },
      cookie: cookieOwner,
    });

    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toMatch(/12/);
  });

  it('el listado del panel SÍ incluye a los desactivados', async () => {
    // Es la excepcion deliberada a la regla de filtrar activo = 1: si no
    // aparecieran, no habria forma de reactivarlos desde el panel.
    const slug = slugNuevo();
    const alta = await pedir('/api/admin/barberos', {
      metodo: 'POST',
      cuerpo: { slug, nombre: 'Dado de baja', activo: false },
      cookie: cookieOwner,
    });
    const id = (await cuerpoDe(alta)).data.id;

    const { data } = await cuerpoDe(await pedir('/api/admin/barberos', { cookie: cookieOwner }));
    const encontrado = data.find((b: { id: string }) => b.id === id);

    expect(encontrado).toBeDefined();
    expect(encontrado.activo).toBe(0);
  });

  it('404 al editar o borrar uno que no existe', async () => {
    const inexistente = uuidv7();

    expect(
      (await pedir(`/api/admin/barberos/${inexistente}`, { metodo: 'PUT', cuerpo: { nombre: 'X' }, cookie: cookieOwner })).status,
    ).toBe(404);
    expect(
      (await pedir(`/api/admin/barberos/${inexistente}`, { metodo: 'DELETE', cookie: cookieOwner })).status,
    ).toBe(404);
  });
});

describe('🔴 el último dueño', () => {
  /**
   * Los tres caminos que dejan el panel sin acceso. La spec nombra dos;
   * DEGRADAR el rol es el tercero y hace exactamente el mismo daño.
   */
  const desactivar = (id: string) =>
    pedir(`/api/admin/barberos/${id}`, { metodo: 'PUT', cuerpo: { activo: false }, cookie: cookieOwner });

  it('no se puede desactivar al único owner', async () => {
    const res = await desactivar(OWNER);

    expect(res.status).toBe(409);
    expect((await cuerpoDe(res)).error).toBe(ERROR_ULTIMO_OWNER_DESACTIVAR);

    // Y sigue activo: el rechazo no puede ser cosmetico.
    const fila = await env.DB.prepare('SELECT activo FROM barberos WHERE id = ?').bind(OWNER).first<{ activo: number }>();
    expect(fila?.activo).toBe(1);
  });

  it('no se puede borrar al único owner', async () => {
    const res = await pedir(`/api/admin/barberos/${OWNER}`, { metodo: 'DELETE', cookie: cookieOwner });

    expect(res.status).toBe(409);
    expect((await cuerpoDe(res)).error).toBe(ERROR_ULTIMO_OWNER_BORRAR);
    expect(await env.DB.prepare('SELECT id FROM barberos WHERE id = ?').bind(OWNER).first()).toBeTruthy();
  });

  it('tampoco se lo puede DEGRADAR a barbero — el mismo daño por otra puerta', async () => {
    const res = await pedir(`/api/admin/barberos/${OWNER}`, {
      metodo: 'PUT',
      cuerpo: { rol: 'barbero' },
      cookie: cookieOwner,
    });

    expect(res.status).toBe(409);
    expect((await cuerpoDe(res)).error).toBe(ERROR_ULTIMO_OWNER_ROL);

    const fila = await env.DB.prepare('SELECT rol FROM barberos WHERE id = ?').bind(OWNER).first<{ rol: string }>();
    expect(fila?.rol).toBe('owner');
  });

  it('con DOS owners activos, desactivar a uno se permite', async () => {
    const alta = await pedir('/api/admin/barberos', {
      metodo: 'POST',
      cuerpo: { slug: slugNuevo(), nombre: 'Segundo dueño', rol: 'owner' },
      cookie: cookieOwner,
    });
    const segundo = (await cuerpoDe(alta)).data.id;

    expect((await desactivar(segundo)).status).toBe(200);
    // Y ahora el primero vuelve a ser el ultimo: se rebloquea.
    expect((await desactivar(OWNER)).status).toBe(409);
  });

  it('un owner DESACTIVADO no cuenta como respaldo', async () => {
    // Es el caso que un `count(rol = owner)` sin `activo = 1` dejaria pasar,
    // dejando el panel accesible solo por una cuenta que no puede loguearse.
    const alta = await pedir('/api/admin/barberos', {
      metodo: 'POST',
      cuerpo: { slug: slugNuevo(), nombre: 'Dueño de licencia', rol: 'owner', activo: false },
      cookie: cookieOwner,
    });
    expect((await cuerpoDe(alta)).data.activo).toBe(0);

    expect((await desactivar(OWNER)).status).toBe(409);
  });

  it('desactivar a un barbero CON TURNOS futuros da 409 con la lista', async () => {
    const manana = addDays(todayArgentina(), 1);
    await env.DB.prepare(
      `INSERT INTO reservas (id, barbero_id, nombre, telefono, servicio, duracion_min, fecha, hora)
       VALUES (?, ?, 'Cliente', '+5493416513207', 'Corte', 30, ?, '10:00')`,
    )
      .bind(uuidv7(), ANA, manana)
      .run();

    const res = await pedir(`/api/admin/barberos/${ANA}`, {
      metodo: 'PUT',
      cuerpo: { activo: false },
      cookie: cookieOwner,
    });

    expect(res.status).toBe(409);
    const cuerpo = await cuerpoDe(res);
    expect(cuerpo.error).toContain('1 turno(s) futuro(s)');
    expect(cuerpo.data).toHaveLength(1);
    expect(cuerpo.data[0].fecha).toBe(manana);
  });
});

describe('servicios', () => {
  const crear = (cuerpo: unknown) =>
    pedir('/api/admin/servicios', { metodo: 'POST', cuerpo, cookie: cookieOwner });

  it('nombre duplicado da 400 con mensaje claro', async () => {
    expect((await crear({ nombre: 'Corte' })).status).toBe(200);

    const res = await crear({ nombre: 'Corte', duracionMin: 45 });
    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toBe(ERROR_SERVICIO_DUPLICADO);
  });

  it('duración fuera de rango se rechaza, los bordes entran', async () => {
    expect((await crear({ nombre: 'Muy corto', duracionMin: 4 })).status).toBe(400);
    expect((await crear({ nombre: 'Muy largo', duracionMin: 481 })).status).toBe(400);
    expect((await crear({ nombre: 'No entero', duracionMin: 30.5 })).status).toBe(400);
    expect((await crear({ nombre: 'Borde bajo', duracionMin: 5 })).status).toBe(200);
    expect((await crear({ nombre: 'Borde alto', duracionMin: 480 })).status).toBe(200);
  });

  it('un precio con decimales o negativo se rechaza: son centavos', async () => {
    expect((await crear({ nombre: 'Decimal', precioCentavos: 1500.5 })).status).toBe(400);
    expect((await crear({ nombre: 'Negativo', precioCentavos: -100 })).status).toBe(400);
    expect((await crear({ nombre: 'Gratis', precioCentavos: 0 })).status).toBe(200);
  });

  it('🔴 cambiar la duración NO toca los turnos ya creados, y avisa', async () => {
    const { data: servicio } = await cuerpoDe(await crear({ nombre: 'Corte', duracionMin: 30 }));

    const reservaId = uuidv7();
    await env.DB.prepare(
      `INSERT INTO reservas (id, barbero_id, servicio_id, nombre, telefono, servicio, duracion_min, fecha, hora)
       VALUES (?, ?, ?, 'Cliente', '+5493416513207', 'Corte', 30, '2027-05-10', '10:00')`,
    )
      .bind(reservaId, ANA, servicio.id)
      .run();

    const res = await pedir(`/api/admin/servicios/${servicio.id}`, {
      metodo: 'PUT',
      cuerpo: { duracionMin: 45 },
      cookie: cookieOwner,
    });

    expect(res.status).toBe(200);
    const cuerpo = await cuerpoDe(res);
    expect(cuerpo.data.duracionMin).toBe(45);

    // El aviso: es lo unico que le dice al dueño que la agenda no se reacomoda.
    expect(cuerpo.warning).toBe(AVISO_DURACION_CAMBIADA);

    // Y el turno viejo conserva SU copia.
    const fila = await env.DB.prepare('SELECT duracion_min FROM reservas WHERE id = ?')
      .bind(reservaId)
      .first<{ duracion_min: number }>();
    expect(fila?.duracion_min).toBe(30);
  });

  it('editar OTRA cosa no dispara el aviso de duración', async () => {
    const { data } = await cuerpoDe(await crear({ nombre: 'Barba', duracionMin: 30 }));

    const res = await pedir(`/api/admin/servicios/${data.id}`, {
      metodo: 'PUT',
      cuerpo: { precioCentavos: 900000 },
      cookie: cookieOwner,
    });

    expect((await cuerpoDe(res)).warning).toBeUndefined();
  });

  it('reenviar la MISMA duración tampoco avisa', async () => {
    const { data } = await cuerpoDe(await crear({ nombre: 'Cejas', duracionMin: 30 }));

    const res = await pedir(`/api/admin/servicios/${data.id}`, {
      metodo: 'PUT',
      cuerpo: { duracionMin: 30 },
      cookie: cookieOwner,
    });

    expect((await cuerpoDe(res)).warning).toBeUndefined();
  });

  it('borrar un servicio deja la reserva y su nombre copiado', async () => {
    const { data } = await cuerpoDe(await crear({ nombre: 'Se va' }));
    const reservaId = uuidv7();
    await env.DB.prepare(
      `INSERT INTO reservas (id, barbero_id, servicio_id, nombre, telefono, servicio, duracion_min, fecha, hora)
       VALUES (?, ?, ?, 'Cliente', '+5493416513208', 'Se va', 30, '2027-05-11', '11:00')`,
    )
      .bind(reservaId, ANA, data.id)
      .run();

    expect((await pedir(`/api/admin/servicios/${data.id}`, { metodo: 'DELETE', cookie: cookieOwner })).status).toBe(200);

    const fila = await env.DB.prepare('SELECT servicio, servicio_id FROM reservas WHERE id = ?')
      .bind(reservaId)
      .first<{ servicio: string; servicio_id: string | null }>();

    expect(fila?.servicio).toBe('Se va');
    expect(fila?.servicio_id).toBeNull();
  });
});

describe('promos y catálogo', () => {
  it('promos: alta, edición, listado y borrado', async () => {
    const alta = await pedir('/api/admin/promos', {
      metodo: 'POST',
      cuerpo: { nombre: '2x1 martes', precioCentavos: 500000, badge: 'NUEVO' },
      cookie: cookieOwner,
    });
    const id = (await cuerpoDe(alta)).data.id;

    const editada = await pedir(`/api/admin/promos/${id}`, {
      metodo: 'PUT',
      cuerpo: { precioCentavos: 450000 },
      cookie: cookieOwner,
    });
    const { data } = await cuerpoDe(editada);
    expect(data.precioCentavos).toBe(450000);
    // Los campos no enviados no se pisan.
    expect(data.badge).toBe('NUEVO');
    expect(data.nombre).toBe('2x1 martes');

    expect((await pedir(`/api/admin/promos/${id}`, { metodo: 'DELETE', cookie: cookieOwner })).status).toBe(200);
    expect((await cuerpoDe(await pedir('/api/admin/promos', { cookie: cookieOwner }))).data).toHaveLength(0);
  });

  it('dos promos con el mismo nombre son válidas: no hay unicidad', async () => {
    const cuerpo = { nombre: '2x1' };
    expect((await pedir('/api/admin/promos', { metodo: 'POST', cuerpo, cookie: cookieOwner })).status).toBe(200);
    expect((await pedir('/api/admin/promos', { metodo: 'POST', cuerpo, cookie: cookieOwner })).status).toBe(200);
  });

  it('catálogo: `incluye` vacío queda en cadena, no en null', async () => {
    // La columna es NOT NULL con default ''. Un null revienta el insert.
    const alta = await pedir('/api/admin/catalogo', {
      metodo: 'POST',
      cuerpo: { nombre: 'Corte clásico' },
      cookie: cookieOwner,
    });

    expect(alta.status).toBe(200);
    expect((await cuerpoDe(alta)).data.incluye).toBe('');
  });

  it('404 en promo o ítem inexistente', async () => {
    const id = uuidv7();
    for (const ruta of [`/api/admin/promos/${id}`, `/api/admin/catalogo/${id}`]) {
      expect((await pedir(ruta, { metodo: 'PUT', cuerpo: { nombre: 'X' }, cookie: cookieOwner })).status).toBe(404);
      expect((await pedir(ruta, { metodo: 'DELETE', cookie: cookieOwner })).status).toBe(404);
    }
  });

  it('el orden respeta `orden` y después el nombre', async () => {
    for (const p of [
      { nombre: 'Zeta', orden: 1 },
      { nombre: 'Alfa', orden: 2 },
      { nombre: 'Beta', orden: 1 },
    ]) {
      await pedir('/api/admin/promos', { metodo: 'POST', cuerpo: p, cookie: cookieOwner });
    }

    const { data } = await cuerpoDe(await pedir('/api/admin/promos', { cookie: cookieOwner }));
    expect(data.map((p: { nombre: string }) => p.nombre)).toEqual(['Beta', 'Zeta', 'Alfa']);
  });
});

describe('configuración del negocio', () => {
  const put = (cuerpo: unknown) =>
    pedir('/api/admin/negocio', { metodo: 'PUT', cuerpo, cookie: cookieOwner });

  it('los rangos rechazan afuera y aceptan los bordes exactos', async () => {
    const casos = [
      ['slotDuracionMin', 4, 5, 240, 241],
      ['minutosAnticipacionMin', -1, 0, 10080, 10081],
      ['diasMaxAnticipacion', 0, 1, 365, 366],
    ] as const;

    for (const [campo, bajoMalo, bajoBueno, altoBueno, altoMalo] of casos) {
      expect((await put({ [campo]: bajoMalo })).status, `${campo} ${bajoMalo}`).toBe(400);
      expect((await put({ [campo]: altoMalo })).status, `${campo} ${altoMalo}`).toBe(400);
      expect((await put({ [campo]: bajoBueno })).status, `${campo} ${bajoBueno}`).toBe(200);
      expect((await put({ [campo]: altoBueno })).status, `${campo} ${altoBueno}`).toBe(200);
    }
  });

  it('un valor no entero se rechaza', async () => {
    expect((await put({ slotDuracionMin: 30.5 })).status).toBe(400);
    expect((await put({ slotDuracionMin: '30' })).status).toBe(400);
  });

  it('el mensaje de rango nombra el parámetro y el rango', async () => {
    // El unico que lo lee es quien esta depurando el frontend.
    const { error } = await cuerpoDe(await put({ slotDuracionMin: 1000 }));
    expect(error).toContain('slot_duracion_min');
    expect(error).toContain('240');
  });

  it('🔴 el timezone de Windows del sistema viejo se rechaza', async () => {
    const res = await put({ timezone: 'Argentina Standard Time' });

    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toContain('IANA');
  });

  it('un IANA válido entra y se guarda', async () => {
    const res = await put({ timezone: 'America/Argentina/Cordoba' });

    expect(res.status).toBe(200);
    expect((await cuerpoDe(res)).data.timezone).toBe('America/Argentina/Cordoba');
  });

  it('cambiar el paso de la grilla avisa; otro campo no', async () => {
    expect((await cuerpoDe(await put({ slotDuracionMin: 15 }))).warning).toContain('grilla');
    expect((await cuerpoDe(await put({ slotDuracionMin: 15 }))).warning).toBeUndefined();
    expect((await cuerpoDe(await put({ nombreNegocio: 'Otra' }))).warning).toBeUndefined();
  });

  it('el PUT es parcial: lo que no viene no se pisa', async () => {
    await put({ nombreNegocio: 'Gebyanos', slotDuracionMin: 30 });
    const { data } = await cuerpoDe(await put({ diasMaxAnticipacion: 21 }));

    expect(data.nombreNegocio).toBe('Gebyanos');
    expect(data.slotDuracionMin).toBe(30);
    expect(data.diasMaxAnticipacion).toBe(21);
  });
});

describe('esTimezoneValida', () => {
  it('acepta identificadores IANA', () => {
    for (const tz of ['America/Argentina/Buenos_Aires', 'UTC', 'Europe/Madrid']) {
      expect(esTimezoneValida(tz), tz).toBe(true);
    }
  });

  it('rechaza los que no lo son', () => {
    for (const tz of ['Argentina Standard Time', 'Marte/Olympus', '', '   ', 'GMT-3', null, 42]) {
      expect(esTimezoneValida(tz), String(tz)).toBe(false);
    }
  });
});

describe('stats', () => {
  const sembrar = (barberoId: string, fecha: string, hora: string, extra = '') =>
    env.DB.prepare(
      `INSERT INTO reservas (id, barbero_id, nombre, telefono, servicio, duracion_min, fecha, hora, estado, tipo)
       VALUES (?, ?, 'C', ?, 'Corte', 30, ?, ?, ?, ?)`,
    ).bind(
      uuidv7(),
      barberoId,
      `+54934165${Math.floor(Math.random() * 100000).toString().padStart(5, '0')}`,
      fecha,
      hora,
      extra === 'cancelada' ? 'cancelada' : 'activa',
      extra === 'bloqueo' ? 'bloqueo' : 'turno',
    );

  it('un barbero solo cuenta lo suyo; el owner cuenta todo', async () => {
    const hoy = todayArgentina();
    await env.DB.batch([sembrar(ANA, hoy, '09:00'), sembrar(ANA, hoy, '10:00'), sembrar(OWNER, hoy, '11:00')]);

    const deAna = await cuerpoDe(await pedir('/api/admin/stats', { cookie: cookieAna }));
    const deOwner = await cuerpoDe(await pedir('/api/admin/stats', { cookie: cookieOwner }));

    expect(deAna.data.hoy).toBe(2);
    expect(deOwner.data.hoy).toBe(3);
  });

  it('un barbero no puede pedir las stats de otro', async () => {
    const res = await pedir(`/api/admin/stats?barberoId=${OWNER}`, { cookie: cookieAna });
    expect(res.status).toBe(403);
  });

  it('no cuenta canceladas ni bloqueos', async () => {
    const hoy = todayArgentina();
    await env.DB.batch([
      sembrar(ANA, hoy, '09:00'),
      sembrar(ANA, hoy, '10:00', 'cancelada'),
      sembrar(ANA, hoy, '11:00', 'bloqueo'),
    ]);

    const { data } = await cuerpoDe(await pedir('/api/admin/stats', { cookie: cookieAna }));
    expect(data.hoy).toBe(1);
    expect(data.mes).toBe(1);
  });

  it('sin ninguna reserva devuelve ceros, no nulls', async () => {
    // `sum()` sobre cero filas da NULL en SQLite: sin el fallback el panel
    // muestra "null turnos".
    const { data } = await cuerpoDe(await pedir('/api/admin/stats', { cookie: cookieAna }));

    expect(data).toMatchObject({ hoy: 0, semana: 0, mes: 0, recurrentesActivos: 0 });
  });

  it('cuenta los recurrentes activos y no los dados de baja', async () => {
    const clienteId = uuidv7();
    await env.DB.prepare('INSERT INTO clientes (id, nombre, telefono) VALUES (?, ?, ?)')
      .bind(clienteId, 'Recu', `+549341${uuidv7().replace(/\D/g, '').slice(0, 7)}`)
      .run();

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO clientes_recurrentes (id, barbero_id, cliente_id, servicio, activo) VALUES (?, ?, ?, 'Corte', 1)",
      ).bind(uuidv7(), ANA, clienteId),
      env.DB.prepare(
        "INSERT INTO clientes_recurrentes (id, barbero_id, cliente_id, servicio, activo) VALUES (?, ?, ?, 'Corte', 0)",
      ).bind(uuidv7(), ANA, clienteId),
    ]);

    const { data } = await cuerpoDe(await pedir('/api/admin/stats', { cookie: cookieAna }));
    expect(data.recurrentesActivos).toBe(1);
  });

  it('🔴 "la semana" es la semana CALENDARIO, no los próximos 7 días', async () => {
    // Jueves 2027-03-11. La semana va del lunes 8 al domingo 14.
    const jueves = new Date('2027-03-11T15:00:00Z');

    await env.DB.batch([
      sembrar(ANA, '2027-03-08', '09:00'), // lunes, YA PASO pero es esta semana
      sembrar(ANA, '2027-03-14', '09:00'), // domingo, ultimo dia
      sembrar(ANA, '2027-03-15', '09:00'), // lunes siguiente: fuera
      sembrar(ANA, '2027-03-07', '09:00'), // domingo anterior: fuera
    ]);

    const stats = await calcularStats(env, ANA, jueves);

    expect(stats.rango.semanaDesde).toBe('2027-03-08');
    expect(stats.rango.semanaHasta).toBe('2027-03-14');
    expect(stats.semana).toBe(2);
    // Los cuatro caen en marzo.
    expect(stats.mes).toBe(4);
  });

  it('el domingo pertenece a la semana que arrancó el lunes anterior', async () => {
    // El error clasico: con `-dow` el domingo abre su propia semana.
    expect(lunesDeLaSemana('2027-03-14')).toBe('2027-03-08');
    expect(lunesDeLaSemana('2027-03-08')).toBe('2027-03-08');
    expect(lunesDeLaSemana('2027-03-09')).toBe('2027-03-08');
  });

  it('el mes no se derrama al siguiente ni se come febrero', async () => {
    await env.DB.batch([
      sembrar(ANA, '2027-02-01', '09:00'),
      sembrar(ANA, '2027-02-28', '09:00'),
      sembrar(ANA, '2027-03-01', '09:00'),
      sembrar(ANA, '2027-01-31', '09:00'),
    ]);

    const stats = await calcularStats(env, ANA, new Date('2027-02-15T15:00:00Z'));
    expect(stats.mes).toBe(2);
  });
});
