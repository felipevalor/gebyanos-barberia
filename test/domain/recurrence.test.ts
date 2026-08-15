import { describe, it, expect, vi } from 'vitest';
import {
  calcularProximaFecha,
  motivoCorto,
  ERROR_SIN_ANCLA,
  ERROR_FRECUENCIA_INVALIDA,
  type RecurrenteConfig,
} from '../../src/domain/recurrence';
import type { Disponibilidad } from '../../src/domain/schedule';
import { diaDeLaSemana } from '../../src/domain/dates';

const HOY = '2026-08-12';
const MARTES = 2;

/** 2026-08-04 es martes. La cadencia de 14 dias tiene que mantener el martes. */
const base: RecurrenteConfig = {
  fechaAncla: '2026-08-04',
  ultimoTurnoFecha: null,
  frecuenciaDias: 14,
  horaPreferida: '10:00',
};

const siempreAbierto = () => 'abierto' as const;

/** Cierra las primeras `n` fechas evaluadas y abre a partir de ahí. */
function cerradoLasPrimeras(n: number, motivo: Disponibilidad = 'feriado') {
  let llamadas = 0;
  return () => (llamadas++ < n ? motivo : ('abierto' as const));
}

const conFecha = (r: ReturnType<typeof calcularProximaFecha>) =>
  'fecha' in r ? r.fecha : null;
const conError = (r: ReturnType<typeof calcularProximaFecha>) =>
  'error' in r ? r.error : null;

describe('calcularProximaFecha', () => {
  it('todo abierto: primer ciclo despues de hoy', () => {
    const r = calcularProximaFecha(base, HOY, siempreAbierto);
    expect(conFecha(r)).toBe('2026-08-18');
  });

  it('ultimo turno futuro: la base pasa a ser ese turno', () => {
    const rc = { ...base, ultimoTurnoFecha: '2026-08-18' };
    const r = calcularProximaFecha(rc, HOY, siempreAbierto);
    // No vuelve a generar el 18: salta al ciclo siguiente.
    expect(conFecha(r)).toBe('2026-09-01');
  });

  it('primer candidato cerrado: avanza un ciclo', () => {
    const r = calcularProximaFecha(base, HOY, cerradoLasPrimeras(1));
    expect(conFecha(r)).toBe('2026-09-01');
  });

  it('los 5 ciclos cerrados: error listando las 5 fechas con su motivo', () => {
    const r = calcularProximaFecha(base, HOY, () => 'feriado');
    const error = conError(r);

    expect(error).toBe(
      'No se pudo calcular la fecha. 5 ciclos cerrados — hora 10:00: ' +
        '2026-08-18(feriado), 2026-09-01(feriado), 2026-09-15(feriado), ' +
        '2026-09-29(feriado), 2026-10-13(feriado)',
    );
  });

  it('el error distingue el motivo de cada fecha', () => {
    const motivos: Disponibilidad[] = [
      'feriado',
      'diaCerrado',
      'fueraDeHorario',
      'feriado',
      'diaCerrado',
    ];
    let i = 0;
    const r = calcularProximaFecha(base, HOY, () => motivos[i++]!);

    expect(conError(r)).toContain('2026-08-18(feriado)');
    expect(conError(r)).toContain('2026-09-01(cerrado)');
    expect(conError(r)).toContain('2026-09-15(fuera de horario)');
  });

  it('sin fechaAncla: error, y ni siquiera consulta disponibilidad', () => {
    const evaluar = vi.fn(siempreAbierto);
    const r = calcularProximaFecha({ ...base, fechaAncla: null }, HOY, evaluar);

    expect(conError(r)).toBe(ERROR_SIN_ANCLA);
    expect(conError(r)).toBe('No se pudo calcular la fecha. Configurá la fecha ancla en el cliente.');
    expect(evaluar).not.toHaveBeenCalled();
  });

  it('ultimo turno en el pasado: se ignora, la base es hoy', () => {
    const rc = { ...base, ultimoTurnoFecha: '2026-07-21' };
    const r = calcularProximaFecha(rc, HOY, siempreAbierto);
    expect(conFecha(r)).toBe('2026-08-18');
  });

  it('preserva la cadencia: siempre cae martes, aunque avance muchos ciclos', () => {
    for (const cerradas of [0, 1, 2, 3, 4]) {
      const r = calcularProximaFecha(base, HOY, cerradoLasPrimeras(cerradas));
      const fecha = conFecha(r);

      expect(fecha).not.toBeNull();
      expect(diaDeLaSemana(fecha!)).toBe(MARTES);
    }
  });

  it('el ancla vieja no cambia la cadencia: sigue cayendo martes', () => {
    // Ancla de hace mas de un anio: el while avanza muchos ciclos.
    const rc = { ...base, fechaAncla: '2025-01-07' }; // martes
    const r = calcularProximaFecha(rc, HOY, siempreAbierto);

    expect(diaDeLaSemana(conFecha(r)!)).toBe(MARTES);
    expect(conFecha(r)! > HOY).toBe(true);
  });

  it('el resultado queda estrictamente despues de la base', () => {
    // Ancla que cae exactamente en hoy: no puede devolver hoy.
    const rc = { ...base, fechaAncla: HOY };
    expect(conFecha(calcularProximaFecha(rc, HOY, siempreAbierto))).toBe('2026-08-26');
  });

  it('respeta una frecuencia distinta de 14', () => {
    const rc = { ...base, frecuenciaDias: 7 };
    expect(conFecha(calcularProximaFecha(rc, HOY, siempreAbierto))).toBe('2026-08-18');

    const rc21 = { ...base, frecuenciaDias: 21 };
    expect(conFecha(calcularProximaFecha(rc21, HOY, siempreAbierto))).toBe('2026-08-25');
  });

  it('no toca la DB: la unica dependencia externa es evaluarFecha', () => {
    const evaluar = vi.fn(siempreAbierto);
    calcularProximaFecha(base, HOY, evaluar);
    expect(evaluar).toHaveBeenCalledTimes(1);
    expect(evaluar).toHaveBeenCalledWith('2026-08-18');
  });
});

