import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import {
  barberoHorarios,
  barberos,
  feriadosOverride,
  negocio,
  servicios,
  serviciosBarbero,
} from '../db/schema';
import { combinarOverrides, evaluarSlot, mensajeCliente, cumpleAnticipacion } from '../domain/schedule';
import {
  todayArgentina,
  timeNowArgentina,
  diaDeLaSemana,
  esFechaValida,
  esHoraValida,
  addDays,
  slotAMs,
} from '../domain/dates';
import { normalizeTel, esTelefonoArgentino, enmascararTel } from '../domain/phone';
import { MENSAJE_OVERLAP } from '../do/BarberoAgenda';
import { hooksPorDefecto, type HooksReserva } from './hooks-reserva';

/**
 * Creacion de reserva. El flujo mas critico del sistema.
 *
 * Las once validaciones de negocio corren EN ORDEN: si dos fallan a la vez, el
 * cliente tiene que ver la primera. Los mensajes son transcripcion textual del
 * sistema en produccion — el frontend y los tests dependen de ellos.
 *
 * El paso 11 (solapamiento) pasa por el Durable Object, que es lo unico que
 * garantiza que dos clientes no terminen con el mismo turno.
 */

export interface EntradaReserva {
  barberoId?: unknown;
  servicioId?: unknown;
  fecha?: unknown;
  hora?: unknown;
  clienteNombre?: unknown;
  clienteTelefono?: unknown;
  mensaje?: unknown;
}

export type ResultadoReserva =
  | { estado: 'exito'; cancelToken: string; mensaje: string }
  | { estado: 'datosInvalidos'; error: string }
  | { estado: 'noDisponible'; error: string }
  | { estado: 'overlap'; error: string };

export const MENSAJE_EXITO = 'Turno agendado exitosamente';

const MAX_NOMBRE = 100;
const MAX_TELEFONO = 20;
const MAX_MENSAJE = 500;

const SLOT_DURACION_DEFAULT = 30;
const ANTICIPACION_DEFAULT = 30;
const DIAS_MAX_DEFAULT = 14;

/** Nombre de servicio cuando el `servicioId` no existe. Paso 7: no rechaza. */
const SERVICIO_DESCONOCIDO = 'Servicio';

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const invalido = (error: string): ResultadoReserva => ({ estado: 'datosInvalidos', error });

/**
 * Validacion de forma. Devuelve el primer error, o los campos ya saneados.
 *
 * Es pura: no toca la base. Los limites de longitud existen para que una
 * request maliciosa no llene la tabla.
 */
export function validarForma(
  entrada: EntradaReserva,
): { ok: false; error: string } | { ok: true; datos: CamposReserva } {
  const barberoId = texto(entrada.barberoId);
  const servicioId = texto(entrada.servicioId);
  const fecha = texto(entrada.fecha);
  const hora = texto(entrada.hora);
  const clienteNombre = texto(entrada.clienteNombre);
  const clienteTelefono = texto(entrada.clienteTelefono);
  const mensaje = texto(entrada.mensaje);

  if (!barberoId) return { ok: false, error: 'barberoId es obligatorio.' };
  if (!servicioId) return { ok: false, error: 'servicioId es obligatorio.' };
  if (!fecha) return { ok: false, error: 'fecha es obligatoria.' };
  if (!/^\d{2}:\d{2}$/.test(hora)) {
    return { ok: false, error: 'Formato de hora inválido. Use HH:mm.' };
  }
  if (!clienteNombre) return { ok: false, error: 'clienteNombre es obligatorio.' };
  if (clienteNombre.length > MAX_NOMBRE) {
    return { ok: false, error: 'El nombre no puede superar los 100 caracteres.' };
  }
  if (!clienteTelefono) return { ok: false, error: 'clienteTelefono es obligatorio.' };
  if (clienteTelefono.length > MAX_TELEFONO) {
    return { ok: false, error: 'El teléfono no puede superar los 20 caracteres.' };
  }
  if (mensaje.length > MAX_MENSAJE) {
    return { ok: false, error: 'El mensaje no puede superar los 500 caracteres.' };
  }

  return {
    ok: true,
    datos: { barberoId, servicioId, fecha, hora, clienteNombre, clienteTelefono, mensaje },
  };
}

export interface CamposReserva {
  barberoId: string;
  servicioId: string;
  fecha: string;
  hora: string;
  clienteNombre: string;
  clienteTelefono: string;
  mensaje: string;
}

