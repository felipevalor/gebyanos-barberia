import { describe, it, expect } from 'vitest';
import { normalizeTel, esTelefonoArgentino, enmascararTel } from '../../src/domain/phone';

const casos: [string, string, string?][] = [
  ['3416513207', '3416513207', 'ya canonico'],
  ['543416513207', '3416513207', 'con +54'],
  ['5493416513207', '3416513207', 'con 549'],
  ['93416513207', '3416513207', 'con el 9 internacional'],
  ['341 651-3207', '3416513207', 'con separadores'],
  ['+54 9 341 651-3207', '3416513207', 'E.164 con espacios'],
];

// Los cuatro que el fallback manual NO resuelve: son exactamente los formatos
// que un argentino escribe naturalmente. Si estos fallan, la libreria no esta
// bien configurada.
const conLibreria: [string, string, string][] = [
  ['03416513207', '3416513207', 'el 0 nacional'],
  ['0341 15 6513207', '3416513207', 'el 0 y el 15'],
  ['341 15 6513207', '3416513207', 'el 15 despues del area'],
  ['011 15 2345-6789', '1123456789', 'area de 2 digitos'],
];

describe('normalizeTel', () => {
  for (const [input, esperado, nota] of casos) {
    it(`${input} → ${esperado}${nota ? ` (${nota})` : ''}`, () => {
      expect(normalizeTel(input)).toBe(esperado);
    });
  }

  for (const [input, esperado, nota] of conLibreria) {
    it(`${input} → ${esperado} (${nota}) — necesita libphonenumber`, () => {
      expect(normalizeTel(input)).toBe(esperado);
    });
  }

  // 'AR' es el pais POR DEFECTO de parsePhoneNumberFromString, no una
  // restriccion: sin chequear `country` estos parsean como validos y se
  // guardaban con la cantidad de digitos equivocada.
  const extranjeros: [string, string, string][] = [
    ['+1 212 555 1234', 'US', 'daba 12125551234, 11 digitos'],
    ['+55 11 91234 5678', 'BR', 'daba 5511912345678, 13 digitos'],
    ['+34 612 345 678', 'ES', 'daba 34612345678, 11 digitos'],
  ];

  for (const [input, pais, antes] of extranjeros) {
    it(`rechaza ${pais}: ${input} → "" (${antes})`, () => {
      expect(normalizeTel(input)).toBe('');
      expect(esTelefonoArgentino(input)).toBe(false);
    });
  }

  it('ningun numero extranjero se cuela como argentino', () => {
    for (const [input] of extranjeros) {
      expect(normalizeTel(input)).not.toMatch(/^\d{10}$/);
    }
  });

  it('vacio, null y undefined dan cadena vacia', () => {
    expect(normalizeTel('')).toBe('');
    expect(normalizeTel(null)).toBe('');
    expect(normalizeTel(undefined)).toBe('');
  });

  it('es idempotente: normalizar dos veces da lo mismo', () => {
    for (const [input] of [...casos, ...conLibreria]) {
      expect(normalizeTel(normalizeTel(input))).toBe(normalizeTel(input));
    }
  });

  it('el resultado canonico son 10 digitos', () => {
    for (const [input] of [...casos, ...conLibreria]) {
      expect(normalizeTel(input)).toMatch(/^\d{10}$/);
    }
  });
});

describe('esTelefonoArgentino', () => {
  it('acepta todas las formas argentinas de la tabla', () => {
    for (const [input] of [...casos, ...conLibreria]) {
      expect(esTelefonoArgentino(input)).toBe(true);
    }
  });

  it('rechaza vacios y basura', () => {
    expect(esTelefonoArgentino(null)).toBe(false);
    expect(esTelefonoArgentino('')).toBe(false);
    expect(esTelefonoArgentino('123')).toBe(false);
    expect(esTelefonoArgentino('no es un telefono')).toBe(false);
  });
});

describe('enmascararTel', () => {
  it('deja solo los ultimos 4 digitos', () => {
    expect(enmascararTel('3416513207')).toBe('******3207');
  });

  it('enmascara tambien si viene con separadores', () => {
    expect(enmascararTel('+54 9 341 651-3207')).toBe('*********3207');
  });

  it('no filtra nada con entradas cortas', () => {
    expect(enmascararTel('123')).toBe('***');
    expect(enmascararTel('')).toBe('');
    expect(enmascararTel(null)).toBe('');
  });
});
