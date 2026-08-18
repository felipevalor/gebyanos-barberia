import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { barberoHorarios, feriadosOverride, reservas } from '../db/schema';
import { crearReserva, type EntradaReserva, type ResultadoReserva } from './reserva';
import { buscarReserva, buscarServicio } from './agenda';
import { evaluarSlot, mensajeCliente, combinarOverrides } from '../domain/schedule';
import { esFechaValida, esHoraValida, diaDeLaSemana, todayArgentina } from '../domain/dates';
import { MENSAJE_OVERLAP } from '../do/BarberoAgenda';
import {
  sincronizarCancelacion,
  sincronizarReprogramacion,
  sinRomper,
} from './calendario-reservas';
import { avisarCambio } from './notificaciones';
import { NOTAS } from './whatsapp';
import type { Rol } from './auth';

/**
 * Escrituras del panel: cancelar, reprogramar, bloquear e importar.
 */

export const MAX_FILAS_IMPORT = 500;

export const ERROR_SOLO_OWNER_IMPORT = 'Solo los dueños pueden importar reservas.';
export const ERROR_SLOT_OCUPADO = 'Ya existe una reserva en ese horario.';
export const ERROR_RESERVA_NO_ENCONTRADA = 'Reserva no encontrada.';
export const ERROR_LOTE_DEMASIADO_GRANDE = `No se pueden importar más de ${MAX_FILAS_IMPORT} filas por vez.`;

/**
 * Permiso sobre una reserva puntual.
 *
 * Un `barbero` solo toca las suyas; el `owner` todas. Va aparte del scoping de
 * los listados porque acá el recurso ya existe y hay que compararlo, no
 * filtrar.
 */
export function puedeTocar(
  sesion: { barberoId: string; rol: Rol },
  reserva: { barberoId: string | null },
): boolean {
  return sesion.rol === 'owner' || reserva.barberoId === sesion.barberoId;
}

// ------------------------------------------------------------- cancelacion

export type ResultadoCancelacion =
  | { estado: 'exito' }
  | { estado: 'noEncontrada' }
  | { estado: 'prohibido' };

/**
 * El hook post-cancelacion, inyectable SOLO para poder probar la red.
 *
 * No es un punto de extension: es el seam que vuelve testeable la garantia de
 * que un hook que lanza no tira la cancelacion. Sin poder inyectar uno roto,
 * esa frontera no tiene test propio — `sincronizarCancelacion` atrapa todo lo
 * suyo, asi que nunca llega a ejercitarla.
 */
export type HookCancelacion = (env: Env, reservaId: string) => Promise<unknown>;

/**
 * SOFT DELETE. Nunca `DELETE` fisico.
 *
 * Marca `estado = 'cancelada'` y sella `cancelada_at`. La fila queda: es
 * historial, y ademas el indice unico parcial solo mira las activas, asi que
 * el slot se libera solo.
 */
export async function cancelarReserva(
  env: Env,
  sesion: { barberoId: string; rol: Rol },
  id: string,
  ahora: Date = new Date(),
  alCancelar: HookCancelacion = sincronizarCancelacion,
): Promise<ResultadoCancelacion> {
  const reserva = await buscarReserva(env, id);
  if (!reserva) return { estado: 'noEncontrada' };
  if (!puedeTocar(sesion, reserva)) return { estado: 'prohibido' };

  await db(env.DB)
    .update(reservas)
    .set({ estado: 'cancelada', canceladaAt: ahora.toISOString() })
    .where(eq(reservas.id, id));

  // Best-effort y DESPUES del commit: el turno ya esta cancelado en la base,
  // que es lo que le importa a la disponibilidad. Un evento que sobreviva en
  // el calendario es molesto; un 500 acá haria creer que no se cancelo.
  //
  // ⚠️ `sinRomper` es una SEGUNDA capa. Con el hook real es redundante —
  // `sincronizarCancelacion` atrapa todo lo suyo— y por eso una mutacion que
  // lo borrara sobrevivia: era un mutante EQUIVALENTE, no un test faltante.
  //
  // Deja de serlo el dia que aparezca un hook que no atrape, y esa es
  // exactamente la razon para no sacarlo: la garantia "nunca tires una reserva
  // por una integracion caida" no puede depender de que cada pieza futura se
  // acuerde de atrapar la suya.
  //
  // Por eso el hook es inyectable: con uno sintetico que lanza, la frontera
  // tiene su propio test y la mutacion rompe.
  await sinRomper('cancelacion', id, () => alCancelar(env, id));

  // El aviso se arma DESPUES: `avisarCambio` relee la reserva, y para el texto
  // del WhatsApp los datos del turno no cambiaron con la cancelacion.
  await sinRomper('aviso-cancelacion', id, () =>
    avisarCambio(env, id, 'cancelada', NOTAS.canceladaPanel),
  );

  return { estado: 'exito' };
}

