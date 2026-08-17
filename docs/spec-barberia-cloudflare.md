# Sistema de reservas para barbería — Spec para construir de cero en Cloudflare

**Proyecto:** Barbería Gebyanos v2
**Fecha:** 12 de agosto de 2026
**Qué es esto:** la especificación completa para construir el producto de nuevo, desde cero, sobre Cloudflare. No es un plan de migración.
**Para quién:** el equipo (o el agente) que va a escribir el código.

---

## 0. Cómo usar este documento

El sistema actual en .NET **no se migra: se usa como fuente de verdad de las reglas de negocio**. Está en producción, tiene 230+ tests pasando y cuatro meses de bugs ya cazados. Todo lo que dice esta spec sobre comportamiento salió de leer ese código, no de suposiciones.

Reglas de lectura:

- Los números, mensajes de error y templates transcritos son **contrato**. Están así porque alguien ya se comió el bug de tenerlos distintos.
- Donde el sistema actual tiene un bug conocido, lo marco con 🐛 y digo qué hacer. No los copies por accidente.
- La sección 4 (reglas de negocio) es la que importa. Si tenés que tirar algo por tiempo, tirá features, nunca precisión en esas reglas.
- Referencias al código viejo, en `barberiagebyanos.BE/`. Consultalo cuando esta spec no alcance.

### Alcance decidido

| Decisión | Valor |
|---|---|
| Producto | Completo de cero: backend y frontend nuevos |
| Contratos de API | Libres. No hay que respetar los del Angular actual |
| Tenancy | **Single-tenant.** Una barbería. Sin registro, sin tenants, sin dominio propio |
| Features día 1 | Núcleo de reservas + magic links + recurrentes + Google Calendar + WhatsApp |

**Lo que queda fuera y por qué:** todo el multi-tenant (`Tenancy/`, `TenantsController`, `TenantProvisioningService`, la Catalog DB, el registro público, la verificación de dominio por DNS). Era la parte más cara y el bloqueante principal en Cloudflare — los bindings de D1 son estáticos y no se puede conectar a una base creada en runtime sin redeploy. Sin multi-tenant ese problema desaparece por completo y D1 pasa a ser una opción cómoda.

---

## 1. Qué hace el producto

Una barbería con varios barberos necesita que sus clientes reserven turnos online sin llamar por teléfono, y que los barberos gestionen su agenda sin planilla.

**Tres usuarios:**

1. **El cliente** (anónimo, sin cuenta). Entra a la web, elige barbero y servicio, ve los horarios libres reales, reserva con nombre y teléfono. Después puede consultar, reprogramar o cancelar su turno con un link que le llega — sin registrarse nunca.
2. **El barbero** (rol `barbero`). Ve su agenda, carga turnos manuales, bloquea horarios, gestiona sus clientes recurrentes, configura sus horarios semanales y feriados.
3. **El dueño** (rol `owner`). Todo lo del barbero, más: gestión de barberos, servicios, promos, configuración global del negocio, import/export de clientes y stats de todos.

**Dos integraciones salientes:** cada turno se sincroniza al Google Calendar del barbero, y cada movimiento le llega por WhatsApp.

**El invariante que no se puede romper nunca:** dos clientes no pueden terminar con el mismo turno. Todo el diseño de la sección 4.4 existe para eso.

---

## 2. Stack propuesto

| Capa | Elección | Por qué |
|---|---|---|
| Runtime | **Cloudflare Workers** + TypeScript | El objetivo |
| Router | **Hono** | Estándar de facto en Workers, middleware similar a Express, tipado |
| Base de datos | **D1** (SQLite) | Single-tenant elimina el problema de bindings estáticos |
| Acceso a datos | **Drizzle ORM** | Tipado, migraciones versionadas, buen soporte de D1 |
| Serialización del slot | **Durable Object por barbero** | Resuelve el anti-doble-reserva. Ver 4.4 |
| Cola de WhatsApp | **Cloudflare Queues** | 10.000 ops/día en Free. Persistente y con reintentos |
| Jobs programados | **Cron Triggers** | 5 en Free. Alcanzan: limpieza de sesiones, recurrentes, caché de feriados |
| Caché de feriados | **Workers KV** con TTL 24 h | La API externa se consulta una vez por día |
| Secretos | **Wrangler secrets** | `MAGIC_LINK_SIGNING_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `CALLMEBOT_*` |
| Frontend | **Static Assets** en el mismo Worker | Mismo origen que la API — la cookie de sesión funciona sin CORS |
| Tests | **Vitest** + `@cloudflare/vitest-pool-workers` | Corre los tests dentro del runtime real de Workers |

### Costo

El **Free plan alcanza** para una barbería: 100.000 requests/día, 5M filas leídas y 100.000 escritas por día en D1, 10.000 ops/día de Queues, 5 Cron Triggers.

El único límite que puede molestar es **10 ms de CPU por request**, que choca con BCrypt (ver 4.7). Si se decide seguir con BCrypt, **Workers Paid ($5/mes)** sube el límite a 30 s. El login es de baja frecuencia, así que el gasto es marginal.

### Estructura de carpetas sugerida

```
src/
  index.ts              # entry: rutas Hono + export de DOs y handlers de cron/queue
  domain/               # lógica pura, sin I/O, 100% testeable en aislamiento
    slots.ts            # generateSlots, checkOverlap, buildEventTimes
    schedule.ts         # evaluarSlot, cumpleAnticipacion, mensajeCliente
    dates.ts            # helpers de fecha en TZ Argentina
    phone.ts            # normalizeTel
    recurrence.ts       # cálculo de próxima fecha por anclaje
  db/
    schema.ts           # schema Drizzle
    migrations/
  services/             # orquestación: leen/escriben DB
  routes/
    public.ts
    admin.ts
    mi-turno.ts
  do/
    BarberoAgenda.ts    # Durable Object: serializa reservas por barbero
    RateLimiter.ts      # Durable Object: rate limiting
  integrations/
    google-calendar.ts  # JWT firmado a mano + REST API v3
    callmebot.ts
    feriados.ts
  middleware/
    auth.ts
    rate-limit.ts
