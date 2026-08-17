import { describe, it, expect } from 'vitest';
import { esViolacionDeUnico, esViolacionDeUnicoEn } from '../../src/db/errores';

/**
 * Estos tests existen por un bug real: el alta de clientes devolvia 500 en vez
 * de un 400 con mensaje claro, porque Drizzle ENVUELVE el error de D1 y el
 * chequeo miraba solo `.message` del error externo.
 */
const envueltoPorDrizzle = () => {
  const interno = new Error(
    'D1_ERROR: UNIQUE constraint failed: clientes.telefono: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)',
  );
  const externo = new Error(
    'Failed query: insert into "clientes" ("id", "nombre", "telefono") values (?, ?, ?)',
  );
  (externo as { cause?: unknown }).cause = interno;
  return externo;
};

describe('esViolacionDeUnico', () => {
  it('reconoce el error DIRECTO de env.DB.prepare', () => {
    expect(
      esViolacionDeUnico(new Error('D1_ERROR: UNIQUE constraint failed: reservas.hora')),
    ).toBe(true);
  });

  it('⚠️ reconoce el error ENVUELTO por Drizzle', () => {
    // El mensaje externo NO menciona el constraint: esta en el `cause`.
    const e = envueltoPorDrizzle();
    expect(e.message).not.toContain('UNIQUE constraint failed');
    expect(esViolacionDeUnico(e)).toBe(true);
  });

  it('recorre varios niveles de cause', () => {
    const hondo = new Error('capa 1');
    (hondo as { cause?: unknown }).cause = envueltoPorDrizzle();
    expect(esViolacionDeUnico(hondo)).toBe(true);
  });

  it('no se cuelga con un cause circular', () => {
    const a = new Error('a');
    const b = new Error('b');
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;
    expect(esViolacionDeUnico(a)).toBe(false);
  });

  it('NO confunde otros errores', () => {
    expect(esViolacionDeUnico(new Error('FOREIGN KEY constraint failed'))).toBe(false);
    expect(esViolacionDeUnico(new Error('no such table: reservas'))).toBe(false);
    expect(esViolacionDeUnico('un string')).toBe(false);
    expect(esViolacionDeUnico(null)).toBe(false);
  });
});

describe('esViolacionDeUnicoEn', () => {
  it('distingue la tabla, incluso a traves del cause', () => {
    const deClientes = envueltoPorDrizzle();

    expect(esViolacionDeUnicoEn(deClientes, 'clientes')).toBe(true);
    // Este es el que evita decirle al cliente "el turno se ocupo" cuando en
    // realidad choco el telefono.
    expect(esViolacionDeUnicoEn(deClientes, 'reservas')).toBe(false);
  });

  it('reconoce el del slot', () => {
    const e = new Error(
      'D1_ERROR: UNIQUE constraint failed: reservas.barbero_id, reservas.fecha, reservas.hora',
    );
    expect(esViolacionDeUnicoEn(e, 'reservas')).toBe(true);
    expect(esViolacionDeUnicoEn(e, 'clientes')).toBe(false);
  });
});
