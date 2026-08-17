# Fase 1 — Cimientos

> Requiere `00-CONTEXTO.md` cargado en la sesión.
> **Criterio de salida:** todos los casos de test de las tareas 1.3 a 1.6 pasan en verde.

Esta fase no produce nada visible. Produce **la base sobre la que se apoya todo el resto**, y es la fase donde un error se propaga a todo el sistema. Los algoritmos de acá salieron del código en producción y sus tests; los números y las fórmulas son contrato.

**No avances a la Fase 2 sin los tests verdes.**

---

## Tarea 1.1 — Setup del proyecto

Proyecto Cloudflare Workers con Wrangler, Hono y TypeScript en modo estricto.

**Qué tiene que quedar:**

- `wrangler.jsonc` con el binding de D1, el namespace de KV, la cola, los Durable Objects y los cron triggers declarados (aunque las implementaciones todavía no existan — dejá los bindings listos y comentados si hace falta).
- `tsconfig.json` en `strict: true`.
- Vitest configurado con `@cloudflare/vitest-pool-workers`, corriendo dentro del runtime real de Workers.
- La estructura de carpetas del contexto, con archivos vacíos o con un stub.
- Un endpoint `GET /health` que devuelva `{ ok: true }`.
- Scripts de npm: `dev`, `test`, `deploy`, y los de migraciones de D1.

**Criterios de aceptación:**

- [ ] `npm run dev` levanta el Worker y `GET /health` responde `{ ok: true }`
- [ ] `npm test` corre y pasa (aunque sea con un test trivial)
- [ ] `tsc --noEmit` no reporta errores

---

## Tarea 1.2 — Schema de base de datos

13 tablas en D1 con Drizzle, más las migraciones.

**Las tablas:** `barberos`, `servicios`, `servicios_barbero`, `barbero_horarios`, `feriados_override`, `clientes`, `reservas`, `clientes_recurrentes`, `admin_sessions`, `magic_link_tokens`, `negocio`, `promos`, `catalogo`.

El detalle completo de columnas está en la sección 3 de `docs/spec-barberia-cloudflare.md`. Lo que no puede fallar:

**Delete behaviors** (son decisiones deliberadas, no defaults):

| Relación | Comportamiento | Por qué |
|---|---|---|
| `reservas.barbero_id` → `barberos` | **SET NULL** | Preserva el historial si se borra un barbero |
| `reservas.cliente_id` → `clientes` | **SET NULL** | Idem |
| `reservas.servicio_id` → `servicios` | **SET NULL** | Idem |
| `clientes_recurrentes.cliente_id` → `clientes` | **RESTRICT** | No se borra un cliente con recurrentes activos |
| `clientes_recurrentes.barbero_id` → `barberos` | **CASCADE** | |
| `barbero_horarios.barbero_id` → `barberos` | **CASCADE** | |
| `feriados_override.barbero_id` → `barberos` | **CASCADE** | |
| `admin_sessions.barbero_id` → `barberos` | **CASCADE** | |
| `servicios_barbero.*` | **CASCADE** en ambas | |
| `magic_link_tokens.reserva_id` → `reservas` | **SET NULL** | |

**Índices:**

