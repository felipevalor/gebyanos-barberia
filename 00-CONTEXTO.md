# Contexto del proyecto — Barbería Gebyanos v2

> **Pegá este archivo al inicio de cada sesión de Claude Code, antes del archivo de fase.**
> Son las reglas que aplican a todo el proyecto. Sin esto, cada sesión reinventa decisiones ya tomadas.

---

## Qué estamos construyendo

Un sistema de reservas de turnos para una barbería con varios barberos, **desde cero**, sobre Cloudflare Workers.

Existe un sistema anterior en .NET 8 + Azure SQL, en producción. **No se migra el código: se usa como fuente de verdad de las reglas de negocio.** Tiene 230+ tests pasando y cuatro meses de bugs ya cazados. La spec completa está en `docs/spec-barberia-cloudflare.md`.

**Single-tenant.** Una sola barbería. No hay tenants, ni registro público, ni dominio propio por cliente. Si ves código o docs del sistema viejo hablando de multi-tenant (`Tenancy/`, `TenantsController`, Catalog DB), está fuera de alcance.

**Tres usuarios:**

- **Cliente** (anónimo, sin cuenta): reserva turnos, y después consulta/reprograma/cancela con un link firmado que recibe por WhatsApp.
- **Barbero** (rol `barbero`): su agenda, sus turnos, sus horarios, sus clientes recurrentes.
- **Dueño** (rol `owner`): todo lo anterior más barberos, servicios, promos, configuración global y stats de todos.

**El invariante que no se rompe nunca:** dos clientes no pueden terminar con el mismo turno.

---

## Restricción de costo: free tier, sin excepciones

**Todo el proyecto tiene que entrar en el plan gratuito de Cloudflare. No se paga nada.**

Si al implementar algo aparece un límite del plan Free que bloquea, **la respuesta no es "pasamos a Workers Paid"** — es buscar la alternativa gratuita, y si no existe, frenar y avisar.

📌 **Sin excepciones, tampoco para producción.** El sistema sale a producción en Free y se queda ahí. Workers Paid ($5/mes) es el plan de contingencia si algo lo fuerza, no un paso planificado. Ver la sección de CPU más abajo: hay un riesgo identificado, con su síntoma y su arreglo escritos, y ese es el nivel de preparación que necesitamos — no pagar por adelantado.

Lo que el free tier da y lo que consume una barbería:

| Recurso | Límite Free | Uso estimado |
|---|---|---|
| Requests de Workers | 100.000/día | < 1.000/día |
| D1 filas leídas | 5.000.000/día | unos pocos miles |
| D1 filas escritas | 100.000/día | < 200/día |
| D1 bases por cuenta | 10 | 1 (o 1 por barbería, ver Fase 6) |
| **Queues** | **10.000 operaciones/día** | **< 200/día** |
| Cron Triggers | 5 por cuenta | 3 |
| Workers KV lecturas | 100.000/día | pocas |
| Durable Objects | Incluidos, backend SQLite | |
| **CPU por request** | **10 ms** | ⚠️ ver abajo |

**Sobra por dos órdenes de magnitud en todo, menos en uno.**

### ⚠️ El límite de CPU: lo documentado y lo medido no coinciden

**La documentación dice 10 ms por request en el plan Free.** Medido contra el Worker real deployado (cuenta confirmada en **Workers Free**, sin método de pago):

| Medición | Resultado |
|---|---|
| Una derivación PBKDF2 de 50k | **~11,6 ms** — y funciona |
| Login completo | **20–57 ms** de CPU — y funciona |
| Techo efectivo observado | **~1,8 segundos** |

O sea que Cloudflare hoy es **mucho más permisivo que su propia documentación**.

🔴 **No construyas asumiendo 1,8 s.** El comportamiento no documentado no es un contrato: la documentación dice 10 ms, y si Cloudflare empieza a aplicarlo, el login se rompe sin aviso y sin que nadie haya cambiado código.

