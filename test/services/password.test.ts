import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verificarPassword,
  necesitaRehash,
  ITERACIONES,
} from '../../src/services/password';

const PASS = 'una password razonable 123';

describe('hashPassword', () => {
  it('produce el formato pbkdf2$iteraciones$salt$hash', async () => {
    const hash = await hashPassword(PASS);
    const partes = hash.split('$');

    expect(partes).toHaveLength(4);
    expect(partes[0]).toBe('pbkdf2');
    expect(Number(partes[1])).toBe(ITERACIONES);
    // Sal de 16 bytes y hash de 32, en base64.
    expect(atob(partes[2]!)).toHaveLength(16);
    expect(atob(partes[3]!)).toHaveLength(32);
  });

  it('usa una sal distinta cada vez: dos hashes de la misma password difieren', async () => {
    const a = await hashPassword(PASS);
    const b = await hashPassword(PASS);

    expect(a).not.toBe(b);
    // Y los dos verifican igual.
    expect(await verificarPassword(PASS, a)).toBe(true);
    expect(await verificarPassword(PASS, b)).toBe(true);
  });

  it('la password no aparece en el hash', async () => {
    const hash = await hashPassword(PASS);
    expect(hash).not.toContain(PASS);
    expect(hash.toLowerCase()).not.toContain('password');
  });
});

describe('verificarPassword', () => {
  it('acepta la correcta y rechaza la incorrecta', async () => {
    const hash = await hashPassword(PASS);

    expect(await verificarPassword(PASS, hash)).toBe(true);
    expect(await verificarPassword(PASS + 'x', hash)).toBe(false);
    expect(await verificarPassword('', hash)).toBe(false);
  });

  it('distingue mayusculas y espacios', async () => {
    const hash = await hashPassword(PASS);

    expect(await verificarPassword(PASS.toUpperCase(), hash)).toBe(false);
    expect(await verificarPassword(` ${PASS}`, hash)).toBe(false);
  });

  it('devuelve false ante un hash mal formado, sin tirar', async () => {
    const malos = [
      null,
      undefined,
      '',
      'no-es-un-hash',
      'pbkdf2$100000$solo-tres-partes',
      'bcrypt$12$abc$def', // esquema desconocido
      'pbkdf2$cero$abc$def', // iteraciones no numericas
      'pbkdf2$0$abc$def', // iteraciones invalidas
      'pbkdf2$100000$!!!no-es-base64!!!$???', // base64 roto
    ];

    for (const malo of malos) {
      await expect(verificarPassword(PASS, malo)).resolves.toBe(false);
    }
  });

  it('verifica con las iteraciones GUARDADAS, no con las actuales', async () => {
    // Es lo que permite subir el costo sin invalidar los hashes viejos.
    const viejo = await hashPassword(PASS, 1000);

    expect(viejo).toContain('$1000$');
    expect(await verificarPassword(PASS, viejo)).toBe(true);
  });

  it('el hash del seed verifica con la password documentada', async () => {
    const delSeed =
      'pbkdf2$100000$6yE+h07asnkJu36+yxivJw==$oVq144e9SHVLnHpCnwBbTRblEaILa2aqRu6sLK3hKgk=';

    expect(await verificarPassword('gebyanos-dev-2026', delSeed)).toBe(true);
    expect(await verificarPassword('otra', delSeed)).toBe(false);
  });
});

describe('necesitaRehash', () => {
  it('es true para un hash con menos iteraciones que las actuales', async () => {
    expect(necesitaRehash(await hashPassword(PASS, 1000))).toBe(true);
  });

  it('es false para un hash actual', async () => {
    expect(necesitaRehash(await hashPassword(PASS))).toBe(false);
  });

  it('es true para un esquema desconocido', () => {
    expect(necesitaRehash('bcrypt$12$loquesea')).toBe(true);
  });

  it('es false si no hay hash: no hay nada que rehashear', () => {
    expect(necesitaRehash(null)).toBe(false);
  });
});

describe('costo de CPU', () => {
  it('una verificacion entra en el presupuesto de 10 ms del plan Free', async () => {
    // Medido: ~7,6 ms con 100.000 iteraciones. Ver docs/notas-operacion.md.
    // Este test es un canario: si alguien sube las iteraciones sin medir, o si
    // el runtime se vuelve mas lento, salta acá y no en produccion con un
    // "Worker exceeded CPU time".
    const hash = await hashPassword(PASS);

    const t0 = performance.now();
    await verificarPassword(PASS, hash);
    const ms = performance.now() - t0;

    expect(ms).toBeLessThan(10);
  });
});
