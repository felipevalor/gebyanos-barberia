import { describe, it, expect } from 'vitest';
import { slotsDisponibles, tieneDisponibilidad } from '../../src/domain/disponibilidad';
import type { EntradaDisponibilidad } from '../../src/domain/disponibilidad';
import { slotAMs } from '../../src/domain/dates';

const HOY = '2027-03-10';
const FUTURO = '2027-03-15';

/** Bloque unico de manana: 9 a 13. */
const manana = [{ inicio: 9, fin: 13 }];
const cortado = [
  { inicio: 9, fin: 13 },
  { inicio: 16, fin: 20 },
];

function entrada(over: Partial<EntradaDisponibilidad> = {}): EntradaDisponibilidad {
  return {
    fecha: FUTURO,
    hoy: HOY,
    ahoraMs: slotAMs(HOY, '08:00'),
    bloques: manana,
    overrideTrabaja: null,
    reservas: [],
    slotDuracionMin: 30,
    duracionServicioMin: 30,
    minutosAnticipacion: 30,
    ...over,
  };
}

describe('cortes tempranos', () => {
  it('fecha pasada da []', () => {
    expect(slotsDisponibles(entrada({ fecha: '2027-03-09' }))).toEqual([]);
  });

  it('dia sin horario configurado da []', () => {
    expect(slotsDisponibles(entrada({ bloques: [] }))).toEqual([]);
  });

  it('feriado (trabaja = false) da [], aunque haya horario', () => {
    expect(slotsDisponibles(entrada({ overrideTrabaja: false }))).toEqual([]);
  });

  it('un override positivo no inventa horarios donde no hay', () => {
    expect(slotsDisponibles(entrada({ bloques: [], overrideTrabaja: true }))).toEqual([]);
  });

  it('hoy mismo NO es fecha pasada', () => {
    expect(slotsDisponibles(entrada({ fecha: HOY })).length).toBeGreaterThan(0);
  });
});

describe('🐛 la grilla usa el paso CONFIGURADO, no 30 fijo', () => {
  it('con slotDuracionMin = 60 la grilla salta de hora en hora', () => {
    const slots = slotsDisponibles(entrada({ slotDuracionMin: 60, duracionServicioMin: 60 }));

    expect(slots).toEqual(['09:00', '10:00', '11:00', '12:00']);
    expect(slots).not.toContain('09:30');
  });

  it('con slotDuracionMin = 15 la grilla es mas densa', () => {
    const slots = slotsDisponibles(entrada({ slotDuracionMin: 15 }));

    expect(slots).toContain('09:15');
    expect(slots).toContain('09:45');
    // 12:45 + 30 min se pasa de las 13:00.
    expect(slots).not.toContain('12:45');
  });
});

describe('🐛 el solapamiento usa la duracion del SERVICIO, no la global', () => {
  it('un servicio de 60 min no se ofrece si se pasa del cierre', () => {
    const de30 = slotsDisponibles(entrada({ duracionServicioMin: 30 }));
    const de60 = slotsDisponibles(entrada({ duracionServicioMin: 60 }));

    // Con 30 min, 12:30 termina 13:00 justo: entra.
    expect(de30).toContain('12:30');
    // Con 60, 12:30 terminaria 13:30: no entra. Ni 12:00, que termina 13:00.
    expect(de60).not.toContain('12:30');
    expect(de60).toContain('12:00');
  });

  it('un servicio de 60 min necesita el doble de hueco entre turnos', () => {
    // Turno existente 11:00-11:30. Con paso de 30 la grilla ofrece 10:30.
    const reservas = [{ hora: '11:00', duracionMin: 30 }];

    expect(slotsDisponibles(entrada({ reservas, duracionServicioMin: 30 }))).toContain('10:30');
    // Con 60 min, 10:30 terminaria 11:30 y pisa el turno.
    expect(slotsDisponibles(entrada({ reservas, duracionServicioMin: 60 }))).not.toContain('10:30');
  });
});

describe('turnos existentes', () => {
  it('un turno de 60 min tapa DOS slots de 30', () => {
    const slots = slotsDisponibles(entrada({ reservas: [{ hora: '10:00', duracionMin: 60 }] }));

    expect(slots).not.toContain('10:00');
    expect(slots).not.toContain('10:30');
    // El de las 11:00 empieza justo cuando termina: contiguo, no solapa.
    expect(slots).toContain('11:00');
    expect(slots).toContain('09:30');
  });

  it('los turnos contiguos no se comen slots de mas', () => {
    const slots = slotsDisponibles(entrada({ reservas: [{ hora: '10:00', duracionMin: 30 }] }));

    expect(slots).not.toContain('10:00');
    expect(slots).toContain('09:30');
    expect(slots).toContain('10:30');
  });
});

