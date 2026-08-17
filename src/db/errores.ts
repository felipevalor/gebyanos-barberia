/**
 * Deteccion de errores de D1.
 *
 * ⚠️ HAY QUE RECORRER LA CADENA DE `cause`, y esta es la razon:
 *
 * Con `env.DB.prepare(...)` el error llega directo y su mensaje dice
 *
 *   D1_ERROR: UNIQUE constraint failed: clientes.telefono: SQLITE_CONSTRAINT
 *
 * pero con Drizzle el error viene ENVUELTO en un `DrizzleQueryError` cuyo
 * mensaje es solo
 *
 *   Failed query: insert into "clientes" (...) values (?, ?, ?)
 *
 * y el texto real queda en `.cause`. Un chequeo con `e.message.includes(...)`
 * funciona en el codigo que usa `prepare` y falla en silencio en el que usa
 * Drizzle: el 400 con mensaje claro se convierte en un 500.
 *
 * Paso exactamente por eso al escribir el alta de clientes.
 */

/** Todos los mensajes de la cadena de errores, del mas externo al mas interno. */
function mensajesEnCadena(e: unknown, profundidad = 5): string[] {
  if (!(e instanceof Error) || profundidad <= 0) return [];
  return [e.message, ...mensajesEnCadena((e as { cause?: unknown }).cause, profundidad - 1)];
}

/** True si el error, o alguno de sus `cause`, es una violacion de indice unico. */
export function esViolacionDeUnico(e: unknown): boolean {
  return mensajesEnCadena(e).some((m) => m.includes('UNIQUE constraint failed'));
}

/**
 * True si la violacion es sobre una columna de la tabla indicada.
 *
 * Sirve para no confundir dos unicos distintos del mismo flujo: en la reserva
 * conviven `reservas(barbero_id, fecha, hora)` y `clientes(telefono)`, y solo
 * el primero significa "el turno se ocupo".
 */
export function esViolacionDeUnicoEn(e: unknown, tabla: string): boolean {
  return mensajesEnCadena(e).some(
    (m) => m.includes('UNIQUE constraint failed') && m.includes(`${tabla}.`),
  );
}
