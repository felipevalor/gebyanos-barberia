import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verificarPassword,
  necesitaRehash,
  validarLargoPassword,
  ITERACIONES,
  LARGO_MIN_PASSWORD,
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
    const viejo = await hashPassword(PASS, 1000);

    expect(viejo).toContain('$1000$');
    expect(await verificarPassword(PASS, viejo)).toBe(true);
  });

  it('el hash del seed verifica con la password documentada', async () => {
    const delSeed =
      'pbkdf2$50000$XBrvvidHIErtlOxua7QorA==$MvFVD38EF+H1BXd+MH/1UY5YfOVGWy4uxQFdDQl+UXM=';

    expect(await verificarPassword('gebyanos-dev-2026', delSeed)).toBe(true);
    expect(await verificarPassword('otra', delSeed)).toBe(false);
  });
});

/**
 * El numero de iteraciones vive DENTRO del hash, no en una constante del
 * codigo. Es lo que permite cambiarlo — para arriba o para abajo — sin
 * invalidar las contraseñas ya guardadas.
 *
 * Sin esto, bajar de 100.000 a 50.000 habria dejado afuera a todo el que ya
 * tenia contraseña.
 */
describe('las iteraciones viajan en el hash', () => {
  it('cada hash declara con cuantas iteraciones se creo', async () => {
    for (const iter of [1_000, 50_000, 100_000]) {
      const hash = await hashPassword(PASS, iter);
      expect(hash.split('$')[1]).toBe(String(iter));
    }
  });

  it('hashes con iteraciones DISTINTAS conviven y verifican todos', async () => {
    const hashes = await Promise.all(
      [1_000, 25_000, 50_000, 100_000].map((i) => hashPassword(PASS, i)),
    );

    for (const hash of hashes) {
      expect(await verificarPassword(PASS, hash)).toBe(true);
      expect(await verificarPassword('otra cosa', hash)).toBe(false);
    }
  });

  it('bajar la constante NO invalida los hashes creados con mas iteraciones', async () => {
    // Este es exactamente el caso que se dio: la politica bajo de 100.000 a
    // 50.000 y ninguna contraseña existente dejo de funcionar.
    const conLaPoliticaVieja = await hashPassword(PASS, 100_000);

    expect(ITERACIONES).toBe(50_000);
    expect(await verificarPassword(PASS, conLaPoliticaVieja)).toBe(true);
    // Y no se marca para rehash: es MAS fuerte que la politica actual.
    expect(necesitaRehash(conLaPoliticaVieja)).toBe(false);
  });

  it('un hash mas debil que la politica actual si se marca para rehash', async () => {
    expect(necesitaRehash(await hashPassword(PASS, 25_000))).toBe(true);
  });
});

describe('largo minimo de password', () => {
  it('exige 12 caracteres', () => {
    expect(LARGO_MIN_PASSWORD).toBe(12);
    expect(validarLargoPassword('a'.repeat(11))).toBe(
      'La contraseña tiene que tener al menos 12 caracteres.',
    );
  });

  it('acepta exactamente 12', () => {
    expect(validarLargoPassword('a'.repeat(12))).toBeNull();
  });

  it('la password del seed cumple el minimo', () => {
    expect(validarLargoPassword('gebyanos-dev-2026')).toBeNull();
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
    // Medido: ~3,8 ms con 50.000 iteraciones, el 38% del presupuesto.
    // Ver docs/notas-operacion.md.
    //
    // El umbral es 6 ms, no 10: si fuera 10 el test recien avisaria cuando ya
    // no hay margen para el resto del request (parseo, query, cookie), y la
    // medicion local es optimista respecto del edge.
    const hash = await hashPassword(PASS);

    const t0 = performance.now();
    await verificarPassword(PASS, hash);
    const ms = performance.now() - t0;

    expect(ms).toBeLessThan(6);
  });
});
