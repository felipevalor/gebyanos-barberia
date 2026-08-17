import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { uuidv7 } from './id';

/**
 * Schema de la barberia sobre D1 (SQLite). 13 tablas.
 *
 * Convenciones (00-CONTEXTO.md):
 *   - IDs        TEXT con UUID v7 generado en el Worker
 *   - Fechas     TEXT "YYYY-MM-DD"        (un solo formato, sin legacy d/M/yyyy)
 *   - Horas      TEXT "HH:mm"             (5 caracteres, con padding)
 *   - Timestamps TEXT ISO-8601 UTC
 *   - Precios    INTEGER en centavos      (nunca float)
 *   - Booleanos  INTEGER 0/1
 */

const id = () => text('id').primaryKey().$defaultFn(uuidv7);
const ahora = () => sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

// ---------------------------------------------------------------- barberos

export const barberos = sqliteTable(
  'barberos',
  {
    id: id(),
    slug: text('slug').notNull(),
    nombre: text('nombre').notNull(),
    tel: text('tel'),
    calendarId: text('calendar_id'),
    callmebotPhone: text('callmebot_phone'),
    /** Cifrada en reposo. Ver Fase 4, tarea 4.3. */
    callmebotApikey: text('callmebot_apikey'),
    activo: integer('activo').notNull().default(1),
    orden: integer('orden').notNull().default(0),
    /** 'barbero' | 'owner' */
    rol: text('rol').notNull().default('barbero'),
    /** PBKDF2, no BCrypt: 10 ms de CPU en el plan Free. Ver Fase 2, tarea 2.5. */
    passwordHash: text('password_hash'),
    createdAt: text('created_at').notNull().default(ahora()),
  },
  (t) => [uniqueIndex('idx_barberos_slug').on(t.slug)],
);

// --------------------------------------------------------------- servicios

export const servicios = sqliteTable(
  'servicios',
  {
    id: id(),
    nombre: text('nombre').notNull(),
    duracionMin: integer('duracion_min').notNull().default(30),
    precioCentavos: integer('precio_centavos'),
    activo: integer('activo').notNull().default(1),
    orden: integer('orden').notNull().default(0),
    incluye: text('incluye'),
    createdAt: text('created_at').notNull().default(ahora()),
  },
  (t) => [uniqueIndex('idx_servicios_nombre').on(t.nombre)],
);

/** Que servicios da cada barbero, con overrides opcionales de duracion y precio. */
export const serviciosBarbero = sqliteTable(
  'servicios_barbero',
  {
    id: id(),
    barberoId: text('barbero_id')
      .notNull()
      .references(() => barberos.id, { onDelete: 'cascade' }),
    servicioId: text('servicio_id')
      .notNull()
      .references(() => servicios.id, { onDelete: 'cascade' }),
    duracionMinOverride: integer('duracion_min_override'),
    precioCentavosOverride: integer('precio_centavos_override'),
  },
  (t) => [uniqueIndex('idx_servicios_barbero').on(t.barberoId, t.servicioId)],
);

// -------------------------------------------------------- barbero_horarios

/**
 * Bloques de atencion por dia de la semana.
 *
 * El indice es NO unico a proposito: dos filas del mismo `dow` son dos bloques
 * (manana y tarde), o sea horario cortado.
 *
 * `hora_inicio` y `hora_fin` son ENTEROS (9, 20), no strings "HH:mm".
 * `dow`: 0 = domingo ... 6 = sabado, igual que Date.getDay().
 */
export const barberoHorarios = sqliteTable(
  'barbero_horarios',
  {
    id: id(),
    barberoId: text('barbero_id')
      .notNull()
      .references(() => barberos.id, { onDelete: 'cascade' }),
    dow: integer('dow').notNull(),
    activo: integer('activo').notNull().default(1),
    horaInicio: integer('hora_inicio').notNull().default(9),
    horaFin: integer('hora_fin').notNull().default(20),
  },
  (t) => [index('idx_barbero_horarios').on(t.barberoId, t.dow)],
);

/**
 * Excepciones por fecha puntual.
 *
 * `trabaja = false` cierra el dia aunque haya horario configurado.
 * `trabaja = true` NO abre un dia sin horario: solo evita que un false lo
 * cierre. Ver `evaluarSlot` en domain/schedule.ts.
 */
