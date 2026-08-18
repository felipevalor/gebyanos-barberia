import { and, eq, gte, asc, desc, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { clientesRecurrentes, clientes, reservas, barberoHorarios, feriadosOverride, negocio } from '../db/schema';
import { uuidv7 } from '../db/id';
import { calcularProximaFecha, type RecurrenteConfig } from '../domain/recurrence';
import { evaluarSlot, mensajeCliente, combinarOverrides } from '../domain/schedule';
import {
  todayArgentina,
  diaDeLaSemana,
  esFechaValida,
  esHoraValida,
  addDays as addDias,
} from '../domain/dates';
import { mensajeRecurrenteConTurnos, type TurnoEnConflicto } from './conflictos';
import type { Rol } from './auth';

/**
 * Clientes recurrentes: los que vuelven cada N dias.
 *
 * La aritmetica de fechas vive en `domain/recurrence.ts` (Fase 1) y NO se
 * duplica acá: este modulo aporta el I/O — leer horarios, evaluar
 * disponibilidad, crear el turno via el Durable Object.
 */

export const ERROR_NO_ENCONTRADO = 'Recurrente no encontrado.';
export const ERROR_NO_VALIDO = 'Recurrente no válido o inactivo.';
export const ERROR_SIN_HORA = 'Cliente no tiene hora preferida.';
export const ERROR_SLOT_OCUPADO = 'Slot Ocupado. Intente mover manualmente.';
export const ERROR_CLIENTE_REQUERIDO = 'Elegí un cliente para el recurrente.';
export const ERROR_FRECUENCIA =
  'La frecuencia tiene que ser un número entero de días entre 1 y 365.';
export const ERROR_HORA_INVALIDA = 'Formato de hora inválido. Usá HH:mm.';
export const ERROR_FECHA_INVALIDA = 'Formato de fecha inválido. Usá YYYY-MM-DD.';

export interface RecurrenteDelPanel {
  id: string;
  barberoId: string;
  clienteId: string;
  clienteNombre: string | null;
  clienteTelefono: string | null;
  servicio: string;
  servicioId: string | null;
  frecuenciaDias: number;
  horaPreferida: string | null;
  fechaAncla: string | null;
  ultimoTurnoFecha: string | null;
  precioEspecialCentavos: number | null;
  notas: string | null;
  activo: number;
  /** Derivados de `reservas`, no del campo. Ver el docstring del listado. */
  proximoTurno: string | null;
  ultimoTurnoReal: string | null;
}

const columnas = {
  id: clientesRecurrentes.id,
  barberoId: clientesRecurrentes.barberoId,
  clienteId: clientesRecurrentes.clienteId,
  servicio: clientesRecurrentes.servicio,
  servicioId: clientesRecurrentes.servicioId,
  frecuenciaDias: clientesRecurrentes.frecuenciaDias,
  horaPreferida: clientesRecurrentes.horaPreferida,
  fechaAncla: clientesRecurrentes.fechaAncla,
  ultimoTurnoFecha: clientesRecurrentes.ultimoTurnoFecha,
  precioEspecialCentavos: clientesRecurrentes.precioEspecialCentavos,
  notas: clientesRecurrentes.notas,
  activo: clientesRecurrentes.activo,
  clienteNombre: clientes.nombre,
  clienteTelefono: clientes.telefono,
};

/**
 * Listado enriquecido con el PROXIMO y el ULTIMO turno REALES.
 *
 * ⚠️ No alcanza con `ultimo_turno_fecha`: ese campo dice cuando el sistema
 * genero por ultima vez, no que haya pasado. Si el turno se cancelo o se
 * reprogramo, el campo miente. El operador necesita ver el estado real de la
 * agenda para entender qué le pasa a cada cliente.
 */
export async function listarRecurrentes(
  env: Env,
  barberoId: string | null,
  ahora: Date = new Date(),
): Promise<RecurrenteDelPanel[]> {
  const hoy = todayArgentina(ahora);

  const filas = await db(env.DB)
    .select(columnas)
    .from(clientesRecurrentes)
    .leftJoin(clientes, eq(clientesRecurrentes.clienteId, clientes.id))
    .where(barberoId ? eq(clientesRecurrentes.barberoId, barberoId) : undefined)
    .orderBy(desc(clientesRecurrentes.activo), asc(clientes.nombre));

  return Promise.all(
    filas.map(async (f) => {
      const [proximo, ultimo] = await Promise.all([
        db(env.DB)
          .select({ fecha: reservas.fecha })
          .from(reservas)
          .where(
            and(
              eq(reservas.clienteId, f.clienteId),
              eq(reservas.barberoId, f.barberoId),
              eq(reservas.estado, 'activa'),
              eq(reservas.tipo, 'turno'),
              gte(reservas.fecha, hoy),
            ),
          )
          .orderBy(asc(reservas.fecha))
          .limit(1),
        db(env.DB)
          .select({ fecha: reservas.fecha })
          .from(reservas)
          .where(
            and(
              eq(reservas.clienteId, f.clienteId),
              eq(reservas.barberoId, f.barberoId),
              eq(reservas.estado, 'activa'),
              eq(reservas.tipo, 'turno'),
              sql`${reservas.fecha} < ${hoy}`,
            ),
          )
          .orderBy(desc(reservas.fecha))
          .limit(1),
      ]);

      return {
        ...f,
        proximoTurno: proximo[0]?.fecha ?? null,
        ultimoTurnoReal: ultimo[0]?.fecha ?? null,
      };
    }),
  );
}

export async function buscarRecurrente(env: Env, id: string) {
  const filas = await db(env.DB)
    .select(columnas)
    .from(clientesRecurrentes)
    .leftJoin(clientes, eq(clientesRecurrentes.clienteId, clientes.id))
    .where(eq(clientesRecurrentes.id, id))
    .limit(1);

  return filas[0] ?? null;
}

/** Un `barbero` solo toca los suyos; el `owner` todos. */
export const puedeTocar = (
  sesion: { barberoId: string; rol: Rol },
  r: { barberoId: string },
): boolean => sesion.rol === 'owner' || r.barberoId === sesion.barberoId;

// ------------------------------------------------------------ escritura

export interface EntradaRecurrente {
  clienteId?: unknown;
  barberoId?: unknown;
  servicio?: unknown;
  servicioId?: unknown;
  frecuenciaDias?: unknown;
  horaPreferida?: unknown;
  fechaAncla?: unknown;
  precioEspecialCentavos?: unknown;
  notas?: unknown;
  activo?: unknown;
}

const texto = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() : undefined);

