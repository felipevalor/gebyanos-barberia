import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest';
import worker from '../../src/index';
import { uuidv7 } from '../../src/db/id';
import { hashPassword } from '../../src/services/password';
import { todayArgentina, addDays, diaDeLaSemana } from '../../src/domain/dates';
import { sembrarHorarioInicial, listarHorarios } from '../../src/services/horarios';
import {
  chequearDesactivarBarbero,
  chequearBorrarBarbero,
} from '../../src/services/conflictos';

const OWNER = '01930000-0000-7000-8000-0000000e0001';
const BARBERO = '01930000-0000-7000-8000-0000000e0002';
const SERVICIO = '01930000-0000-7000-8000-0000000e0010';
const PASS = 'la-password-de-config';

const HOY = todayArgentina();
/** Una fecha futura cuyo dia de la semana conocemos. */
const FUTURO = addDays(HOY, 7);
const DOW_FUTURO = diaDeLaSemana(FUTURO);

const ip = () => `192.0.2.9-${uuidv7()}`;

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

let cookie = '';

async function sembrarTurno(o: {
  hora: string;
  fecha?: string;
  tipo?: string;
  estado?: string;
  duracionMin?: number;
  nombre?: string;
}): Promise<string> {
  const id = uuidv7();
  await env.DB.prepare(
    `INSERT INTO reservas (id, barbero_id, nombre, telefono, servicio, duracion_min, fecha, hora, estado, tipo, source)
     VALUES (?, ?, ?, '3416513207', 'Corte', ?, ?, ?, ?, ?, 'web')`,
  )
    .bind(
      id,
      BARBERO,
      o.nombre ?? 'Juan',
      o.duracionMin ?? 30,
      o.fecha ?? FUTURO,
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
    env.DB.prepare("INSERT OR REPLACE INTO barberos (id, slug, nombre, rol, password_hash) VALUES (?, 'jefe', 'Jefe', 'owner', ?)").bind(OWNER, hash),
    env.DB.prepare("INSERT OR REPLACE INTO barberos (id, slug, nombre, rol, password_hash) VALUES (?, 'pepe', 'Pepe', 'barbero', ?)").bind(BARBERO, hash),
    env.DB.prepare("INSERT OR IGNORE INTO servicios (id, nombre, duracion_min) VALUES (?, 'Corte', 30)").bind(SERVICIO),
  ]);

  const res = await pedir('/api/admin/auth', {
    metodo: 'POST',
    cuerpo: { usuario: 'pepe', password: PASS },
  });
  cookie = `admin_token=${/admin_token=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1]}`;
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM reservas').run();
  await env.DB.prepare('DELETE FROM feriados_override').run();
  await env.DB.prepare('DELETE FROM barbero_horarios').run();
  await env.DB.prepare('DELETE FROM clientes_recurrentes').run();
  // Despues de recurrentes: clientes_recurrentes.cliente_id es RESTRICT.
  // Y hace falta porque clientes.telefono es UNICO — sin esto, dos tests que
  // usan el mismo telefono chocan.
  await env.DB.prepare('DELETE FROM clientes').run();
  await sembrarHorarioInicial(env, BARBERO);
});

// =========================================================== 3.1 horarios

describe('horario inicial de un barbero nuevo', () => {
  it('se siembra lunes a sabado 9-20, con domingo SIN bloques', async () => {
    await env.DB.prepare('DELETE FROM barbero_horarios').run();
    expect(await sembrarHorarioInicial(env, BARBERO)).toBe(true);

    const bloques = await listarHorarios(env, BARBERO);
    expect(bloques.map((b) => b.dow)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const b of bloques) {
      expect(b.horaInicio).toBe(9);
      expect(b.horaFin).toBe(20);
      expect(b.activo).toBe(1);
    }
  });

  it('es idempotente: no duplica si ya tiene horarios', async () => {
    expect(await sembrarHorarioInicial(env, BARBERO)).toBe(false);
    expect(await listarHorarios(env, BARBERO)).toHaveLength(6);
  });

  it('⚠️ un barbero SIN horarios queda CERRADO, no abierto 24/7', async () => {
    // El sistema viejo devuelve "abierto" si no hay ninguna fila de horario, o
    // sea que un barbero sin configurar acepta reservas a las 4 de la mañana.
    // Acá `evaluarSlot` mantiene su regla sin excepciones.
    await env.DB.prepare('DELETE FROM barbero_horarios').run();

    const { data } = await cuerpoDe(
      await pedir(`/api/disponibilidad?barberoId=${BARBERO}&fecha=${FUTURO}`),
    );
    expect(data.slots).toEqual([]);

    // Y una reserva directa por API tampoco entra.
    const res = await pedir('/api/reservas', {
      metodo: 'POST',
      cuerpo: {
        barberoId: BARBERO, servicioId: SERVICIO, fecha: FUTURO, hora: '04:00',
        clienteNombre: 'Madrugador', clienteTelefono: '3416513207',
      },
    });
    expect(res.status).toBe(400);
    expect((await cuerpoDe(res)).error).toBe('La barbería no atiende ese día.');
  });

  it('el GET no inventa horarios: devuelve lo que hay', async () => {
    await env.DB.prepare('DELETE FROM barbero_horarios').run();

    const { data } = await cuerpoDe(await pedir('/api/admin/horarios', { cookie }));
    expect(data).toEqual([]);
  });
});