```

**La carpeta `domain/` es sagrada: cero I/O, cero imports de Workers.** Es lo que se testea a fondo y donde viven todas las reglas de la sección 4.

---

## 3. Modelo de datos

13 tablas, todas en una sola base D1. Las decisiones de tipos vienen de que SQLite no tiene `date`, `time`, `uuid` ni `decimal`.

### Convenciones globales

| Concepto | En SQLite/D1 | Nota |
|---|---|---|
| IDs | `TEXT` con **UUID v7** generado en el Worker | v7 es ordenable por tiempo, reemplaza a `newsequentialid()` |
| Fechas | `TEXT` `"YYYY-MM-DD"` | Ordenable lexicográficamente |
| Horas | `TEXT` `"HH:mm"` | Siempre 5 caracteres, con padding |
| Timestamps | `TEXT` ISO-8601 UTC | `new Date().toISOString()` |
| Precios | `INTEGER` en **centavos** | Nunca float — evita errores de precisión |
| Booleanos | `INTEGER` 0/1 | SQLite no tiene bool |

### Tablas

**`barberos`** — son también los usuarios del panel.

| Columna | Tipo | Notas |
|---|---|---|
| `id` | TEXT PK | UUID v7 |
| `slug` | TEXT NOT NULL | **UNIQUE.** Es el usuario de login |
| `nombre` | TEXT NOT NULL | |
| `tel` | TEXT | |
| `calendar_id` | TEXT | ID del Google Calendar. Si es null, no sincroniza |
| `callmebot_phone` | TEXT | |
| `callmebot_api_key` | TEXT | **Cifrada en reposo.** Ver 4.8 |
| `activo` | INTEGER NOT NULL DEFAULT 1 | |
| `orden` | INTEGER NOT NULL DEFAULT 0 | Orden de display |
| `rol` | TEXT NOT NULL DEFAULT 'barbero' | `'owner'` \| `'barbero'` |
| `password_hash` | TEXT | Nunca se serializa a JSON |
| `created_at` | TEXT NOT NULL | |

**`servicios`**

| Columna | Tipo | Notas |
|---|---|---|
| `id` | TEXT PK | |
| `nombre` | TEXT NOT NULL | **UNIQUE** |
| `duracion_min` | INTEGER NOT NULL DEFAULT 30 | |
| `precio_centavos` | INTEGER | |
| `incluye` | TEXT | Descripción larga |
| `activo` | INTEGER NOT NULL DEFAULT 1 | |
| `orden` | INTEGER NOT NULL DEFAULT 0 | |
| `created_at` | TEXT NOT NULL | |

**`servicios_barbero`** — pivot con overrides por barbero.

| Columna | Tipo | Notas |
|---|---|---|
| `id` | TEXT PK | |
| `barbero_id` | TEXT NOT NULL | FK → `barberos.id` **ON DELETE CASCADE** |
| `servicio_id` | TEXT NOT NULL | FK → `servicios.id` **ON DELETE CASCADE** |
| `duracion_min_override` | INTEGER | Si null, usa `servicios.duracion_min` |
| `precio_centavos_override` | INTEGER | Si null, usa `servicios.precio_centavos` |

UNIQUE `(barbero_id, servicio_id)`.

**`barbero_horarios`** — el horario semanal. Varias filas por día permiten horario cortado.

| Columna | Tipo | Notas |
|---|---|---|
| `id` | TEXT PK | |
| `barbero_id` | TEXT NOT NULL | FK → `barberos.id` **CASCADE** |
| `dow` | INTEGER NOT NULL | **0 = domingo … 6 = sábado** (igual que `Date.getDay()`) |
| `activo` | INTEGER NOT NULL DEFAULT 1 | |
| `hora_inicio` | INTEGER NOT NULL DEFAULT 9 | **Hora entera**, no "HH:mm" |
| `hora_fin` | INTEGER NOT NULL DEFAULT 20 | **Hora entera** |

Índice `(barbero_id, dow)` — **NO único**, a propósito: dos filas del mismo día son dos bloques (mañana y tarde).

**`feriados_override`** — excepciones por fecha puntual.

| Columna | Tipo | Notas |
|---|---|---|
| `id` | TEXT PK | |
| `barbero_id` | TEXT NOT NULL | FK → `barberos.id` **CASCADE** |
| `fecha` | TEXT NOT NULL | `"YYYY-MM-DD"` |
| `trabaja` | INTEGER NOT NULL DEFAULT 0 | 0 = cerrado ese día, 1 = abre |
| `motivo` | TEXT | |

UNIQUE `(barbero_id, fecha)`.

**`clientes`**

| Columna | Tipo | Notas |
|---|---|---|
| `id` | TEXT PK | |
| `nombre` | TEXT NOT NULL | |
| `telefono` | TEXT | **UNIQUE parcial** (`WHERE telefono IS NOT NULL`). Guardado **normalizado** (10 dígitos). El único es necesario: dos Durable Objects de barberos distintos no se ven entre sí y crearían dos clientes con el mismo teléfono |
| `email` | TEXT | |
| `notas` | TEXT | |
| `created_at`, `updated_at` | TEXT NOT NULL | |

**`reservas`** — la tabla central.

| Columna | Tipo | Notas |
|---|---|---|
| `id` | TEXT PK | |
| `barbero_id` | TEXT | FK → `barberos.id` **ON DELETE SET NULL** — preserva el historial |
| `cliente_id` | TEXT | FK → `clientes.id` **SET NULL** |
| `servicio_id` | TEXT | FK → `servicios.id` **SET NULL** |
| `nombre` | TEXT NOT NULL | Snapshot: si el cliente cambia el nombre, el turno viejo no muta |
| `telefono` | TEXT NOT NULL | Snapshot normalizado |
| `servicio` | TEXT NOT NULL | Snapshot del **nombre** del servicio |
| `fecha` | TEXT NOT NULL | `"YYYY-MM-DD"` |
| `hora` | TEXT NOT NULL | `"HH:mm"` |
| `duracion_min` | INTEGER NOT NULL DEFAULT 30 | Snapshot de la duración |
| `mensaje` | TEXT | Máx 500 |
| `calendar_event_id` | TEXT | Para poder borrar/reprogramar en Calendar |
| `cancel_token` | TEXT | UNIQUE. Legacy — el flujo nuevo usa magic links |
| `source` | TEXT NOT NULL DEFAULT 'web' | `'web'` \| `'admin'` \| `'import'` |
| `turno_auto_fecha` | TEXT | Fecha calculada por el anclaje, si vino de un recurrente |
| `estado` | TEXT NOT NULL DEFAULT 'activa' | 🆕 **`'activa'` \| `'cancelada'`.** Ver abajo |
| `cancelada_at` | TEXT | 🆕 |
| `created_at` | TEXT NOT NULL | |

Índices:

```sql
CREATE UNIQUE INDEX idx_reservas_slot
  ON reservas(barbero_id, fecha, hora)
  WHERE estado = 'activa';

CREATE INDEX idx_reservas_fecha ON reservas(fecha);
CREATE INDEX idx_reservas_telefono ON reservas(telefono);
CREATE UNIQUE INDEX idx_reservas_cancel_token
  ON reservas(cancel_token) WHERE cancel_token IS NOT NULL;
```

⚠️ **Verificar el índice único parcial en D1 antes de confiar en él.** SQLite soporta `CREATE UNIQUE INDEX ... WHERE`, pero la documentación de Cloudflare solo muestra ejemplos con `CREATE INDEX` no único. Es el primer spike de la sección 8.

🆕 **Soft delete.** El sistema actual hace `DELETE` físico de la reserva al cancelar: no hay historial, no se puede auditar, y contradice lo que promete su propio `CLAUDE.md`. Ya existe un design doc sin implementar (`docs/superpowers/specs/2026-06-07-soft-delete-reservas-design.md`). **Construilo bien desde el día 1** — es gratis ahora y caro después. Consecuencia: cada query de disponibilidad tiene que filtrar `estado = 'activa'`, y el índice único es parcial sobre esa condición (si no, una reserva cancelada bloquea el slot para siempre).

**`clientes_recurrentes`**

| Columna | Tipo | Notas |
|---|---|---|
| `id` | TEXT PK | |
| `barbero_id` | TEXT NOT NULL | FK → `barberos.id` **CASCADE** |
| `cliente_id` | TEXT NOT NULL | FK → `clientes.id` **ON DELETE RESTRICT** |
| `servicio` | TEXT NOT NULL | Snapshot |
| `servicio_id` | TEXT | FK → `servicios.id` **SET NULL** |
| `frecuencia_dias` | INTEGER NOT NULL DEFAULT 14 | |
| `hora_preferida` | TEXT | `"HH:mm"`. Obligatoria para generar |
| `fecha_ancla` | TEXT | `"YYYY-MM-DD"`. Base del cálculo |
| `ultimo_turno_fecha` | TEXT | Se actualiza en cada generación |
| `precio_centavos_especial` | INTEGER | |
| `notas` | TEXT | |
| `activo` | INTEGER NOT NULL DEFAULT 1 | |
| `created_at` | TEXT NOT NULL | |

**`admin_sessions`**

| Columna | Tipo | Notas |
|---|---|---|
| `id` | TEXT PK | **Es el token de sesión.** Generado con CSPRNG, no autoincremental |
| `barbero_id` | TEXT NOT NULL | FK → `barberos.id` **CASCADE** |
| `role` | TEXT NOT NULL | Copia del rol al momento del login |
| `created_at` | TEXT NOT NULL | |
| `expires_at` | TEXT NOT NULL | Índice — el cron de limpieza barre por acá |

**`magic_link_tokens`**

| Columna | Tipo | Notas |
|---|---|---|
| `jti` | TEXT PK | UUID emitido por la app |
| `reserva_id` | TEXT | FK → `reservas.id` **SET NULL** |
| `purpose` | TEXT NOT NULL DEFAULT 'access' | |
| `expires_at` | TEXT NOT NULL | Índice |
| `used_at` | TEXT | Para los tokens single-use |
| `revoked_at` | TEXT | |
| `created_at` | TEXT NOT NULL | |

**`negocio`** — configuración global, fila única con `id = 1`.

| Columna | Tipo | Default |
|---|---|---|
| `id` | INTEGER PK | Siempre `1` |
| `nombre_negocio` | TEXT | `'Barbería Gebyanos'` |
| `timezone` | TEXT | `'America/Argentina/Buenos_Aires'` — **IANA.** El sistema viejo guarda `'Argentina Standard Time'` (nombre de Windows); no lo copies, en Workers no sirve |
| `slot_duracion_min` | INTEGER | `30` |
| `minutos_anticipacion_min` | INTEGER | `30` |
| `dias_max_anticipacion` | INTEGER | `14` |
| `logo_url` | TEXT | |
| `color_primario` | TEXT | |
| `color_secundario` | TEXT | |

**`promos`** y **`catalogo`** — solo display en la landing, sin lógica de negocio. `id`, `nombre`, `precio_centavos`, `activo`, `orden`, más `unidad`/`nota`/`badge` en promos e `incluye` en catálogo.

---

## 4. Reglas de negocio

**Esta es la sección crítica.** Todo lo de acá salió de leer el código en producción y sus tests. Los números son contrato.

### 4.1 Constantes

| Regla | Valor | Configurable |
|---|---|---|
| Duración de slot | **30 min** | `negocio.slot_duracion_min` |
| Anticipación mínima para reservar | **30 min** | `negocio.minutos_anticipacion_min` |
| Anticipación máxima | **14 días** | `negocio.dias_max_anticipacion` |
| TTL de magic link | **15 min** | Env var |
| Frecuencia default de recurrente | **14 días** | Por cliente |
| Ciclos de reintento del recurrente | **5** | No |
| Duración de sesión admin | **24 h** | No |
| Rate limit público | **10 req / 15 min por IP** | No |
| Ventana de rate limit | **15 min** | No |
| Timeout a CallMeBot | **10 s** | No |
| BCrypt cost factor | **12** | No |
| Zona horaria | **America/Argentina/Buenos_Aires** (UTC-3, sin DST) | `negocio.timezone` |

### 4.2 Manejo de fechas y horas

Todo el sistema opera en hora de Argentina. **"Hoy" y "ahora" nunca se leen del reloj UTC directo** — se convierten primero.

```ts
const TZ = 'America/Argentina/Buenos_Aires';