/** Valida los campos comunes al alta y a la edicion. */
export function validarEntrada(e: EntradaRecurrente): string | null {
  if (e.frecuenciaDias !== undefined) {
    const f = e.frecuenciaDias;
    if (typeof f !== 'number' || !Number.isInteger(f) || f < 1 || f > 365) return ERROR_FRECUENCIA;
  }
  if (e.horaPreferida !== undefined && e.horaPreferida !== null) {
    const h = texto(e.horaPreferida);
    if (!h || !esHoraValida(h)) return ERROR_HORA_INVALIDA;
  }
  if (e.fechaAncla !== undefined && e.fechaAncla !== null) {
    const f = texto(e.fechaAncla);
    if (!f || !esFechaValida(f)) return ERROR_FECHA_INVALIDA;
  }
  return null;
}

export async function crearRecurrente(
  env: Env,
  barberoId: string,
  e: EntradaRecurrente,
): Promise<{ estado: 'exito'; id: string } | { estado: 'error'; error: string }> {
  const clienteId = texto(e.clienteId);
  if (!clienteId) return { estado: 'error', error: ERROR_CLIENTE_REQUERIDO };

  const error = validarEntrada(e);
  if (error) return { estado: 'error', error };

  const id = uuidv7();
  await db(env.DB).insert(clientesRecurrentes).values({
    id,
    barberoId,
    clienteId,
    servicio: texto(e.servicio) ?? 'Corte',
    servicioId: texto(e.servicioId) ?? null,
    frecuenciaDias: typeof e.frecuenciaDias === 'number' ? e.frecuenciaDias : 14,
    horaPreferida: texto(e.horaPreferida) ?? null,
    // Sin ancla explicita, hoy: la cadencia arranca desde el alta.
    fechaAncla: texto(e.fechaAncla) ?? todayArgentina(),
    precioEspecialCentavos:
      typeof e.precioEspecialCentavos === 'number' ? e.precioEspecialCentavos : null,
    notas: texto(e.notas) ?? null,
    activo: e.activo === false ? 0 : 1,
  });

  return { estado: 'exito', id };
}

