import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { disponibilidadDelDia, disponibilidadDelMes } from '../../src/services/disponibilidad';
import { uuidv7 } from '../../src/db/id';
import { diaDeLaSemana, slotAMs } from '../../src/domain/dates';

const CON_HORARIO = '01930000-0000-7000-8000-0000000000b1';
const SIN_HORARIO = '01930000-0000-7000-8000-0000000000b2';

/** Servicio de 60 min. Se usa para el bug de la duracion. */
const SERVICIO_60 = '01930000-0000-7000-8000-0000000000c1';
const SERVICIO_30 = '01930000-0000-7000-8000-0000000000c2';

const HOY = '2027-03-10';
const FUTURO = '2027-03-15';
/** Un instante de HOY a las 08:00 de Argentina. */
const ahoraA = (hora: string, fecha = HOY) => new Date(slotAMs(fecha, hora));

/**
 * Envuelve el binding de D1 contando los `prepare`.
 * Es la unica forma honesta de verificar el criterio de "no mas de 5 queries":
 * medir, no confiar en leer el codigo.
 */
function contando(d1: D1Database) {
  let n = 0;
  const proxy = new Proxy(d1, {
    get(target, prop, receiver) {
      const valor = Reflect.get(target, prop, receiver) as unknown;

      if (prop === 'prepare' && typeof valor === 'function') {
        return (...args: unknown[]) => {
          n += 1;
          return (valor as (...a: unknown[]) => unknown).apply(target, args);
        };
      }

      // `batch` no pasa por `prepare` del binding contado: cada statement se
      // preparo antes. Se cuenta el batch como sus N sentencias, que es lo que
      // cuesta. Hoy disponibilidad no lo usa, pero el import masivo de la 2.7
      // es candidato a reusar este helper.
      if (prop === 'batch' && typeof valor === 'function') {
        return (sentencias: unknown[]) => {
          n += Array.isArray(sentencias) ? sentencias.length : 1;
          return (valor as (...a: unknown[]) => unknown).apply(target, [sentencias]);
        };
      }

      if (typeof valor === 'function') return (valor as () => unknown).bind(target);
      return valor;
    },
  });
  return { d1: proxy as D1Database, queries: () => n };
}

const slotsDe = async (
  params: { barberoId?: string; fecha?: string; servicioId?: string },
  ahora = ahoraA('08:00'),
) =>
  (
    await disponibilidadDelDia(
      env.DB,
      {
        barberoId: params.barberoId ?? CON_HORARIO,
        fecha: params.fecha ?? FUTURO,
        servicioId: params.servicioId,
      },
      ahora,
    )
  ).slots;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
  await env.DB.prepare('INSERT OR REPLACE INTO negocio (id) VALUES (1)').run();

  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO barberos (id, slug, nombre) VALUES (?, 'con', 'Con horario')").bind(CON_HORARIO),
    env.DB.prepare("INSERT OR IGNORE INTO barberos (id, slug, nombre) VALUES (?, 'sin', 'Sin horario')").bind(SIN_HORARIO),
    env.DB.prepare("INSERT OR IGNORE INTO servicios (id, nombre, duracion_min) VALUES (?, 'Largo', 60)").bind(SERVICIO_60),
    env.DB.prepare("INSERT OR IGNORE INTO servicios (id, nombre, duracion_min) VALUES (?, 'Corto', 30)").bind(SERVICIO_30),
  ]);

  // Horario cortado 9-13 y 16-20 TODOS los dias, para que cualquier fecha sirva.
  for (let dow = 0; dow <= 6; dow++) {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO barbero_horarios (id, barbero_id, dow, hora_inicio, hora_fin) VALUES (?, ?, ?, 9, 13)',
      ).bind(uuidv7(), CON_HORARIO, dow),
      env.DB.prepare(
        'INSERT INTO barbero_horarios (id, barbero_id, dow, hora_inicio, hora_fin) VALUES (?, ?, ?, 16, 20)',
      ).bind(uuidv7(), CON_HORARIO, dow),
    ]);
  }
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM reservas').run();
  await env.DB.prepare('DELETE FROM feriados_override').run();
  await env.DB.prepare('DELETE FROM servicios_barbero').run();
});

