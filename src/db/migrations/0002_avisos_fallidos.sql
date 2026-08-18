CREATE TABLE `avisos_fallidos` (
	`id` text PRIMARY KEY NOT NULL,
	`reserva_id` text,
	`barbero_id` text,
	`tipo` text NOT NULL,
	`motivo` text NOT NULL,
	`intentos` integer DEFAULT 1 NOT NULL,
	`resumen` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`reserva_id`) REFERENCES `reservas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`barbero_id`) REFERENCES `barberos`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_avisos_fallidos_barbero` ON `avisos_fallidos` (`barbero_id`,`created_at`);