// "YYYY-MM-DD" de hoy en Argentina
function todayArgentina(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());  // en-CA da directamente YYYY-MM-DD
}

// "HH:mm" de ahora en Argentina
function timeNowArgentina(): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date());
}
```

Argentina no usa horario de verano desde 2009, así que el offset es fijo `-03:00`. Usar `Intl` de todas formas: es correcto sin costo extra y no se rompe si eso cambia.

**Formato canónico:** `"YYYY-MM-DD"` en todo el sistema, sin excepción. El sistema viejo arrastra un formato legacy `"d/M/yyyy"` en paralelo y un parser flexible de tres formatos. **No lo repliques** — empezás limpio, usá un solo formato.

### 4.3 Generación de slots

Dos funciones puras. Los detalles importan más de lo que parece.

**`generateSlots(horaInicio: number, horaFin: number, slotDuracionMin = 30): string[]`**

Genera las horas de inicio candidatas dentro de un bloque. `horaInicio` y `horaFin` son horas enteras.

```ts
function generateSlots(horaInicio: number, horaFin: number, slotDuracionMin = 30): string[] {
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
- El minuto **se reinicia a 0 en cada hora**. Si `slotDuracionMin` no divide 60 (ej. 40), no hay acarreo entre horas. Es intencional en el original.
- Si `horaFin <= horaInicio`, devuelve `[]`.

**`generateSlotsFromBlocks(bloques: {inicio, fin}[], slotDuracionMin = 30): string[]`**

Ordena los bloques por `inicio` ascendente y concatena el resultado de `generateSlots` de cada uno.

🐛 **El original no deduplica ni fusiona bloques solapados.** Con `[(9,13),(12,15)]` emite `12:00` dos veces. **Corregilo:** deduplicá el resultado. No hay razón para arrastrar esto.

**`checkOverlap(hora, durMin, existentes): {overlap, conflicto}`**

La fórmula de intersección de intervalos semiabiertos `[start, end)`:

```ts
function checkOverlap(
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

**Los comparadores estrictos (`<`, `>`) son deliberados: turnos contiguos NO solapan.** Un turno que termina 10:30 y otro que empieza 10:30 conviven. Si usás `<=`/`>=` rompés la agenda entera.

Casos de test obligatorios:

| hora | dur | existentes | overlap |
|---|---|---|---|
| `10:00` | 30 | `[]` | `false` |
| `10:00` | 30 | `[(10:00, 30)]` | `true`, conflicto `10:00` |
| `10:30` | 30 | `[(10:00, 60)]` | `true`, conflicto `10:00` |
| `09:30` | 30 | `[(10:00, 30)]` | `false` — contiguo antes |
| `10:30` | 30 | `[(10:00, 30)]` | `false` — contiguo después |

### 4.4 Disponibilidad: la máquina de estados

Cuatro estados posibles para un slot:

```ts
type Disponibilidad = 'abierto' | 'diaCerrado' | 'feriado' | 'fueraDeHorario';
```

**`evaluarSlot(bloquesActivos, overrideTrabaja, hora, durMin): Disponibilidad`**

El **orden de evaluación es la regla de negocio**. No lo reordenes:

```ts
function evaluarSlot(
  bloquesActivos: { inicio: number; fin: number }[],
  overrideTrabaja: boolean | null,
  hora: string,
  durMin: number
): Disponibilidad {
  // 1. El override negativo gana sobre TODO. Ni se miran los bloques.
  if (overrideTrabaja === false) return 'feriado';

  // 2. Sin bloques activos ese día de la semana → cerrado.
  if (bloquesActivos.length === 0) return 'diaCerrado';

  // 3. El turno completo tiene que caber dentro de algún bloque.
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

1. **Un feriado (`trabaja = false`) cierra el día aunque haya horario configurado.** Se evalúa primero, antes de mirar los bloques.
2. **Un override positivo (`trabaja = true`) NO abre un día sin horario configurado.** Solo evita que un `false` lo cierre. Si un barbero no tiene bloques el domingo y le pones un override `true` para un domingo puntual, sigue dando `diaCerrado` — porque el override es un booleano, no trae horas. Es contraintuitivo y es a propósito.
3. **El turno completo tiene que caber:** `start >= bloqueInicio && end <= bloqueFin`. Ambos límites inclusivos — un turno puede terminar exactamente a la hora de cierre.
4. **Un hueco entre bloques da `fueraDeHorario`**, no `diaCerrado`. Con horario cortado 9-13 y 16-20, las 14:00 están fuera de horario.

Casos de test obligatorios (bloques: mañana `[(9,13)]`, cortado `[(9,13),(16,20)]`):

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

**Regla "cerrado gana" ante duplicados.** Si por dato sucio hay varias filas de override para la misma fecha, se combinan con AND lógico arrancando en `null`:

```ts
let overrideTrabaja: boolean | null = null;
for (const o of overrides) {
  overrideTrabaja = (overrideTrabaja ?? true) && o.trabaja;
}
```

Con el UNIQUE `(barbero_id, fecha)` esto no debería pasar, pero la defensa es barata.

**`cumpleAnticipacion(slot, ahora, minutos): boolean`**

```ts
const cumpleAnticipacion = (slotMs: number, ahoraMs: number, minutos: number) =>
  slotMs >= ahoraMs + minutos * 60_000;
```

Comparación **inclusiva**: un slot exactamente en el límite cumple.

**Mensajes al cliente** (transcritos textuales, son contrato de UX):

| Estado | Mensaje |
|---|---|
| `diaCerrado` | `La barbería no atiende ese día.` |
| `feriado` | `La barbería no atiende esa fecha (feriado o cierre).` |
| `fueraDeHorario` | `El horario elegido está fuera del horario de atención.` |
| otro | `Turno no disponible.` |

### 4.5 Listar slots disponibles de una fecha

El algoritmo del endpoint público de horarios. Cuatro cortes tempranos y dos filtros.

1. Si `fecha < hoy` → `[]`.
2. `dow = getDay()` de la fecha. Traer bloques con `dow` coincidente y `activo = 1`.
3. Si no hay bloques → `[]`.
4. Traer overrides de esa fecha, combinar con AND. Si el resultado es `false` → `[]`.
5. Leer `negocio`: `minutosAnticipacion` (default 30) y `slotDuracion` (default 30).
6. Generar la grilla con `generateSlotsFromBlocks(bloques, slotDuracion)`.
7. Traer reservas **activas** de ese barbero y fecha.
8. Para cada slot candidato:
   - **Si `fecha === hoy`**, descartar si `slot < ahora + minutosAnticipacion`. Si la fecha es futura, no se aplica.
   - Descartar si `checkOverlap(slot, slotDuracion, reservas).overlap`.
9. Devolver los que sobrevivieron.

🐛 **Bug del original a NO copiar:** genera la grilla con 30 min hardcodeado, ignorando `negocio.slot_duracion_min`, pero después usa el valor configurado para el chequeo de solapamiento. Es inconsistente: si configurás slots de 45 min, la grilla igual sale cada 30. **Pasá `slotDuracion` en los dos lados** (paso 6 y paso 8).

🐛 **Segundo bug relacionado:** el original valida el solapamiento con `slotDuracion` global en vez de la duración real del servicio elegido. Con un servicio de 60 min, el chequeo usa 30 y puede ofrecer un slot que en realidad pisa el siguiente. **Usá la duración del servicio** cuando el cliente ya lo eligió — es el fix correcto y el sistema viejo lo tiene anotado como pendiente en `docs/EDGE_CASES.md`.

### 4.6 El flujo de reserva

`POST /api/reservas`. **El flujo más crítico del sistema.** Once pasos, en este orden exacto.

> Nota de nomenclatura: en el sistema viejo este endpoint es `POST /api/reserva` (singular) y el campo de fecha del body es `fechaIso`. Como los contratos son libres, acá propongo `reservas` y `fecha`. Los **mensajes de error** sí son transcripción textual del original y conviene conservarlos.

**Validación de forma** (antes de tocar la DB):

| Campo | Regla | Mensaje |
|---|---|---|
| `barberoId` | requerido | `barberoId es obligatorio.` |
| `servicioId` | requerido | `servicioId es obligatorio.` |
| `fecha` | requerido | `fecha es obligatoria.` (en el sistema viejo el campo se llama `fechaIso`) |
| `hora` | requerido, regex `^\d{2}:\d{2}$` | `Formato de hora inválido. Use HH:mm.` |
| `clienteNombre` | requerido, máx 100 | `clienteNombre es obligatorio.` / `El nombre no puede superar los 100 caracteres.` |
| `clienteTelefono` | requerido, máx 20 | `clienteTelefono es obligatorio.` / `El teléfono no puede superar los 20 caracteres.` |
| `mensaje` | máx 500 | `El mensaje no puede superar los 500 caracteres.` |

**Rate limit:** 10 por IP en 15 min. Si excede: `429` con `Demasiados intentos. Intentá más tarde.`

**Validaciones de negocio, en orden:**

| # | Chequeo | Mensaje de rechazo |
|---|---|---|
| 1 | Fecha parseable `YYYY-MM-DD` | `Formato de fecha inválido.` |
| 2 | `fecha >= hoy` | `No se puede agendar un turno en el pasado.` |
| 3 | `fecha <= hoy + diasMaxAnticipacion` | `Solo se puede reservar con hasta {N} días de anticipación.` |
| 4 | Si es hoy, la hora no pasó | `No se puede agendar un turno en un horario que ya pasó.` |
| 5 | Normalizar teléfono (4.9) | — |
| 6 | Barbero existe y está activo | `Barbero inválido.` |
| 7 | Servicio existe | Si no, usar nombre `"Servicio"` y duración default. **No rechaza** |
| 8 | `evaluarSlot() === 'abierto'` | El mensaje de la tabla de 4.4 |
| 9 | `cumpleAnticipacion()` | `Debés reservar con al menos {N} minutos de anticipación.` |
| 10 | Hora parseable `HH:mm` | `Formato de hora inválido.` |
| 11 | Sin solapamiento — **serializado** | `Lo sentimos, este turno acaba de ser reservado por alguien más.` |

**El paso 8 es la regla de oro: el backend valida disponibilidad aunque el frontend ya haya ocultado el slot.** Nunca confiar en el cliente.

**El paso 11 es el problema arquitectónico.** El sistema actual usa una transacción SQL con `IsolationLevel.RepeatableRead` más el índice único como red. **D1 no tiene transacciones interactivas ni niveles de aislamiento** — solo `db.batch()`, que es atómico pero no permite lógica JS entre statements. Y el flujo necesita justamente eso: leer las reservas, decidir en código, escribir.

**Solución: un Durable Object por barbero.**

⚠️ **Un DO no serializa solo cuando los datos viven en D1.** Las *input gates* protegen las operaciones de `ctx.storage`; D1 es una llamada externa y en cada `await` el event loop cede. La sección crítica va dentro de `blockConcurrencyWhile`.

```ts
export class BarberoAgenda extends DurableObject<Env> {
  async reservar(input: ReservaInput): Promise<ReservaResult> {
    let resultado: ReservaResult = { estado: 'error', detalle: 'sin resultado' };

    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        const existentes = await this.reservasActivas(input.barberoId, input.fecha);
        const { overlap, conflicto } = checkOverlap(
          input.hora, input.duracionMin, existentes
        );
        if (overlap) { resultado = { estado: 'overlap', conflicto }; return; }

        resultado = await this.insertarReserva(input);  // el UNIQUE queda de red
      } catch (e) {
        // Si la excepción escapa del callback, el DO se resetea.
        resultado = esColisionDeSlot(e)
          ? { estado: 'overlap', conflicto: input.hora }
          : { estado: 'error', detalle: String(e) };
      }
    });

    return resultado;
  }
}
```

Sin `blockConcurrencyWhile`, dos turnos que **se solapan parcialmente** (30 min a las 10:00 contra 60 min a las 09:30) entran los dos: no comparten `(fecha, hora)`, así que el índice único no los ve.

El DO se direcciona con `idFromName(barberoId)`. Todas las escrituras de reservas de un barbero pasan por su DO; las lecturas de solo consulta pueden ir directo a D1.

**Mantené el índice único parcial de todas formas.** Defensa en dos capas: si un bug de routing deja pasar una escritura sin el DO, el constraint la ataja. Mapeá el error de constraint de D1 al mismo mensaje de overlap.

**Estados de resultado:** `exito` | `overlap` | `datosInvalidos` | `noDisponible`. Los tres de error → `400`. Excepción no controlada → `500` con `Ocurrió un error al procesar la reserva. Por favor, reintenta.`

**Dentro de la operación serializada:** upsert del `cliente` por teléfono normalizado (crear o actualizar nombre), insertar la `reserva` con `source = 'web'`, `estado = 'activa'` y un `cancel_token` nuevo.

**Post-commit, best-effort — si fallan, la reserva YA está confirmada:**

- Si el barbero tiene `calendar_id`, crear el evento en Google Calendar. Si falla, log y seguir.
- Encolar la notificación de WhatsApp en Queues con el texto `Reserva confirmada vía Web.`

**Nunca hagas que un fallo de Calendar o WhatsApp tire la reserva.** El cliente ya tiene su turno.

**Respuesta OK:** `{ ok: true, data: { cancelToken, mensaje: "Turno agendado exitosamente" } }` — envuelto en `data` para respetar la convención `ApiResponse<T>` de la sección 5. (El sistema viejo los devuelve al nivel raíz.)

### 4.7 Autenticación del panel admin

**Login — `POST /admin/api/auth`**, body `{ usuario, password }`.

1. Normalizar `usuario`: `trim().toLowerCase()`.
2. Buscar en `barberos` por `slug = usuario AND activo = 1`. **Los barberos son los usuarios.**
3. Si no existe o no tiene hash → contar como fallo y devolver la respuesta genérica (anti-enumeración de usuarios).
4. Verificar la password (ver abajo).
5. Generar el token de sesión: **16 bytes de `crypto.getRandomValues`**, no un UUID predecible.
6. Insertar `admin_sessions` con `expires_at = now + 24h`.
7. Setear la cookie.

**La cookie, exactamente:**

```
Set-Cookie: admin_token={token}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires={expiresAt}
```

**El token NUNCA va en el body de la respuesta.** Body: `{ ok: true, user: { id, slug, nombre, rol } }`.

**El middleware de auth lee SOLO la cookie.** Ignorá deliberadamente el header `Authorization: Bearer`. Es la mitigación de XSS del diseño actual: si un script roba el token, no puede reenviarlo como header porque el backend no acepta esa vía, y la cookie es `HttpOnly` así que JS no la ve.

**Rate limit de login: 10 fallos por IP en 15 min, y solo se consume en los intentos fallidos** — un login correcto no gasta cupo. Excedido: `429 Demasiados intentos. Intentá más tarde.` Credenciales malas: `401 Usuario o contraseña incorrectos`.

**Hashing de passwords — decisión pendiente.** El sistema actual usa BCrypt con cost 12, más una migración transparente de hashes SHA-256 legacy (si el hash no empieza con `$2`, verifica SHA-256 y rehashea a BCrypt al vuelo).

Como arrancás de cero **no hay hashes legacy que soportar**, así que podés elegir libre:

| Opción | Pro | Contra |
|---|---|---|
| **PBKDF2 vía `crypto.subtle`** ⭐ | Nativo en Workers, sin dependencias, rápido. Entra en los 10 ms de CPU del Free plan | Menos resistente a GPU que BCrypt a igual costo |
| BCrypt (`bcryptjs`) con cost 12 | Paridad con el sistema actual | **No entra en 10 ms de CPU.** Obliga a Workers Paid |

Recomendación: **PBKDF2 con al menos 100.000 iteraciones y sal de 16 bytes.** Es lo que la plataforma te da nativo y elimina la dependencia del plan pago para un endpoint de login.

**Logout — `DELETE /admin/api/auth`:** leer el token directo de la cookie (no de los claims, por si la sesión ya expiró), borrar la fila de `admin_sessions`, borrar la cookie con las mismas opciones. Responder `{ ok: true }` siempre.

**Errores del middleware:** `401 { ok: false, error: "No autorizado" }` y `403 { ok: false, error: "Prohibido" }`.

**Limpieza:** un Cron Trigger horario que borra `admin_sessions` con `expires_at < now`.

### 4.8 Roles y scoping

Dos roles: `owner` y `barbero`.

| Recurso | `barbero` | `owner` |
|---|---|---|
| Agenda | Solo la propia | Todas, con filtro opcional por barbero |
| Reservas | Ver/crear/editar/borrar las propias | Todas |
| Import de reservas y clientes | ❌ | ✅ |
| Clientes | Solo los que tienen reserva con él | Todos |
| Recurrentes | Solo los propios | Todos |
| Horarios y feriados | Solo los propios | Los de cualquier barbero |
| Stats | Solo las propias | Globales |
| CallMeBot propio | ✅ | ✅ |
| Configuración del negocio | ❌ | ✅ |
| Alta/baja de barberos | ❌ | ✅ |
| Servicios, promos, catálogo | ❌ | ✅ |

🐛 **Bug del original:** los chequeos de "solo owner" devuelven `401` con `{ error: "Solo dueños" }` cuando corresponde `403` — el usuario está autenticado, lo que le falta es permiso. **Usá `403`.**

**Patrón de resolución del barbero objetivo:** si el caller es `owner` y viene `?barberoId=` en la query, operar sobre ese barbero; si no, sobre el propio. Un `barbero` nunca puede apuntar a otro.

### 4.9 Normalización de teléfonos

**Forma canónica: 10 dígitos = código de área + número.** Sin `+54`, sin el `9` internacional, sin el `0` nacional, sin el `15` de celular.

**Usá `libphonenumber-js` con región `'AR'`. No lo hagas a mano.** El código de área argentino tiene longitud variable (2 dígitos en Buenos Aires `11`, 3 en Rosario `341`, 4 en algunas zonas como `2954`) y el `15` de celular va **después** del área, no al principio. Sin la metadata real de códigos de área es imposible saber dónde cortar.

Algoritmo:

1. Si el input es vacío o null → `""`.
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

Los cuatro casos marcados son los que el fallback manual **no** resuelve. Son exactamente los formatos que un argentino escribe naturalmente.

### 4.10 Magic links: el cliente sin cuenta

Cómo un cliente consulta y modifica su turno sin registrarse.

**Formato del token:** `{base64url(payloadJson)}.{base64url(hmacSha256)}` — un JWT minimalista sin header, firmado con HMAC-SHA256 vía `crypto.subtle`.

**Payload:**

```json
{ "jti": "uuid", "rid": "uuid-de-la-reserva", "exp": 1234567890, "purpose": "access" }
```

`exp` en epoch **segundos**. TTL default 15 minutos.

**Validación, en este orden exacto:**

| # | Chequeo | Error |
|---|---|---|
| 1 | Token no vacío | `Token vacío` |
| 2 | Un solo `.`, ninguna mitad vacía | `Formato de token inválido` |
| 3 | **Firma HMAC en tiempo constante** | `Firma inválida` |
| 4 | Payload deserializable | `Payload inválido` |
| 5 | `exp` del payload vs. ahora | `Token expirado` |
| 6 | Existe la fila por `jti` | `Token no encontrado` |
| 7 | `revoked_at` es null | `Token revocado` |
| 8 | `expires_at` de la fila vs. ahora | `Token expirado` |
| 9 | Si es single-use, `used_at` es null | `Token ya utilizado` |
| 10 | Si es single-use, marcar `used_at` | — |

**El paso 3 va antes de tocar la base, a propósito.** Un token forjado nunca llega a hacer una query. Y la comparación tiene que ser en tiempo constante para no filtrar información por timing:

```ts
// crypto.subtle.verify ya es constant-time. Usalo en vez de comparar strings.
const valida = await crypto.subtle.verify('HMAC', key, firmaRecibida, payloadBytes);
```

**La fila en la base es la fuente de verdad final.** La firma solo prueba autoría; la revocación, la expiración real y el consumo viven en la tabla.

**Los cinco endpoints:**

| Endpoint | Rate limit | Single-use | Qué hace |
|---|---|---|---|
| `POST /api/mi-turno/buscar` | 10 | — | Busca turnos futuros por teléfono (+ nombre opcional) |
| `POST /api/mi-turno/access-link` | 20 | — | Emite el token. **Acá está el control de ownership** |
| `GET /api/mi-turno?token=` | 30 | ❌ multi-uso | Ver el turno |
| `PUT /api/mi-turno?token=` | 10 | ❌ multi-uso | Reprogramar |
| `POST /api/mi-turno/cancel?token=` | 10 | ✅ **single-use** | Cancelar |

**El control de ownership, que es todo el modelo de seguridad de este flujo:** en `access-link`, normalizar el teléfono recibido y compararlo con `reserva.telefono`. Si no coincide → `401 No autorizado.` No hay password ni otro secreto: **el teléfono ES la credencial**. Por eso los rate limits de acá son la única defensa contra enumeración, y por eso el TTL es corto.

**Al cancelar, revocá todos los tokens vivos de esa reserva** (`revoked_at = now`), no solo el usado. Si no, un link viejo en el historial del browser sigue sirviendo.

**Al reprogramar:** validar formato de fecha y hora, rechazar fechas pasadas (`No se puede agendar un turno en el pasado.`), rechazar editar un turno que ya pasó (`No se puede editar un turno pasado.`), chequear solapamiento excluyendo la propia reserva (`Ese horario ya está ocupado. Elegí otro.`), reprogramar el evento de Calendar y notificar por WhatsApp.

**Al cancelar:** rechazar si el turno ya pasó (`No se puede cancelar un turno pasado.`), borrar el evento de Calendar, revocar tokens, marcar `estado = 'cancelada'` y `cancelada_at` (soft delete, no `DELETE`), notificar por WhatsApp.

### 4.11 Turnos recurrentes

Un cliente que viene cada N días (default 14). El sistema calcula la próxima fecha desde una fecha ancla.

**Precondiciones:** el recurrente existe y está `activo`; el caller es el dueño o `owner` (si no, `403`); tiene `hora_preferida` seteada (si no, `Cliente no tiene hora preferida.`).

**El algoritmo de cálculo:**

```ts
function calcularProximaFecha(rc: ClienteRecurrente, hoy: string): CalculoResult {
  if (!rc.fechaAncla) {
    return { error: 'No se pudo calcular la fecha. Configurá la fecha ancla en el cliente.' };
  }

  // La base es hoy, salvo que el último turno generado sea todavía futuro.
  let base = hoy;
  if (rc.ultimoTurnoFecha && rc.ultimoTurnoFecha > hoy) {
    base = rc.ultimoTurnoFecha;
  }

  // Avanzar desde el ancla en saltos de frecuenciaDias hasta pasar la base.
  let cursor = rc.fechaAncla;
  while (cursor <= base) {
    cursor = addDays(cursor, rc.frecuenciaDias);
  }

  // Probar hasta 5 ciclos buscando el primero con el día abierto.
  const intentadas: string[] = [];
  for (let i = 0; i < 5; i++) {
    const disp = evaluarSlot(bloquesDe(cursor), overrideDe(cursor), rc.horaPreferida, duracion);
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
- El cursor arranca en la **fecha ancla**, no en el último turno. Preserva la cadencia original: si el ancla es un martes y la frecuencia 14, siempre cae martes.
- La condición del while es `cursor <= base` — el resultado queda **estrictamente después** de la base.
- Si los 5 ciclos están cerrados, el error **lista cada fecha intentada con su motivo**. Es lo que le permite al operador entender por qué falló en vez de ver "no se pudo".

**Si se pasa una fecha explícita**, se usa esa y solo se valida disponibilidad puntual — sin el loop. Si está cerrada: `No se generó: {motivo} Mové la fecha/hora manualmente.`

**Al crear:** pasar por el mismo Durable Object del barbero. Si hay solapamiento: `Slot Ocupado. Intente mover manualmente.` El turno queda con `source = 'admin'` y `turno_auto_fecha` = la fecha calculada (para auditoría). Actualizar `ultimo_turno_fecha`.

🆕 **El sistema actual no tiene generación automática: un humano tiene que apretar el botón para cada cliente.** Está listado como pendiente en `docs/EDGE_CASES.md`. En Cloudflare es un **Cron Trigger** y es una de las mejoras más baratas de todo el proyecto: correr diario, buscar recurrentes activos cuya próxima fecha entra en la ventana de anticipación, generar. Hacelo idempotente (chequear que no exista ya un turno para ese ciclo) y logueá lo que falló para revisión manual.

### 4.12 Bloqueos administrativos

Un barbero necesita tapar un horario sin que sea un turno de cliente (almuerzo, trámite, lo que sea).

**Mecanismo del sistema actual:** insertar una reserva falsa con `servicio = "Bloqueo Administrativo"`, `nombre = "BLOQUEDAO"` (sí, con el typo) y teléfono `0000000000`.

Funciona, pero es frágil: **todas** las queries que cuentan "turnos de clientes reales" tienen que acordarse de excluir ese string mágico. Si una se olvida, un bloqueo cuenta como turno de cliente.

🆕 **Hacelo bien:** agregá una columna `tipo` a `reservas` con valores `'turno'` | `'bloqueo'`. Es explícito, indexable y no depende de comparar strings. Las queries de disponibilidad cuentan los dos (el slot está ocupado igual); las de "turnos de clientes" filtran `tipo = 'turno'`.

### 4.13 Bloquear + Avisar: no dejar turnos huérfanos

Patrón que impide cambios de configuración que dejarían turnos existentes sin horario válido. **Todas devuelven `409` con la lista de turnos en conflicto**, para que el admin vea exactamente qué tiene que reagendar.

| Operación | Chequeo | Mensaje |
|---|---|---|
Cambiar el horario de un día | Turnos futuros de ese `dow` que no encajan en los bloques nuevos | `Hay {n} turno(s) que quedarían fuera del nuevo horario. Reagendalos o cancelalos antes de cambiar el horario.` |
| Editar un bloque puntual | Igual, recalculando con el bloque editado | Mismo mensaje |
| Cerrar una fecha (feriado) | Turnos en esa fecha | `Hay {n} turno(s) ese día. Reagendalos o cancelalos antes de marcarlo como cerrado.` |
| Desactivar un barbero | Turnos futuros del barbero | `No se puede desactivar: el barbero tiene {n} turno(s) futuro(s). Reagendalos o cancelalos antes de desactivarlo.` |
| Borrar un barbero | Turnos futuros **y** recurrentes asociados | `No se puede borrar: el barbero tiene {n} turno(s) futuro(s). Reasignalos o cancelalos antes de borrarlo.` + ` Además tiene clientes recurrentes asociados que se perderían.` |

**Payload del 409:**

```json
{
  "ok": false,
  "error": "Hay 3 turno(s) que quedarían fuera del nuevo horario...",
  "data": [
    { "id": "...", "fecha": "2026-08-20", "hora": "10:00",
      "nombre": "Juan", "telefono": "3416513207", "servicio": "Corte" }
  ]
}
```

**Todas estas queries filtran igual:** `fecha >= hoy AND estado = 'activa' AND tipo = 'turno'`. O sea: turno de cliente real, futuro, no cancelado, no bloqueo.

**Casos que avisan pero NO bloquean** (200 con warning): borrar o desactivar un recurrente que tiene turnos futuros ya generados. Se hace la operación y se devuelve `{ warning, turnosFuturos: [...] }` — los turnos ya generados son compromisos con clientes reales y no se cancelan solos.

### 4.14 Notificaciones de WhatsApp

Vía **CallMeBot** (`https://api.callmebot.com/whatsapp.php?phone={tel}&text={texto}&apikey={key}`, GET). Cada barbero tiene su propio teléfono y API key; hay un fallback global en config.

**Validación de teléfono:** regex `^\+?\d{7,15}$`. Si no pasa: `Número inválido. Usá formato internacional, ej: +5491122334455 (país 54 + 9 + área + número).`

**Template exacto del mensaje:**

```
{titulo}
  Nombre:   {nombre}
  Tel:      {telefono}
  Servicio: {servicio}
  Fecha:    {fecha} {hora}
  Nota:     {extra}        ← solo si hay extra
```

**El título se elige por el contenido del extra** (case-insensitive):

| Si el extra contiene | Título |
|---|---|
| `CANCELADO` | `❌ Turno cancelado:` |
| `reagendado` | `✏️ Turno modificado:` |
| cualquier otra cosa | `✅ Nueva reserva:` |

Los textos de extra que usa el sistema: `Reserva confirmada vía Web.`, `Turno cargado desde el panel admin.`, `TURNO CANCELADO por el cliente.`, `TURNO CANCELADO desde el panel admin.`, `Turno reagendado por el cliente.`, `Turno reagendado desde el panel admin.`, `Tu turno recurrente ha sido cargado.`

🐛 **Esa heurística de elegir el título por substring es fea y frágil.** Ya que empezás de cero, **pasá un tipo explícito** (`'creada' | 'cancelada' | 'modificada' | 'recurrente'`) y elegí el template por ahí. El resultado visible para el barbero es idéntico.

**Detección de errores — importante:** **CallMeBot devuelve HTTP 200 incluso cuando falla**, y describe el error en el body. Hay que parsear el texto buscando estas palabras (case-insensitive): `error`, `apikey`, `not allowed`, `not registered`, `invalid`, `no longer`, `you need to`, `wrong`, `fail`. Limpiar el HTML del detalle y truncar a 300 caracteres.

**Todo el envío es best-effort:** nunca propagues la excepción. Logueá y seguí. Y **enmascará el teléfono en los logs** (solo los últimos 4 dígitos).

**Arquitectura:** el endpoint encola en **Cloudflare Queues** y responde. Un consumer procesa. Ganás reintentos automáticos y persistencia — mejor que el `Channel` en memoria actual, que pierde los mensajes pendientes en cada deploy.

### 4.15 Google Calendar

**Es la integración más cara de escribir**, porque no hay SDK de .NET que te resuelva el OAuth.

Autenticación por **Service Account**: hay que armar un JWT firmado con RS256 usando la private key del JSON de credenciales, canjearlo por un access token en `https://oauth2.googleapis.com/token`, y usar ese token contra la Calendar API v3. Todo con `fetch` y `crypto.subtle`.

**Buena noticia: este código ya existió en este proyecto.** El stack original en Cloudflare tenía exactamente esto en `functions/admin/api/_gcal.js` (líneas 1-208 según `migration/PLAN_MIGRACION.md`). **Recuperalo del historial de git antes de escribirlo de nuevo.**

**Campos del evento:**

- `summary`: `"{nombreCliente} - {servicio}"`, o `"{nombreCliente} (R) - {servicio}"` si viene de un recurrente
- `description`: `"Tel: {telefono}"`, o `"Generado Auto. Tel: {tel}"` para recurrentes
- `start` y `end`: objetos con `dateTime` en ISO-8601 **con offset explícito** y `timeZone: "America/Argentina/Buenos_Aires"`

**Construcción de los timestamps:**

```ts
function buildEventTimes(fecha: string, hora: string, duracionMin: number) {
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

🐛 **Bug del original:** si `duracionMin` empuja el fin más allá de medianoche, genera una hora inválida tipo `"25:30"` y **no incrementa la fecha**. Con turnos de 30-60 min y cierre a las 20:00 nunca se dispara, pero es una bomba de tiempo. **Manejá el cruce de medianoche** o al menos validá y logueá.

Doble refuerzo del timezone (offset en el string **y** campo `timeZone`) es deliberado: garantiza que Google lo interprete bien sin importar su heurística.

**Operaciones:** crear evento (devuelve `eventId`, hay que guardarlo en `reservas.calendar_event_id`), borrar evento, listar eventos del día.

**Todo best-effort.** Si `calendar_id` es null o las credenciales no están configuradas, la integración se deshabilita silenciosamente y todo devuelve null/false. Nunca rompas una reserva por Calendar.

### 4.16 Feriados nacionales

Se consulta `https://api.argentinadatos.com/v1/feriados/{año}` — API pública argentina, sin auth.

El panel de feriados combina los feriados nacionales con los overrides propios del barbero. **Ojo con la semántica:** un feriado nacional **no cierra la barbería automáticamente** — es información para que el barbero decida. Lo que cierra es un `feriados_override` con `trabaja = 0`.

**Cacheá en Workers KV con TTL de 24 h.** El sistema actual cachea en memoria del proceso sin TTL (una llamada por año por instancia); en Workers no hay memoria persistente, así que KV es el reemplazo natural.

### 4.17 Cifrado de la API key de CallMeBot

La `callmebot_api_key` de cada barbero se guarda cifrada, no en claro. El sistema actual usa la Data Protection API de ASP.NET, que no existe en Workers.

**Reemplazo:** AES-GCM vía `crypto.subtle`, con la clave maestra en un secret de Wrangler.

```ts
async function encrypt(plaintext: string, masterKey: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, masterKey, new TextEncoder().encode(plaintext)
  );
  // Guardar iv + ciphertext juntos, con prefijo de versión para poder rotar.
  return `v1:${b64(iv)}:${b64(new Uint8Array(ct))}`;
}
```

El prefijo de versión permite rotar el esquema más adelante sin migrar todo de golpe.

---

## 5. Superficie de API

Contratos libres (frontend nuevo). Esta es una propuesta REST coherente; ajustala si querés.

**Convención de respuesta:** `{ ok: boolean, data?: T, error?: string }`.

### Públicos (sin auth)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/negocio` | Config pública: nombre, timezone, branding, duración de slot |
| GET | `/api/barberos` | Barberos activos, ordenados. Cacheable 300 s |
| GET | `/api/servicios` | Servicios activos con duración y precio. Cacheable 300 s |
| GET | `/api/promos` | Promos activas. Cacheable 300 s |
| GET | `/api/catalogo` | Catálogo de la landing. Cacheable 300 s |
| GET | `/api/disponibilidad?barberoId&fecha&servicioId` | **Slots libres de un día.** Ver 4.5 |
| GET | `/api/disponibilidad/mes?barberoId&año&mes&servicioId` | Qué días del mes tienen algo libre (para pintar el calendario) |
| POST | `/api/reservas` | **Crear reserva.** Ver 4.6. Rate limit 10 |
| POST | `/api/mi-turno/buscar` | Buscar turnos por teléfono. Rate limit 10 |
| POST | `/api/mi-turno/access-link` | Emitir magic link. Rate limit 20 |
| GET | `/api/mi-turno?token=` | Ver turno. Rate limit 30 |
| PUT | `/api/mi-turno?token=` | Reprogramar. Rate limit 10 |
| POST | `/api/mi-turno/cancel?token=` | Cancelar. Rate limit 10, single-use |

### Admin (cookie `admin_token`)

| Método | Ruta | Rol |
|---|---|---|
| POST | `/admin/api/auth` | — (login) |
| DELETE | `/admin/api/auth` | cualquiera |
| GET | `/admin/api/me` | cualquiera |
| GET | `/admin/api/agenda?desde&hasta&barberoId` | scoped |
| GET/POST | `/admin/api/reservas` | scoped |
| PUT/DELETE | `/admin/api/reservas/:id` | dueño u owner |
| POST | `/admin/api/reservas/importar` | **owner** |
| POST | `/admin/api/bloqueos` | scoped |
| GET | `/admin/api/clientes` | scoped |
| GET | `/admin/api/clientes/exportar` | scoped (CSV) |
| GET | `/admin/api/clientes/:id/historial` | scoped |
| POST | `/admin/api/clientes` | **owner** |
| POST | `/admin/api/clientes/importar` | **owner** |
| GET/POST | `/admin/api/recurrentes` | scoped |
| PUT/DELETE/PATCH | `/admin/api/recurrentes/:id` | dueño u owner |
| POST | `/admin/api/recurrentes/:id/generar` | dueño u owner |
| GET | `/admin/api/horarios?barberoId` | scoped |
| PUT | `/admin/api/horarios/dia/:dow` | scoped, **409** |
| PUT | `/admin/api/horarios/:id` | scoped, **409** |
| GET/POST | `/admin/api/feriados` | scoped, **409** al cerrar |
| DELETE | `/admin/api/feriados/:id` | dueño u owner |
| GET | `/admin/api/stats` | scoped |
| GET/PUT | `/admin/api/negocio` | GET cualquiera, **PUT owner** |
| GET/PUT/POST | `/admin/api/callmebot[/test]` | cualquiera (el propio) |
| GET/POST | `/admin/api/barberos` | **owner** |
| PUT/DELETE | `/admin/api/barberos/:id` | **owner**, **409** |
| GET/POST | `/admin/api/servicios` | **owner** |
| PUT/DELETE | `/admin/api/servicios/:id` | **owner** |
| GET/POST/PUT/DELETE | `/admin/api/promos[/:id]` | **owner** |
| GET/POST/PUT | `/admin/api/catalogo[/:id]` | **owner** |

### Cron Triggers

| Cron | Qué hace |
|---|---|
| `0 * * * *` | Borrar `admin_sessions` expiradas y `magic_link_tokens` vencidos |
| `0 9 * * *` | 🆕 Generar turnos recurrentes pendientes (ver 4.11) |
| `0 3 * * *` | Refrescar la caché KV de feriados nacionales |

---

## 6. Frontend

Angular 18 (paridad con el equipo actual), Svelte o React — a elección. Se sirve como **Static Assets del mismo Worker**, que resuelve dos cosas gratis: mismo origen (la cookie `admin_token` funciona sin CORS ni `SameSite=None`) y un solo deploy.

**Dos aplicaciones:**

**Pública** — landing con servicios y promos, flujo de reserva (barbero → servicio → calendario → slot → datos → confirmación), y "mi turno" (buscar por teléfono → recibir link → ver/reprogramar/cancelar).

**Panel admin** — login, dashboard con stats, agenda (vista día/semana), CRUD de reservas, clientes con historial e import/export, recurrentes, configuración de horarios y feriados, y las secciones de owner (barberos, servicios, promos, catálogo, negocio).

**Reglas de UI que importan:**

- **El frontend nunca es la única validación.** Oculta los slots ocupados por UX, pero el backend valida igual. Un cliente puede llegar con un slot que se ocupó hace 3 segundos: manejá el error de overlap con un mensaje claro y refrescá la grilla.
- Cuando el backend devuelve `409` con lista de conflictos, **mostrá la lista** — es el punto del patrón. Un "no se pudo" pelado hace que el admin no sepa qué reagendar.
- Los magic links tienen 15 minutos de vida. Si el token expiró, ofrecé pedir uno nuevo en vez de un error genérico.

---

## 7. Plan de construcción

Cinco fases. Cada una deja algo que funciona y se puede probar.

### Fase 1 — Cimientos

Proyecto Wrangler + Hono + TypeScript. Schema Drizzle completo con las migraciones D1. **Toda la carpeta `domain/` con sus tests**: slots, schedule, dates, phone, recurrence. Vitest con `@cloudflare/vitest-pool-workers`.

**Empezá por acá y no avances sin los tests verdes.** Es lógica pura, sin I/O, y todos los casos de prueba están en la sección 4. Es la fase más importante y la más fácil de hacer bien.

*Criterio de salida:* los casos de test de 4.3, 4.4, 4.9 y 4.11 pasan.

### Fase 2 — Reservas de punta a punta

Durable Object `BarberoAgenda`. Endpoints públicos de lectura (negocio, barberos, servicios, disponibilidad). `POST /api/reservas` con las once validaciones. Auth admin con cookie + PBKDF2. Rate limiting con DO. Agenda y CRUD de reservas del panel. Bloqueos.

*Criterio de salida:* un cliente reserva desde la API y el barbero lo ve en su agenda. **Test de concurrencia: N requests simultáneos al mismo slot, exactamente uno gana.**

### Fase 3 — Configuración y horarios

Horarios semanales con bloques múltiples. Feriados y overrides. El patrón bloquear+avisar con los 409. CRUD de barberos, servicios, promos, catálogo. Config del negocio. Clientes con historial, import y export CSV. Stats.

*Criterio de salida:* el panel es autosuficiente — no hace falta tocar la base a mano para operar.

### Fase 4 — Integraciones

Google Calendar (recuperando `_gcal.js` del historial). Queues + consumer de WhatsApp con CallMeBot. Cifrado AES-GCM de las API keys. Caché KV de feriados. Cron de limpieza.

*Criterio de salida:* una reserva aparece en Calendar y le llega el WhatsApp al barbero.

### Fase 5 — Magic links y recurrentes

Los cinco endpoints de mi-turno con HMAC. Recurrentes: CRUD, generación manual, y **el Cron Trigger de generación automática** (que el sistema viejo nunca tuvo).

*Criterio de salida:* un cliente cancela su turno con un link sin haberse registrado, y los recurrentes se generan solos.

### Después: frontend

Puede arrancar en paralelo desde la Fase 2, mockeando lo que falte.

---

## 8. Spikes antes de arrancar

Tres cosas que la documentación de Cloudflare no confirma y que conviene resolver el primer día.

1. **Índice único parcial en D1.** Correr `CREATE UNIQUE INDEX ... WHERE estado = 'activa'` contra una D1 real, insertar un duplicado y anotar **el texto exacto del error** (hay que mapearlo al mensaje de overlap). SQLite lo soporta; la doc de Cloudflare solo muestra ejemplos no únicos. *(medio día)*
2. **Concurrencia real del Durable Object.** Prototipar `BarberoAgenda.reservar()` y tirarle 50 requests simultáneos al mismo slot. Verificar que gane exactamente uno. Es el spike que valida el diseño de 4.6 — hacelo antes de construir encima. *(1-2 días)*
3. **PBKDF2 vs. BCrypt en el límite de CPU.** Medir los dos en un Worker del Free plan. Define si hace falta Workers Paid. *(medio día)*

---

## 9. Decisiones abiertas

1. **Framework de frontend.** Angular da continuidad con el equipo; algo más liviano da un bundle más chico en Static Assets.
2. **Duración de slot: global o por servicio.** Hoy la grilla es de 30 min fijos y ya genera bugs (4.5). Slots por duración de servicio es más correcto pero complica la UI del calendario. **Decidilo ahora**, no después.
3. **¿Se migran los datos de producción?** Si Gebyanos sigue operando en Azure, hay clientes y reservas reales. Hace falta un script de export SQL Server → import D1, y una ventana de cutover. `Barberia.Migrator/` tiene el molde del mapeo de IDs, en la dirección inversa.
4. **Rate limiting: Durable Object o el binding nativo.** El binding de Rate Limiting de Workers es más simple; un DO te da control fino sobre la clave y la ventana. El sistema actual usa `{ip}:{endpoint}` con ventana de 15 min.
5. **¿Multi-tenant en el horizonte?** Quedó fuera del alcance, pero si va a volver en 6 meses, conviene que el schema no se pinte al rincón. La contra: diseñar para un futuro que puede no llegar. Con un solo tenant hoy, lo razonable es no hacer nada — solo no bloquearse.

---

## 10. Referencias al código actual

Cuando esta spec no alcance, el código en producción es la fuente de verdad. Todo bajo `barberiagebyanos.BE/`:

| Qué buscar | Dónde |
|---|---|
| Lógica pura de slots y horarios | `Barberia.Api/Helpers/{SlotHelper,ScheduleHelper,DateHelper,PhoneHelper}.cs` |
| Flujo de reserva completo | `Barberia.Api/Services/ReservaService.cs` |
| Disponibilidad y queries de conflicto | `Barberia.Api/Services/ScheduleAvailabilityService.cs` |
| Anti-doble-reserva | `Barberia.Api/Services/BookingSlotGuard.cs` |
| Magic links | `Barberia.Api/Services/MagicLinkTokenService.cs`, `Controllers/MiTurnoController.cs` |
| Recurrentes | `Barberia.Api/Services/RecurrenteService.cs` |
| Auth y cookie | `Barberia.Api/Controllers/Admin/AuthController.cs`, `Auth/AdminCookieAuthenticationHandler.cs` |
| WhatsApp | `Barberia.Api/Services/WhatsAppNotificationService.cs` |
| Google Calendar | `Barberia.Api/Services/GoogleCalendarService.cs` |
| Bloquear+avisar | `Barberia.Api/Controllers/Admin/HorariosAdminController.cs` |
| Schema y relaciones | `Barberia.Api/Data/BarberiaDbContext.cs` |
| **Casos borde conocidos** | `docs/EDGE_CASES.md` ← leelo completo antes de la Fase 2 |
| **JWT de Google en JS** | historial de git: `functions/admin/api/_gcal.js` |
| Mapeo de datos legacy | `Barberia.Migrator/Program.cs`, `LegacyModels.cs` |
| Casos de test como spec | `Barberia.Api.Tests/Helpers/*Tests.cs` |

**Y una cosa más, independiente de todo esto:** `Barberia.Api/appsettings.Development.json` tiene la private key de una service account de Google en texto plano, commiteada. **Rotá esa credencial**, no la reuses en el proyecto nuevo.
