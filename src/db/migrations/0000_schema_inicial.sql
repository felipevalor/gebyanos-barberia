CREATE TABLE `admin_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`barbero_id` text NOT NULL,
	`role` text DEFAULT 'barbero' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`barbero_id`) REFERENCES `barberos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_expires` ON `admin_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `barbero_horarios` (
	`id` text PRIMARY KEY NOT NULL,
	`barbero_id` text NOT NULL,
	`dow` integer NOT NULL,
	`activo` integer DEFAULT 1 NOT NULL,
	`hora_inicio` integer DEFAULT 9 NOT NULL,
	`hora_fin` integer DEFAULT 20 NOT NULL,
	FOREIGN KEY (`barbero_id`) REFERENCES `barberos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_barbero_horarios` ON `barbero_horarios` (`barbero_id`,`dow`);--> statement-breakpoint
CREATE TABLE `barberos` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`nombre` text NOT NULL,
	`tel` text,
	`calendar_id` text,
	`callmebot_phone` text,
	`callmebot_apikey` text,
	`activo` integer DEFAULT 1 NOT NULL,
	`orden` integer DEFAULT 0 NOT NULL,
	`rol` text DEFAULT 'barbero' NOT NULL,
	`password_hash` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_barberos_slug` ON `barberos` (`slug`);--> statement-breakpoint
CREATE TABLE `catalogo` (
	`id` text PRIMARY KEY NOT NULL,
	`nombre` text NOT NULL,
	`incluye` text DEFAULT '' NOT NULL,
	`precio_centavos` integer,
	`activo` integer DEFAULT 1 NOT NULL,
	`orden` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `clientes` (
	`id` text PRIMARY KEY NOT NULL,
	`nombre` text NOT NULL,
	`telefono` text,
	`email` text,
	`notas` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `clientes_recurrentes` (
	`id` text PRIMARY KEY NOT NULL,
	`barbero_id` text NOT NULL,
	`cliente_id` text NOT NULL,
	`servicio` text NOT NULL,
	`servicio_id` text,
	`frecuencia_dias` integer DEFAULT 14 NOT NULL,
	`hora_preferida` text,
	`fecha_ancla` text,
	`ultimo_turno_fecha` text,
	`precio_especial_centavos` integer,
	`notas` text,
	`activo` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`barbero_id`) REFERENCES `barberos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cliente_id`) REFERENCES `clientes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`servicio_id`) REFERENCES `servicios`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `feriados_override` (
	`id` text PRIMARY KEY NOT NULL,
	`barbero_id` text NOT NULL,
	`fecha` text NOT NULL,
	`trabaja` integer DEFAULT 0 NOT NULL,
	`motivo` text,
	FOREIGN KEY (`barbero_id`) REFERENCES `barberos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_feriados` ON `feriados_override` (`barbero_id`,`fecha`);--> statement-breakpoint
CREATE TABLE `magic_link_tokens` (
	`jti` text PRIMARY KEY NOT NULL,
	`reserva_id` text,
	`purpose` text DEFAULT 'access' NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`reserva_id`) REFERENCES `reservas`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_magic_expires` ON `magic_link_tokens` (`expires_at`);--> statement-breakpoint
CREATE TABLE `negocio` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`nombre_negocio` text DEFAULT 'Barbería Gebyanos' NOT NULL,
	`timezone` text DEFAULT 'America/Argentina/Buenos_Aires' NOT NULL,
	`slot_duracion_min` integer DEFAULT 30 NOT NULL,
	`minutos_anticipacion_min` integer DEFAULT 30 NOT NULL,
	`dias_max_anticipacion` integer DEFAULT 14 NOT NULL,
	`logo_url` text,
	`color_primario` text,
	`color_secundario` text
);
--> statement-breakpoint
CREATE TABLE `promos` (
	`id` text PRIMARY KEY NOT NULL,
	`nombre` text NOT NULL,
	`precio_centavos` integer,
	`unidad` text,
	`nota` text,
	`badge` text,
	`activo` integer DEFAULT 1 NOT NULL,
	`orden` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reservas` (
	`id` text PRIMARY KEY NOT NULL,
	`barbero_id` text,
	`cliente_id` text,
	`servicio_id` text,
	`nombre` text NOT NULL,
	`telefono` text NOT NULL,
	`servicio` text NOT NULL,
	`duracion_min` integer DEFAULT 30 NOT NULL,
	`fecha` text NOT NULL,
	`hora` text NOT NULL,
	`estado` text DEFAULT 'activa' NOT NULL,
	`tipo` text DEFAULT 'turno' NOT NULL,
	`mensaje` text,
	`source` text DEFAULT 'web' NOT NULL,
	`calendar_event_id` text,
	`cancel_token` text,
	`turno_auto_iso` text,
	`cancelada_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`barbero_id`) REFERENCES `barberos`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`cliente_id`) REFERENCES `clientes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`servicio_id`) REFERENCES `servicios`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reservas_slot` ON `reservas` (`barbero_id`,`fecha`,`hora`) WHERE "reservas"."estado" = 'activa';--> statement-breakpoint
CREATE INDEX `idx_reservas_fecha` ON `reservas` (`fecha`);--> statement-breakpoint
CREATE INDEX `idx_reservas_telefono` ON `reservas` (`telefono`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reservas_cancel_token` ON `reservas` (`cancel_token`) WHERE "reservas"."cancel_token" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `servicios` (
	`id` text PRIMARY KEY NOT NULL,
	`nombre` text NOT NULL,
	`duracion_min` integer DEFAULT 30 NOT NULL,
	`precio_centavos` integer,
	`activo` integer DEFAULT 1 NOT NULL,
	`orden` integer DEFAULT 0 NOT NULL,
	`incluye` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_servicios_nombre` ON `servicios` (`nombre`);--> statement-breakpoint
CREATE TABLE `servicios_barbero` (
	`id` text PRIMARY KEY NOT NULL,
	`barbero_id` text NOT NULL,
	`servicio_id` text NOT NULL,
	`duracion_min_override` integer,
	`precio_centavos_override` integer,
	FOREIGN KEY (`barbero_id`) REFERENCES `barberos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`servicio_id`) REFERENCES `servicios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_servicios_barbero` ON `servicios_barbero` (`barbero_id`,`servicio_id`);