describe('criterios de aceptacion — dia', () => {
  it('fecha pasada → []', async () => {
    expect(await slotsDe({ fecha: '2027-03-09' })).toEqual([]);
  });

  it('dia sin horario configurado → []', async () => {
    expect(await slotsDe({ barberoId: SIN_HORARIO })).toEqual([]);
  });

  it('feriado (trabaja = 0) → []', async () => {
    await env.DB.prepare(
      'INSERT INTO feriados_override (id, barbero_id, fecha, trabaja) VALUES (?, ?, ?, 0)',
    )
      .bind(uuidv7(), CON_HORARIO, FUTURO)
      .run();

    expect(await slotsDe({})).toEqual([]);
  });

  it('un servicio de 60 min no ofrece slots que se pasen del cierre', async () => {
    const con30 = await slotsDe({ servicioId: SERVICIO_30 });
    const con60 = await slotsDe({ servicioId: SERVICIO_60 });

    expect(con30).toContain('12:30');
    expect(con60).not.toContain('12:30');
    expect(con60).toContain('12:00');
    // Lo mismo al cierre de la tarde.
    expect(con30).toContain('19:30');
    expect(con60).not.toContain('19:30');
    expect(con60).toContain('19:00');
  });

  it('hoy, los slots que no cumplen los 30 min de anticipacion no aparecen', async () => {
    const slots = await slotsDe({ fecha: HOY }, ahoraA('10:10'));

    expect(slots).not.toContain('10:00');
    expect(slots).not.toContain('10:30');
    expect(slots[0]).toBe('11:00');
  });

  it('un turno existente de 60 min tapa dos slots de 30', async () => {
    await env.DB.prepare(
      `INSERT INTO reservas (id, barbero_id, nombre, telefono, servicio, duracion_min, fecha, hora)
       VALUES (?, ?, 'Juan', '3416513207', 'Largo', 60, ?, '10:00')`,
    )
      .bind(uuidv7(), CON_HORARIO, FUTURO)
      .run();

    const slots = await slotsDe({});
    expect(slots).not.toContain('10:00');
    expect(slots).not.toContain('10:30');
    expect(slots).toContain('11:00');
  });

  it('los bloqueos administrativos ocupan el slot igual que un turno', async () => {
    await env.DB.prepare(
      `INSERT INTO reservas (id, barbero_id, nombre, telefono, servicio, duracion_min, fecha, hora, tipo)
       VALUES (?, ?, 'Bloqueo', '0', 'Bloqueo', 30, ?, '11:00', 'bloqueo')`,
    )
      .bind(uuidv7(), CON_HORARIO, FUTURO)
      .run();

    expect(await slotsDe({})).not.toContain('11:00');
  });

  it('una reserva cancelada NO ocupa el slot', async () => {
    await env.DB.prepare(
      `INSERT INTO reservas (id, barbero_id, nombre, telefono, servicio, duracion_min, fecha, hora, estado)
       VALUES (?, ?, 'Juan', '3416513207', 'Corte', 30, ?, '11:00', 'cancelada')`,
    )
      .bind(uuidv7(), CON_HORARIO, FUTURO)
      .run();

    expect(await slotsDe({})).toContain('11:00');
  });

  it('mas alla de la ventana de 14 dias → []', async () => {
    expect(await slotsDe({ fecha: '2027-03-25' })).toEqual([]); // +15
    expect((await slotsDe({ fecha: '2027-03-24' })).length).toBeGreaterThan(0); // +14, el limite
  });
});

