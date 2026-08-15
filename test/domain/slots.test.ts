import { describe, it, expect } from 'vitest';
import {
  generateSlots,
  generateSlotsFromBlocks,
  checkOverlap,
  buildEventTimes,
} from '../../src/domain/slots';

describe('generateSlots', () => {
  it('(10, 12) da exactamente 4 slots, sin incluir 12:00', () => {
    expect(generateSlots(10, 12)).toEqual(['10:00', '10:30', '11:00', '11:30']);
  });

  it('(12, 10) da [] — horaFin <= horaInicio', () => {
    expect(generateSlots(12, 10)).toEqual([]);
  });

  it('(10, 10) da []', () => {
    expect(generateSlots(10, 10)).toEqual([]);
  });

  it('el minuto se reinicia en cada hora: con 40 min no hay acarreo', () => {
    // Intencional: 10:00, 10:40, y despues vuelve a :00. No emite 11:20.
    expect(generateSlots(10, 12, 40)).toEqual(['10:00', '10:40', '11:00', '11:40']);
  });
});

describe('generateSlotsFromBlocks', () => {
  it('un bloque', () => {
    expect(generateSlotsFromBlocks([{ inicio: 10, fin: 12 }])).toEqual([
      '10:00',
      '10:30',
      '11:00',
      '11:30',
    ]);
  });

  it('dos bloques separados dan 8 elementos', () => {
    const slots = generateSlotsFromBlocks([
      { inicio: 9, fin: 11 },
      { inicio: 14, fin: 16 },
    ]);
    expect(slots).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '14:00',
      '14:30',
      '15:00',
      '15:30',
    ]);
    expect(slots).toHaveLength(8);
  });

  it('sin bloques da []', () => {
    expect(generateSlotsFromBlocks([])).toEqual([]);
  });

  it('🐛 bloques solapados NO duplican slots', () => {
    const slots = generateSlotsFromBlocks([
      { inicio: 9, fin: 13 },
      { inicio: 12, fin: 15 },
    ]);

    expect(slots.filter((s) => s === '12:00')).toHaveLength(1);
    expect(slots.filter((s) => s === '12:30')).toHaveLength(1);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('ordena los bloques por inicio antes de concatenar', () => {
    const slots = generateSlotsFromBlocks([
      { inicio: 16, fin: 18 },
      { inicio: 9, fin: 11 },
    ]);
    expect(slots).toEqual(['09:00', '09:30', '10:00', '10:30', '16:00', '16:30', '17:00', '17:30']);
    expect([...slots]).toEqual([...slots].sort());
  });
});

describe('checkOverlap', () => {
  it('sin turnos existentes no hay overlap', () => {
    expect(checkOverlap('10:00', 30, [])).toEqual({ overlap: false, conflicto: null });
  });

  it('mismo horario exacto: overlap', () => {
    expect(checkOverlap('10:00', 30, [{ hora: '10:00', duracionMin: 30 }])).toEqual({
      overlap: true,
      conflicto: '10:00',
    });
  });

  it('empieza adentro de un turno largo: overlap', () => {
    expect(checkOverlap('10:30', 30, [{ hora: '10:00', duracionMin: 60 }])).toEqual({
      overlap: true,
      conflicto: '10:00',
    });
  });

  it('contiguo ANTES no solapa: termina 10:00, el otro empieza 10:00', () => {
    expect(checkOverlap('09:30', 30, [{ hora: '10:00', duracionMin: 30 }])).toEqual({
      overlap: false,
      conflicto: null,
    });
  });

  it('contiguo DESPUES no solapa: el otro termina 10:30, este empieza 10:30', () => {
    expect(checkOverlap('10:30', 30, [{ hora: '10:00', duracionMin: 30 }])).toEqual({
      overlap: false,
      conflicto: null,
    });
  });

  it('devuelve el PRIMER conflicto en orden de iteracion, sin ordenar', () => {
    const existentes = [
      { hora: '14:00', duracionMin: 60 },
      { hora: '09:00', duracionMin: 60 },
    ];
    // 09:30 solapa con el segundo, que es el unico conflicto.
    expect(checkOverlap('09:30', 30, existentes).conflicto).toBe('09:00');

    // Con dos conflictos posibles gana el que aparece primero en el array.
    const solapados = [
      { hora: '10:00', duracionMin: 120 },
      { hora: '11:00', duracionMin: 30 },
    ];
    expect(checkOverlap('11:00', 30, solapados).conflicto).toBe('10:00');
  });
});

describe('buildEventTimes', () => {
  it('turno de 45 min con offset de Argentina', () => {
    expect(buildEventTimes('2026-04-01', '10:30', 45)).toEqual({
      startIso: '2026-04-01T10:30:00-03:00',
      endIso: '2026-04-01T11:15:00-03:00',
    });
  });

  it('padea las horas de un solo digito', () => {
    expect(buildEventTimes('2026-04-01', '09:00', 30)).toEqual({
      startIso: '2026-04-01T09:00:00-03:00',
      endIso: '2026-04-01T09:30:00-03:00',
    });
  });

  it('🐛 cruce de medianoche: incrementa la fecha en vez de generar "25:30"', () => {
    const { endIso } = buildEventTimes('2026-04-01', '23:30', 120);
    expect(endIso).toBe('2026-04-02T01:30:00-03:00');
    expect(endIso).not.toContain('25:');
  });

  it('cruce de medianoche a fin de mes', () => {
    expect(buildEventTimes('2026-04-30', '23:00', 90).endIso).toBe('2026-05-01T00:30:00-03:00');
  });

  it('terminar exactamente a medianoche pasa al dia siguiente 00:00', () => {
    expect(buildEventTimes('2026-04-01', '23:30', 30).endIso).toBe('2026-04-02T00:00:00-03:00');
  });
});
