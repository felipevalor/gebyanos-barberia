import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { esColisionDeSlot, type ReservaInput } from '../../src/do/BarberoAgenda';
import { uuidv7 } from '../../src/db/id';

const BARBERO = '01930000-0000-7000-8000-0000000000aa';
const FECHA = '2027-03-15';

const agenda = () => env.BARBERO_AGENDA.get(env.BARBERO_AGENDA.idFromName(BARBERO));

function input(over: Partial<ReservaInput> = {}): ReservaInput {
  return {
    barberoId: BARBERO,
    fecha: FECHA,
    hora: '10:00',
    duracionMin: 30,
    nombre: 'Juan',
    telefono: '3416513207',
    servicio: 'Corte',
    ...over,
  };
}

async function activasEnLaBase(fecha = FECHA): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM reservas WHERE barbero_id = ? AND fecha = ? AND estado = 'activa'",
  )
    .bind(BARBERO, fecha)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO barberos (id, slug, nombre, rol) VALUES (?, 'gaby', 'Gaby', 'owner')",
  )
    .bind(BARBERO)
    .run();
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM reservas WHERE barbero_id = ?').bind(BARBERO).run();
});

/**
 * EL TEST MAS IMPORTANTE DEL PROYECTO.
 *
 * El invariante: dos clientes no pueden terminar con el mismo turno.
 */
describe('concurrencia', () => {
  it('50 requests simultaneos al mismo slot: gana exactamente uno', async () => {
    const stub = agenda();

    const resultados = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        stub.reservar(input({ nombre: `Cliente ${i}` })),
      ),
    );

    const exitos = resultados.filter((r) => r.estado === 'exito');
    const overlaps = resultados.filter((r) => r.estado === 'overlap');
    const errores = resultados.filter((r) => r.estado === 'error');

    expect(exitos).toHaveLength(1);
    expect(overlaps).toHaveLength(49);
    expect(errores).toEqual([]); // ninguno se cae con 500

    // Y la base coincide con lo que se le contesto a los clientes.
    expect(await activasEnLaBase()).toBe(1);
  });

  it('50 simultaneos con solapamiento PARCIAL: gana exactamente uno', async () => {
    // 09:30 de 60 min termina 10:30; 10:00 de 30 min empieza adentro.
    // NO comparten (fecha, hora), asi que el indice unico NO los ve:
    // esto lo tiene que atajar el checkOverlap adentro del DO.
    const stub = agenda();

    const resultados = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        i % 2 === 0
          ? stub.reservar(input({ hora: '09:30', duracionMin: 60 }))
          : stub.reservar(input({ hora: '10:00', duracionMin: 30 })),
      ),
    );

    expect(resultados.filter((r) => r.estado === 'exito')).toHaveLength(1);
    expect(resultados.filter((r) => r.estado === 'error')).toEqual([]);
    expect(await activasEnLaBase()).toBe(1);
  });

  it('slots que NO se solapan entran todos, aunque salgan simultaneos', async () => {
    // Contra-prueba: la serializacion no puede rechazar de mas.
    const stub = agenda();
    const horas = ['09:00', '09:30', '10:00', '10:30', '11:00'];

    const resultados = await Promise.all(horas.map((hora) => stub.reservar(input({ hora }))));

    expect(resultados.every((r) => r.estado === 'exito')).toBe(true);
    expect(await activasEnLaBase()).toBe(5);
  });

  it('cada reserva exitosa devuelve ids distintos', async () => {
    const stub = agenda();
    const horas = ['09:00', '10:00', '11:00'];
    const resultados = await Promise.all(horas.map((hora) => stub.reservar(input({ hora }))));

    const ids = resultados.flatMap((r) => (r.estado === 'exito' ? [r.reservaId] : []));
    const tokens = resultados.flatMap((r) => (r.estado === 'exito' ? [r.cancelToken] : []));

    expect(new Set(ids).size).toBe(3);
    expect(new Set(tokens).size).toBe(3);
  });
});