**Y notá esto:** el login completo consume 20–57 ms. Si los 10 ms se aplicaran, fallaría **con cualquier cantidad de iteraciones**, incluso cero. Bajar el factor de trabajo no es una mitigación.

**La regla operativa:**

- **No subas las iteraciones del hash** apoyándote en este margen. 50.000 se queda.
- **No metas operaciones nuevas de CPU intensivo** en el camino de un request. El presupuesto ya está gastado.
- **Se sale a producción en Free.** El riesgo está identificado y no bloquea nada.

**Qué hacer si algún día se rompe.** Este es el punto de la nota — no evitar el riesgo, sino no perder una tarde diagnosticándolo:

| Síntoma | Qué es | Arreglo |
|---|---|---|
| El login empieza a devolver 500 sin que nadie haya tocado código, y el log de Cloudflare dice `exceededCpu` | Cloudflare empezó a aplicar el límite documentado de 10 ms | Workers Paid ($5/mes). El tope pasa a 30 s y el problema desaparece |

**Sin esta nota, ese día se debuggea código que está bien.** Con ella, es un click.

**Cuidado con generalizar:** que el límite de CPU sea blando no significa que todos lo sean. **El de bases D1 sí se aplica** — se ve en la pantalla de uso de la cuenta. Ese techo de 10 es real y limita la Fase 6.

**Cómo medir CPU en producción, si hace falta de nuevo:** `performance.now()` está congelado dentro del Worker (devuelve siempre 0, es mitigación de Spectre). Lo que funciona es un endpoint temporal con N repeticiones de la operación, leer `cpuTime` de `wrangler tail`, y sacar la pendiente. Borrá el endpoint después y verificá el 404.

**Y una regla general que salió de esto: el edge es ~3× más lento que una máquina de desarrollo.** Toda medición local necesita ese factor antes de creerle.