describe('PUT /horarios/dia/:dow', () => {
  it('un dia con dos bloques genera slots en los dos rangos y ninguno en el hueco', async () => {
    const res = await pedir(`/api/admin/horarios/dia/${DOW_FUTURO}`, {
      metodo: 'PUT',
      cookie,
      cuerpo: { bloques: [{ horaInicio: 9, horaFin: 13 }, { horaInicio: 16, horaFin: 20 }] },
    });
    expect(res.status).toBe(200);

    const { data } = await cuerpoDe(
      await pedir(`/api/disponibilidad?barberoId=${BARBERO}&fecha=${FUTURO}`),
    );

    expect(data.slots).toContain('09:00');
    expect(data.slots).toContain('12:30');
    expect(data.slots).not.toContain('13:00');
    expect(data.slots).not.toContain('14:00');
    expect(data.slots).not.toContain('15:30');
    expect(data.slots).toContain('16:00');
    expect(data.slots).toContain('19:30');
  });

  it('reemplaza TODOS los bloques del dia', async () => {
    await pedir(`/api/admin/horarios/dia/${DOW_FUTURO}`, {
      metodo: 'PUT',
      cookie,
      cuerpo: { bloques: [{ horaInicio: 10, horaFin: 12 }] },
    });

    const bloques = (await listarHorarios(env, BARBERO)).filter((b) => b.dow === DOW_FUTURO);
    expect(bloques).toHaveLength(1);
    expect(bloques[0]).toMatchObject({ horaInicio: 10, horaFin: 12 });
  });

  it('una lista vacia deja el dia cerrado', async () => {
    await pedir(`/api/admin/horarios/dia/${DOW_FUTURO}`, {
      metodo: 'PUT', cookie, cuerpo: { bloques: [] },
    });

    const { data } = await cuerpoDe(
      await pedir(`/api/disponibilidad?barberoId=${BARBERO}&fecha=${FUTURO}`),
    );
    expect(data.slots).toEqual([]);
  });

  it('rechaza hora_fin <= hora_inicio', async () => {
    for (const bloque of [{ horaInicio: 13, horaFin: 9 }, { horaInicio: 9, horaFin: 9 }]) {
      const res = await pedir(`/api/admin/horarios/dia/${DOW_FUTURO}`, {
        metodo: 'PUT', cookie, cuerpo: { bloques: [bloque] },
      });
      expect(res.status).toBe(400);
      expect((await cuerpoDe(res)).error).toContain('mayor que la de inicio');
    }
  });

  it('rechaza horas fuera de 0-24 y no enteras', async () => {
    for (const bloque of [
      { horaInicio: -1, horaFin: 10 },
      { horaInicio: 9, horaFin: 25 },
      { horaInicio: 9.5, horaFin: 20 },
    ]) {
      const res = await pedir(`/api/admin/horarios/dia/${DOW_FUTURO}`, {
        metodo: 'PUT', cookie, cuerpo: { bloques: [bloque] },
      });
      expect(res.status).toBe(400);
    }
  });

  it('rechaza un dow invalido', async () => {
    for (const dow of [7, -1, 'lunes']) {
      const res = await pedir(`/api/admin/horarios/dia/${dow}`, {
        metodo: 'PUT', cookie, cuerpo: { bloques: [] },
      });
      expect(res.status).toBe(400);
      expect((await cuerpoDe(res)).error).toBe(
        'Día de la semana inválido. Usá 0 (domingo) a 6 (sábado).',
      );
    }
  });
});

// ================================================== 3.2 Bloquear + Avisar

