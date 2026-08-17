/**
 * Feriados nacionales argentinos, de api.argentinadatos.com.
 *
 * SON INFORMATIVOS: no cierran la barbería. Muchas barberías abren los
 * feriados, y algunas justamente esos días trabajan más. Lo que cierra es el
 * override propio del barbero.
 *
 * El cache en KV llega en la Fase 4. Acá se llama directo.
 */

const BASE = 'https://api.argentinadatos.com/v1/feriados';
const TIMEOUT_MS = 5_000;

export interface FeriadoNacional {
  fecha: string;
  nombre: string;
  tipo: string;
}

interface RespuestaApi {
  fecha?: unknown;
  nombre?: unknown;
  tipo?: unknown;
}

/**
 * Feriados de un año. Devuelve [] ante cualquier problema.
 *
 * Es un dato decorativo del panel: si la API de terceros está caída, la
 * pantalla de feriados tiene que seguir mostrando los overrides propios, que
 * son los que de verdad afectan la agenda. Tirar acá dejaría el panel sin
 * poder cerrar un día por culpa de un servicio ajeno.
 */
export async function feriadosNacionales(anio: number): Promise<FeriadoNacional[]> {
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) return [];

  try {
    const respuesta = await fetch(`${BASE}/${anio}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });

    if (!respuesta.ok) {
      console.warn(`feriados nacionales: HTTP ${respuesta.status} para ${anio}`);
      return [];
    }

    const datos: unknown = await respuesta.json();
    if (!Array.isArray(datos)) return [];

    return datos
      .filter((f): f is RespuestaApi => Boolean(f) && typeof f === 'object')
      .map((f) => ({
        fecha: String(f.fecha ?? ''),
        nombre: String(f.nombre ?? ''),
        tipo: String(f.tipo ?? ''),
      }))
      .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.fecha));
  } catch (e) {
    console.warn(
      'feriados nacionales: no se pudieron obtener',
      e instanceof Error ? e.message : String(e),
    );
    return [];
  }
}
