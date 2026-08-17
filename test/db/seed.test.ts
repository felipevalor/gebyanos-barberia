import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import seedSql from '../../src/db/seed.sql?raw';
import { verificarPassword } from '../../src/services/password';

/**
 * El seed es un criterio de aceptacion de la tarea 1.2: un barbero owner, 3
 * servicios y horarios de lunes a sabado. Se ejecuta el archivo real, no una
 * copia, para que el test se rompa si alguien lo edita mal.
 */
describe('seed', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.MIGRATIONS);

    // D1 no acepta multiples statements por prepare(): se parte en sentencias.
    const sentencias = seedSql
      .split(';')
      .map((s) => s.replace(/--[^\n]*/g, '').trim())
      .filter((s) => s.length > 0);

    await env.DB.batch(sentencias.map((s) => env.DB.prepare(s)));
  });

  it('carga un unico barbero, con rol owner', async () => {
    const { results } = await env.DB.prepare('SELECT slug, rol, activo FROM barberos').all<{
      slug: string;
      rol: string;
      activo: number;
    }>();

    expect(results).toHaveLength(1);
    expect(results[0]?.rol).toBe('owner');
    expect(results[0]?.activo).toBe(1);
  });

  it('carga 3 servicios activos, con precio en centavos', async () => {
    const { results } = await env.DB.prepare(
      'SELECT nombre, duracion_min, precio_centavos FROM servicios WHERE activo = 1 ORDER BY orden',
    ).all<{ nombre: string; duracion_min: number; precio_centavos: number }>();

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.nombre)).toEqual(['Corte', 'Corte y barba', 'Barba']);

    // Enteros: si alguien mete pesos con coma, esto se rompe.
    for (const r of results) {
      expect(Number.isInteger(r.precio_centavos)).toBe(true);
      expect(r.precio_centavos).toBeGreaterThan(0);
    }
  });

  it('el owner tiene los 3 servicios asignados', async () => {
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM servicios_barbero',
    ).first<{ n: number }>();
    expect(row?.n).toBe(3);
  });

  it('carga horarios de lunes a sabado, sin domingo', async () => {
    const { results } = await env.DB.prepare(
      'SELECT DISTINCT dow FROM barbero_horarios ORDER BY dow',
    ).all<{ dow: number }>();

    expect(results.map((r) => r.dow)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('cada dia tiene dos bloques: horario cortado', async () => {
    const { results } = await env.DB.prepare(
      'SELECT dow, COUNT(*) AS n FROM barbero_horarios GROUP BY dow',
    ).all<{ dow: number; n: number }>();

    expect(results).toHaveLength(6);
    for (const r of results) expect(r.n).toBe(2);
  });

  it('negocio es la fila unica id = 1, con timezone IANA', async () => {
    const { results } = await env.DB.prepare('SELECT id, timezone FROM negocio').all<{
      id: number;
      timezone: string;
    }>();

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(1);
    // NO el nombre de Windows del sistema viejo ("Argentina Standard Time").
    expect(results[0]?.timezone).toBe('America/Argentina/Buenos_Aires');
  });

  it('es idempotente: correrlo dos veces no duplica nada', async () => {
    const sentencias = seedSql
      .split(';')
      .map((s) => s.replace(/--[^\n]*/g, '').trim())
      .filter((s) => s.length > 0);
    await env.DB.batch(sentencias.map((s) => env.DB.prepare(s)));

    const barberos = await env.DB.prepare('SELECT COUNT(*) AS n FROM barberos').first<{ n: number }>();
    const servicios = await env.DB.prepare('SELECT COUNT(*) AS n FROM servicios').first<{ n: number }>();
    const horarios = await env.DB.prepare('SELECT COUNT(*) AS n FROM barbero_horarios').first<{ n: number }>();

    expect(barberos?.n).toBe(1);
    expect(servicios?.n).toBe(3);
    expect(horarios?.n).toBe(12);
  });

  it('el owner tiene un hash PBKDF2 valido y la password documentada', async () => {
    const row = await env.DB.prepare('SELECT password_hash FROM barberos').first<{
      password_hash: string | null;
    }>();

    expect(row?.password_hash).toMatch(/^pbkdf2\$50000\$/);
    // La password del comentario del seed tiene que ser LA password: un
    // comentario que miente sobre las credenciales cuesta media hora.
    expect(await verificarPassword('gebyanos-dev-2026', row?.password_hash)).toBe(true);
  });
});
