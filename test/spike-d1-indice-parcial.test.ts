import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Spike Fase 1, tarea 1.2 — D1 y `CREATE UNIQUE INDEX ... WHERE`.
 *
 * Este test se queda como documentacion ejecutable: fija el comportamiento del
 * indice unico parcial Y el texto exacto del error, que la Fase 2 tiene que
 * mapear al mensaje de overlap. Si Cloudflare cambia el formato del error,
 * este test se pone rojo antes que la logica de reservas.
 *
 * La tabla es descartable, no toca el schema real.
 */
describe('spike: indice unico parcial en D1', () => {
  beforeAll(async () => {
    await env.DB.exec('DROP TABLE IF EXISTS spike_reservas');
    await env.DB.exec(
      'CREATE TABLE spike_reservas (id TEXT PRIMARY KEY, barbero_id TEXT NOT NULL, fecha TEXT NOT NULL, hora TEXT NOT NULL, estado TEXT NOT NULL DEFAULT \'activa\')',
    );
    await env.DB.exec(
      "CREATE UNIQUE INDEX idx_spike_slot ON spike_reservas(barbero_id, fecha, hora) WHERE estado = 'activa'",
    );
  });

  const insertar = (id: string, estado: string) =>
    env.DB.prepare('INSERT INTO spike_reservas VALUES (?, ?, ?, ?, ?)')
      .bind(id, 'b1', '2026-09-01', '10:00', estado)
      .run();

  it('D1 acepta el indice unico parcial', async () => {
    const { results } = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_spike_slot'",
    ).all<{ sql: string }>();

    expect(results[0]?.sql).toContain("WHERE estado = 'activa'");
  });

  it('dos reservas activas en el mismo slot: la segunda falla', async () => {
    await insertar('a', 'activa');

    await expect(insertar('b', 'activa')).rejects.toThrowError(
      /UNIQUE constraint failed/,
    );

    // El texto exacto, para mapearlo en la Fase 2.
    const error = await insertar('b2', 'activa').then(
      () => null,
      (e: unknown) => e as Error,
    );
    console.log('D1_ERROR_TEXTO_EXACTO >>> ' + error?.message);
  });

  it('una reserva cancelada NO bloquea el slot', async () => {
    await env.DB.prepare("UPDATE spike_reservas SET estado='cancelada' WHERE id='a'").run();

    await expect(insertar('c', 'activa')).resolves.toBeDefined();

    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM spike_reservas WHERE estado='activa'",
    ).all<{ n: number }>();
    expect(results[0]?.n).toBe(1);
  });
});