📌 **Queues SÍ está en el plan gratuito** desde febrero de 2026: 10.000 operaciones/día, retención de 24 h. Si alguna herramienta o documentación dice que requiere Workers Paid, está desactualizada — [confirmado en la doc oficial](https://developers.cloudflare.com/queues/platform/pricing/).

## Stack

| Capa | Elección |
|---|---|
| Runtime | Cloudflare Workers + TypeScript |
| Router | Hono |
| Base de datos | D1 (SQLite) |
| Acceso a datos | Drizzle ORM |
| Serialización de reservas | Durable Object por barbero |
| Cola de notificaciones | Cloudflare Queues |
| Jobs programados | Cron Triggers |
| Caché | Workers KV |
| Tests | Vitest + `@cloudflare/vitest-pool-workers` |
| Frontend | Static Assets del mismo Worker |

---

## Estructura de carpetas

```
src/
  index.ts              # entry: rutas Hono + export de DOs y handlers de cron/queue
  domain/               # lógica pura, CERO I/O
    slots.ts
    schedule.ts
    dates.ts
    phone.ts
    recurrence.ts
  db/
    schema.ts
    migrations/
  services/             # orquestación: leen/escriben DB
  routes/
    public.ts
    admin.ts
    mi-turno.ts
  do/
    BarberoAgenda.ts
    RateLimiter.ts
  integrations/
    google-calendar.ts
    callmebot.ts
    feriados.ts
  middleware/
    auth.ts
    rate-limit.ts
```

**`domain/` es sagrada: cero I/O, cero imports de Workers, cero acceso a DB.** Es lo que se testea a fondo. Si una función de `domain/` necesita datos, se le pasan por parámetro.

---

## Convenciones de datos

| Concepto | En SQLite/D1 | Nota |
|---|---|---|
| IDs | `TEXT` con **UUID v7** generado en el Worker | Ordenable por tiempo |
| Fechas | `TEXT` `"YYYY-MM-DD"` | Formato único en todo el sistema |
| Horas | `TEXT` `"HH:mm"` | Siempre 5 caracteres, con padding |
| Timestamps | `TEXT` ISO-8601 UTC | `new Date().toISOString()` |
| Precios | `INTEGER` en **centavos** | Nunca float |
| Booleanos | `INTEGER` 0/1 | |

**Un solo formato de fecha: `"YYYY-MM-DD"`.** El sistema viejo arrastra un formato legacy `"d/M/yyyy"` en paralelo y un parser de tres formatos. No lo repliques.

---

## Constantes de negocio

Estos números son **contrato**. Están así porque alguien ya se comió el bug de tenerlos distintos.

| Regla | Valor | Configurable en |
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
| Zona horaria | **America/Argentina/Buenos_Aires** (UTC-3, sin DST) | `negocio.timezone` |

**Descartado a propósito:** el sistema viejo usa BCrypt con cost factor 12. Acá usamos **PBKDF2** (ver Fase 2, tarea 2.5) porque BCrypt no entra en los 10 ms de CPU del plan Free de Workers. No hay hashes legacy que soportar, así que no hay razón para arrastrarlo.

---

## Manejo de fechas: la regla que más se rompe

**Todo el sistema opera en hora de Argentina. "Hoy" y "ahora" nunca se leen del reloj UTC directo.**

```ts
const TZ = 'America/Argentina/Buenos_Aires';

// "YYYY-MM-DD" de hoy en Argentina
export function todayArgentina(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());  // en-CA da directamente YYYY-MM-DD
}

// "HH:mm" de ahora en Argentina
export function timeNowArgentina(): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date());
}
```

Argentina no usa horario de verano desde 2009, así que el offset es fijo `-03:00`. Usá `Intl` igual: es correcto sin costo extra.

**Nunca uses `new Date()` sin convertir para decidir si una fecha es pasada o futura.** Un turno a las 21:00 hora Argentina es "mañana" en UTC.

---

## Convención de respuestas de API

```ts
type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };
```

Códigos:

| Situación | Código |
|---|---|
| OK | 200 |
| Validación o regla de negocio | 400 |
| Sin autenticar | 401 |
| Autenticado sin permiso | **403** (no 401) |
| No encontrado | 404 |
| Conflicto que requiere acción del admin | 409 (con lista de conflictos) |
| Rate limit | 429 |
| Error no controlado | 500 |

---

## Reglas de oro

1. **El backend valida siempre, aunque el frontend ya haya filtrado.** Un slot puede ocuparse entre que la UI lo muestra y el cliente hace click.
2. **Los mensajes de error al usuario son contrato.** No los reescribas ni los "mejores" — el frontend y los tests dependen de ellos. Si uno te parece mal, marcalo y lo decidimos; no lo cambies solo.
3. **Todos los mensajes van en voseo rioplatense.** `Usá`, `Elegí`, `Revisá`, `Debés`, `Intentá`, `Reagendalos`. Nunca tuteo (`Usa`, `Intenta`) ni usted (`Use`, `Intente`). Es un producto para una barbería argentina. Si escribís un mensaje nuevo, seguí esa voz — y si ves uno que no la sigue, marcalo.

   **Y distinguí dos audiencias**, porque no se escriben igual:

   | Tipo | Quién lo ve | Cómo se escribe |
   |---|---|---|
   | **De cara al humano** | El cliente reservando, el barbero en el panel | Voseo, cálido, accionable. Dice qué hacer, no qué falló. `Revisá el teléfono...`, `Elegí otro.` |
   | **De diagnóstico** | Solo un frontend con bug lo dispara | Preciso. Puede nombrar el parámetro y el formato esperado. `Formato de fecha inválido en desde. Usá YYYY-MM-DD.` |

   Un error de forma que ningún humano debería ver **conviene** que nombre el parámetro: le ahorra media hora a quien lo esté depurando. Un error que ve el cliente nunca menciona nombres técnicos.
4. **Google Calendar y WhatsApp son best-effort.** Si fallan, la reserva ya está confirmada. Log y seguir. Nunca tires una reserva por una integración caída.
5. **Soft delete en reservas.** Nunca `DELETE` físico. `estado = 'cancelada'` + `cancelada_at`. Todas las queries de disponibilidad filtran `estado = 'activa'`.
6. **Turnos contiguos NO solapan.** La fórmula de intersección usa comparadores estrictos (`<`, `>`). Si usás `<=`/`>=` rompés la agenda entera.
7. **Filtrá siempre por `activo = 1`** al leer barberos y servicios. Es el olvido que ya apareció dos veces: un barbero desactivado devolvía horarios, un servicio discontinuado imponía su duración.
8. **Enmascará teléfonos en los logs.** Solo los últimos 4 dígitos.
9. **Nada de secretos en el código.** Todo por `wrangler secret`.

---

## Bugs del sistema viejo que NO hay que copiar

Están marcados con 🐛 en la spec. Los seis:

1. **Grilla de slots con 30 min hardcodeado** ignorando `negocio.slot_duracion_min`, mientras el chequeo de solapamiento sí usa el valor configurado. → Pasá la duración configurada en los dos lados.
2. **Solapamiento validado con la duración global** en vez de la duración real del servicio elegido. Con un servicio de 60 min puede ofrecer un slot que pisa el siguiente. → Usá la duración del servicio.
3. **`generateSlotsFromBlocks` no deduplica** bloques solapados. → Deduplicá.
4. **Chequeos de "solo owner" devuelven 401** cuando corresponde 403. → Usá 403.
5. **Bloqueos administrativos identificados por un string mágico** (`servicio = "Bloqueo Administrativo"`, `nombre = "BLOQUEDAO"` con typo). → Columna `tipo` con `'turno' | 'bloqueo'`.
6. **`buildEventTimes` genera horas inválidas** tipo `"25:30"` si el turno cruza medianoche, sin incrementar la fecha. → Manejalo o al menos validá y logueá.

---

## Referencias al código viejo

Cuando la spec no alcance, el código en producción es la fuente de verdad. Todo bajo `barberiagebyanos.BE/`:

| Qué | Dónde |
|---|---|
| Lógica pura de slots y horarios | `Barberia.Api/Helpers/{SlotHelper,ScheduleHelper,DateHelper,PhoneHelper}.cs` |
| Flujo de reserva | `Barberia.Api/Services/ReservaService.cs` |
| Disponibilidad | `Barberia.Api/Services/ScheduleAvailabilityService.cs` |
| Anti-doble-reserva | `Barberia.Api/Services/BookingSlotGuard.cs` |
| Magic links | `Barberia.Api/Services/MagicLinkTokenService.cs`, `Controllers/MiTurnoController.cs` |
| Recurrentes | `Barberia.Api/Services/RecurrenteService.cs` |
| Auth | `Barberia.Api/Controllers/Admin/AuthController.cs`, `Auth/AdminCookieAuthenticationHandler.cs` |
| WhatsApp | `Barberia.Api/Services/WhatsAppNotificationService.cs` |
| Google Calendar | `Barberia.Api/Services/GoogleCalendarService.cs` |
| Schema | `Barberia.Api/Data/BarberiaDbContext.cs` |
| **Casos borde conocidos** | `docs/EDGE_CASES.md` |
| **JWT de Google en JS** | historial de git: `functions/admin/api/_gcal.js` |
| Tests como spec ejecutable | `Barberia.Api.Tests/Helpers/*Tests.cs` |

---

## Las cinco fases

| Fase | Qué deja funcionando |
|---|---|
| **1 — Cimientos** | Proyecto, schema, y toda la lógica pura con tests verdes |
| **2 — Reservas** | Un cliente reserva por API y el barbero lo ve en su agenda |
| **3 — Configuración** | El panel es autosuficiente, no hace falta tocar la base a mano |
| **4 — Integraciones** | La reserva aparece en Calendar y llega el WhatsApp |
| **5 — Magic links y recurrentes** | El cliente cancela sin cuenta; los recurrentes se generan solos |

**No arranques una fase sin la anterior terminada.** Cada archivo de fase declara su criterio de salida.