export async function actualizarRecurrente(
  env: Env,
  id: string,
  e: EntradaRecurrente,
): Promise<string | null> {
  const error = validarEntrada(e);
  if (error) return error;

  const cambios: Record<string, unknown> = {};
  if (e.servicio !== undefined) cambios.servicio = texto(e.servicio) ?? 'Corte';
  if (e.servicioId !== undefined) cambios.servicioId = texto(e.servicioId) ?? null;
  if (typeof e.frecuenciaDias === 'number') cambios.frecuenciaDias = e.frecuenciaDias;
  if (e.horaPreferida !== undefined) cambios.horaPreferida = texto(e.horaPreferida) ?? null;
  if (e.fechaAncla !== undefined) cambios.fechaAncla = texto(e.fechaAncla) ?? null;
  if (e.precioEspecialCentavos !== undefined) {
    cambios.precioEspecialCentavos =
      typeof e.precioEspecialCentavos === 'number' ? e.precioEspecialCentavos : null;
  }
  if (e.notas !== undefined) cambios.notas = texto(e.notas) ?? null;
  if (typeof e.activo === 'boolean') cambios.activo = e.activo ? 1 : 0;

  if (Object.keys(cambios).length > 0) {
    await db(env.DB).update(clientesRecurrentes).set(cambios).where(eq(clientesRecurrentes.id, id));
  }
  return null;
}

export const borrarRecurrente = (env: Env, id: string) =>
  db(env.DB).delete(clientesRecurrentes).where(eq(clientesRecurrentes.id, id));

export const cambiarActivo = (env: Env, id: string, activo: boolean) =>
  db(env.DB)
    .update(clientesRecurrentes)
    .set({ activo: activo ? 1 : 0 })
    .where(eq(clientesRecurrentes.id, id));

// -------------------------------------- el warning NO bloqueante (3.2 → 5.2)

/**
 * ⏭️ EL CASO QUE LA TAREA 3.2 DEJO PENDIENTE.
 *
 * Borrar o desactivar un recurrente cuando quedan turnos futuros ya generados
 * **NO bloquea**: la operacion se hace igual y devuelve 200 con `warning`.
 *
 * ⚠️ Y esa es la diferencia con los otros cuatro casos de Bloquear+Avisar:
 * esos turnos son COMPROMISOS CON CLIENTES REALES. Borrar la regla de
 * recurrencia no deberia cancelarlos — el dueño decide qué hacer con ellos.
 * Bloquear la operacion lo obligaria a cancelar turnos de gente que no pidio
 * nada, solo para poder dar de baja una regla.
 */
export async function turnosFuturosDelRecurrente(
  env: Env,
  r: { clienteId: string; barberoId: string },
  ahora: Date = new Date(),
): Promise<TurnoEnConflicto[]> {
  return db(env.DB)
    .select({
      id: reservas.id,
      fecha: reservas.fecha,
      hora: reservas.hora,
      nombre: reservas.nombre,
      telefono: reservas.telefono,
      servicio: reservas.servicio,
      duracionMin: reservas.duracionMin,
    })
    .from(reservas)
    .where(
      and(
        eq(reservas.clienteId, r.clienteId),
        eq(reservas.barberoId, r.barberoId),
        gte(reservas.fecha, todayArgentina(ahora)),
        eq(reservas.estado, 'activa'),
        eq(reservas.tipo, 'turno'),
      ),
    )
    .orderBy(asc(reservas.fecha), asc(reservas.hora));
}

export interface AvisoTurnosFuturos {
  turnosFuturosCount: number;
  turnosFuturos: TurnoEnConflicto[];
}