```sql
-- El anti-doble-reserva. Parcial sobre estado activo:
-- si no, una reserva cancelada bloquea el slot para siempre.
CREATE UNIQUE INDEX idx_reservas_slot
  ON reservas(barbero_id, fecha, hora)
  WHERE estado = 'activa';

CREATE INDEX idx_reservas_fecha ON reservas(fecha);
CREATE INDEX idx_reservas_telefono ON reservas(telefono);

-- El teléfono identifica al cliente. Sin este único, dos reservas simultáneas
-- con el mismo teléfono y barberos DISTINTOS crean dos clientes: son dos
-- Durable Objects que no se ven entre sí.
CREATE UNIQUE INDEX idx_clientes_telefono
  ON clientes(telefono) WHERE telefono IS NOT NULL;
CREATE UNIQUE INDEX idx_reservas_cancel_token
  ON reservas(cancel_token) WHERE cancel_token IS NOT NULL;

CREATE UNIQUE INDEX idx_barberos_slug ON barberos(slug);
CREATE UNIQUE INDEX idx_servicios_nombre ON servicios(nombre);
CREATE UNIQUE INDEX idx_servicios_barbero ON servicios_barbero(barbero_id, servicio_id);
CREATE UNIQUE INDEX idx_feriados ON feriados_override(barbero_id, fecha);
CREATE INDEX idx_barbero_horarios ON barbero_horarios(barbero_id, dow);  -- NO único
CREATE INDEX idx_sessions_expires ON admin_sessions(expires_at);
CREATE INDEX idx_magic_expires ON magic_link_tokens(expires_at);
```

**⚠️ Primer spike, hacelo antes que nada:** verificá que D1 acepte `CREATE UNIQUE INDEX ... WHERE`. SQLite lo soporta pero la doc de Cloudflare solo muestra ejemplos no únicos. Insertá un duplicado a propósito y **anotá el texto exacto del error** — hay que mapearlo al mensaje de overlap en la Fase 2.

**Detalles que importan:**

- `barbero_horarios` tiene índice **NO único** en `(barbero_id, dow)` a propósito: dos filas del mismo día son dos bloques (mañana y tarde), o sea horario cortado.
- `barbero_horarios.hora_inicio` y `hora_fin` son **enteros** (9, 20), no strings `"HH:mm"`.
- `dow`: **0 = domingo … 6 = sábado**, igual que `Date.getDay()`.
- `negocio` es una fila única con `id = 1`. Default de `timezone`: `'America/Argentina/Buenos_Aires'` (IANA — el sistema viejo guarda el nombre de Windows, no lo copies).
- `reservas` lleva **snapshots**: `nombre`, `telefono`, `servicio` y `duracion_min` se copian al crear. Si el cliente cambia su nombre, el turno viejo no muta.
- `reservas.estado` es `'activa' | 'cancelada'`, default `'activa'`.
- `reservas.tipo` es `'turno' | 'bloqueo'`, default `'turno'`.

**Criterios de aceptación:**

- [ ] Las migraciones corren limpias sobre una D1 vacía
- [ ] El índice único parcial se crea sin error (o está documentado que D1 no lo soporta y cuál es el plan B)
- [ ] Insertar dos reservas activas con el mismo `(barbero_id, fecha, hora)` falla
- [ ] Insertar una reserva activa donde ya hay una **cancelada** con el mismo slot **funciona**
- [ ] Un seed de datos de prueba carga un barbero owner, 3 servicios y horarios de lunes a sábado

---

## Tarea 1.3 — Lógica de slots (`domain/slots.ts`)

Tres funciones puras. **Los detalles son contraintuitivos a propósito; leelos completos antes de escribir.**

### `generateSlots(horaInicio, horaFin, slotDuracionMin = 30): string[]`

Genera las horas de inicio candidatas dentro de un bloque. `horaInicio` y `horaFin` son **horas enteras**.

```ts
export function generateSlots(horaInicio: number, horaFin: number, slotDuracionMin = 30): string[] {
  const slots: string[] = [];
  for (let h = horaInicio; h < horaFin; h++) {
    for (let m = 0; m < 60; m += slotDuracionMin) {
      slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return slots;
}
```

Tres cosas a no equivocar:

- **`horaFin` es exclusivo a nivel de hora.** `generateSlots(10, 12)` da `["10:00","10:30","11:00","11:30"]` — **no** incluye `12:00`.
- El minuto **se reinicia a 0 en cada hora**. Si `slotDuracionMin` no divide 60 (ej. 40), no hay acarreo entre horas. Es intencional.
- Si `horaFin <= horaInicio`, devuelve `[]`.

### `generateSlotsFromBlocks(bloques, slotDuracionMin = 30): string[]`

