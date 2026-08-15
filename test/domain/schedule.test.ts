import { describe, it, expect } from 'vitest';
import {
  evaluarSlot,
  cumpleAnticipacion,
  mensajeCliente,
  combinarOverrides,
  type Disponibilidad,
} from '../../src/domain/schedule';
import type { Bloque } from '../../src/domain/slots';

const manana: Bloque[] = [{ inicio: 9, fin: 13 }];
const cortado: Bloque[] = [
  { inicio: 9, fin: 13 },
  { inicio: 16, fin: 20 },
];
const sinBloques: Bloque[] = [];

describe('evaluarSlot', () => {
  const casos: {
    nombre: string;
    bloques: Bloque[];
    override: boolean | null;
    hora: string;
    dur: number;
    esperado: Disponibilidad;
  }[] = [
    { nombre: 'slot normal', bloques: manana, override: null, hora: '10:00', dur: 30, esperado: 'abierto' },
    { nombre: 'sin horario configurado', bloques: sinBloques, override: null, hora: '10:00', dur: 30, esperado: 'diaCerrado' },
    { nombre: 'el feriado gana sobre el bloque', bloques: manana, override: false, hora: '10:00', dur: 30, esperado: 'feriado' },
    { nombre: 'override positivo con horario', bloques: manana, override: true, hora: '10:00', dur: 30, esperado: 'abierto' },
    { nombre: 'termina 13:00, justo el limite', bloques: manana, override: null, hora: '12:30', dur: 30, esperado: 'abierto' },
    { nombre: 'termina 13:15, se pasa', bloques: manana, override: null, hora: '12:45', dur: 30, esperado: 'fueraDeHorario' },
    { nombre: 'empieza a la hora de cierre', bloques: manana, override: null, hora: '13:00', dur: 30, esperado: 'fueraDeHorario' },
    { nombre: 'antes de abrir', bloques: manana, override: null, hora: '08:30', dur: 30, esperado: 'fueraDeHorario' },
    { nombre: 'el hueco del mediodia', bloques: cortado, override: null, hora: '14:00', dur: 30, esperado: 'fueraDeHorario' },
    { nombre: 'bloque de la tarde', bloques: cortado, override: null, hora: '17:00', dur: 30, esperado: 'abierto' },
    { nombre: 'el override positivo NO abre un dia sin horario', bloques: sinBloques, override: true, hora: '10:00', dur: 30, esperado: 'diaCerrado' },
  ];

  for (const c of casos) {
    it(`${c.nombre} → ${c.esperado}`, () => {
      expect(evaluarSlot(c.bloques, c.override, c.hora, c.dur)).toBe(c.esperado);
    });
  }

  it('usa la duracion del SERVICIO: 60 min no entra donde 30 sí', () => {
    // 🐛 El original valida el solapamiento con la duracion global en vez de la
    // del servicio elegido, y ofrece slots que pisan el cierre.
    expect(evaluarSlot(manana, null, '12:30', 30)).toBe('abierto');
    expect(evaluarSlot(manana, null, '12:30', 60)).toBe('fueraDeHorario');
  });

  it('el feriado gana incluso sobre un dia sin horario', () => {
    expect(evaluarSlot(sinBloques, false, '10:00', 30)).toBe('feriado');
  });
});

describe('cumpleAnticipacion', () => {
  const ahora = Date.parse('2026-06-07T10:00:00-03:00');
  const min = (n: number) => ahora + n * 60_000;

  it('+2 h con minimo 30: cumple', () => {
    expect(cumpleAnticipacion(min(120), ahora, 30)).toBe(true);
  });

  it('+10 min con minimo 30: no cumple', () => {
    expect(cumpleAnticipacion(min(10), ahora, 30)).toBe(false);
  });

  it('+30 min con minimo 30: cumple — el limite es inclusivo', () => {
    expect(cumpleAnticipacion(min(30), ahora, 30)).toBe(true);
  });

  it('−5 min con minimo 0: no cumple', () => {
    expect(cumpleAnticipacion(min(-5), ahora, 0)).toBe(false);
  });
});

describe('mensajeCliente', () => {
  it('transcribe los cuatro mensajes textualmente', () => {
    expect(mensajeCliente('diaCerrado')).toBe('La barbería no atiende ese día.');
    expect(mensajeCliente('feriado')).toBe('La barbería no atiende esa fecha (feriado o cierre).');
    expect(mensajeCliente('fueraDeHorario')).toBe(
      'El horario elegido está fuera del horario de atención.',
    );
    expect(mensajeCliente('abierto')).toBe('Turno no disponible.');
  });
});

describe('combinarOverrides', () => {
  it('sin overrides devuelve null', () => {
    expect(combinarOverrides([])).toBeNull();
  });

  it('uno solo se propaga', () => {
    expect(combinarOverrides([{ trabaja: true }])).toBe(true);
    expect(combinarOverrides([{ trabaja: false }])).toBe(false);
  });

  it('cerrado gana ante duplicados, en cualquier orden', () => {
    expect(combinarOverrides([{ trabaja: true }, { trabaja: false }])).toBe(false);
    expect(combinarOverrides([{ trabaja: false }, { trabaja: true }])).toBe(false);
  });

  it('todos positivos dan true', () => {
    expect(combinarOverrides([{ trabaja: true }, { trabaja: true }])).toBe(true);
  });
});