describe('Bloquear+Avisar: cambiar el horario de un dia', () => {
  it('409 con la LISTA de turnos que quedarian afuera', async () => {
    await sembrarTurno({ hora: '18:00', nombre: 'Ana' });
    await sembrarTurno({ hora: '19:00', nombre: 'Beto' });
    await sembrarTurno({ hora: '10:00', nombre: 'Sigue entrando' });

    const res = await pedir(`/api/admin/horarios/dia/${DOW_FUTURO}`, {
      metodo: 'PUT', cookie,
      cuerpo: { bloques: [{ horaInicio: 9, horaFin: 13 }] },
    });

    expect(res.status).toBe(409);
    const body = await cuerpoDe(res);
    expect(body.error).toBe(
      'Hay 2 turno(s) que quedarían fuera del nuevo horario. Reagendalos o cancelalos antes de cambiar el horario.',
    );

    // La lista es el punto: sin ella el dueño no sabe qué reagendar.
    expect(body.data).toHaveLength(2);
    expect(body.data.map((t: any) => t.nombre).sort()).toEqual(['Ana', 'Beto']);
    for (const t of body.data) {
      for (const campo of ['id', 'fecha', 'hora', 'nombre', 'telefono', 'servicio']) {
        expect(t[campo]).toBeDefined();
      }
    }
  });

  it('el horario NO se cambia cuando hay conflicto', async () => {
    await sembrarTurno({ hora: '18:00' });

    await pedir(`/api/admin/horarios/dia/${DOW_FUTURO}`, {
      metodo: 'PUT', cookie, cuerpo: { bloques: [{ horaInicio: 9, horaFin: 13 }] },
    });

    const bloques = (await listarHorarios(env, BARBERO)).filter((b) => b.dow === DOW_FUTURO);
    expect(bloques[0]).toMatchObject({ horaInicio: 9, horaFin: 20 });
  });

  it('sin conflictos aplica el cambio', async () => {
    await sembrarTurno({ hora: '10:00' });

    const res = await pedir(`/api/admin/horarios/dia/${DOW_FUTURO}`, {
      metodo: 'PUT', cookie, cuerpo: { bloques: [{ horaInicio: 9, horaFin: 13 }] },
    });
    expect(res.status).toBe(200);
  });

  it('un BLOQUEO administrativo NO cuenta como conflicto', async () => {
    // No tendria sentido que el propio bloqueo del barbero le impida cambiar
    // su horario.
    await sembrarTurno({ hora: '18:00', tipo: 'bloqueo' });

    const res = await pedir(`/api/admin/horarios/dia/${DOW_FUTURO}`, {
      metodo: 'PUT', cookie, cuerpo: { bloques: [{ horaInicio: 9, horaFin: 13 }] },
    });
    expect(res.status).toBe(200);
  });

  it('una reserva CANCELADA no cuenta', async () => {
    await sembrarTurno({ hora: '18:00', estado: 'cancelada' });

    expect(
      (await pedir(`/api/admin/horarios/dia/${DOW_FUTURO}`, {
        metodo: 'PUT', cookie, cuerpo: { bloques: [{ horaInicio: 9, horaFin: 13 }] },
      })).status,
    ).toBe(200);
  });

  it('un turno PASADO no cuenta', async () => {
    await sembrarTurno({ hora: '18:00', fecha: addDays(HOY, -7) });

    expect(
      (await pedir(`/api/admin/horarios/dia/${DOW_FUTURO}`, {
        metodo: 'PUT', cookie, cuerpo: { bloques: [{ horaInicio: 9, horaFin: 13 }] },
      })).status,
    ).toBe(200);
  });

  it('un turno de OTRO dia de la semana no cuenta', async () => {
    await sembrarTurno({ hora: '18:00', fecha: addDays(FUTURO, 1) });

    expect(
      (await pedir(`/api/admin/horarios/dia/${DOW_FUTURO}`, {
        metodo: 'PUT', cookie, cuerpo: { bloques: [{ horaInicio: 9, horaFin: 13 }] },
      })).status,
    ).toBe(200);
  });

  it('usa la duracion REAL del turno: uno de 60 min no entra donde uno de 30 sí', async () => {
    // 12:30 + 30 min termina 13:00 justo; + 60 se pasa.
    await sembrarTurno({ hora: '12:30', duracionMin: 60 });

    const res = await pedir(`/api/admin/horarios/dia/${DOW_FUTURO}`, {
      metodo: 'PUT', cookie, cuerpo: { bloques: [{ horaInicio: 9, horaFin: 13 }] },
    });
    expect(res.status).toBe(409);
  });

  it('un bloque DESACTIVADO no cubre nada', async () => {
    await sembrarTurno({ hora: '10:00' });

    const res = await pedir(`/api/admin/horarios/dia/${DOW_FUTURO}`, {
      metodo: 'PUT', cookie,
      cuerpo: { bloques: [{ horaInicio: 9, horaFin: 20, activo: false }] },
    });
    expect(res.status).toBe(409);
  });
});