Ordena los bloques por `inicio` ascendente y concatena el resultado de `generateSlots` de cada uno.

🐛 **El original no deduplica.** Con `[(9,13),(12,15)]` emite `12:00` dos veces. **Deduplicá el resultado.**

### `checkOverlap(hora, durMin, existentes): { overlap, conflicto }`

Intersección de intervalos semiabiertos `[start, end)`.

```ts
export function checkOverlap(
  hora: string, durMin: number,
  existentes: { hora: string; duracionMin: number }[]
): { overlap: boolean; conflicto: string | null } {
  const toMin = (h: string) => {
    const [hh, mm] = h.split(':').map(Number);
    return hh * 60 + mm;
  };
  const newStart = toMin(hora);
  const newEnd = newStart + durMin;

  for (const r of existentes) {
    const rStart = toMin(r.hora);
    const rEnd = rStart + r.duracionMin;
    if (newStart < rEnd && newEnd > rStart) {
      return { overlap: true, conflicto: r.hora };
    }
  }
  return { overlap: false, conflicto: null };
}
```

**Los comparadores estrictos son deliberados: turnos contiguos NO solapan.** Un turno que termina 10:30 y otro que empieza 10:30 conviven. Con `<=`/`>=` rompés la agenda entera.

Devuelve el **primer** conflicto en orden de iteración, sin ordenar antes.

### `buildEventTimes(fecha, hora, duracionMin): { startIso, endIso }`

```ts
export function buildEventTimes(fecha: string, hora: string, duracionMin: number) {
  const [h, m] = hora.split(':').map(Number);
  const totalEnd = h * 60 + m + duracionMin;
  const off = '-03:00';  // Argentina, sin DST
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    startIso: `${fecha}T${pad(h)}:${pad(m)}:00${off}`,
    endIso: `${fecha}T${pad(Math.floor(totalEnd / 60))}:${pad(totalEnd % 60)}:00${off}`,
  };
}
```

🐛 **Si el turno cruza medianoche, el original genera `"25:30"` y no incrementa la fecha.** Con turnos de 30-60 min y cierre a las 20:00 nunca se dispara, pero manejalo o al menos validá y logueá.

### Casos de test obligatorios

`generateSlots`:

| Input | Output |
|---|---|
| `(10, 12)` | `["10:00","10:30","11:00","11:30"]` — exactamente 4 |
| `(12, 10)` | `[]` |

`generateSlotsFromBlocks`:

| Input | Output |
|---|---|
| `[(10,12)]` | `["10:00","10:30","11:00","11:30"]` |
| `[(9,11),(14,16)]` | `["09:00","09:30","10:00","10:30","14:00","14:30","15:00","15:30"]` — 8 elementos |
| `[]` | `[]` |
| `[(9,13),(12,15)]` | sin duplicados de `12:00`, `12:30` |

`checkOverlap`:

| hora | dur | existentes | overlap | conflicto |
|---|---|---|---|---|
| `10:00` | 30 | `[]` | `false` | `null` |
| `10:00` | 30 | `[(10:00, 30)]` | `true` | `10:00` |
| `10:30` | 30 | `[(10:00, 60)]` | `true` | `10:00` |
| `09:30` | 30 | `[(10:00, 30)]` | `false` | — contiguo antes |
| `10:30` | 30 | `[(10:00, 30)]` | `false` | — contiguo después |

`buildEventTimes`:

| Input | Output |
|---|---|
| `("2026-04-01", "10:30", 45)` | start `2026-04-01T10:30:00-03:00`, end `2026-04-01T11:15:00-03:00` |

**Criterios de aceptación:**

- [ ] Los 12 casos de las tablas pasan
- [ ] `domain/slots.ts` no importa nada de Cloudflare ni de la DB
- [ ] Los tests corren sin necesidad de una D1

---

## Tarea 1.4 — Lógica de horarios (`domain/schedule.ts`)

### `evaluarSlot(bloquesActivos, overrideTrabaja, hora, durMin): Disponibilidad`

