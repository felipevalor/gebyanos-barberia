-- Seed de datos de prueba: 1 barbero owner, 3 servicios, horarios lunes a sabado.
-- Idempotente: los IDs son fijos y usa INSERT OR REPLACE / OR IGNORE.
--
-- ⚠️ CREDENCIALES DE DESARROLLO. NO SEMBRAR ESTO EN PRODUCCION.
--
--     usuario:  gaby
--     password: gebyanos-dev-2026
--
-- El hash es PBKDF2-SHA256, 50.000 iteraciones, sal de 16 bytes. Es publico
-- porque esta en el repo: sirve para levantar el entorno local, no para
-- proteger nada. En produccion el owner se crea con una password propia.

-- Fila unica de configuracion global.
INSERT OR REPLACE INTO negocio (id, nombre_negocio, timezone) VALUES
  (1, 'Barbería Gebyanos', 'America/Argentina/Buenos_Aires');

INSERT OR REPLACE INTO barberos (id, slug, nombre, tel, activo, orden, rol, password_hash) VALUES
  ('01920000-0000-7000-8000-000000000001', 'gaby', 'Gaby', '3416513207', 1, 0, 'owner',
   'pbkdf2$50000$XBrvvidHIErtlOxua7QorA==$MvFVD38EF+H1BXd+MH/1UY5YfOVGWy4uxQFdDQl+UXM=');

INSERT OR REPLACE INTO servicios (id, nombre, duracion_min, precio_centavos, activo, orden, incluye) VALUES
  ('01920000-0000-7000-8000-000000000101', 'Corte',            30,  800000, 1, 0, 'Lavado y peinado'),
  ('01920000-0000-7000-8000-000000000102', 'Corte y barba',    60, 1200000, 1, 1, 'Corte, perfilado de barba y toalla caliente'),
  ('01920000-0000-7000-8000-000000000103', 'Barba',            30,  500000, 1, 2, 'Perfilado y toalla caliente');

-- El owner da los tres servicios.
INSERT OR REPLACE INTO servicios_barbero (id, barbero_id, servicio_id) VALUES
  ('01920000-0000-7000-8000-000000000201', '01920000-0000-7000-8000-000000000001', '01920000-0000-7000-8000-000000000101'),
  ('01920000-0000-7000-8000-000000000202', '01920000-0000-7000-8000-000000000001', '01920000-0000-7000-8000-000000000102'),
  ('01920000-0000-7000-8000-000000000203', '01920000-0000-7000-8000-000000000001', '01920000-0000-7000-8000-000000000103');

-- Horario cortado, lunes (dow 1) a sabado (dow 6): 09-13 y 16-20.
-- Dos filas por dow a proposito: el indice (barbero_id, dow) NO es unico.
INSERT OR REPLACE INTO barbero_horarios (id, barbero_id, dow, activo, hora_inicio, hora_fin) VALUES
  ('01920000-0000-7000-8000-000000000301', '01920000-0000-7000-8000-000000000001', 1, 1,  9, 13),
  ('01920000-0000-7000-8000-000000000302', '01920000-0000-7000-8000-000000000001', 1, 1, 16, 20),
  ('01920000-0000-7000-8000-000000000303', '01920000-0000-7000-8000-000000000001', 2, 1,  9, 13),
  ('01920000-0000-7000-8000-000000000304', '01920000-0000-7000-8000-000000000001', 2, 1, 16, 20),
  ('01920000-0000-7000-8000-000000000305', '01920000-0000-7000-8000-000000000001', 3, 1,  9, 13),
  ('01920000-0000-7000-8000-000000000306', '01920000-0000-7000-8000-000000000001', 3, 1, 16, 20),
  ('01920000-0000-7000-8000-000000000307', '01920000-0000-7000-8000-000000000001', 4, 1,  9, 13),
  ('01920000-0000-7000-8000-000000000308', '01920000-0000-7000-8000-000000000001', 4, 1, 16, 20),
  ('01920000-0000-7000-8000-000000000309', '01920000-0000-7000-8000-000000000001', 5, 1,  9, 13),
  ('01920000-0000-7000-8000-000000000310', '01920000-0000-7000-8000-000000000001', 5, 1, 16, 20),
  ('01920000-0000-7000-8000-000000000311', '01920000-0000-7000-8000-000000000001', 6, 1,  9, 13),
  ('01920000-0000-7000-8000-000000000312', '01920000-0000-7000-8000-000000000001', 6, 1, 16, 20);