describe('Bloquear+Avisar: editar un bloque puntual', () => {
  it('409 recalculando con el bloque editado', async () => {
    await pedir(`/api/admin/horarios/dia/${DOW_FUTURO}`, {
      metodo: 'PUT', cookie,
      cuerpo: { bloques: [{ horaInicio: 9, horaFin: 13 }, { horaInicio: 16, horaFin: 20 }] },
    });
    await sembrarTurno({ hora: '19:00' });

    const bloques = (await listarHorarios(env, BARBERO)).filter((b) => b.dow === DOW_FUTURO);
    const tarde = bloques.find((b) => b.horaInicio === 16)!;

    const res = await pedir(`/api/admin/horarios/${tarde.id}`, {
      metodo: 'PUT', cookie, cuerpo: { horaInicio: 16, horaFin: 18 },
    });

    expect(res.status).toBe(409);
    expect((await cuerpoDe(res)).error).toContain('quedarían fuera del nuevo horario');
  });

  it('los OTROS bloques del dia siguen cubriendo', async () => {
    // Achicar el bloque de la tarde no afecta a un turno de la mañana.
    await pedir(`/api/admin/horarios/dia/${DOW_FUTURO}`, {
      metodo: 'PUT', cookie,
      cuerpo: { bloques: [{ horaInicio: 9, horaFin: 13 }, { horaInicio: 16, horaFin: 20 }] },
    });
    await sembrarTurno({ hora: '10:00' });

    const bloques = (await listarHorarios(env, BARBERO)).filter((b) => b.dow === DOW_FUTURO);
    const tarde = bloques.find((b) => b.horaInicio === 16)!;

    expect(
      (await pedir(`/api/admin/horarios/${tarde.id}`, {
        metodo: 'PUT', cookie, cuerpo: { horaInicio: 16, horaFin: 18 },
      })).status,
    ).toBe(200);
  });

  it('un bloque inexistente da 404', async () => {
    const res = await pedir(`/api/admin/horarios/${uuidv7()}`, {
      metodo: 'PUT', cookie, cuerpo: { horaInicio: 9, horaFin: 20 },
    });
    expect(res.status).toBe(404);
  });
});

// ========================================================== 3.1 feriados