```ts
export type Disponibilidad = 'abierto' | 'diaCerrado' | 'feriado' | 'fueraDeHorario';
```

**El orden de evaluación ES la regla de negocio. No lo reordenes.**

```ts
export function evaluarSlot(
  bloquesActivos: { inicio: number; fin: number }[],
  overrideTrabaja: boolean | null,
  hora: string,
  durMin: number
): Disponibilidad {
  // 1. El override negativo gana sobre TODO. Ni se miran los bloques.
  if (overrideTrabaja === false) return 'feriado';

  // 2. Sin bloques activos ese día de la semana → cerrado.
  if (bloquesActivos.length === 0) return 'diaCerrado';

  // 3. El turno COMPLETO tiene que caber dentro de algún bloque.
  const [hh, mm] = hora.split(':').map(Number);
  const start = hh * 60 + mm;
  const end = start + durMin;

  for (const { inicio, fin } of bloquesActivos) {
    if (start >= inicio * 60 && end <= fin * 60) return 'abierto';
  }

  return 'fueraDeHorario';
}
```

Las cuatro reglas que hay que entender:

1. **Un feriado (`trabaja = false`) cierra el día aunque haya horario configurado.** Se evalúa primero.
2. **Un override positivo (`trabaja = true`) NO abre un día sin horario configurado.** Solo evita que un `false` lo cierre. Si un barbero no tiene bloques el domingo y le pones un override `true` para un domingo puntual, sigue dando `diaCerrado` — el override es un booleano, no trae horas. Es contraintuitivo y es a propósito.
3. **El turno completo tiene que caber:** `start >= bloqueInicio && end <= bloqueFin`. Ambos límites **inclusivos** — un turno puede terminar exactamente a la hora de cierre.
4. **Un hueco entre bloques da `fueraDeHorario`**, no `diaCerrado`.

### `cumpleAnticipacion(slotMs, ahoraMs, minutos): boolean`

```ts
export const cumpleAnticipacion = (slotMs: number, ahoraMs: number, minutos: number) =>
  slotMs >= ahoraMs + minutos * 60_000;
```

Comparación **inclusiva**: un slot exactamente en el límite cumple.

### `mensajeCliente(estado): string`

Transcripción textual. **Son contrato de UX, no los reescribas:**

| Estado | Mensaje |
|---|---|
| `diaCerrado` | `La barbería no atiende ese día.` |
| `feriado` | `La barbería no atiende esa fecha (feriado o cierre).` |
| `fueraDeHorario` | `El horario elegido está fuera del horario de atención.` |
| otro | `Turno no disponible.` |

### `combinarOverrides(overrides): boolean | null`

Regla "cerrado gana" ante datos duplicados: AND lógico arrancando en `null`.

```ts
export function combinarOverrides(overrides: { trabaja: boolean }[]): boolean | null {
  let r: boolean | null = null;
  for (const o of overrides) r = (r ?? true) && o.trabaja;
  return r;
}
```

Con el UNIQUE `(barbero_id, fecha)` no debería pasar, pero la defensa es barata.

### Casos de test obligatorios

Bloques: mañana `[{inicio:9,fin:13}]`, cortado `[{inicio:9,fin:13},{inicio:16,fin:20}]`.

| bloques | override | hora | dur | esperado |
|---|---|---|---|---|
| mañana | `null` | `10:00` | 30 | `abierto` |
| `[]` | `null` | `10:00` | 30 | `diaCerrado` |
| mañana | `false` | `10:00` | 30 | `feriado` ← gana sobre el bloque |
| mañana | `true` | `10:00` | 30 | `abierto` |
| mañana | `null` | `12:30` | 30 | `abierto` ← termina 13:00, justo el límite |
| mañana | `null` | `12:45` | 30 | `fueraDeHorario` ← termina 13:15, se pasa |
| mañana | `null` | `13:00` | 30 | `fueraDeHorario` |
| mañana | `null` | `08:30` | 30 | `fueraDeHorario` |
| cortado | `null` | `14:00` | 30 | `fueraDeHorario` ← el hueco |
| cortado | `null` | `17:00` | 30 | `abierto` |
| `[]` | `true` | `10:00` | 30 | `diaCerrado` ← el override positivo no abre nada |