describe('frecuenciaDias invalida', () => {
  // El pseudocodigo original avanza con `while (cursor <= base) cursor =
  // addDays(cursor, frecuenciaDias)`, que con frecuencia <= 0 no termina
  // nunca: agota los 10 ms de CPU del Worker. Estos tests fallarian por
  // timeout, no por assertion, si volviera el bucle.
  for (const frecuencia of [0, -14, 1.5, NaN]) {
    it(`frecuencia ${frecuencia}: error, sin colgarse`, () => {
      const r = calcularProximaFecha({ ...base, frecuenciaDias: frecuencia }, HOY, siempreAbierto);
      expect(conError(r)).toBe(ERROR_FRECUENCIA_INVALIDA);
    });
  }

  it('no consulta disponibilidad si la frecuencia es invalida', () => {
    const evaluar = vi.fn(siempreAbierto);
    calcularProximaFecha({ ...base, frecuenciaDias: 0 }, HOY, evaluar);
    expect(evaluar).not.toHaveBeenCalled();
  });

  it('frecuencia 1 con un ancla muy vieja resuelve igual', () => {
    // ~600 ciclos. Con el bucle original era O(n); ahora es aritmetica O(1).
    const rc = { ...base, fechaAncla: '2025-01-07', frecuenciaDias: 1 };
    expect(conFecha(calcularProximaFecha(rc, HOY, siempreAbierto))).toBe('2026-08-13');
  });
});

describe('motivoCorto', () => {
  it('etiqueta cada disponibilidad', () => {
    expect(motivoCorto('abierto')).toBe('abierto');
    expect(motivoCorto('diaCerrado')).toBe('cerrado');
    expect(motivoCorto('feriado')).toBe('feriado');
    expect(motivoCorto('fueraDeHorario')).toBe('fuera de horario');
  });
});