describe('duracion del servicio', () => {
  it('el override de servicios_barbero gana sobre la duracion del catalogo', async () => {
    // Corto dura 30 en el catalogo, pero este barbero tarda 60.
    await env.DB.prepare(
      'INSERT INTO servicios_barbero (id, barbero_id, servicio_id, duracion_min_override) VALUES (?, ?, ?, 60)',
    )
      .bind(uuidv7(), CON_HORARIO, SERVICIO_30)
      .run();

    const res = await disponibilidadDelDia(
      env.DB,
      { barberoId: CON_HORARIO, fecha: FUTURO, servicioId: SERVICIO_30 },
      ahoraA('08:00'),
    );

    expect(res.duracionMin).toBe(60);
    expect(res.slots).not.toContain('12:30');
  });

  it('un servicio DESACTIVADO no impone su duracion: cae al paso de grilla', async () => {
    const discontinuado = uuidv7();
    await env.DB.prepare(
      "INSERT INTO servicios (id, nombre, duracion_min, activo) VALUES (?, 'Discontinuado', 90, 0)",
    )
      .bind(discontinuado)
      .run();

    const res = await disponibilidadDelDia(
      env.DB,
      { barberoId: CON_HORARIO, fecha: FUTURO, servicioId: discontinuado },
      ahoraA('08:00'),
    );

    // Si contara, la duracion seria 90 y no habria slot a las 12:30.
    expect(res.duracionMin).toBe(30);
    expect(res.slots).toContain('12:30');
  });

  it('un servicio inexistente no rompe: usa el paso de grilla', async () => {
    const res = await disponibilidadDelDia(
      env.DB,
      { barberoId: CON_HORARIO, fecha: FUTURO, servicioId: uuidv7() },
      ahoraA('08:00'),
    );

    expect(res.duracionMin).toBe(30);
    expect(res.slots).toContain('12:30');
  });

  it('sin servicioId usa el paso de grilla', async () => {
    const res = await disponibilidadDelDia(
      env.DB,
      { barberoId: CON_HORARIO, fecha: FUTURO },
      ahoraA('08:00'),
    );
    expect(res.duracionMin).toBe(30);
  });
});