/** El payload del 200-con-warning. `null` si no hay nada que avisar. */
export async function avisoDeTurnosFuturos(
  env: Env,
  r: { clienteId: string; barberoId: string },
  ahora: Date = new Date(),
): Promise<{ datos: AvisoTurnosFuturos; warning: string } | null> {
  const turnos = await turnosFuturosDelRecurrente(env, r, ahora);
  if (turnos.length === 0) return null;

  return {
    datos: { turnosFuturosCount: turnos.length, turnosFuturos: turnos },
    warning: mensajeRecurrenteConTurnos(turnos.length),
  };
}

// ------------------------------------------------------------ generacion

export type ResultadoGeneracion =
  | { estado: 'exito'; fecha: string; hora: string; reservaId: string }
  | { estado: 'noValido' }
  | { estado: 'sinHora' }
  | { estado: 'ocupado' }
  | { estado: 'noSeGenero'; error: string };

/**
 * Disponibilidad de una fecha para este recurrente, con la duracion del
 * servicio y su hora preferida.
 */
async function evaluadorDeFechas(
  env: Env,
  barberoId: string,
  hora: string,
  duracionMin: number,
): Promise<(fecha: string) => ReturnType<typeof evaluarSlot>> {
  const [bloques, overrides] = await Promise.all([
    db(env.DB)
      .select({
        dow: barberoHorarios.dow,
        inicio: barberoHorarios.horaInicio,
        fin: barberoHorarios.horaFin,
      })
      .from(barberoHorarios)
      .where(and(eq(barberoHorarios.barberoId, barberoId), eq(barberoHorarios.activo, 1))),
    db(env.DB)
      .select({ fecha: feriadosOverride.fecha, trabaja: feriadosOverride.trabaja })
      .from(feriadosOverride)
      .where(eq(feriadosOverride.barberoId, barberoId)),
  ]);

  // Todo en memoria: el calculo prueba hasta 5 fechas y una query por fecha
  // serian 5 viajes a D1 por cada recurrente, cada dia.
  return (fecha: string) => {
    const dow = diaDeLaSemana(fecha);
    const delDia = bloques.filter((b) => b.dow === dow).map((b) => ({ inicio: b.inicio, fin: b.fin }));
    const propios = overrides.filter((o) => o.fecha === fecha).map((o) => ({ trabaja: o.trabaja === 1 }));

    return evaluarSlot(delDia, combinarOverrides(propios), hora, duracionMin);
  };
}

/**
 * Genera el proximo turno de un recurrente.
 *
 * Con `fechaExplicita` NO corre el loop de 5 ciclos: se valida esa fecha y
 * nada mas. Es el boton "generar para tal dia" del panel, donde el operador ya
 * eligio y no quiere que el sistema le mueva la fecha.
 */
export async function generarTurno(
  env: Env,
  recurrenteId: string,
  opciones: { fechaExplicita?: string; ahora?: Date } = {},
): Promise<ResultadoGeneracion> {
  const ahora = opciones.ahora ?? new Date();
  const r = await buscarRecurrente(env, recurrenteId);

  if (!r || r.activo !== 1) return { estado: 'noValido' };
  if (!r.horaPreferida) return { estado: 'sinHora' };

  const duracionMin = await duracionDelServicio(env, r.servicioId);
  const evaluar = await evaluadorDeFechas(env, r.barberoId, r.horaPreferida, duracionMin);

  let fecha: string;

  if (opciones.fechaExplicita) {
    const disp = evaluar(opciones.fechaExplicita);
    if (disp !== 'abierto') {
      return {
        estado: 'noSeGenero',
        error: `No se generó: ${mensajeCliente(disp)} Mové la fecha/hora manualmente.`,
      };
    }
    fecha = opciones.fechaExplicita;
  } else {
    const config: RecurrenteConfig = {
      fechaAncla: r.fechaAncla,
      ultimoTurnoFecha: r.ultimoTurnoFecha,
      frecuenciaDias: r.frecuenciaDias,
      horaPreferida: r.horaPreferida,
    };

    const calculo = calcularProximaFecha(config, todayArgentina(ahora), evaluar);
    if ('error' in calculo) return { estado: 'noSeGenero', error: calculo.error };
    fecha = calculo.fecha;
  }

  // Pasa por el Durable Object: un recurrente compite por el slot igual que
  // cualquier reserva. El anti-doble-reserva no tiene excepciones.
  const agenda = env.BARBERO_AGENDA.get(env.BARBERO_AGENDA.idFromName(r.barberoId));

  const creada = await agenda.reservar({
    barberoId: r.barberoId,
    clienteId: r.clienteId,
    servicioId: r.servicioId,
    nombre: r.clienteNombre ?? 'Cliente',
    telefono: r.clienteTelefono ?? '',
    servicio: r.servicio,
    duracionMin,
    fecha,
    hora: r.horaPreferida,
    source: 'admin',
    // Marca de auditoria: distingue un turno generado de uno cargado a mano, y
    // es lo que hace idempotente al cron de la 5.3.
    turnoAutoIso: new Date(`${fecha}T00:00:00.000Z`).toISOString(),
  });

  if (creada.estado === 'overlap') return { estado: 'ocupado' };
  if (creada.estado !== 'exito') return { estado: 'noSeGenero', error: ERROR_SLOT_OCUPADO };

  await db(env.DB)
    .update(clientesRecurrentes)
    .set({ ultimoTurnoFecha: fecha })
    .where(eq(clientesRecurrentes.id, recurrenteId));

  return { estado: 'exito', fecha, hora: r.horaPreferida, reservaId: creada.reservaId };
}

