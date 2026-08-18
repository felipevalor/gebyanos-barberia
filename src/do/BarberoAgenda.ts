import { DurableObject } from 'cloudflare:workers';
import { checkOverlap, type TurnoExistente } from '../domain/slots';
import { uuidv7 } from '../db/id';
import { esViolacionDeUnico, esViolacionDeUnicoEn } from '../db/errores';

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

  /**
   * Marca de auditoria de los turnos generados por el motor de recurrentes.
   *
   * ⚠️ Ademas de auditoria, es lo que hace IDEMPOTENTE al cron de la 5.3: el
   * job pregunta si ya existe un turno activo con este mismo valor antes de
   * generar. Sin eso, un cron diario crea un turno duplicado por dia.
   */
  turnoAutoIso?: string | null;

  /**
   * Si viene, se hace upsert del cliente por telefono ADENTRO de la seccion
   * critica: buscar por telefono, actualizar el nombre si existe, crearlo si
   * no. Fuera de la serializacion, dos reservas simultaneas del mismo
   * telefono podrian crear dos clientes.
   *
   * El telefono tiene que llegar ya normalizado.
   */
  upsertCliente?: { nombre: string; telefono: string } | undefined;
}

export interface ReprogramarInput {
  /** La reserva que se mueve. Sigue siendo la misma fila: conserva id y cancel_token. */
  reservaId: string;
  barberoId: string;
  fecha: string;
  hora: string;
  duracionMin: number;
  /** Si cambia de servicio. Si no viene, se conservan los del turno. */
  servicioId?: string | null;
  servicio?: string | undefined;
}

export type ReprogramarResult =
  | { estado: 'exito' }
  | { estado: 'overlap'; conflicto: string | null }
  | { estado: 'noEncontrada' }
  | { estado: 'error'; detalle: string };

export type ReservaResult =
  | { estado: 'exito'; reservaId: string; cancelToken: string; clienteId: string | null }
  | { estado: 'overlap'; conflicto: string | null }
  | { estado: 'error'; detalle: string };

/** Mensaje al cliente cuando el slot se ocupo. Transcripcion textual. */
export const MENSAJE_OVERLAP =
  'Lo sentimos, este turno acaba de ser reservado por alguien más.';

/**
 * Especifico del indice del SLOT.
 *
 * Existen dos unicos en este flujo — `reservas(barbero_id, fecha, hora)` y
 * `clientes(telefono)` — y solo el primero significa "el turno se ocupo". Sin
 * esta distincion, un choque de telefono se le reportaria al cliente como
 * "este turno acaba de ser reservado por alguien más", que es mentira.
 *
 * El texto exacto varia segun la capa (`D1_ERROR:` desde el Worker,
 * ` [code: 7500]` desde wrangler --remote) y Drizzle ademas lo envuelve.
 * Ver src/db/errores.ts y docs/spike-indice-unico-parcial.md.
 */