describe('solapamiento secuencial', () => {
  it('un turno de 60 min bloquea el slot de adentro', async () => {
    const stub = agenda();

    expect((await stub.reservar(input({ hora: '09:30', duracionMin: 60 }))).estado).toBe('exito');

    const segundo = await stub.reservar(input({ hora: '10:00', duracionMin: 30 }));
    expect(segundo.estado).toBe('overlap');
    if (segundo.estado === 'overlap') expect(segundo.conflicto).toBe('09:30');

    expect(await activasEnLaBase()).toBe(1);
  });

  it('turnos contiguos NO se bloquean entre si', async () => {
    const stub = agenda();

    expect((await stub.reservar(input({ hora: '10:00', duracionMin: 30 }))).estado).toBe('exito');
    // Empieza 10:30, justo cuando termina el anterior.
    expect((await stub.reservar(input({ hora: '10:30', duracionMin: 30 }))).estado).toBe('exito');

    expect(await activasEnLaBase()).toBe(2);
  });

  it('una reserva cancelada libera el slot', async () => {
    const stub = agenda();
    const primera = await stub.reservar(input());
    expect(primera.estado).toBe('exito');

    await env.DB.prepare(
      "UPDATE reservas SET estado = 'cancelada', cancelada_at = '2027-01-01T00:00:00Z' WHERE barbero_id = ?",
    )
      .bind(BARBERO)
      .run();

    expect((await stub.reservar(input())).estado).toBe('exito');
    expect(await activasEnLaBase()).toBe(1);
  });

  it('otro dia del mismo barbero no interfiere', async () => {
    const stub = agenda();
    expect((await stub.reservar(input())).estado).toBe('exito');
    expect((await stub.reservar(input({ fecha: '2027-03-16' }))).estado).toBe('exito');
  });
});

describe('persistencia de la reserva', () => {
  it('guarda snapshots, estado, tipo, source y cancel_token', async () => {
    const stub = agenda();
    const r = await stub.reservar(
      input({ nombre: 'Ana', telefono: '3416513207', servicio: 'Corte y barba', duracionMin: 60 }),
    );
    expect(r.estado).toBe('exito');

    const row = await env.DB.prepare('SELECT * FROM reservas WHERE barbero_id = ?')
      .bind(BARBERO)
      .first<Record<string, unknown>>();

    expect(row?.nombre).toBe('Ana');
    expect(row?.telefono).toBe('3416513207');
    expect(row?.servicio).toBe('Corte y barba');
    expect(row?.duracion_min).toBe(60);
    expect(row?.estado).toBe('activa');
    expect(row?.tipo).toBe('turno');
    expect(row?.source).toBe('web');
    expect(row?.cancel_token).toBe(r.estado === 'exito' ? r.cancelToken : null);
  });

  it('acepta bloqueos administrativos con tipo = bloqueo', async () => {
    const stub = agenda();
    const r = await stub.reservar(
      input({ tipo: 'bloqueo', servicio: 'Bloqueo', nombre: 'Bloqueo', source: 'admin' }),
    );
    expect(r.estado).toBe('exito');

    const row = await env.DB.prepare('SELECT tipo, source FROM reservas WHERE barbero_id = ?')
      .bind(BARBERO)
      .first<{ tipo: string; source: string }>();
    expect(row?.tipo).toBe('bloqueo');
    expect(row?.source).toBe('admin');
  });

  it('un bloqueo administrativo ocupa el slot igual que un turno', async () => {
    const stub = agenda();
    expect((await stub.reservar(input({ tipo: 'bloqueo' }))).estado).toBe('exito');
    expect((await stub.reservar(input())).estado).toBe('overlap');
  });
});

describe('mapeo del error de constraint de D1', () => {
  it('reconoce el texto exacto que devuelve D1 desde el Worker', () => {
    const real = new Error(
      'D1_ERROR: UNIQUE constraint failed: reservas.barbero_id, reservas.fecha, reservas.hora: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)',
    );
    expect(esColisionDeSlot(real)).toBe(true);
  });

  it('reconoce las otras dos formas del mismo error', () => {
    // wrangler --local
    expect(
      esColisionDeSlot(new Error('UNIQUE constraint failed: reservas.barbero_id')),
    ).toBe(true);
    // wrangler --remote
    expect(
      esColisionDeSlot(new Error('UNIQUE constraint failed: reservas.hora [code: 7500]')),
    ).toBe(true);
  });

  it('NO confunde otros errores con overlap', () => {
    expect(esColisionDeSlot(new Error('D1_ERROR: no such table: reservas'))).toBe(false);
    expect(esColisionDeSlot(new Error('FOREIGN KEY constraint failed'))).toBe(false);
    expect(esColisionDeSlot('un string')).toBe(false);
    expect(esColisionDeSlot(null)).toBe(false);
  });

  it('una escritura que se saltea el DO igual choca contra el indice unico', async () => {
    // Simula el bug de routing del que el indice es la red de seguridad.
    const stub = agenda();
    expect((await stub.reservar(input())).estado).toBe('exito');

    await expect(
      env.DB.prepare(
        `INSERT INTO reservas (id, barbero_id, nombre, telefono, servicio, fecha, hora)
         VALUES (?, ?, 'Colado', '3416513207', 'Corte', ?, '10:00')`,
      )
        .bind(uuidv7(), BARBERO, FECHA)
        .run(),
    ).rejects.toThrowError(/UNIQUE constraint failed/);

    expect(await activasEnLaBase()).toBe(1);
  });
});