describe('feriados', () => {
  afterEach(() => vi.restoreAllMocks());

  it('el upsert por (barbero, fecha) NO duplica filas', async () => {
    for (const motivo of ['Primera', 'Segunda']) {
      const res = await pedir('/api/admin/feriados', {
        metodo: 'POST', cookie,
        cuerpo: { fecha: FUTURO, trabaja: false, motivo },
      });
      expect(res.status).toBe(200);
    }

    const filas = await env.DB.prepare('SELECT motivo FROM feriados_override').all<{ motivo: string }>();
    expect(filas.results).toHaveLength(1);
    expect(filas.results[0]?.motivo).toBe('Segunda');
  });

  it('un override con trabaja = 0 deja el dia sin slots', async () => {
    await pedir('/api/admin/feriados', {
      metodo: 'POST', cookie, cuerpo: { fecha: FUTURO, trabaja: false },
    });

    const { data } = await cuerpoDe(
      await pedir(`/api/disponibilidad?barberoId=${BARBERO}&fecha=${FUTURO}`),
    );
    expect(data.slots).toEqual([]);
  });

  it('un override con trabaja = 1 NO abre un dia sin horario configurado', async () => {
    // La regla contraintuitiva de evaluarSlot: el override es un booleano, no
    // trae horas.
    await env.DB.prepare('DELETE FROM barbero_horarios').run();

    await pedir('/api/admin/feriados', {
      metodo: 'POST', cookie, cuerpo: { fecha: FUTURO, trabaja: true },
    });

    const { data } = await cuerpoDe(
      await pedir(`/api/disponibilidad?barberoId=${BARBERO}&fecha=${FUTURO}`),
    );
    expect(data.slots).toEqual([]);
  });

  it('cerrar una fecha CON turnos da 409 con la lista', async () => {
    await sembrarTurno({ hora: '10:00', nombre: 'Ana' });
    await sembrarTurno({ hora: '11:00', nombre: 'Beto' });

    const res = await pedir('/api/admin/feriados', {
      metodo: 'POST', cookie, cuerpo: { fecha: FUTURO, trabaja: false },
    });

    expect(res.status).toBe(409);
    const body = await cuerpoDe(res);
    expect(body.error).toBe(
      'Hay 2 turno(s) ese día. Reagendalos o cancelalos antes de marcarlo como cerrado.',
    );
    expect(body.data).toHaveLength(2);

    // Y NO se creo el override.
    const filas = await env.DB.prepare('SELECT id FROM feriados_override').all();
    expect(filas.results).toHaveLength(0);
  });

  it('ABRIR una fecha con turnos no bloquea: no deja a nadie huerfano', async () => {
    await sembrarTurno({ hora: '10:00' });

    expect(
      (await pedir('/api/admin/feriados', {
        metodo: 'POST', cookie, cuerpo: { fecha: FUTURO, trabaja: true },
      })).status,
    ).toBe(200);
  });

  it('el GET separa nacionales de propios', async () => {
    // La API externa se mockea: el test no puede depender de una red ajena.
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes('argentinadatos')) {
        return new Response(
          JSON.stringify([{ fecha: `${FUTURO.slice(0, 4)}-05-01`, nombre: 'Día del Trabajador', tipo: 'inamovible' }]),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return fetchOriginal(url as never);
    }) as typeof fetch;

    try {
      await pedir('/api/admin/feriados', {
        metodo: 'POST', cookie, cuerpo: { fecha: FUTURO, trabaja: false, motivo: 'Vacaciones' },
      });

      const { data } = await cuerpoDe(
        await pedir(`/api/admin/feriados?anio=${FUTURO.slice(0, 4)}`, { cookie }),
      );

      expect(data.nacionales).toHaveLength(1);
      expect(data.nacionales[0].nombre).toBe('Día del Trabajador');
      expect(data.propios).toHaveLength(1);
      expect(data.propios[0].motivo).toBe('Vacaciones');
      // Van separados: "es feriado pero abrimos" y "cerramos sin ser feriado"
      // son estados distintos.
      expect(data).not.toHaveProperty('feriados');
    } finally {
      globalThis.fetch = fetchOriginal;
    }
  });

  it('si la API de feriados falla, los propios se muestran igual', async () => {
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes('argentinadatos')) throw new Error('red caida');
      return fetchOriginal(url as never);
    }) as typeof fetch;

    try {
      await pedir('/api/admin/feriados', {
        metodo: 'POST', cookie, cuerpo: { fecha: FUTURO, trabaja: false },
      });

      const res = await pedir(`/api/admin/feriados?anio=${FUTURO.slice(0, 4)}`, { cookie });
      expect(res.status).toBe(200);

      const { data } = await cuerpoDe(res);
      expect(data.nacionales).toEqual([]);
      expect(data.propios).toHaveLength(1);
    } finally {
      globalThis.fetch = fetchOriginal;
    }
  });

  it('borrar un override reabre el dia', async () => {
    const { data } = await cuerpoDe(
      await pedir('/api/admin/feriados', {
        metodo: 'POST', cookie, cuerpo: { fecha: FUTURO, trabaja: false },
      }),
    );

    expect((await pedir(`/api/admin/feriados/${data.id}`, { metodo: 'DELETE', cookie })).status).toBe(200);

    const dispo = await cuerpoDe(
      await pedir(`/api/disponibilidad?barberoId=${BARBERO}&fecha=${FUTURO}`),
    );
    expect(dispo.data.slots.length).toBeGreaterThan(0);
  });

  it('rechaza fecha y trabaja invalidos', async () => {
    expect(
      (await pedir('/api/admin/feriados', { metodo: 'POST', cookie, cuerpo: { fecha: '15/3/2027', trabaja: false } })).status,
    ).toBe(400);
    expect(
      (await pedir('/api/admin/feriados', { metodo: 'POST', cookie, cuerpo: { fecha: FUTURO } })).status,
    ).toBe(400);
  });
});

// ============ 3.2: los dos chequeos de barbero, que la 3.4 va a cablear