`cumpleAnticipacion` (ahora = `2026-06-07 10:00`):

| slot | minutos | esperado |
|---|---|---|
| +2 h | 30 | `true` |
| +10 min | 30 | `false` |
| +30 min | 30 | `true` ← límite exacto, inclusivo |
| −5 min | 0 | `false` |

**Criterios de aceptación:**

- [ ] Los 15 casos pasan
- [ ] Los 4 mensajes coinciden textualmente
- [ ] Cero I/O en el módulo

---

## Tarea 1.5 — Fechas y teléfonos (`domain/dates.ts`, `domain/phone.ts`)

### `dates.ts`

`todayArgentina()` y `timeNowArgentina()` según el contexto compartido. Más los helpers que necesites: `addDays(fecha, n)`, `parseFecha`, `formatFecha`, comparaciones.

**Formato único `"YYYY-MM-DD"`.** No implementes el parser flexible de tres formatos del sistema viejo.

Casos de test:

| Función | Input | Output |
|---|---|---|
| `addDays` | `("2026-08-12", 14)` | `"2026-08-26"` |
| `addDays` | `("2026-02-25", 5)` | `"2026-03-02"` — cruce de mes |
| `addDays` | `("2026-12-28", 5)` | `"2027-01-02"` — cruce de año |
| `addDays` | `("2028-02-27", 2)` | `"2028-02-29"` — año bisiesto |

### `phone.ts` — `normalizeTel(raw): string`

**Forma canónica: 10 dígitos = código de área + número.** Sin `+54`, sin el `9` internacional, sin el `0` nacional, sin el `15` de celular.

**Usá `libphonenumber-js` con región `'AR'`. No lo hagas a mano.** El código de área argentino tiene longitud variable (2 dígitos en Buenos Aires `11`, 3 en Rosario `341`, 4 en algunas zonas) y el `15` va **después** del área. Sin la metadata real es imposible saber dónde cortar.

Algoritmo:

1. Vacío o null → `""`.
2. Intentar `parsePhoneNumber(raw, 'AR')`. Si es válido, formatear a E.164 y recortar el prefijo internacional.
3. Si el parseo falla, fallback manual sobre solo los dígitos:
   - 13 dígitos que empiezan con `549` → sacar los primeros 3
   - 12 dígitos que empiezan con `54` → sacar los primeros 2
   - 11 dígitos que empiezan con `9` → sacar el primero
   - cualquier otro caso → devolver los dígitos tal cual

Casos de test obligatorios:

| Input | Output |
|---|---|
| `3416513207` | `3416513207` |
| `543416513207` | `3416513207` |
| `5493416513207` | `3416513207` |
| `93416513207` | `3416513207` |
| `341 651-3207` | `3416513207` |
| `+54 9 341 651-3207` | `3416513207` |
| `03416513207` | `3416513207` ← necesita libphonenumber |
| `0341 15 6513207` | `3416513207` ← necesita libphonenumber |
| `341 15 6513207` | `3416513207` ← necesita libphonenumber |
| `011 15 2345-6789` | `1123456789` ← área de 2 dígitos |
| `null` / `""` | `""` |

**Los cuatro marcados son los que el fallback manual NO resuelve** — y son exactamente los formatos que un argentino escribe naturalmente. Si esos cuatro no pasan, la librería no está bien configurada.

**Criterios de aceptación:**

- [ ] Los 4 casos de `addDays` pasan
- [ ] Los 11 casos de teléfono pasan, incluidos los cuatro con `0` y `15`
- [ ] Cero I/O

---

## Tarea 1.6 — Cálculo de recurrencia (`domain/recurrence.ts`)