describe('anticipacion', () => {
  it('solo se aplica si la fecha es HOY', () => {
    // Son las 11:00 de hoy. Para una fecha futura, las 09:00 siguen validas.
    const ahoraMs = slotAMs(HOY, '11:00');

    expect(slotsDisponibles(entrada({ fecha: FUTURO, ahoraMs }))).toContain('09:00');
  });

  it('hoy, descarta los slots que no cumplen los 30 minutos', () => {
    // 10:10 + 30 min de anticipacion = 10:40. El primero valido es 11:00.
    const slots = slotsDisponibles(entrada({ fecha: HOY, ahoraMs: slotAMs(HOY, '10:10') }));

    expect(slots).not.toContain('10:00');
    expect(slots).not.toContain('10:30');
    expect(slots[0]).toBe('11:00');
  });

  it('el limite de anticipacion es inclusivo', () => {
    // 10:00 + 30 = 10:30 exacto.
    const slots = slotsDisponibles(entrada({ fecha: HOY, ahoraMs: slotAMs(HOY, '10:00') }));

    expect(slots).toContain('10:30');
    expect(slots).not.toContain('10:00');
  });

  it('con anticipacion 0, el slot en curso ya no sirve pero el siguiente si', () => {
    const slots = slotsDisponibles(
      entrada({ fecha: HOY, ahoraMs: slotAMs(HOY, '10:01'), minutosAnticipacion: 0 }),
    );

    expect(slots).not.toContain('10:00');
    expect(slots).toContain('10:30');
  });
});

describe('horario cortado', () => {
  it('no ofrece slots en el hueco del mediodia', () => {
    const slots = slotsDisponibles(entrada({ bloques: cortado }));

    expect(slots).toContain('12:30');
    expect(slots).not.toContain('13:00');
    expect(slots).not.toContain('14:00');
    expect(slots).not.toContain('15:30');
    expect(slots).toContain('16:00');
    expect(slots).toContain('19:30');
    expect(slots).not.toContain('20:00');
  });

  it('devuelve los slots en orden ascendente, sin duplicados', () => {
    const slots = slotsDisponibles(entrada({ bloques: cortado }));

    expect([...slots]).toEqual([...slots].sort());
    expect(new Set(slots).size).toBe(slots.length);
  });
});

describe('tieneDisponibilidad', () => {
  it('es true si queda al menos un slot', () => {
    expect(tieneDisponibilidad(entrada())).toBe(true);
  });

  it('es false si el dia esta lleno', () => {
    // Un unico turno que cubre el bloque entero.
    const reservas = [{ hora: '09:00', duracionMin: 240 }];
    expect(tieneDisponibilidad(entrada({ reservas }))).toBe(false);
  });

  it('es false para un feriado', () => {
    expect(tieneDisponibilidad(entrada({ overrideTrabaja: false }))).toBe(false);
  });
});

/**
 * Las dos formas de horario que existen en el sistema.
 *
 * El seed de desarrollo usa horario CORTADO (9-13 y 16-20) y produccion, por
 * ahora, un bloque CONTINUO (9-20). Los dos son validos, pero si los tests solo
 * ejercitaran uno, un bug de la otra forma no lo agarraria nadie hasta que un
 * cliente reserve.
 *
 * Estos tests corren las mismas afirmaciones contra las dos.
 */
describe('las dos formas de horario', () => {
  const formas = [
    { nombre: 'continuo (produccion)', bloques: [{ inicio: 9, fin: 20 }] },
    {
      nombre: 'cortado (seed de desarrollo)',
      bloques: [
        { inicio: 9, fin: 13 },
        { inicio: 16, fin: 20 },
      ],
    },
  ];

  for (const { nombre, bloques } of formas) {
    describe(nombre, () => {
      it('abre a las 09:00 y el ultimo slot de 30 min es 19:30', () => {
        const slots = slotsDisponibles(entrada({ bloques }));

        expect(slots[0]).toBe('09:00');
        expect(slots[slots.length - 1]).toBe('19:30');
        expect(slots).not.toContain('20:00');
      });

      it('un turno existente tapa su slot y ninguno mas', () => {
        const slots = slotsDisponibles(
          entrada({ bloques, reservas: [{ hora: '10:00', duracionMin: 30 }] }),
        );

        expect(slots).not.toContain('10:00');
        expect(slots).toContain('09:30');
        expect(slots).toContain('10:30');
      });

      it('un servicio de 60 min no se ofrece pegado al cierre', () => {
        const slots = slotsDisponibles(entrada({ bloques, duracionServicioMin: 60 }));

        expect(slots).toContain('19:00');
        expect(slots).not.toContain('19:30');
      });

      it('el feriado cierra el dia entero', () => {
        expect(slotsDisponibles(entrada({ bloques, overrideTrabaja: false }))).toEqual([]);
      });

      it('la anticipacion se aplica igual', () => {
        const slots = slotsDisponibles(
          entrada({ bloques, fecha: HOY, ahoraMs: slotAMs(HOY, '10:10') }),
        );
        expect(slots[0]).toBe('11:00');
      });
    });
  }

  it('la UNICA diferencia entre las dos es el hueco del mediodia', () => {
    const continuo = slotsDisponibles(entrada({ bloques: formas[0]!.bloques }));
    const cortado = slotsDisponibles(entrada({ bloques: formas[1]!.bloques }));

    const soloEnContinuo = continuo.filter((s) => !cortado.includes(s));

    // 13:00 a 15:30 inclusive: seis slots de 30 minutos.
    expect(soloEnContinuo).toEqual(['13:00', '13:30', '14:00', '14:30', '15:00', '15:30']);
    expect(cortado.filter((s) => !continuo.includes(s))).toEqual([]);
  });
});
