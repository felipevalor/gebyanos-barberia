import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import worker from '../../src/index';
import { uuidv7 } from '../../src/db/id';
import { hashPassword } from '../../src/services/password';
import { addDays, todayArgentina } from '../../src/domain/dates';
import {
  generarTurno,
  generarRecurrentesDelDia,
  yaGenerado,
  ventanaDeAnticipacion,
  listarRecurrentes,
} from '../../src/services/recurrentes';
import { mensajeRecurrenteConTurnos } from '../../src/services/conflictos';

const OWNER = '01930000-0000-7000-8000-000000080001';
const ANA = '01930000-0000-7000-8000-000000080002';
const PASS = 'la-password-de-recurrentes';
const TEL = '3416513207';

let CLIENTE = '';
let HOY = '';
const AHORA = new Date('2027-06-15T12:00:00Z');

const ip = () => `192.0.2.170-${uuidv7()}`;

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

let cookieAna = '';

async function sesion(slug: string): Promise<string> {
  const res = await pedir('/api/admin/auth', {
    metodo: 'POST',
    cuerpo: { usuario: slug, password: PASS },
  });
  return `admin_token=${/admin_token=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1]}`;
}

/** Recurrente sembrado directo, con ancla de hoy y frecuencia de 14 días. */
async function sembrarRecurrente(o: {
  barberoId?: string;
  hora?: string | null;
  activo?: number;
  ancla?: string;
  frecuencia?: number;
  ultimoTurnoFecha?: string | null;
} = {}): Promise<string> {
  const id = uuidv7();
  await env.DB.prepare(
    `INSERT INTO clientes_recurrentes
       (id, barbero_id, cliente_id, servicio, frecuencia_dias, hora_preferida, fecha_ancla, ultimo_turno_fecha, activo)
     VALUES (?, ?, ?, 'Corte', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      o.barberoId ?? ANA,
      CLIENTE,
      o.frecuencia ?? 14,
      o.hora === null ? null : (o.hora ?? '10:00'),
      o.ancla ?? HOY,
      o.ultimoTurnoFecha ?? null,
      o.activo ?? 1,
    )
    .run();
  return id;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
  await env.DB.prepare('INSERT OR REPLACE INTO negocio (id) VALUES (1)').run();

  const hash = await hashPassword(PASS);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO barberos (id, slug, nombre, rol, password_hash) VALUES (?, 'duenia', 'Dueña', 'owner', ?)",
    ).bind(OWNER, hash),
    env.DB.prepare(
      "INSERT OR REPLACE INTO barberos (id, slug, nombre, rol, password_hash) VALUES (?, 'anarec', 'Ana', 'barbero', ?)",
    ).bind(ANA, hash),
  ]);

  const filas = [];
  for (const barbero of [OWNER, ANA]) {
    for (const dow of [0, 1, 2, 3, 4, 5, 6]) {
      filas.push(
        env.DB.prepare(
          'INSERT INTO barbero_horarios (id, barbero_id, dow, activo, hora_inicio, hora_fin) VALUES (?, ?, ?, 1, 8, 22)',
        ).bind(uuidv7(), barbero, dow),
      );
    }
  }
  await env.DB.batch(filas);

  cookieAna = await sesion('anarec');
});

beforeEach(async () => {
  HOY = todayArgentina(AHORA);

  await env.DB.batch([
    env.DB.prepare('DELETE FROM reservas'),
    env.DB.prepare('DELETE FROM clientes_recurrentes'),
    env.DB.prepare('DELETE FROM clientes'),
    env.DB.prepare('UPDATE negocio SET dias_max_anticipacion = 14 WHERE id = 1'),
  ]);

  CLIENTE = uuidv7();
  await env.DB.prepare('INSERT INTO clientes (id, nombre, telefono) VALUES (?, ?, ?)')
    .bind(CLIENTE, 'Juan Pérez', TEL)
    .run();
});

afterEach(() => vi.restoreAllMocks());

// ==========================================================================

describe('generación manual', () => {
  it('genera el turno y actualiza ultimo_turno_fecha', async () => {
    const id = await sembrarRecurrente();

    const r = await generarTurno(env, id, { ahora: AHORA });
    expect(r.estado).toBe('exito');

    const fila = await env.DB.prepare(
      'SELECT ultimo_turno_fecha FROM clientes_recurrentes WHERE id = ?',
    )
      .bind(id)
      .first<{ ultimo_turno_fecha: string }>();

    expect(fila?.ultimo_turno_fecha).toBe(r.estado === 'exito' ? r.fecha : '');
  });

  it('🔴 el turno queda con source = admin y turno_auto_iso seteado', async () => {
    const id = await sembrarRecurrente();
    const r = await generarTurno(env, id, { ahora: AHORA });

    const fila = await env.DB.prepare(
      'SELECT source, turno_auto_iso, cliente_id FROM reservas WHERE id = ?',
    )
      .bind(r.estado === 'exito' ? r.reservaId : '')
      .first<{ source: string; turno_auto_iso: string; cliente_id: string }>();

    expect(fila?.source).toBe('admin');
    // La marca de auditoría es también lo que hace idempotente al cron.
    expect(fila?.turno_auto_iso).toBeTruthy();
    expect(fila?.cliente_id).toBe(CLIENTE);
  });

  it('un recurrente inactivo no genera', async () => {
    const id = await sembrarRecurrente({ activo: 0 });
    expect((await generarTurno(env, id, { ahora: AHORA })).estado).toBe('noValido');
  });

  it('sin hora preferida no genera', async () => {
    const id = await sembrarRecurrente({ hora: null });
    expect((await generarTurno(env, id, { ahora: AHORA })).estado).toBe('sinHora');
  });

  it('🔴 con fecha explícita NO corre el loop de 5 ciclos', async () => {
    // El operador ya eligió el día: el sistema no se lo puede mover.
    const id = await sembrarRecurrente();
    const cerrado = addDays(HOY, 3);

    await env.DB.prepare(
      'INSERT INTO feriados_override (id, barbero_id, fecha, trabaja) VALUES (?, ?, ?, 0)',
    )
      .bind(uuidv7(), ANA, cerrado)
      .run();

    const r = await generarTurno(env, id, { fechaExplicita: cerrado, ahora: AHORA });

    // Falla en esa fecha en vez de saltar al siguiente ciclo.
    expect(r.estado).toBe('noSeGenero');
    expect(r.estado === 'noSeGenero' && r.error).toContain('Mové la fecha/hora manualmente.');
  });

  it('un slot ocupado da el mensaje de la spec', async () => {
    const id = await sembrarRecurrente();
    const primera = await generarTurno(env, id, { ahora: AHORA });
    const fecha = primera.estado === 'exito' ? primera.fecha : '';

    const otro = await sembrarRecurrente();
    const r = await generarTurno(env, otro, { fechaExplicita: fecha, ahora: AHORA });

    expect(r.estado).toBe('ocupado');
  });

  it('el turno generado pasa por el DO: respeta el anti-doble-reserva', async () => {
    const id = await sembrarRecurrente();
    const r = await generarTurno(env, id, { ahora: AHORA });
    const fecha = r.estado === 'exito' ? r.fecha : '';

    const { results } = await env.DB.prepare(
      "SELECT id FROM reservas WHERE fecha = ? AND hora = '10:00' AND barbero_id = ? AND estado = 'activa'",
    )
      .bind(fecha, ANA)
      .all();

    expect(results).toHaveLength(1);
  });
});

describe('permisos y listado', () => {
  it('un barbero no puede generar para el recurrente de otro', async () => {
    const id = await sembrarRecurrente({ barberoId: OWNER });

    const res = await pedir(`/api/admin/recurrentes/${id}/generar`, {
      metodo: 'POST',
      cuerpo: {},
      cookie: cookieAna,
    });

    expect(res.status).toBe(403);
  });

  it('🔴 el listado muestra el próximo turno REAL, no solo el último registrado', async () => {
    // `ultimo_turno_fecha` dice cuándo generó el sistema, no lo que hay en la
    // agenda: si el turno se canceló o se movió, el campo miente.
    const id = await sembrarRecurrente();
    await generarTurno(env, id, { ahora: AHORA });

    const [r] = await listarRecurrentes(env, ANA, AHORA);

    expect(r?.proximoTurno).toBe(addDays(HOY, 14));
    expect(r?.clienteNombre).toBe('Juan Pérez');
  });

  it('el próximo turno desaparece del listado si se cancela', async () => {
    const id = await sembrarRecurrente();
    const g = await generarTurno(env, id, { ahora: AHORA });
    await env.DB.prepare("UPDATE reservas SET estado = 'cancelada' WHERE id = ?")
      .bind(g.estado === 'exito' ? g.reservaId : '')
      .run();

    const [r] = await listarRecurrentes(env, ANA, AHORA);

    // El campo del recurrente sigue diciendo que generó...
    expect(r?.ultimoTurnoFecha).toBeTruthy();
    // ...pero la agenda real ya no tiene ese turno.
    expect(r?.proximoTurno).toBeNull();
  });
});

describe('⏭️ el warning NO bloqueante (viene de la 3.2)', () => {
  it('🔴 borrar con turnos futuros: 200 con warning, NO 409', async () => {
    // Esos turnos son compromisos con clientes reales: borrar la regla de
    // recurrencia no debería cancelarlos. El dueño decide qué hacer.
    const id = await sembrarRecurrente();
    await generarTurno(env, id, { ahora: AHORA });

    const res = await pedir(`/api/admin/recurrentes/${id}`, {
      metodo: 'DELETE',
      cookie: cookieAna,
    });

    expect(res.status).toBe(200);
    const cuerpo = await cuerpoDe(res);

    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.warning).toBe(mensajeRecurrenteConTurnos(1));
    expect(cuerpo.data.turnosFuturosCount).toBe(1);
    expect(cuerpo.data.turnosFuturos).toHaveLength(1);
  });

  it('🔴 la operación SE HACE: el recurrente se borra y el turno queda', async () => {
    const id = await sembrarRecurrente();
    const g = await generarTurno(env, id, { ahora: AHORA });

    await pedir(`/api/admin/recurrentes/${id}`, { metodo: 'DELETE', cookie: cookieAna });

    expect(
      await env.DB.prepare('SELECT id FROM clientes_recurrentes WHERE id = ?').bind(id).first(),
    ).toBeNull();

    const turno = await env.DB.prepare('SELECT estado FROM reservas WHERE id = ?')
      .bind(g.estado === 'exito' ? g.reservaId : '')
      .first<{ estado: string }>();
    expect(turno?.estado).toBe('activa');
  });

  it('sin turnos futuros no hay warning', async () => {
    const id = await sembrarRecurrente();

    const cuerpo = await cuerpoDe(
      await pedir(`/api/admin/recurrentes/${id}`, { metodo: 'DELETE', cookie: cookieAna }),
    );

    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.warning).toBeUndefined();
  });

  it('desactivar también avisa, y reactivar no', async () => {
    const id = await sembrarRecurrente();
    await generarTurno(env, id, { ahora: AHORA });

    const baja = await cuerpoDe(
      await pedir(`/api/admin/recurrentes/${id}/activo`, {
        metodo: 'PATCH',
        cuerpo: { activo: false },
        cookie: cookieAna,
      }),
    );
    expect(baja.warning).toBe(mensajeRecurrenteConTurnos(1));
    expect(baja.data.activo).toBe(0);

    // Reactivar no deja ningún turno huérfano.
    const alta = await cuerpoDe(
      await pedir(`/api/admin/recurrentes/${id}/activo`, {
        metodo: 'PATCH',
        cuerpo: { activo: true },
        cookie: cookieAna,
      }),
    );
    expect(alta.warning).toBeUndefined();
  });
});

describe('🔴 el cron: idempotencia', () => {
  it('correrlo DOS VECES el mismo día no duplica turnos', async () => {
    // Sin esto, un cron diario le llena la agenda al barbero con un duplicado
    // por día.
    await sembrarRecurrente();

    const uno = await generarRecurrentesDelDia(env, AHORA);
    const dos = await generarRecurrentesDelDia(env, AHORA);

    expect(uno.generados).toBe(1);
    expect(dos.generados).toBe(0);
    expect(dos.salteados).toBe(1);

    const { results } = await env.DB.prepare(
      "SELECT id FROM reservas WHERE estado = 'activa'",
    ).all();
    expect(results).toHaveLength(1);
  });

  it('🔴 el segundo chequeo agarra el turno cargado a mano', async () => {
    // `ultimo_turno_fecha` solo sabe lo que el motor registró. Si el turno ya
    // existe en la agenda con la marca del ciclo, no hay que volver a crearlo.
    const id = await sembrarRecurrente();
    const fecha = addDays(HOY, 14);

    await env.DB.prepare(
      `INSERT INTO reservas (id, barbero_id, cliente_id, nombre, telefono, servicio, duracion_min, fecha, hora, turno_auto_iso)
       VALUES (?, ?, ?, 'Juan Pérez', ?, 'Corte', 30, ?, '10:00', ?)`,
    )
      .bind(uuidv7(), ANA, CLIENTE, TEL, fecha, new Date(`${fecha}T00:00:00.000Z`).toISOString())
      .run();

    // El campo del recurrente sigue en null: solo el chequeo de la agenda
    // puede saberlo.
    const antes = await env.DB.prepare(
      'SELECT ultimo_turno_fecha FROM clientes_recurrentes WHERE id = ?',
    )
      .bind(id)
      .first<{ ultimo_turno_fecha: string | null }>();
    expect(antes?.ultimo_turno_fecha).toBeNull();

    expect(await yaGenerado(env, { id, clienteId: CLIENTE, barberoId: ANA, ultimoTurnoFecha: null }, fecha)).toBe(true);

    const r = await generarRecurrentesDelDia(env, AHORA);
    expect(r.generados).toBe(0);
    expect(r.salteados).toBe(1);
  });

  it('🔴 el chequeo barato corta ANTES de ir a la base', async () => {
    // Los dos chequeos no son redundantes: `ultimo_turno_fecha` es una
    // comparación en memoria y evita la query. Una mutación que lo borraba
    // sobrevivía porque el chequeo de la agenda lo cubre — pero a costa de un
    // SELECT por recurrente y por corrida, todos los días.
    const fecha = addDays(HOY, 14);
    const sentencias: string[] = [];
    const original = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      sentencias.push(sql);
      return original(sql);
    });

    const r = await yaGenerado(
      env,
      { id: 'x', clienteId: CLIENTE, barberoId: ANA, ultimoTurnoFecha: fecha },
      fecha,
    );

    expect(r).toBe(true);
    expect(sentencias).toHaveLength(0);
  });

  it('un turno CANCELADO no cuenta como ya generado', async () => {
    const fecha = addDays(HOY, 14);
    await env.DB.prepare(
      `INSERT INTO reservas (id, barbero_id, cliente_id, nombre, telefono, servicio, duracion_min, fecha, hora, estado, turno_auto_iso)
       VALUES (?, ?, ?, 'Juan Pérez', ?, 'Corte', 30, ?, '10:00', 'cancelada', ?)`,
    )
      .bind(uuidv7(), ANA, CLIENTE, TEL, fecha, new Date(`${fecha}T00:00:00.000Z`).toISOString())
      .run();

    expect(
      await yaGenerado(env, { id: 'x', clienteId: CLIENTE, barberoId: ANA, ultimoTurnoFecha: null }, fecha),
    ).toBe(false);
  });
});

describe('el cron: ventana y errores', () => {
  it('🔴 la ventana sale de negocio.dias_max_anticipacion, no de un 14 fijo', async () => {
    await env.DB.prepare('UPDATE negocio SET dias_max_anticipacion = 3 WHERE id = 1').run();
    expect(await ventanaDeAnticipacion(env)).toBe(3);

    // Con la ventana en 3 y frecuencia 14, todavía es temprano.
    await sembrarRecurrente();
    expect((await generarRecurrentesDelDia(env, AHORA)).salteados).toBe(1);

    // Con la ventana en 21, entra.
    await env.DB.prepare('UPDATE negocio SET dias_max_anticipacion = 21 WHERE id = 1').run();
    expect((await generarRecurrentesDelDia(env, AHORA)).generados).toBe(1);
  });

  it('los inactivos se saltean sin aparecer en el resumen', async () => {
    await sembrarRecurrente({ activo: 0 });

    expect(await generarRecurrentesDelDia(env, AHORA)).toEqual({
      generados: 0,
      salteados: 0,
      fallidos: [],
    });
  });

  it('sin hora preferida se saltea', async () => {
    await sembrarRecurrente({ hora: null });

    const r = await generarRecurrentesDelDia(env, AHORA);
    expect(r.salteados).toBe(1);
    expect(r.generados).toBe(0);
  });

  it('🔴 uno que falla NO impide que los demás se generen', async () => {
    // Con 40 clientes, un solo error dejaría sin turno a los 39 restantes.
    await sembrarRecurrente({ frecuencia: 0 }); // frecuencia inválida: falla
    await sembrarRecurrente({ hora: '11:00' }); // este tiene que salir igual

    const r = await generarRecurrentesDelDia(env, AHORA);

    expect(r.generados).toBe(1);
    expect(r.fallidos).toHaveLength(1);
  });

  it('🔴 una EXCEPCIÓN en uno no frena a los demás', async () => {
    // El test de abajo usa una frecuencia inválida, que es el camino de error
    // CONTROLADO —`calcularProximaFecha` devuelve `{error}`— y nunca entra al
    // `catch`. Una mutación que reemplazaba el catch por un `throw` sobrevivía
    // por eso. Acá se rompe de verdad: la primera llamada al Durable Object
    // lanza.
    await sembrarRecurrente({ hora: '10:00' });
    await sembrarRecurrente({ hora: '11:00' });

    let primera = true;
    const original = env.BARBERO_AGENDA.get.bind(env.BARBERO_AGENDA);
    vi.spyOn(env.BARBERO_AGENDA, 'get').mockImplementation((id: DurableObjectId) => {
      if (primera) {
        primera = false;
        throw new Error('el Durable Object explotó');
      }
      return original(id);
    });

    const r = await generarRecurrentesDelDia(env, AHORA);

    expect(r.generados).toBe(1);
    expect(r.fallidos).toHaveLength(1);
    expect(r.fallidos[0]?.motivo).toContain('el Durable Object explotó');
  });

  it('🔴 el resumen dice QUÉ falló y por qué', async () => {
    // Sin esto, un recurrente que dejó de generar pasa desapercibido durante
    // semanas: el turno simplemente no aparece.
    const id = await sembrarRecurrente({ frecuencia: 0 });

    const r = await generarRecurrentesDelDia(env, AHORA);

    expect(r.fallidos[0]?.recurrenteId).toBe(id);
    expect(r.fallidos[0]?.cliente).toBe('Juan Pérez');
    expect(r.fallidos[0]?.motivo).toContain('frecuencia');
  });

  it('el cron de las 09:00 UTC lo dispara y loguea el resumen', async () => {
    await sembrarRecurrente();
    const logs: unknown[][] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a));

    const ctx = createExecutionContext();
    await worker.scheduled(
      { cron: '0 * * * *', scheduledTime: AHORA.setUTCHours(9, 0, 0, 0), noRetry: () => {} },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const linea = logs.find((l) => String(l[0]).includes('recurrentes'));
    expect(linea?.[1]).toMatchObject({ generados: 1, salteados: 0 });
  });
});