Función pura que calcula la próxima fecha de un turno recurrente. **Recibe por parámetro una función para consultar disponibilidad** — así se mantiene pura y testeable con un mock.

```ts
export function calcularProximaFecha(
  rc: { fechaAncla: string | null; ultimoTurnoFecha: string | null;
        frecuenciaDias: number; horaPreferida: string },
  hoy: string,
  evaluarFecha: (fecha: string) => Disponibilidad,
  duracionMin: number
): { fecha: string } | { error: string } {
  if (!rc.fechaAncla) {
    return { error: 'No se pudo calcular la fecha. Configurá la fecha ancla en el cliente.' };
  }

  // La base es hoy, salvo que el último turno generado sea todavía futuro.
  let base = hoy;
  if (rc.ultimoTurnoFecha && rc.ultimoTurnoFecha > hoy) base = rc.ultimoTurnoFecha;

  // Avanzar desde el ancla en saltos de frecuenciaDias hasta pasar la base.
  let cursor = rc.fechaAncla;
  while (cursor <= base) cursor = addDays(cursor, rc.frecuenciaDias);

  // Probar hasta 5 ciclos buscando el primero con el día abierto.
  const intentadas: string[] = [];
  for (let i = 0; i < 5; i++) {
    const disp = evaluarFecha(cursor);
    intentadas.push(`${cursor}(${motivoCorto(disp)})`);
    if (disp === 'abierto') return { fecha: cursor };
    cursor = addDays(cursor, rc.frecuenciaDias);
  }

  return {
    error: `No se pudo calcular la fecha. 5 ciclos cerrados — hora ${rc.horaPreferida}: ${intentadas.join(', ')}`
  };
}
```

Los cuatro detalles que importan:

- **La base es `hoy`, salvo que `ultimoTurnoFecha` sea futuro**, en cuyo caso es ese. Evita generar dos turnos para el mismo ciclo.
- El cursor arranca en la **fecha ancla**, no en el último turno. Preserva la cadencia: si el ancla es un martes y la frecuencia 14, siempre cae martes.
- La condición del while es `cursor <= base` — el resultado queda **estrictamente después** de la base.
- Si los 5 ciclos fallan, el error **lista cada fecha intentada con su motivo**. Es lo que le permite al operador entender por qué falló.

**Casos de test obligatorios** (mockeando `evaluarFecha`):

| Escenario | Esperado |
|---|---|
| Ancla `2026-08-04`, frecuencia 14, hoy `2026-08-12`, todo abierto | `2026-08-18` |
| Ancla `2026-08-04`, frecuencia 14, hoy `2026-08-12`, `ultimoTurno = 2026-08-18` | `2026-09-01` |
| Ancla `2026-08-04`, frecuencia 14, hoy `2026-08-12`, primer candidato cerrado | `2026-09-01` |
| Los 5 ciclos cerrados | error listando las 5 fechas con motivo |
| Sin `fechaAncla` | error `No se pudo calcular la fecha. Configurá la fecha ancla en el cliente.` |
| `ultimoTurno` en el pasado | se ignora, la base es `hoy` |
| Ancla martes, frecuencia 14, avanza muchos ciclos | todas las fechas caen martes |

**Criterios de aceptación:**

- [ ] Los 7 escenarios pasan
- [ ] La función no toca la DB — recibe `evaluarFecha` por parámetro
- [ ] El mensaje de error de 5 ciclos incluye las fechas y sus motivos

---

## Cierre de la Fase 1

Antes de pasar a la Fase 2:

- [ ] `npm test` en verde, sin tests skipeados
- [ ] `tsc --noEmit` limpio
- [ ] Las migraciones corren sobre una D1 vacía
- [ ] El spike del índice único parcial está resuelto y documentado
- [ ] Nada en `domain/` importa Cloudflare, Drizzle ni la DB

**Si el spike del índice reveló que D1 no soporta índices únicos parciales, pará y avisá** — cambia el diseño del anti-doble-reserva de la Fase 2.