export const feriadosOverride = sqliteTable(
  'feriados_override',
  {
    id: id(),
    barberoId: text('barbero_id')
      .notNull()
      .references(() => barberos.id, { onDelete: 'cascade' }),
    fecha: text('fecha').notNull(),
    trabaja: integer('trabaja').notNull().default(0),
    motivo: text('motivo'),
  },
  (t) => [uniqueIndex('idx_feriados').on(t.barberoId, t.fecha)],
);

// ---------------------------------------------------------------- clientes

export const clientes = sqliteTable(
  'clientes',
  {
    id: id(),
    nombre: text('nombre').notNull(),
    /** Normalizado a la forma canonica argentina. Identifica al cliente. */
    telefono: text('telefono'),
    email: text('email'),
    notas: text('notas'),
    createdAt: text('created_at').notNull().default(ahora()),
    updatedAt: text('updated_at').notNull().default(ahora()),
  },
  (t) => [
    /**
     * El telefono identifica al cliente, asi que es UNICO.
     *
     * Sin esto, dos reservas simultaneas con el mismo telefono y barberos
     * DISTINTOS crean dos clientes: el Durable Object serializa por barbero,
     * asi que son dos DOs que no se ven entre si. El indice es la unica
     * defensa posible, porque no hay un punto de serializacion comun.
     *
     * Parcial: varios clientes sin telefono conviven.
     */
    uniqueIndex('idx_clientes_telefono')
      .on(t.telefono)
      .where(sql`${t.telefono} IS NOT NULL`),
  ],
);

// ---------------------------------------------------------------- reservas

/**
 * Turnos y bloqueos administrativos.
 *
 * SNAPSHOTS: `nombre`, `telefono`, `servicio` y `duracion_min` se copian al
 * crear. Si el cliente cambia su nombre o el servicio cambia de duracion, el
 * turno viejo no muta.
 *
 * SOFT DELETE: nunca DELETE fisico. `estado = 'cancelada'` + `cancelada_at`.
 * Todas las queries de disponibilidad filtran `estado = 'activa'`.
 *
 * Las FKs son SET NULL para preservar el historial si se borra un barbero,
 * un cliente o un servicio.
 */
export const reservas = sqliteTable(
  'reservas',
  {
    id: id(),

    barberoId: text('barbero_id').references(() => barberos.id, { onDelete: 'set null' }),
    clienteId: text('cliente_id').references(() => clientes.id, { onDelete: 'set null' }),
    servicioId: text('servicio_id').references(() => servicios.id, { onDelete: 'set null' }),

    // Snapshots al momento de crear.
    nombre: text('nombre').notNull(),
    telefono: text('telefono').notNull(),
    servicio: text('servicio').notNull(),
    duracionMin: integer('duracion_min').notNull().default(30),

    fecha: text('fecha').notNull(),
    hora: text('hora').notNull(),

    /** 'activa' | 'cancelada' */
    estado: text('estado').notNull().default('activa'),
    /**
     * 'turno' | 'bloqueo'
     *
     * Columna explicita en vez del string magico del sistema viejo
     * (servicio = "Bloqueo Administrativo", nombre = "BLOQUEDAO").
     */
    tipo: text('tipo').notNull().default('turno'),

    mensaje: text('mensaje'),
    source: text('source').notNull().default('web'),
    calendarEventId: text('calendar_event_id'),
    cancelToken: text('cancel_token'),
    /** Marca de generacion automatica del recurrente. Ver Fase 5. */
    turnoAutoIso: text('turno_auto_iso'),

    canceladaAt: text('cancelada_at'),
    createdAt: text('created_at').notNull().default(ahora()),
  },
  (t) => [
    /**
     * EL anti-doble-reserva.
     *
     * Parcial sobre `estado = 'activa'`: si no, una reserva cancelada bloquea
     * el slot para siempre. Verificado contra D1 local y remoto — ver
     * docs/spike-indice-unico-parcial.md.
     */
    uniqueIndex('idx_reservas_slot')
      .on(t.barberoId, t.fecha, t.hora)
      .where(sql`${t.estado} = 'activa'`),

    index('idx_reservas_fecha').on(t.fecha),
    index('idx_reservas_telefono').on(t.telefono),

    uniqueIndex('idx_reservas_cancel_token')
      .on(t.cancelToken)
      .where(sql`${t.cancelToken} IS NOT NULL`),
  ],
);

