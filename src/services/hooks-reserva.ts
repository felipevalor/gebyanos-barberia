/**
 * Hooks post-commit de una reserva. BEST-EFFORT.
 *
 * Cuando esto corre, la reserva YA esta confirmada en la base. Si Google
 * Calendar o WhatsApp fallan, se loguea y se sigue: nunca se tira una reserva
 * por una integracion caida (regla de oro 3).
 *
 * Implementaciones reales: Fase 4. Acá quedan los seams y el manejo de error,
 * que es la parte que no puede estar mal.
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
      if (!datos.calendarId) return;
      // Fase 4, tarea 4.1.
    });

    await aPruebaDeFallos('whatsapp', datos, async () => {
      if (!env.NOTIFICACIONES) return;
      // Fase 4, tarea 4.2. El texto va a ser "Reserva confirmada vía Web."
    });
  },
};