/** Duracion del servicio, o el slot global si el recurrente no tiene uno. */
async function duracionDelServicio(env: Env, servicioId: string | null): Promise<number> {
  if (servicioId) {
    const filas = await db(env.DB)
      .select({ d: sql<number>`duracion_min` })
      .from(sql`servicios`)
      .where(sql`id = ${servicioId}`)
      .limit(1);
    if (filas[0]?.d) return filas[0].d;
  }

  const cfg = await db(env.DB)
    .select({ d: negocio.slotDuracionMin })
    .from(negocio)
    .where(eq(negocio.id, 1))
    .limit(1);

  return cfg[0]?.d ?? 30;
}

// ------------------------------------------- generacion automatica (5.3)

/**
 * El motor que el sistema viejo nunca tuvo: hoy un humano aprieta el boton
 * cliente por cliente.
 *
 * ⚠️ LA VENTANA SALE DE `negocio.dias_max_anticipacion`, NO DE UN 14 FIJO.
 *
 * El turno del recurrente se crea apenas entra en la ventana en que CUALQUIERA
 * podria reservar, y esa es toda la idea: asi el cliente recurrente tiene su
 * lugar asegurado, porque cuando el resto puede reservar el slot ya esta
 * ocupado. Con menos anticipacion, su horario de siempre queda libre unos dias
 * y lo puede tomar un ocasional — justo lo que se quiere evitar teniendo
 * recurrentes. Si el negocio cambia su ventana, esto la sigue.
 */
export async function ventanaDeAnticipacion(env: Env): Promise<number> {
  const filas = await db(env.DB)
    .select({ d: negocio.diasMaxAnticipacion })
    .from(negocio)
    .where(eq(negocio.id, 1))
    .limit(1);

  return filas[0]?.d ?? 14;
}

/**
 * ¿Ya existe el turno de este ciclo?
 *
 * ⚠️ LOS DOS CHEQUEOS, Y NO UNO. El cron corre TODOS LOS DIAS: sin
 * idempotencia le llena la agenda al barbero con un duplicado diario.
 *
 *   1. `ultimo_turno_fecha >= fecha` — barato, pero solo sabe lo que el propio
 *      motor registro; si alguien cargo el turno a mano, no se entera.
 *   2. una reserva activa con el mismo `turno_auto_iso` — mira la agenda real.
 *
 * El costo de hacer los dos es una query. El de saltear uno es un turno
 * duplicado que alguien tiene que cancelar a mano.
 */
