-- Spike Fase 1, tarea 1.2: verificar que D1 acepte CREATE UNIQUE INDEX ... WHERE
-- Se usa una tabla descartable para no tocar el schema real.

DROP TABLE IF EXISTS spike_reservas;

CREATE TABLE spike_reservas (
  id         TEXT PRIMARY KEY,
  barbero_id TEXT NOT NULL,
  fecha      TEXT NOT NULL,
  hora       TEXT NOT NULL,
  estado     TEXT NOT NULL DEFAULT 'activa'
);

-- El indice bajo prueba.
CREATE UNIQUE INDEX idx_spike_slot
  ON spike_reservas(barbero_id, fecha, hora)
  WHERE estado = 'activa';