// ---------------------------------------------------------- reprogramacion

export type ResultadoEdicion =
  | { estado: 'exito' }
  | { estado: 'noEncontrada' }
  | { estado: 'prohibido' }
  | { estado: 'overlap'; error: string }
  | { estado: 'datosInvalidos'; error: string };

/**
 * Mueve una reserva de fecha y hora.
 *
 * CONSERVA `id` y `cancel_token`. Es un UPDATE que pasa por el Durable Object,
 * no un cancelar-y-recrear: los magic links de la Fase 5 apuntan al id del
 * turno, asi que recrearlo dejaria al cliente con un link hacia un turno
 * cancelado justo despues de haber reprogramado bien.
 *
 * Valida lo mismo que un alta desde el panel — fecha real, no pasada, dentro
 * del horario de atencion — pero NO la anticipacion, igual que el alta.
 */
export async function reprogramarReserva(
  env: Env,
  sesion: { barberoId: string; rol: Rol },
  id: string,
  cambios: { fecha: string; hora: string; servicioId?: string },
  ahora: Date = new Date(),
): Promise<ResultadoEdicion> {
  if (!esFechaValida(cambios.fecha)) {
    return { estado: 'datosInvalidos', error: 'Formato de fecha inválido.' };
  }
  if (!esHoraValida(cambios.hora)) {
    return { estado: 'datosInvalidos', error: 'Formato de hora inválido. Usá HH:mm.' };
  }

  const reserva = await buscarReserva(env, id);
  if (!reserva) return { estado: 'noEncontrada' };
  if (!puedeTocar(sesion, reserva)) return { estado: 'prohibido' };
  if (reserva.estado !== 'activa') return { estado: 'noEncontrada' };

  const cliente = db(env.DB);
  const filas = await cliente
    .select({
      barberoId: reservas.barberoId,
      servicioId: reservas.servicioId,
      servicio: reservas.servicio,
      duracionMin: reservas.duracionMin,
    })
    .from(reservas)
    .where(eq(reservas.id, id))
    .limit(1);

  const actual = filas[0];
  if (!actual?.barberoId) return { estado: 'noEncontrada' };
  const barberoId = actual.barberoId;

  if (cambios.fecha < todayArgentina(ahora)) {
    return { estado: 'datosInvalidos', error: 'No se puede agendar un turno en el pasado.' };
  }

  // Si cambia de servicio, se recalcula duracion y nombre; si no, se conservan.
  let duracionMin = actual.duracionMin;
  let servicioNuevo: { id: string; nombre: string } | null = null;

  if (cambios.servicioId && cambios.servicioId !== actual.servicioId) {
    const servicio = await buscarServicio(env, cambios.servicioId);
    if (!servicio) {
      return { estado: 'datosInvalidos', error: 'Servicio inválido.' };
    }
    duracionMin = servicio.duracionMin;
    servicioNuevo = { id: cambios.servicioId, nombre: servicio.nombre };
  }

  // El horario de atencion sigue aplicando, con la duracion del servicio.
  const dow = diaDeLaSemana(cambios.fecha);
  const [bloques, overrides] = await Promise.all([
    cliente
      .select({ inicio: barberoHorarios.horaInicio, fin: barberoHorarios.horaFin })
      .from(barberoHorarios)
      .where(
        and(
          eq(barberoHorarios.barberoId, barberoId),
          eq(barberoHorarios.dow, dow),
          eq(barberoHorarios.activo, 1),
        ),
      ),
    cliente
      .select({ trabaja: feriadosOverride.trabaja })
      .from(feriadosOverride)
      .where(
        and(
          eq(feriadosOverride.barberoId, barberoId),
          eq(feriadosOverride.fecha, cambios.fecha),
        ),
      ),
  ]);

  const disponible = evaluarSlot(
    bloques,
    combinarOverrides(overrides.map((o) => ({ trabaja: o.trabaja === 1 }))),
    cambios.hora,
    duracionMin,
  );
  if (disponible !== 'abierto') {
    return { estado: 'datosInvalidos', error: mensajeCliente(disponible) };
  }

  const agenda = env.BARBERO_AGENDA.get(env.BARBERO_AGENDA.idFromName(barberoId));
  const r = await agenda.reprogramar({
    reservaId: id,
    barberoId,
    fecha: cambios.fecha,
    hora: cambios.hora,
    duracionMin,
    ...(servicioNuevo
      ? { servicioId: servicioNuevo.id, servicio: servicioNuevo.nombre }
      : {}),
  });

  switch (r.estado) {
    case 'exito':
      await sinRomper('reprogramacion', id, () => sincronizarReprogramacion(env, id));
      // Despues del UPDATE: `avisarCambio` relee, asi que el aviso lleva la
      // fecha y hora NUEVAS. Mandarlo antes avisaria del turno viejo.
      await sinRomper('aviso-reprogramacion', id, () =>
        avisarCambio(env, id, 'modificada', NOTAS.reagendadaPanel),
      );
      return { estado: 'exito' };
    case 'overlap':
      return { estado: 'overlap', error: MENSAJE_OVERLAP };
    case 'noEncontrada':
      return { estado: 'noEncontrada' };
    default:
      throw new Error(r.detalle);
  }
}