export const esColisionDeSlot = (e: unknown): boolean => esViolacionDeUnicoEn(e, 'reservas');

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

  /**
   * Turnos activos del barbero ese dia. Solo `estado = 'activa'`.
   *
   * `excluirId` saca del calculo la reserva que se esta moviendo: sin eso, un
   * turno reprogramado al mismo horario que ya tiene choca CONSIGO MISMO.
   */
  async #reservasActivas(
    barberoId: string,
    fecha: string,
    excluirId?: string,
  ): Promise<TurnoExistente[]> {
    const { results } = await this.env.DB.prepare(
      `SELECT hora, duracion_min FROM reservas
       WHERE barbero_id = ? AND fecha = ? AND estado = 'activa' AND id IS NOT ?
       ORDER BY hora`,
    )
      .bind(barberoId, fecha, excluirId ?? null)
      .all<{ hora: string; duracion_min: number }>();

    return results.map((r) => ({ hora: r.hora, duracionMin: r.duracion_min }));
  }

  /**
   * Mueve una reserva de fecha y hora CONSERVANDO su identidad.
   *
   * ⚠️ POR QUE ES UN UPDATE Y NO UN CANCELAR-Y-RECREAR
   *
   * Recrear cambiaria el `id` y el `cancel_token`, y los magic links de la
   * Fase 5 apuntan al id: despues de reprogramar, el link del cliente quedaria
   * apuntando a un turno cancelado. Refrescar la pagina mostraria "turno
   * cancelado" a alguien que acaba de reprogramar bien.
   *
   * Y POR QUE PASA POR EL DO
   *
   * Un UPDATE suelto de fecha/hora no pasa por ningun punto de serializacion,
   * asi que dos reprogramaciones simultaneas al mismo slot entrarian las dos.
   * El indice unico solo las atajaria si coinciden exacto — un solapamiento
   * parcial no lo ve. Acá el leer-decidir-escribir va adentro de
   * `blockConcurrencyWhile`, igual que el alta.
   *
   * Una reprogramacion NUNCA cambia de barbero, asi que siempre es el mismo
   * DO: no hay dos instancias que coordinar.
   */
  async reprogramar(input: ReprogramarInput): Promise<ReprogramarResult> {
    let resultado: ReprogramarResult = {
      estado: 'error',
      detalle: 'La operación no produjo resultado.',
    };

    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        resultado = await this.#reprogramarSerializado(input);
      } catch (e) {
        resultado = esColisionDeSlot(e)
          ? { estado: 'overlap', conflicto: input.hora }
          : { estado: 'error', detalle: e instanceof Error ? e.message : String(e) };
      }
    });

    return resultado;
  }

  async #reprogramarSerializado(input: ReprogramarInput): Promise<ReprogramarResult> {
    const existentes = await this.#reservasActivas(
      input.barberoId,
      input.fecha,
      input.reservaId,
    );

    const { overlap, conflicto } = checkOverlap(input.hora, input.duracionMin, existentes);
    if (overlap) return { estado: 'overlap', conflicto };

    try {
      const r = await this.env.DB.prepare(
        `UPDATE reservas
            SET fecha = ?, hora = ?, duracion_min = ?,
                servicio_id = COALESCE(?, servicio_id),
                servicio    = COALESCE(?, servicio)
          WHERE id = ? AND barbero_id = ? AND estado = 'activa'`,
      )
        .bind(
          input.fecha,
          input.hora,
          input.duracionMin,
          input.servicioId ?? null,
          input.servicio ?? null,
          input.reservaId,
          input.barberoId,
        )
        .run();

      // Sin filas afectadas: o no existe, o es de otro barbero, o ya se cancelo.
      if (!r.meta.changes) return { estado: 'noEncontrada' };
    } catch (e) {
      // Segunda capa: el indice unico parcial ataja un UPDATE hacia un slot
      // ocupado igual que ataja un INSERT.
      if (esColisionDeSlot(e)) return { estado: 'overlap', conflicto: input.hora };
      throw e;
    }

    return { estado: 'exito' };
  }

  /**
   * Busca el cliente por telefono; actualiza el nombre si existe, lo crea si
   * no. Devuelve su id.
   *
   * ⚠️ ESTE DO NO ALCANZA PARA SERIALIZAR ESTO.
   *
   * `blockConcurrencyWhile` serializa las escrituras de UN barbero, porque el
   * DO se direcciona con `idFromName(barberoId)`. Dos reservas simultaneas del
   * mismo telefono con barberos DISTINTOS son dos instancias que no se ven
   * entre si: las dos leen "no existe" y las dos insertan.
   *
   * No hay punto de serializacion comun — meter todos los clientes en un DO
   * global convertiria el alta de clientes en el cuello de botella del
   * sistema. La defensa es el indice unico parcial sobre `clientes.telefono`,
   * y este manejo del choque: si el INSERT viola el unico, es que la otra
   * instancia gano la carrera, asi que se relee su fila.
   */
  async #upsertCliente(nombre: string, telefono: string): Promise<string> {
    const buscar = () =>
      this.env.DB.prepare('SELECT id FROM clientes WHERE telefono = ? LIMIT 1')
        .bind(telefono)
        .first<{ id: string }>();

    const ahora = new Date().toISOString();

    const actualizar = async (id: string): Promise<string> => {
      await this.env.DB.prepare('UPDATE clientes SET nombre = ?, updated_at = ? WHERE id = ?')
        .bind(nombre, ahora, id)
        .run();
      return id;
    };

    const existente = await buscar();
    if (existente) return actualizar(existente.id);

    const id = uuidv7();
    try {
      await this.env.DB.prepare(
        'INSERT INTO clientes (id, nombre, telefono, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
        .bind(id, nombre, telefono, ahora, ahora)
        .run();
      return id;
    } catch (e) {
      if (!esViolacionDeUnico(e)) throw e;

      // Otro DO lo creo entre nuestro SELECT y nuestro INSERT.
      const ganador = await buscar();
      if (!ganador) throw e; // el unico salto por otra razon: no tragarselo
      return actualizar(ganador.id);
    }
  }

  async #reservarSerializado(input: ReservaInput): Promise<ReservaResult> {
    const existentes = await this.#reservasActivas(input.barberoId, input.fecha);

    // Detecta el solapamiento PARCIAL, que el indice unico no puede ver.
    const { overlap, conflicto } = checkOverlap(input.hora, input.duracionMin, existentes);
    if (overlap) return { estado: 'overlap', conflicto };

    // Recien despues de saber que el slot esta libre: no se crean clientes
    // por intentos que van a rebotar.
    const clienteId = input.upsertCliente
      ? await this.#upsertCliente(input.upsertCliente.nombre, input.upsertCliente.telefono)
      : (input.clienteId ?? null);

    const reservaId = uuidv7();
    const cancelToken = uuidv7();

    try {
      await this.env.DB.prepare(
        `INSERT INTO reservas
           (id, barbero_id, cliente_id, servicio_id,
            nombre, telefono, servicio, duracion_min,
            fecha, hora, estado, tipo, mensaje, source, cancel_token, turno_auto_iso)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'activa', ?, ?, ?, ?, ?)`,
      )
        .bind(
          reservaId,
          input.barberoId,
          clienteId,
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
          input.turnoAutoIso ?? null,
        )
        .run();
    } catch (e) {
      // Segunda capa de defensa: si un bug de routing dejara pasar una
      // escritura sin el DO, el indice unico parcial la ataja acá. Se mapea al
      // mismo resultado que el overlap logico, no a un 500.
      if (esColisionDeSlot(e)) return { estado: 'overlap', conflicto: input.hora };
      throw e;
    }

    return { estado: 'exito', reservaId, cancelToken, clienteId };
  }
}