describe('Bloquear+Avisar: desactivar y borrar barbero', () => {
  it('desactivar con turnos futuros: mensaje textual y lista', async () => {
    await sembrarTurno({ hora: '10:00', nombre: 'Ana' });
    await sembrarTurno({ hora: '11:00', nombre: 'Beto' });

    const chequeo = await chequearDesactivarBarbero(env, BARBERO);

    expect(chequeo.hayConflicto).toBe(true);
    if (!chequeo.hayConflicto) return;
    expect(chequeo.mensaje).toBe(
      'No se puede desactivar: el barbero tiene 2 turno(s) futuro(s). Reagendalos o cancelalos antes de desactivarlo.',
    );
    expect(chequeo.turnos).toHaveLength(2);
  });

  it('desactivar sin turnos futuros no bloquea', async () => {
    await sembrarTurno({ hora: '10:00', fecha: addDays(HOY, -3) });
    await sembrarTurno({ hora: '11:00', estado: 'cancelada' });
    await sembrarTurno({ hora: '12:00', tipo: 'bloqueo' });

    expect((await chequearDesactivarBarbero(env, BARBERO)).hayConflicto).toBe(false);
  });

  it('⚠️ borrar avisa de los RECURRENTES, que el CASCADE se llevaria en silencio', async () => {
    // reservas.barbero_id es SET NULL pero clientes_recurrentes.barbero_id es
    // CASCADE: borrar el barbero borra sus recurrentes sin dejar rastro.
    await sembrarTurno({ hora: '10:00' });

    const clienteId = uuidv7();
    await env.DB.prepare("INSERT INTO clientes (id, nombre, telefono) VALUES (?, 'Fiel', '3416513207')")
      .bind(clienteId)
      .run();
    await env.DB.prepare(
      "INSERT INTO clientes_recurrentes (id, barbero_id, cliente_id, servicio) VALUES (?, ?, ?, 'Corte')",
    )
      .bind(uuidv7(), BARBERO, clienteId)
      .run();

    const chequeo = await chequearBorrarBarbero(env, BARBERO);

    expect(chequeo.hayConflicto).toBe(true);
    if (!chequeo.hayConflicto) return;
    expect(chequeo.mensaje).toBe(
      'No se puede borrar: el barbero tiene 1 turno(s) futuro(s). Reasignalos o cancelalos antes de borrarlo.' +
        ' Además tiene clientes recurrentes asociados que se perderían.',
    );
  });

  it('borrar SIN turnos pero CON recurrentes tambien bloquea', async () => {
    const clienteId = uuidv7();
    await env.DB.prepare("INSERT INTO clientes (id, nombre, telefono) VALUES (?, 'Fiel', '3416513207')")
      .bind(clienteId)
      .run();
    await env.DB.prepare(
      "INSERT INTO clientes_recurrentes (id, barbero_id, cliente_id, servicio) VALUES (?, ?, ?, 'Corte')",
    )
      .bind(uuidv7(), BARBERO, clienteId)
      .run();

    const chequeo = await chequearBorrarBarbero(env, BARBERO);
    expect(chequeo.hayConflicto).toBe(true);
    if (!chequeo.hayConflicto) return;
    expect(chequeo.mensaje).toContain('0 turno(s) futuro(s)');
    expect(chequeo.mensaje).toContain('clientes recurrentes asociados');
  });

  it('borrar con turnos pero SIN recurrentes no menciona recurrentes', async () => {
    await sembrarTurno({ hora: '10:00' });

    const chequeo = await chequearBorrarBarbero(env, BARBERO);
    expect(chequeo.hayConflicto).toBe(true);
    if (!chequeo.hayConflicto) return;
    expect(chequeo.mensaje).not.toContain('recurrentes');
    expect(chequeo.mensaje).toBe(
      'No se puede borrar: el barbero tiene 1 turno(s) futuro(s). Reasignalos o cancelalos antes de borrarlo.',
    );
  });

  it('un recurrente DESACTIVADO no cuenta', async () => {
    const clienteId = uuidv7();
    await env.DB.prepare("INSERT INTO clientes (id, nombre, telefono) VALUES (?, 'Ex', '3416513207')")
      .bind(clienteId)
      .run();
    await env.DB.prepare(
      "INSERT INTO clientes_recurrentes (id, barbero_id, cliente_id, servicio, activo) VALUES (?, ?, ?, 'Corte', 0)",
    )
      .bind(uuidv7(), BARBERO, clienteId)
      .run();

    expect((await chequearBorrarBarbero(env, BARBERO)).hayConflicto).toBe(false);
  });

  it('el borrado del barbero sin nada pendiente no bloquea', async () => {
    expect((await chequearBorrarBarbero(env, BARBERO)).hayConflicto).toBe(false);
  });
});
