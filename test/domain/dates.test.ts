import { describe, it, expect } from 'vitest';
import {
  todayArgentina,
  timeNowArgentina,
  addDays,
  slotAMs,
  diaDeLaSemana,
  esFechaValida,
  esHoraValida,
  compararFechas,
} from '../../src/domain/dates';

describe('addDays', () => {
  it('caso base', () => {
    expect(addDays('2026-08-12', 14)).toBe('2026-08-26');
  });

  it('cruce de mes', () => {
    expect(addDays('2026-02-25', 5)).toBe('2026-03-02');
  });

  it('cruce de anio', () => {
    expect(addDays('2026-12-28', 5)).toBe('2027-01-02');
  });

  it('anio bisiesto', () => {
    expect(addDays('2028-02-27', 2)).toBe('2028-02-29');
  });

  it('acepta n negativo', () => {
    expect(addDays('2026-03-02', -5)).toBe('2026-02-25');
  });

  it('n = 0 es identidad', () => {
    expect(addDays('2026-08-12', 0)).toBe('2026-08-12');
  });

  it('2026 NO es bisiesto', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });
});

describe('todayArgentina', () => {
  it('devuelve YYYY-MM-DD', () => {
    expect(todayArgentina()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('a las 23:30 ART sigue siendo el dia anterior al de UTC', () => {
    // 2026-08-15T02:30Z = 2026-08-14 23:30 en Argentina.
    // Leer el reloj UTC directo daria "2026-08-15": ese es el bug.
    const instante = new Date('2026-08-15T02:30:00Z');
    expect(todayArgentina(instante)).toBe('2026-08-14');
    expect(instante.toISOString().slice(0, 10)).toBe('2026-08-15');
  });

  it('a las 00:30 ART ya es el dia nuevo', () => {
    expect(todayArgentina(new Date('2026-08-15T03:30:00Z'))).toBe('2026-08-15');
  });
});

describe('timeNowArgentina', () => {
  it('devuelve HH:mm con padding', () => {
    expect(timeNowArgentina(new Date('2026-08-15T12:05:00Z'))).toBe('09:05');
  });

  it('usa reloj de 24 h, no 12 h', () => {
    expect(timeNowArgentina(new Date('2026-08-15T23:00:00Z'))).toBe('20:00');
  });

  it('medianoche es 00:00, no 24:00', () => {
    expect(timeNowArgentina(new Date('2026-08-15T03:00:00Z'))).toBe('00:00');
  });
});

describe('slotAMs', () => {
  it('interpreta el slot en hora de Argentina, no en la del runtime', () => {
    expect(slotAMs('2026-08-15', '10:00')).toBe(Date.parse('2026-08-15T13:00:00Z'));
  });

  it('un slot mas tarde da un instante mayor', () => {
    expect(slotAMs('2026-08-15', '10:30')).toBeGreaterThan(slotAMs('2026-08-15', '10:00'));
  });
});

describe('diaDeLaSemana', () => {
  it('0 = domingo ... 6 = sabado, igual que Date.getDay()', () => {
    expect(diaDeLaSemana('2026-08-16')).toBe(0); // domingo
    expect(diaDeLaSemana('2026-08-17')).toBe(1); // lunes
    expect(diaDeLaSemana('2026-08-15')).toBe(6); // sabado
  });
});

describe('validaciones', () => {
  it('acepta fechas reales', () => {
    expect(esFechaValida('2026-08-12')).toBe(true);
    expect(esFechaValida('2028-02-29')).toBe(true);
  });

  it('rechaza formato incorrecto', () => {
    expect(esFechaValida('12/8/2026')).toBe(false); // el legacy d/M/yyyy
    expect(esFechaValida('2026-8-12')).toBe(false); // sin padding
    expect(esFechaValida('')).toBe(false);
  });

  it('rechaza fechas que no existen aunque el formato este bien', () => {
    expect(esFechaValida('2026-02-30')).toBe(false);
    expect(esFechaValida('2026-02-29')).toBe(false); // 2026 no es bisiesto
    expect(esFechaValida('2026-13-01')).toBe(false);
  });

  it('valida horas', () => {
    expect(esHoraValida('09:00')).toBe(true);
    expect(esHoraValida('23:59')).toBe(true);
    expect(esHoraValida('9:00')).toBe(false); // sin padding
    expect(esHoraValida('24:00')).toBe(false);
    expect(esHoraValida('10:60')).toBe(false);
  });
});

describe('compararFechas', () => {
  it('ordena cronologicamente', () => {
    expect(compararFechas('2026-08-12', '2026-08-26')).toBeLessThan(0);
    expect(compararFechas('2026-08-26', '2026-08-12')).toBeGreaterThan(0);
    expect(compararFechas('2026-08-12', '2026-08-12')).toBe(0);
  });

  it('sirve para ordenar un array', () => {
    const fechas = ['2027-01-02', '2026-08-12', '2026-12-28'];
    expect([...fechas].sort(compararFechas)).toEqual([
      '2026-08-12',
      '2026-12-28',
      '2027-01-02',
    ]);
  });
});
