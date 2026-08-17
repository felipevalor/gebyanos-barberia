import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { uuidv7 } from '../../src/db/id';
import { VENTANA_MS, LIMITE_POR_VENTANA } from '../../src/middleware/rate-limit';
import RateLimiterFuente from '../../src/do/RateLimiter.ts?raw';

/**
 * Tests directos del DO, con el tiempo controlado.
 *
 * El reinicio de ventana no se puede probar por HTTP sin esperar 15 minutos:
 * por eso `ahoraMs` es un parametro del DO y no un `Date.now()` interno.
 */
const nuevo = () => env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(uuidv7()));

const T0 = 1_800_000_000_000;

describe('ventana fija', () => {
  it('pasada la ventana, el contador se reinicia', async () => {
    const rl = nuevo();

    for (let i = 0; i < LIMITE_POR_VENTANA + 1; i++) {
      await rl.consumir(LIMITE_POR_VENTANA, VENTANA_MS, T0);
    }
    expect((await rl.chequear(LIMITE_POR_VENTANA, VENTANA_MS, T0)).permitido).toBe(false);

    // Justo antes de que venza: sigue bloqueado.
    const casi = T0 + VENTANA_MS - 1;
    expect((await rl.chequear(LIMITE_POR_VENTANA, VENTANA_MS, casi)).permitido).toBe(false);

    // Al cumplirse la ventana exacta: cupo entero de nuevo.
    const despues = T0 + VENTANA_MS;
    const estado = await rl.chequear(LIMITE_POR_VENTANA, VENTANA_MS, despues);
    expect(estado.permitido).toBe(true);
    expect(estado.restantes).toBe(LIMITE_POR_VENTANA);
  });

  it('la ventana NO es deslizante: arranca en el primer request, no en el ultimo', async () => {
    const rl = nuevo();

    await rl.consumir(LIMITE_POR_VENTANA, VENTANA_MS, T0);
    // Un consumo casi al final de la ventana no la extiende.
    await rl.consumir(LIMITE_POR_VENTANA, VENTANA_MS, T0 + VENTANA_MS - 1000);

    const estado = await rl.chequear(LIMITE_POR_VENTANA, VENTANA_MS, T0 + VENTANA_MS);
    expect(estado.restantes).toBe(LIMITE_POR_VENTANA);
  });

  it('resetEnMs cuenta hacia el fin de la ventana', async () => {
    const rl = nuevo();
    await rl.consumir(LIMITE_POR_VENTANA, VENTANA_MS, T0);

    expect((await rl.chequear(LIMITE_POR_VENTANA, VENTANA_MS, T0)).resetEnMs).toBe(VENTANA_MS);
    expect(
      (await rl.chequear(LIMITE_POR_VENTANA, VENTANA_MS, T0 + 60_000)).resetEnMs,
    ).toBe(VENTANA_MS - 60_000);
  });
});

describe('el limite exacto', () => {
  it('consumir: el request numero `limite` entra, el siguiente no', async () => {
    const rl = nuevo();

    for (let i = 1; i <= LIMITE_POR_VENTANA; i++) {
      const estado = await rl.consumir(LIMITE_POR_VENTANA, VENTANA_MS, T0);
      expect(estado.permitido).toBe(true);
      expect(estado.restantes).toBe(LIMITE_POR_VENTANA - i);
    }

    expect((await rl.consumir(LIMITE_POR_VENTANA, VENTANA_MS, T0)).permitido).toBe(false);
  });

  it('chequear: con el cupo justo agotado ya devuelve false', async () => {
    // Es la diferencia de comparacion entre chequear y consumir. Si chequear
    // usara `<=`, el login regalaria un intento de mas.
    const rl = nuevo();
    for (let i = 0; i < LIMITE_POR_VENTANA; i++) {
      await rl.consumir(LIMITE_POR_VENTANA, VENTANA_MS, T0);
    }

    expect((await rl.chequear(LIMITE_POR_VENTANA, VENTANA_MS, T0)).permitido).toBe(false);
  });

  it('chequear no consume: repetirlo muchas veces no agota nada', async () => {
    // 50 y no 1000: son llamadas RPC secuenciales al DO, y con mil el test se
    // pasaba de los 5 s de timeout cuando la maquina estaba cargada. Un test
    // lento termina siendo un test flaky, y cincuenta prueban lo mismo.
    const rl = nuevo();

    for (let i = 0; i < 50; i++) {
      expect((await rl.chequear(LIMITE_POR_VENTANA, VENTANA_MS, T0)).permitido).toBe(true);
    }
    expect((await rl.chequear(LIMITE_POR_VENTANA, VENTANA_MS, T0)).restantes).toBe(
      LIMITE_POR_VENTANA,
    );
  });
});

describe('aislamiento por clave', () => {
  it('dos claves distintas no se ven entre si', async () => {
    const a = nuevo();
    const b = nuevo();

    for (let i = 0; i < LIMITE_POR_VENTANA + 1; i++) {
      await a.consumir(LIMITE_POR_VENTANA, VENTANA_MS, T0);
    }

    expect((await a.chequear(LIMITE_POR_VENTANA, VENTANA_MS, T0)).permitido).toBe(false);
    expect((await b.chequear(LIMITE_POR_VENTANA, VENTANA_MS, T0)).permitido).toBe(true);
  });

  it('la misma clave comparte contador entre stubs', async () => {
    const nombre = uuidv7();
    const uno = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(nombre));
    const otro = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(nombre));

    for (let i = 0; i < LIMITE_POR_VENTANA + 1; i++) {
      await uno.consumir(LIMITE_POR_VENTANA, VENTANA_MS, T0);
    }

    expect((await otro.chequear(LIMITE_POR_VENTANA, VENTANA_MS, T0)).permitido).toBe(false);
  });
});

describe('el contador es efimero a proposito', () => {
  it('no escribe nada en ctx.storage', async () => {
    // Persistirlo agregaria escrituras en cada request para proteger un dato
    // que no vale nada a los 15 minutos. La defensa real contra el doble
    // booking es BarberoAgenda mas el indice unico, no esto.
    const rl = nuevo();
    for (let i = 0; i < 5; i++) await rl.consumir(LIMITE_POR_VENTANA, VENTANA_MS, T0);

    // Sin comentarios: el docstring del DO menciona `ctx.storage` justamente
    // para explicar por que NO se usa.
    const codigo = RateLimiterFuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    expect(codigo).not.toContain('ctx.storage');
    expect(codigo).not.toContain('alarm');
  });
});