// ---------------------------------------------------------------- bloqueos

/**
 * Bloqueo administrativo: ocupa un slot sin ser el turno de nadie.
 *
 * 🐛 El sistema viejo lo marcaba con un string magico (`servicio = "Bloqueo
 * Administrativo"`, `nombre = "BLOQUEDAO"` con typo) y cada query de "turnos
 * reales" tenia que acordarse de excluirlo. Acá va la columna `tipo`.
 *
 * Pasa por el Durable Object igual que una reserva: un bloqueo y un turno
 * compiten por el mismo slot.
 */
export async function crearBloqueo(
  env: Env,
  barberoId: string,
  datos: { fecha: string; hora: string; motivo?: string; duracionMin?: number },
): Promise<{ estado: 'exito' } | { estado: 'ocupado' } | { estado: 'error'; detalle: string }> {
  const agenda = env.BARBERO_AGENDA.get(env.BARBERO_AGENDA.idFromName(barberoId));

  const resultado = await agenda.reservar({
    barberoId,
    fecha: datos.fecha,
    hora: datos.hora,
    duracionMin: datos.duracionMin ?? 30,
    nombre: '',
    telefono: '',
    servicio: datos.motivo?.trim() || 'Bloqueo',
    mensaje: datos.motivo?.trim() || null,
    source: 'admin',
    tipo: 'bloqueo',
  });

  if (resultado.estado === 'overlap') return { estado: 'ocupado' };
  if (resultado.estado === 'error') return { estado: 'error', detalle: resultado.detalle };
  return { estado: 'exito' };
}

// ------------------------------------------------------------------ import

export interface ErrorDeImport {
  fila: number;
  motivo: string;
}

export interface ResultadoImport {
  importadas: number;
  salteadas: number;
  errores: ErrorDeImport[];
}

/**
 * Import masivo. Solo `owner`.
 *
 * Cada fila pasa por el Durable Object igual que una reserva normal: las que
 * chocan se REPORTAN, no abortan el lote. Un "importé 340 de 500" sin decir
 * cuáles fallaron es inútil para el operador.
 *
 * No dispara Calendar ni WhatsApp — eso lo garantiza `modo: 'import'`.
 */
export async function importarReservas(
  env: Env,
  filas: unknown[],
  ahora: Date = new Date(),
): Promise<ResultadoImport> {
  const errores: ErrorDeImport[] = [];
  let importadas = 0;

  // Secuencial a proposito: en paralelo, dos filas del mismo lote que compiten
  // por el mismo slot darian un resultado que depende del orden de llegada.
  for (let i = 0; i < filas.length; i++) {
    const fila = filas[i];
    if (!fila || typeof fila !== 'object') {
      errores.push({ fila: i + 1, motivo: 'La fila no es un objeto.' });
      continue;
    }

    const resultado: ResultadoReserva = await crearReserva(env, fila as EntradaReserva, {
      ahora,
      modo: 'import',
    });

    if (resultado.estado === 'exito') {
      importadas += 1;
    } else {
      errores.push({
        fila: i + 1,
        motivo: resultado.estado === 'overlap' ? MENSAJE_OVERLAP : resultado.error,
      });
    }
  }

  return { importadas, salteadas: errores.length, errores };
}

/** Turnos de clientes de un barbero, sin bloqueos. Para los tests y la Fase 3. */
export async function contarTurnosDeClientes(env: Env, barberoId: string): Promise<number> {
  const filas = await db(env.DB)
    .select({ id: reservas.id })
    .from(reservas)
    .where(and(eq(reservas.barberoId, barberoId), eq(reservas.tipo, 'turno')));

  return filas.length;
}