export async function yaGenerado(
  env: Env,
  r: { id: string; clienteId: string; barberoId: string; ultimoTurnoFecha: string | null },
  fecha: string,
): Promise<boolean> {
  if (r.ultimoTurnoFecha && r.ultimoTurnoFecha >= fecha) return true;

  const marca = new Date(`${fecha}T00:00:00.000Z`).toISOString();
  const filas = await db(env.DB)
    .select({ id: reservas.id })
    .from(reservas)
    .where(
      and(
        eq(reservas.clienteId, r.clienteId),
        eq(reservas.barberoId, r.barberoId),
        eq(reservas.estado, 'activa'),
        eq(reservas.turnoAutoIso, marca),
      ),
    )
    .limit(1);

  return filas.length > 0;
}

export interface ResumenGeneracion {
  generados: number;
  salteados: number;
  fallidos: { recurrenteId: string; cliente: string | null; motivo: string }[];
}

/**
 * Corrida diaria. Genera los turnos de los recurrentes activos cuya proxima
 * fecha entra en la ventana.
 *
 * ⚠️ CADA RECURRENTE VA EN SU PROPIO TRY. Uno que falla no puede frenar a los
 * demas: con 40 clientes, un solo error dejaria sin turno a los 39 restantes.
 *
 * El resumen final es la herramienta de diagnostico del operador. Sin el, un
 * recurrente que dejo de generar pasa desapercibido durante semanas — el
 * turno simplemente no aparece y nadie sabe por qué.
 */
export async function generarRecurrentesDelDia(
  env: Env,
  ahora: Date = new Date(),
): Promise<ResumenGeneracion> {
  const resumen: ResumenGeneracion = { generados: 0, salteados: 0, fallidos: [] };

  const activos = await db(env.DB)
    .select({
      id: clientesRecurrentes.id,
      barberoId: clientesRecurrentes.barberoId,
      clienteId: clientesRecurrentes.clienteId,
      ultimoTurnoFecha: clientesRecurrentes.ultimoTurnoFecha,
      fechaAncla: clientesRecurrentes.fechaAncla,
      frecuenciaDias: clientesRecurrentes.frecuenciaDias,
      horaPreferida: clientesRecurrentes.horaPreferida,
      servicioId: clientesRecurrentes.servicioId,
      clienteNombre: clientes.nombre,
    })
    .from(clientesRecurrentes)
    .leftJoin(clientes, eq(clientesRecurrentes.clienteId, clientes.id))
    .where(eq(clientesRecurrentes.activo, 1));

  const hoy = todayArgentina(ahora);
  const limite = addDias(hoy, await ventanaDeAnticipacion(env));

  for (const r of activos) {
    try {
      if (!r.horaPreferida) {
        resumen.salteados++;
        continue;
      }

      const duracionMin = await duracionDelServicio(env, r.servicioId);
      const evaluar = await evaluadorDeFechas(env, r.barberoId, r.horaPreferida, duracionMin);

      const calculo = calcularProximaFecha(
        {
          fechaAncla: r.fechaAncla,
          ultimoTurnoFecha: r.ultimoTurnoFecha,
          frecuenciaDias: r.frecuenciaDias,
          horaPreferida: r.horaPreferida,
        },
        hoy,
        evaluar,
      );

      if ('error' in calculo) {
        resumen.fallidos.push({
          recurrenteId: r.id,
          cliente: r.clienteNombre,
          motivo: calculo.error,
        });
        continue;
      }

      // Todavia falta para su turno: se genera en una corrida futura.
      if (calculo.fecha > limite) {
        resumen.salteados++;
        continue;
      }

      if (await yaGenerado(env, r, calculo.fecha)) {
        resumen.salteados++;
        continue;
      }

      const generado = await generarTurno(env, r.id, {
        fechaExplicita: calculo.fecha,
        ahora,
      });

      if (generado.estado === 'exito') {
        resumen.generados++;
      } else {
        resumen.fallidos.push({
          recurrenteId: r.id,
          cliente: r.clienteNombre,
          motivo:
            generado.estado === 'ocupado'
              ? ERROR_SLOT_OCUPADO
              : generado.estado === 'noSeGenero'
                ? generado.error
                : generado.estado,
        });
      }
    } catch (e) {
      resumen.fallidos.push({
        recurrenteId: r.id,
        cliente: r.clienteNombre,
        motivo: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return resumen;
}