export interface OpcionesReserva {
  ahora?: Date;
  /** Inyectables para poder testear que un hook roto no tumba la reserva. */
  hooks?: HooksReserva;
}

export async function crearReserva(
  env: Env,
  entrada: EntradaReserva,
  opciones: OpcionesReserva = {},
): Promise<ResultadoReserva> {
  const ahora = opciones.ahora ?? new Date();
  const hooks = opciones.hooks ?? hooksPorDefecto;

  const forma = validarForma(entrada);
  if (!forma.ok) return invalido(forma.error);
  const datos = forma.datos;

  const cliente = db(env.DB);

  // Configuracion: hace falta para los pasos 3 y 9.
  const configFila = (
    await cliente
      .select({
        slotDuracionMin: negocio.slotDuracionMin,
        minutosAnticipacion: negocio.minutosAnticipacionMin,
        diasMaxAnticipacion: negocio.diasMaxAnticipacion,
      })
      .from(negocio)
      .where(eq(negocio.id, 1))
      .limit(1)
  )[0];

  const slotDuracionMin = configFila?.slotDuracionMin ?? SLOT_DURACION_DEFAULT;
  const minutosAnticipacion = configFila?.minutosAnticipacion ?? ANTICIPACION_DEFAULT;
  const diasMaxAnticipacion = configFila?.diasMaxAnticipacion ?? DIAS_MAX_DEFAULT;

  const hoy = todayArgentina(ahora);

  // 1. Fecha parseable.
  if (!esFechaValida(datos.fecha)) return invalido('Formato de fecha inválido.');

  // 2. No en el pasado.
  if (datos.fecha < hoy) return invalido('No se puede agendar un turno en el pasado.');

  // 3. Dentro de la ventana de anticipacion maxima.
  if (datos.fecha > addDays(hoy, diasMaxAnticipacion)) {
    return invalido(
      `Solo se puede reservar con hasta ${diasMaxAnticipacion} días de anticipación.`,
    );
  }

  // 4. Si es hoy, la hora no puede haber pasado. Es distinto del paso 9: acá
  //    se rechaza el pasado, allá el margen minimo.
  if (datos.fecha === hoy && datos.hora < timeNowArgentina(ahora)) {
    return invalido('No se puede agendar un turno en un horario que ya pasó.');
  }

  // 5. Normalizar el telefono.
  //
  //    ⚠️ `normalizeTel` sola NO garantiza la forma canonica: cuando
  //    libphonenumber no puede parsear, cae a un fallback que devuelve los
  //    digitos tal cual (normalizeTel("123") === "123"). El 400 sale de la
  //    validacion explicita.
  //
  //    El mensaje NO viene de la spec: es el unico string inventado de este
  //    endpoint. Ver docs/pendientes.md.
  if (!esTelefonoArgentino(datos.clienteTelefono)) {
    return invalido('Teléfono inválido. Ingresá un número argentino de 10 dígitos.');
  }
  const telefono = normalizeTel(datos.clienteTelefono);

  const dow = diaDeLaSemana(datos.fecha);

  const [barberoFila, servicioFila, bloques, overrides] = await Promise.all([
    cliente
      .select({ id: barberos.id, calendarId: barberos.calendarId })
      .from(barberos)
      .where(and(eq(barberos.id, datos.barberoId), eq(barberos.activo, 1)))
      .limit(1),
    cliente
      .select({
        nombre: servicios.nombre,
        duracion: servicios.duracionMin,
        override: serviciosBarbero.duracionMinOverride,
      })
      .from(servicios)
      .leftJoin(
        serviciosBarbero,
        and(
          eq(serviciosBarbero.servicioId, servicios.id),
          eq(serviciosBarbero.barberoId, datos.barberoId),
        ),
      )
      .where(eq(servicios.id, datos.servicioId))
      .limit(1),
    cliente
      .select({ inicio: barberoHorarios.horaInicio, fin: barberoHorarios.horaFin })
      .from(barberoHorarios)
      .where(
        and(
          eq(barberoHorarios.barberoId, datos.barberoId),
          eq(barberoHorarios.dow, dow),
          eq(barberoHorarios.activo, 1),
        ),
      ),
    cliente
      .select({ trabaja: feriadosOverride.trabaja })
      .from(feriadosOverride)
      .where(
        and(
          eq(feriadosOverride.barberoId, datos.barberoId),
          eq(feriadosOverride.fecha, datos.fecha),
        ),
      ),
  ]);

  // 6. Barbero existe y esta activo.
  const barbero = barberoFila[0];
  if (!barbero) return invalido('Barbero inválido.');

  // 7. Servicio: si no existe NO rechaza. Un servicio borrado no deberia
  //    impedir reservar.
  const servicio = servicioFila[0];
  const servicioNombre = servicio?.nombre ?? SERVICIO_DESCONOCIDO;
  const duracionMin = servicio?.override ?? servicio?.duracion ?? slotDuracionMin;

  // 8. La regla de oro: el backend valida disponibilidad aunque el frontend ya
  //    haya ocultado el slot. Con la duracion del SERVICIO, no la global.
  const overrideTrabaja = combinarOverrides(overrides.map((o) => ({ trabaja: o.trabaja === 1 })));
  const estado = evaluarSlot(bloques, overrideTrabaja, datos.hora, duracionMin);
  if (estado !== 'abierto') {
    return { estado: 'noDisponible', error: mensajeCliente(estado) };
  }

  // 9. Anticipacion minima.
  if (!cumpleAnticipacion(slotAMs(datos.fecha, datos.hora), ahora.getTime(), minutosAnticipacion)) {
    return invalido(`Debés reservar con al menos ${minutosAnticipacion} minutos de anticipación.`);
  }

  // 10. Hora parseable de verdad: el regex de forma deja pasar "99:99".
  //
  //     ⚠️ EN EL ORDEN DE LA SPEC ESTE PASO ES INALCANZABLE. Una hora que
  //     pasa el regex pero es imposible ("99:99", "24:00") cae siempre en el
  //     paso 8: `evaluarSlot` la evalua como fuera de todos los bloques y
  //     devuelve 'fueraDeHorario'. O sea que el cliente recibe "El horario
  //     elegido está fuera del horario de atención." en vez de "Formato de
  //     hora inválido.".
  //
  //     Se deja igual porque el criterio de aceptacion pide ESTE orden, y
  //     moverlo cambiaria un mensaje que es contrato. Para que el paso sirva,
  //     tendria que correr antes del 8. Consultado con el autor de la spec.
  if (!esHoraValida(datos.hora)) return invalido('Formato de hora inválido.');

  // 11. Sin solapamiento — via el Durable Object.
  const agenda = env.BARBERO_AGENDA.get(env.BARBERO_AGENDA.idFromName(datos.barberoId));
  const resultado = await agenda.reservar({
    barberoId: datos.barberoId,
    fecha: datos.fecha,
    hora: datos.hora,
    duracionMin,
    nombre: datos.clienteNombre,
    telefono,
    servicio: servicioNombre,
    servicioId: servicio ? datos.servicioId : null,
    mensaje: datos.mensaje || `${servicioNombre} el ${datos.fecha} a las ${datos.hora}`,
    source: 'web',
    tipo: 'turno',
    upsertCliente: { nombre: datos.clienteNombre, telefono },
  });

  if (resultado.estado === 'overlap') {
    return { estado: 'overlap', error: MENSAJE_OVERLAP };
  }
  if (resultado.estado === 'error') {
    throw new Error(resultado.detalle);
  }

  // Post-commit, best-effort. La reserva YA esta confirmada: si esto falla,
  // se loguea y se sigue. Nunca se tira una reserva por una integracion caida.
  //
  // El try/catch va ACA, en el llamador, y no solo adentro de los hooks: la
  // garantia no puede depender de que cada implementacion de hook se acuerde
  // de atrapar sus propios errores.
  try {
    await hooks.ejecutar(env, {
      reservaId: resultado.reservaId,
      barberoId: datos.barberoId,
      calendarId: barbero.calendarId,
      fecha: datos.fecha,
      hora: datos.hora,
      duracionMin,
      servicio: servicioNombre,
      nombre: datos.clienteNombre,
      telefono,
      telefonoEnmascarado: enmascararTel(telefono),
    });
  } catch (e) {
    console.error(
      'hooks post-reserva fallaron, la reserva sigue confirmada',
      JSON.stringify({
        reservaId: resultado.reservaId,
        telefono: enmascararTel(telefono),
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }

  return { estado: 'exito', cancelToken: resultado.cancelToken, mensaje: MENSAJE_EXITO };
}
