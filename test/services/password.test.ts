import { describe, it, expect, vi } from 'vitest';
import {
  hashPassword,
  verificarPassword,
  necesitaRehash,
  validarLargoPassword,
  ITERACIONES,
  LARGO_MIN_PASSWORD,
  MARCA_HASH_INVALIDO,
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

describe('🔴 un hash corrupto deja rastro, pero NO cambia la respuesta', () => {
  /**
   * La única excepción a la regla de oro de los catch, y es deliberada: un
   * hash corrupto es un error del servidor y aun así se responde lo mismo que
   * ante una password mal tipeada. Responder distinto sería un canal de
   * enumeración.
   *
   * Lo que compensa la excepción es el log.
   */
  const corruptos: [string, string][] = [
    ['sin las 4 partes', 'pbkdf2$50000$soloTres'],
    ['esquema desconocido', 'bcrypt$50000$c2FsdA==$aGFzaA=='],
    ['iteraciones no numéricas', 'pbkdf2$muchas$c2FsdA==$aGFzaA=='],
    ['iteraciones en cero', 'pbkdf2$0$c2FsdA==$aGFzaA=='],
    ['base64 roto en el salt', 'pbkdf2$50000$!!!no-es-base64!!!$aGFzaA=='],
  ];

  for (const [caso, hash] of corruptos) {
    it(`${caso}: devuelve false y deja una línea marcada`, async () => {
      const lineas: unknown[][] = [];
      vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void lineas.push(a));

      expect(await verificarPassword('la-que-sea', hash, 'barbero-123')).toBe(false);

      expect(lineas).toHaveLength(1);
      expect(lineas[0]?.[0]).toBe(MARCA_HASH_INVALIDO);
      expect(lineas[0]?.[1]).toMatchObject({ barberoId: 'barbero-123' });
    });
  }

  it('🔴 el log NUNCA lleva el hash ni la password', async () => {
    const lineas: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(
      (...a: unknown[]) => void lineas.push(a.map((x) => JSON.stringify(x)).join(' ')),
    );

    await verificarPassword('la-password-secreta', 'pbkdf2$50000$!!!roto!!!$aGFzaA==', 'b-1');

    const todo = lineas.join('\n');
    expect(todo).not.toContain('la-password-secreta');
    expect(todo).not.toContain('!!!roto!!!');
    expect(todo).not.toContain('aGFzaA==');
  });

  it('🔴 un login normal fallido NO deja esa línea: si no, el marcador no sirve', async () => {
    // Es la mitad que hace útil al log. Si un hash corrupto y una password mal
    // tipeada produjeran líneas parecidas, el primero seguiría siendo invisible.
    const lineas: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void lineas.push(a));

    const hashBueno = await hashPassword('la-password-correcta');

    expect(await verificarPassword('la-password-equivocada', hashBueno, 'b-1')).toBe(false);
    expect(lineas).toHaveLength(0);
  });

  it('un slug inexistente tampoco: no hay hash, no hay corrupción', async () => {
    const lineas: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void lineas.push(a));

    expect(await verificarPassword('x', null)).toBe(false);
    expect(await verificarPassword('x', undefined)).toBe(false);
    expect(lineas).toHaveLength(0);
  });
});

describe('🔴 el procedimiento de emergencia: scripts/hash-password.mjs', () => {
  /**
   * Es la única puerta cuando un barbero queda afuera del panel: el endpoint
   * que cambia la password exige estar logueado, así que un hash corrupto no
   * se arregla desde la aplicación.
   *
   * Si el script y `password.ts` se desincronizan, el hash generado no falla
   * al escribirlo — falla después, en el login, y ahí ya nadie relaciona las
   * dos cosas. Por eso hay dos tests: uno que verifica un hash real generado
   * por el script, y otro que fija que las constantes no se separen.
   */

  /** Generado con: node scripts/hash-password.mjs 'password-de-emergencia-2026' */
  const HASH_DEL_SCRIPT = 'pbkdf2$50000$Apguv53ibPu0qv9w0P+MAw==$rAR7soDsYmS0VUSAyf5TU6AKtGflfEFz0YX3UgMwrGk=';
  const PASSWORD = 'password-de-emergencia-2026';

  it('un hash generado por el script valida contra verificarPassword', async () => {
    expect(await verificarPassword(PASSWORD, HASH_DEL_SCRIPT)).toBe(true);
  });

  it('y no valida con otra password', async () => {
    expect(await verificarPassword('otra-password-larga', HASH_DEL_SCRIPT)).toBe(false);
  });

  it('🔴 las constantes del script no se separaron de password.ts', async () => {
    const fuente = (await import('../../scripts/hash-password.mjs?raw')).default;

    expect(fuente).toContain(`const ESQUEMA = 'pbkdf2'`);
    expect(fuente).toContain(`const ITERACIONES = ${ITERACIONES.toLocaleString('en-US').replace(/,/g, '_')}`);
    expect(fuente).toContain('LARGO_HASH = 32');
    expect(fuente).toContain(`hash: 'SHA-256'`);
    expect(fuente).toContain(`LARGO_MIN_PASSWORD = ${LARGO_MIN_PASSWORD}`);
  });
});
