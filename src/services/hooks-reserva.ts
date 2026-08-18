import { sincronizarAlta } from './calendario-reservas';
import { encolarAviso, avisoDeReserva } from './notificaciones';
import { NOTAS } from './whatsapp';

/**
 * Hooks post-commit de una reserva. BEST-EFFORT.
 *
 * Cuando esto corre, la reserva YA esta confirmada en la base. Si Google
 * Calendar o WhatsApp fallan, se loguea y se sigue: nunca se tira una reserva
 * por una integracion caida (regla de oro 3).
 *
 * Google Calendar (4.1) y WhatsApp (4.2), en ese orden. El orden no importa
 * para la correccion —los dos son independientes— pero Calendar primero deja
 * el `calendar_event_id` guardado antes de que nada mas pueda fallar.
 */

export interface DatosReservaCreada {
  reservaId: string;
  barberoId: string;
  /** Calendario del barbero, si tiene uno configurado. */
  calendarId: string | null;
  fecha: string;
  hora: string;
  duracionMin: number;
  servicio: string;
  nombre: string;
  telefono: string;
  /** Solo los ultimos 4 digitos. Es lo unico que puede ir a un log. */
  telefonoEnmascarado: string;
  /** 'creada' por defecto; 'recurrente' cuando lo genera el cron (Fase 5). */
  tipo?: 'creada' | 'recurrente';
  /** La nota del aviso. Distingue una reserva web de una del panel. */
  nota?: string;
}

export interface HooksReserva {
  ejecutar(env: Env, datos: DatosReservaCreada): Promise<void>;
}

/** Corre `fn` y se traga cualquier error, dejandolo en el log. */
async function aPruebaDeFallos(
  nombre: string,
  datos: DatosReservaCreada,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(
      `hook ${nombre} fallo, la reserva sigue confirmada`,
      JSON.stringify({
        reservaId: datos.reservaId,
        telefono: datos.telefonoEnmascarado,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}

export const hooksPorDefecto: HooksReserva = {
  async ejecutar(env, datos) {
    await aPruebaDeFallos('google-calendar', datos, async () => {
      // El chequeo de `calendarId` tambien esta adentro de `sincronizarAlta`;
      // acá evita el viaje a la base cuando ya sabemos que no hay nada que
      // hacer, que es el caso de todo barbero sin calendario propio.
      if (!datos.calendarId) return;
      await sincronizarAlta(env, datos.reservaId);
    });

    await aPruebaDeFallos('whatsapp', datos, async () => {
      if (!env.NOTIFICACIONES) return;

      // ENCOLA Y VUELVE. El envio real lo hace el consumer: si CallMeBot esta
      // caido, el que espera no es el cliente que acaba de reservar.
      await encolarAviso(
        env,
        avisoDeReserva(
          {
            id: datos.reservaId,
            barberoId: datos.barberoId,
            nombre: datos.nombre,
            telefono: datos.telefono,
            servicio: datos.servicio,
            fecha: datos.fecha,
            hora: datos.hora,
          },
          datos.tipo ?? 'creada',
          datos.nota ?? NOTAS.web,
        ),
      );
    });
  },
};
