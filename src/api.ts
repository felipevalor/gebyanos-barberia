/**
 * Contrato de respuestas de la API. Ver 00-CONTEXTO.md.
 *
 *   { ok: true, data }  |  { ok: false, error }
 */
export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };

export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500;

export const ok = <T>(data: T): ApiResponse<T> => ({ ok: true, data });

export const fail = (error: string): ApiResponse<never> => ({ ok: false, error });