// ----------------------------------------------------- clientes_recurrentes

/**
 * Clientes que vuelven cada N dias. El cron genera el proximo turno.
 *
 * `cliente_id` es RESTRICT: no se borra un cliente que tiene recurrentes.
 */
export const clientesRecurrentes = sqliteTable('clientes_recurrentes', {
  id: id(),
  barberoId: text('barbero_id')
    .notNull()
    .references(() => barberos.id, { onDelete: 'cascade' }),
  clienteId: text('cliente_id')
    .notNull()
    .references(() => clientes.id, { onDelete: 'restrict' }),

  servicio: text('servicio').notNull(),
  servicioId: text('servicio_id').references(() => servicios.id, { onDelete: 'set null' }),

  frecuenciaDias: integer('frecuencia_dias').notNull().default(14),
  horaPreferida: text('hora_preferida'),
  /** Fija la cadencia: el cursor avanza desde aca, no desde el ultimo turno. */
  fechaAncla: text('fecha_ancla'),
  ultimoTurnoFecha: text('ultimo_turno_fecha'),

  precioEspecialCentavos: integer('precio_especial_centavos'),
  notas: text('notas'),
  activo: integer('activo').notNull().default(1),
  createdAt: text('created_at').notNull().default(ahora()),
});

// --------------------------------------------------------- admin_sessions

export const adminSessions = sqliteTable(
  'admin_sessions',
  {
    id: id(),
    barberoId: text('barbero_id')
      .notNull()
      .references(() => barberos.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('barbero'),
    createdAt: text('created_at').notNull().default(ahora()),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [index('idx_sessions_expires').on(t.expiresAt)],
);

// ------------------------------------------------------ magic_link_tokens

/** Autogestion del cliente sin cuenta. La PK es el jti del token. */
export const magicLinkTokens = sqliteTable(
  'magic_link_tokens',
  {
    jti: text('jti').primaryKey().$defaultFn(uuidv7),
    reservaId: text('reserva_id').references(() => reservas.id, { onDelete: 'set null' }),
    purpose: text('purpose').notNull().default('access'),
    expiresAt: text('expires_at').notNull(),
    usedAt: text('used_at'),
    revokedAt: text('revoked_at'),
    createdAt: text('created_at').notNull().default(ahora()),
  },
  (t) => [index('idx_magic_expires').on(t.expiresAt)],
);

// ----------------------------------------------------------------- negocio

/**
 * Fila unica con id = 1.
 *
 * `timezone` guarda el nombre IANA. El sistema viejo guarda el de Windows
 * ("Argentina Standard Time"); no se copia.
 */
export const negocio = sqliteTable('negocio', {
  id: integer('id').primaryKey().default(1),
  nombreNegocio: text('nombre_negocio').notNull().default('Barbería Gebyanos'),
  timezone: text('timezone').notNull().default('America/Argentina/Buenos_Aires'),
  slotDuracionMin: integer('slot_duracion_min').notNull().default(30),
  minutosAnticipacionMin: integer('minutos_anticipacion_min').notNull().default(30),
  diasMaxAnticipacion: integer('dias_max_anticipacion').notNull().default(14),
  logoUrl: text('logo_url'),
  colorPrimario: text('color_primario'),
  colorSecundario: text('color_secundario'),
});

// ------------------------------------------------------------------ promos

export const promos = sqliteTable('promos', {
  id: id(),
  nombre: text('nombre').notNull(),
  precioCentavos: integer('precio_centavos'),
  unidad: text('unidad'),
  nota: text('nota'),
  badge: text('badge'),
  activo: integer('activo').notNull().default(1),
  orden: integer('orden').notNull().default(0),
  createdAt: text('created_at').notNull().default(ahora()),
});

// ---------------------------------------------------------------- catalogo

/** Vidriera publica: no es lo mismo que `servicios`, que es lo reservable. */
export const catalogo = sqliteTable('catalogo', {
  id: id(),
  nombre: text('nombre').notNull(),
  incluye: text('incluye').notNull().default(''),
  precioCentavos: integer('precio_centavos'),
  activo: integer('activo').notNull().default(1),
  orden: integer('orden').notNull().default(0),
});
