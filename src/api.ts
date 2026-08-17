/**
 * Contrato de respuestas de la API. Ver 00-CONTEXTO.md.
 *
 *   { ok: true, data }  |  { ok: false, error }
 *
 * Dos extensiones, las dos del patron Bloquear+Avisar de la tarea 3.2:
 *
 *   - un error puede traer `data` con la lista de conflictos. Un "no se pudo"
 *     pelado deja al dueño sin saber que reagendar;
 *   - una respuesta exitosa puede traer `warning` cuando la operacion se hizo
 *     pero algo quedo pendiente de atencion humana.
 */
export type ApiResponse<T> =
  | { ok: true; data: T; warning?: string }
  | { ok: false; error: string; data?: unknown };

export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500;

export function ok<T>(data: T, warning?: string): ApiResponse<T> {
  return warning ? { ok: true, data, warning } : { ok: true, data };
}

/**
 * `detalle` es la lista de conflictos del 409. Se omite del JSON cuando no
 * viene, para que un error comun siga siendo exactamente `{ ok, error }`.
 */
export function fail(error: string, detalle?: unknown): ApiResponse<never> {
  return detalle === undefined ? { ok: false, error } : { ok: false, error, data: detalle };
}