describe('criterios de aceptacion — mes', () => {
  it('CON servicioId: exactamente 5 queries — el caso del criterio', async () => {
    const { d1, queries } = contando(env.DB);

    await disponibilidadDelMes(
      d1,
      { barberoId: CON_HORARIO, anio: 2027, mes: 3, servicioId: SERVICIO_60 },
      ahoraA('08:00'),
    );

    // Exacto, no <=: si sube a 6 hay que enterarse aunque siga "cerca".
    expect(queries()).toBe(5);
  });

  it('SIN servicioId: 4 queries — se saltea la de la duracion', async () => {
    const { d1, queries } = contando(env.DB);

    await disponibilidadDelMes(d1, { barberoId: CON_HORARIO, anio: 2027, mes: 3 }, ahoraA('08:00'));

    expect(queries()).toBe(4);
  });

  it('un mes de 31 dias no cuesta mas queries que uno de 28', async () => {
    const marzo = contando(env.DB);
    await disponibilidadDelMes(
      marzo.d1,
      { barberoId: CON_HORARIO, anio: 2027, mes: 3, servicioId: SERVICIO_60 },
      ahoraA('08:00'),
    );

    const febrero = contando(env.DB);
    await disponibilidadDelMes(
      febrero.d1,
      { barberoId: CON_HORARIO, anio: 2027, mes: 2, servicioId: SERVICIO_60 },
      ahoraA('08:00'),
    );

    expect(marzo.queries()).toBe(febrero.queries());
    expect(marzo.queries()).toBe(5);
  });

  it('febrero de anio bisiesto tiene 29 dias, y el 29 se evalua', async () => {
    // 2028 es bisiesto. La ventana de 14 dias se corre para que el 29 entre.
    const res = await disponibilidadDelMes(
      env.DB,
      { barberoId: CON_HORARIO, anio: 2028, mes: 2 },
      ahoraA('08:00', '2028-02-20'),
    );

    expect(res.diasDisponibles).toContain('2028-02-29');
    expect(res.diasDisponibles).not.toContain('2028-03-01');
    expect(res.diasDisponibles.every((f) => f.startsWith('2028-02-'))).toBe(true);
  });

  it('febrero de anio NO bisiesto no inventa el 29', async () => {
    const res = await disponibilidadDelMes(
      env.DB,
      { barberoId: CON_HORARIO, anio: 2027, mes: 2 },
      ahoraA('08:00', '2027-02-20'),
    );

    expect(res.diasDisponibles).not.toContain('2027-02-29');
    expect(res.diasDisponibles).toContain('2027-02-28');
  });

  it('devuelve solo los dias dentro de la ventana de 14 dias', async () => {
    const res = await disponibilidadDelMes(
      env.DB,
      { barberoId: CON_HORARIO, anio: 2027, mes: 3 },
      ahoraA('08:00'),
    );

    // hoy = 2027-03-10, ventana hasta el 24 inclusive.
    expect(res.diasDisponibles).toContain('2027-03-10');
    expect(res.diasDisponibles).toContain('2027-03-24');
    expect(res.diasDisponibles).not.toContain('2027-03-25');
    // Ni los dias pasados del mes.
    expect(res.diasDisponibles).not.toContain('2027-03-09');
    expect(res.diasDisponibles).not.toContain('2027-03-01');
  });

  it('un feriado saca ese dia del calendario', async () => {
    await env.DB.prepare(
      'INSERT INTO feriados_override (id, barbero_id, fecha, trabaja) VALUES (?, ?, ?, 0)',
    )
      .bind(uuidv7(), CON_HORARIO, '2027-03-12')
      .run();

    const res = await disponibilidadDelMes(
      env.DB,
      { barberoId: CON_HORARIO, anio: 2027, mes: 3 },
      ahoraA('08:00'),
    );

    expect(res.diasDisponibles).not.toContain('2027-03-12');
    expect(res.diasDisponibles).toContain('2027-03-11');
  });

  it('un dia lleno de turnos no aparece como disponible', async () => {
    // Dos turnos largos que cubren manana y tarde del 2027-03-11.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO reservas (id, barbero_id, nombre, telefono, servicio, duracion_min, fecha, hora)
         VALUES (?, ?, 'X', '0', 'Bloque', 240, '2027-03-11', '09:00')`,
      ).bind(uuidv7(), CON_HORARIO),
      env.DB.prepare(
        `INSERT INTO reservas (id, barbero_id, nombre, telefono, servicio, duracion_min, fecha, hora)
         VALUES (?, ?, 'X', '0', 'Bloque', 240, '2027-03-11', '16:00')`,
      ).bind(uuidv7(), CON_HORARIO),
    ]);

    const res = await disponibilidadDelMes(
      env.DB,
      { barberoId: CON_HORARIO, anio: 2027, mes: 3 },
      ahoraA('08:00'),
    );

    expect(res.diasDisponibles).not.toContain('2027-03-11');
    expect(res.diasDisponibles).toContain('2027-03-12');
  });

  it('el barbero sin horario no tiene ningun dia disponible', async () => {
    const res = await disponibilidadDelMes(
      env.DB,
      { barberoId: SIN_HORARIO, anio: 2027, mes: 3 },
      ahoraA('08:00'),
    );
    expect(res.diasDisponibles).toEqual([]);
  });

  it('el mes coincide dia por dia con el endpoint de dia', async () => {
    // Si divergen, el calendario pinta un dia que despues no ofrece horarios.
    await env.DB.prepare(
      'INSERT INTO feriados_override (id, barbero_id, fecha, trabaja) VALUES (?, ?, ?, 0)',
    )
      .bind(uuidv7(), CON_HORARIO, '2027-03-13')
      .run();

    const ahora = ahoraA('10:10');
    const mes = await disponibilidadDelMes(
      env.DB,
      { barberoId: CON_HORARIO, anio: 2027, mes: 3, servicioId: SERVICIO_60 },
      ahora,
    );

    for (let dia = 1; dia <= 31; dia++) {
      const fecha = `2027-03-${String(dia).padStart(2, '0')}`;
      const delDia = await disponibilidadDelDia(
        env.DB,
        { barberoId: CON_HORARIO, fecha, servicioId: SERVICIO_60 },
        ahora,
      );

      expect(mes.diasDisponibles.includes(fecha)).toBe(delDia.slots.length > 0);
    }
  });
});

describe('barbero desactivado', () => {
  it('no ofrece horarios aunque tenga horario configurado', async () => {
    await env.DB.prepare('UPDATE barberos SET activo = 0 WHERE id = ?').bind(CON_HORARIO).run();

    try {
      // El dia y el mes tienen que coincidir: si uno lo oculta y el otro no,
      // el cliente ve el calendario pintado y la grilla vacia.
      expect(await slotsDe({})).toEqual([]);

      const mes = await disponibilidadDelMes(
        env.DB,
        { barberoId: CON_HORARIO, anio: 2027, mes: 3 },
        ahoraA('08:00'),
      );
      expect(mes.diasDisponibles).toEqual([]);
    } finally {
      await env.DB.prepare('UPDATE barberos SET activo = 1 WHERE id = ?').bind(CON_HORARIO).run();
    }
  });

  it('reactivarlo devuelve los horarios', async () => {
    expect((await slotsDe({})).length).toBeGreaterThan(0);
  });
});

describe('horario cortado con un servicio largo', () => {
  const CORTADO = '01930000-0000-7000-8000-0000000000b3';
  const SERVICIO_90 = '01930000-0000-7000-8000-0000000000c3';

  beforeAll(async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO barberos (id, slug, nombre) VALUES (?, 'cortado', 'Cortado')")
      .bind(CORTADO)
      .run();
    await env.DB.prepare("INSERT OR IGNORE INTO servicios (id, nombre, duracion_min) VALUES (?, 'Muy largo', 90)")
      .bind(SERVICIO_90)
      .run();

    // Bloque largo a la manana (9-13) y uno de UNA hora a la tarde (16-17).
    for (let dow = 0; dow <= 6; dow++) {
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO barbero_horarios (id, barbero_id, dow, hora_inicio, hora_fin) VALUES (?, ?, ?, 9, 13)',
        ).bind(uuidv7(), CORTADO, dow),
        env.DB.prepare(
          'INSERT INTO barbero_horarios (id, barbero_id, dow, hora_inicio, hora_fin) VALUES (?, ?, ?, 16, 17)',
        ).bind(uuidv7(), CORTADO, dow),
      ]);
    }
  });

  it('un servicio de 60 min entra en la manana y solo una vez en la tarde', async () => {
    const slots = await slotsDe({ barberoId: CORTADO, servicioId: SERVICIO_60 });

    // Manana: ultimo inicio 12:00 (termina 13:00).
    expect(slots).toContain('12:00');
    expect(slots).not.toContain('12:30');
    // Tarde: el bloque dura exactamente 60 min, asi que solo entra 16:00.
    expect(slots).toContain('16:00');
    expect(slots).not.toContain('16:30');
  });

  it('un servicio de 90 min entra en la manana y en la tarde NO entra nunca', async () => {
    // Este es el caso que se equivoca en silencio: la grilla de 30 min ofrece
    // 16:00 y 16:30, y los dos hay que descartarlos porque el bloque de la
    // tarde es mas corto que el servicio.
    const slots = await slotsDe({ barberoId: CORTADO, servicioId: SERVICIO_90 });

    expect(slots).toContain('11:30'); // termina 13:00, justo el cierre
    expect(slots).not.toContain('12:00'); // terminaria 13:30
    expect(slots.filter((s) => s >= '16:00')).toEqual([]);
  });

  it('el mismo dia con un servicio de 30 min si ofrece la tarde completa', async () => {
    const slots = await slotsDe({ barberoId: CORTADO, servicioId: SERVICIO_30 });

    expect(slots).toContain('16:00');
    expect(slots).toContain('16:30');
    expect(slots).not.toContain('17:00');
  });

  it('un servicio que no entra en ningun bloque deja el dia sin slots', async () => {
    const SERVICIO_300 = uuidv7();
    await env.DB.prepare("INSERT INTO servicios (id, nombre, duracion_min) VALUES (?, 'Jornada', 300)")
      .bind(SERVICIO_300)
      .run();

    expect(await slotsDe({ barberoId: CORTADO, servicioId: SERVICIO_300 })).toEqual([]);
  });
});

describe('dow: el horario del dia correcto', () => {
  it('solo ofrece slots los dias que el barbero tiene configurados', async () => {
    // Se le saca el horario a un unico dow y se verifica ese dia puntual.
    const dow = diaDeLaSemana('2027-03-16');
    await env.DB.prepare('DELETE FROM barbero_horarios WHERE barbero_id = ? AND dow = ?')
      .bind(CON_HORARIO, dow)
      .run();

    expect(await slotsDe({ fecha: '2027-03-16' })).toEqual([]);
    // El dia anterior, con otro dow, sigue abierto.
    expect((await slotsDe({ fecha: '2027-03-15' })).length).toBeGreaterThan(0);

    // Se repone para no ensuciar los otros tests del archivo.
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO barbero_horarios (id, barbero_id, dow, hora_inicio, hora_fin) VALUES (?, ?, ?, 9, 13)',
      ).bind(uuidv7(), CON_HORARIO, dow),
      env.DB.prepare(
        'INSERT INTO barbero_horarios (id, barbero_id, dow, hora_inicio, hora_fin) VALUES (?, ?, ?, 16, 20)',
      ).bind(uuidv7(), CON_HORARIO, dow),
    ]);
  });
});
