import { DurableObject } from 'cloudflare:workers';
import { checkOverlap, type TurnoExistente } from '../domain/slots';
import { uuidv7 } from '../db/id';

/**
 * Serializa las escrituras de reservas de UN barbero.
 *
 * Es donde se garantiza el invariante del sistema: dos clientes no pueden
 * terminar con el mismo turno. Se direcciona con `idFromName(barberoId)`.
 *
 * QUE PASA POR ACA: toda escritura de reservas del barbero — reserva publica,
 * alta desde el panel, reprogramacion, bloqueos administrativos y generacion
 * de recurrentes.
 *
 * QUE NO: las lecturas de solo consulta (agenda, disponibilidad, listados).
 * Van directo a D1 para no serializar de gusto.
 *
 *
 * ⚠️ POR QUE `blockConcurrencyWhile` Y NO ALCANZA CON EL DO SOLO
 *
 * La idea de "un DO procesa un request a la vez" vale para las operaciones de
 * `ctx.storage`: ahi las input gates impiden que otro request se intercale.
 * Pero este DO no usa `ctx.storage` — las reservas viven en D1, que desde el
 * punto de vista del DO es una llamada externa, igual que un `fetch()`.
 *
 * En cada `await` a D1 el event loop cede y OTRO request puede entrar. Sin
 * proteccion, 50 requests simultaneos pueden leer todos la misma foto "no hay
 * nada reservado", decidir todos que no hay overlap, y recien chocar en el
 * INSERT. Para el mismo (fecha, hora) exacto los ataja el indice unico, pero
 * dos turnos que se solapan PARCIALMENTE (10:00 de 30 min contra 09:30 de 60)
 * no comparten clave: el indice no los ve y entrarian los dos.
 *
 * La doc de Cloudflare lo dice explicito: "Reserve blockConcurrencyWhile [...]
 * for cases where you make external async calls (such as fetch()) and cannot
 * tolerate state changes while the event loop yields."
 *
 * Por eso el leer-decidir-escribir va adentro de `blockConcurrencyWhile`, que
 * bloquea la entrega de cualquier otro evento hasta que termina.
 */

export interface ReservaInput {
  barberoId: string;
  fecha: string;
  hora: string;
  duracionMin: number;

  /** Snapshots al momento de crear. No mutan si despues cambia el origen. */
  nombre: string;
  telefono: string;
  servicio: string;

  clienteId?: string | null;
  servicioId?: string | null;
  mensaje?: string | null;
  source?: string;
  tipo?: 'turno' | 'bloqueo';
}

export type ReservaResult =
  | { estado: 'exito'; reservaId: string; cancelToken: string }
  | { estado: 'overlap'; conflicto: string | null }
  | { estado: 'error'; detalle: string };

/** Mensaje al cliente cuando el slot se ocupo. Transcripcion textual. */
export const MENSAJE_OVERLAP =
  'Lo sentimos, este turno acaba de ser reservado por alguien más.';

/**
 * True si el error de D1 es una violacion de indice unico.
 *
 * El texto exacto varia segun la capa (`D1_ERROR:` desde el Worker,
 * ` [code: 7500]` desde wrangler --remote). Lo estable es el nucleo.
 * Ver docs/spike-indice-unico-parcial.md.
 */
export function esColisionDeSlot(e: unknown): boolean {
  return e instanceof Error && e.message.includes('UNIQUE constraint failed');
}

export class BarberoAgenda extends DurableObject<Env> {
  /**
   * Crea una reserva si el slot esta libre.
   *
   * Toda la seccion critica (leer las reservas del dia, decidir, escribir) va
   * adentro de `blockConcurrencyWhile`. Nada puede tirar desde adentro: si una
   * excepcion escapa, el DO se resetea, asi que se atrapa y se devuelve como
   * valor.
   */
  async reservar(input: ReservaInput): Promise<ReservaResult> {
    let resultado: ReservaResult = {
      estado: 'error',
      detalle: 'La operación no produjo resultado.',
    };

    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        resultado = await this.#reservarSerializado(input);
      } catch (e) {
        resultado = esColisionDeSlot(e)
          ? { estado: 'overlap', conflicto: input.hora }
          : { estado: 'error', detalle: e instanceof Error ? e.message : String(e) };
      }
    });

    return resultado;
  }

  /** Turnos activos del barbero ese dia. Solo `estado = 'activa'`. */
  async #reservasActivas(barberoId: string, fecha: string): Promise<TurnoExistente[]> {
    const { results } = await this.env.DB.prepare(
      `SELECT hora, duracion_min FROM reservas
       WHERE barbero_id = ? AND fecha = ? AND estado = 'activa'
       ORDER BY hora`,
    )
      .bind(barberoId, fecha)
      .all<{ hora: string; duracion_min: number }>();

    return results.map((r) => ({ hora: r.hora, duracionMin: r.duracion_min }));
  }

  async #reservarSerializado(input: ReservaInput): Promise<ReservaResult> {
    const existentes = await this.#reservasActivas(input.barberoId, input.fecha);

    // Detecta el solapamiento PARCIAL, que el indice unico no puede ver.
    const { overlap, conflicto } = checkOverlap(input.hora, input.duracionMin, existentes);
    if (overlap) return { estado: 'overlap', conflicto };

    const reservaId = uuidv7();
    const cancelToken = uuidv7();

    try {
      await this.env.DB.prepare(
        `INSERT INTO reservas
           (id, barbero_id, cliente_id, servicio_id,
            nombre, telefono, servicio, duracion_min,
            fecha, hora, estado, tipo, mensaje, source, cancel_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'activa', ?, ?, ?, ?)`,
      )
        .bind(
          reservaId,
          input.barberoId,
          input.clienteId ?? null,
          input.servicioId ?? null,
          input.nombre,
          input.telefono,
          input.servicio,
          input.duracionMin,
          input.fecha,
          input.hora,
          input.tipo ?? 'turno',
          input.mensaje ?? null,
          input.source ?? 'web',
          cancelToken,
        )
        .run();
    } catch (e) {
      // Segunda capa de defensa: si un bug de routing dejara pasar una
      // escritura sin el DO, el indice unico parcial la ataja acá. Se mapea al
      // mismo resultado que el overlap logico, no a un 500.
      if (esColisionDeSlot(e)) return { estado: 'overlap', conflicto: input.hora };
      throw e;
    }

    return { estado: 'exito', reservaId, cancelToken };
  }
}