/**
 * Reprogramar tiene el mismo invariante que el alta: dos turnos no pueden
 * terminar en el mismo slot.
 *
 * Es la razon de que el UPDATE pase por el DO en vez de ir suelto a D1. Un
 * UPDATE directo no se serializa contra nada.
 */
describe('concurrencia al reprogramar', () => {
  async function sembrarActivas(horas: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const hora of horas) {
      const r = await agenda().reservar(input({ hora }));
      if (r.estado === 'exito') ids.push(r.reservaId);
    }
    return ids;
  }

  it('10 reprogramaciones simultaneas al MISMO slot: gana exactamente una', async () => {
    const horas = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30'];
    const ids = await sembrarActivas(horas);
    expect(ids).toHaveLength(10);

    const stub = agenda();
    const resultados = await Promise.all(
      ids.map((reservaId) =>
        stub.reprogramar({
          reservaId,
          barberoId: BARBERO,
          fecha: FECHA,
          hora: '18:00',
          duracionMin: 30,
        }),
      ),
    );

    expect(resultados.filter((r) => r.estado === 'exito')).toHaveLength(1);
    expect(resultados.filter((r) => r.estado === 'error')).toEqual([]);

    const fila = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM reservas WHERE barbero_id = ? AND fecha = ? AND hora = '18:00' AND estado = 'activa'",
    )
      .bind(BARBERO, FECHA)
      .first<{ n: number }>();
    expect(fila?.n).toBe(1);
  });

  it('reprogramaciones a slots DISTINTOS entran todas', async () => {
    // Contra-prueba: serializar no puede rechazar de mas.
    const ids = await sembrarActivas(['09:00', '09:30', '10:00']);
    const stub = agenda();
    const destinos = ['16:00', '16:30', '17:00'];

    const resultados = await Promise.all(
      ids.map((reservaId, i) =>
        stub.reprogramar({
          reservaId,
          barberoId: BARBERO,
          fecha: FECHA,
          hora: destinos[i]!,
          duracionMin: 30,
        }),
      ),
    );

    expect(resultados.every((r) => r.estado === 'exito')).toBe(true);
    expect(await activasEnLaBase()).toBe(3);
  });

  it('un solapamiento PARCIAL al reprogramar tambien se ataja', async () => {
    // 60 min desde las 16:00 contra 30 min desde las 16:30: no comparten
    // (fecha, hora), asi que el indice unico no los ve.
    const ids = await sembrarActivas(['09:00', '09:30']);
    const stub = agenda();

    const resultados = await Promise.all([
      stub.reprogramar({ reservaId: ids[0]!, barberoId: BARBERO, fecha: FECHA, hora: '16:00', duracionMin: 60 }),
      stub.reprogramar({ reservaId: ids[1]!, barberoId: BARBERO, fecha: FECHA, hora: '16:30', duracionMin: 30 }),
    ]);

    expect(resultados.filter((r) => r.estado === 'exito')).toHaveLength(1);
    expect(resultados.filter((r) => r.estado === 'overlap')).toHaveLength(1);
  });

  it('reprogramar una reserva de OTRO barbero no hace nada', async () => {
    const ids = await sembrarActivas(['09:00']);
    const otro = env.BARBERO_AGENDA.get(env.BARBERO_AGENDA.idFromName('otro-barbero'));

    const r = await otro.reprogramar({
      reservaId: ids[0]!,
      barberoId: 'otro-barbero',
      fecha: FECHA,
      hora: '18:00',
      duracionMin: 30,
    });

    expect(r.estado).toBe('noEncontrada');
    const fila = await env.DB.prepare('SELECT hora FROM reservas WHERE id = ?')
      .bind(ids[0])
      .first<{ hora: string }>();
    expect(fila?.hora).toBe('09:00');
  });
});
