# Spike — ¿D1 acepta `CREATE UNIQUE INDEX ... WHERE`?

**Fase 1, tarea 1.2. Resultado: SÍ. El diseño anti-doble-reserva de la Fase 2 no cambia.**

Fecha: 2026-08-15 · wrangler 4.123.0 · workerd 1.20260811.1

## Qué se probó

```sql
CREATE UNIQUE INDEX idx_spike_slot
  ON spike_reservas(barbero_id, fecha, hora)
  WHERE estado = 'activa';
```

Sobre una tabla descartable (`spike_reservas`), en los tres entornos que importan:

| Entorno | Índice creado | Duplicado activo rechazado | Slot reusable tras cancelar |
|---|---|---|---|
| D1 local (miniflare) | ✅ | ✅ | ✅ |
| **D1 remoto (Cloudflare)** | ✅ | ✅ | ✅ |
| Binding `env.DB` desde el Worker | ✅ | ✅ | ✅ |

La parcialidad funciona: una reserva `cancelada` **no** bloquea el slot, que es exactamente por lo que el índice lleva el `WHERE`.

## Texto exacto del error

**Desde adentro del Worker** (`env.DB.prepare(...).run()` lanza), que es la forma que la Fase 2 tiene que atrapar y mapear al mensaje de overlap:

```
D1_ERROR: UNIQUE constraint failed: spike_reservas.barbero_id, spike_reservas.fecha, spike_reservas.hora: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)
```

Con la tabla real el nombre cambia a `reservas.barbero_id, reservas.fecha, reservas.hora`.

Variantes según dónde se lo mire:

| Origen | Texto |
|---|---|
| Worker (`env.DB`) | prefijo `D1_ERROR: ` + el mensaje de SQLite |
| `wrangler d1 execute --local` | el mensaje de SQLite, sin prefijo |
| `wrangler d1 execute --remote` | el mensaje de SQLite + ` [code: 7500]` |

### Cómo detectarlo en la Fase 2

El prefijo `D1_ERROR:` y el sufijo `[code: 7500]` son envoltorios de capa, no del motor. Lo estable es el núcleo:

```ts
const esColisionDeSlot = (e: unknown) =>
  e instanceof Error && e.message.includes('UNIQUE constraint failed');
```

Si hiciera falta distinguir de otros índices únicos de la tabla (`cancel_token`), chequear además que el mensaje mencione `reservas.hora`.

## Regresión

`test/spike-d1-indice-parcial.test.ts` deja el comportamiento y el texto del error fijados como test. Si Cloudflare cambia el formato, se pone rojo ahí y no en la lógica de reservas.

## Cómo reproducirlo

```bash
npm test -- --reporter=verbose            # los 3 casos, vía binding
./node_modules/.bin/wrangler d1 execute barberia --local  --file=./docs/spike-indice-unico-parcial.sql
./node_modules/.bin/wrangler d1 execute barberia --remote --file=./docs/spike-indice-unico-parcial.sql
```

La tabla `spike_reservas` ya fue borrada de la base remota.
