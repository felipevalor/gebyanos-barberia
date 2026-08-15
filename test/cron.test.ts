import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src/index';

/**
 * Un unico cron horario despacha los tres jobs. Ver src/index.ts.
 * Los Cron Triggers son 5 por cuenta en el plan Free.
 */
async function correrCron(isoUtc: string): Promise<string[]> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
    logs.push(String(msg));
  });

  const ctx = createExecutionContext();
  await worker.scheduled(
    { cron: '0 * * * *', scheduledTime: Date.parse(isoUtc), noRetry: () => {} },
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);

  spy.mockRestore();
  return logs;
}

afterEach(() => vi.restoreAllMocks());

describe('despacho del cron horario', () => {
  it('corre la limpieza en toda hora', async () => {
    const logs = await correrCron('2026-08-15T13:00:00Z');
    expect(logs.some((l) => l.includes('limpieza'))).toBe(true);
    expect(logs.some((l) => l.includes('recordatorios'))).toBe(false);
    expect(logs.some((l) => l.includes('recurrentes'))).toBe(false);
  });

  it('corre los recordatorios a las 00:00 UTC (21:00 ART)', async () => {
    const logs = await correrCron('2026-08-15T00:00:00Z');
    expect(logs.some((l) => l.includes('recordatorios'))).toBe(true);
    expect(logs.some((l) => l.includes('limpieza'))).toBe(true);
  });

  it('corre los recurrentes a las 09:00 UTC (06:00 ART)', async () => {
    const logs = await correrCron('2026-08-15T09:00:00Z');
    expect(logs.some((l) => l.includes('recurrentes'))).toBe(true);
    expect(logs.some((l) => l.includes('limpieza'))).toBe(true);
  });
});
