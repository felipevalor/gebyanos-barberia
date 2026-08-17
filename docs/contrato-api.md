# Contrato de API — Barbería Gebyanos

**Generado leyendo el código real** (tareas 2.1 a 2.4), no la spec. Si algo acá
no coincide con el comportamiento, es un bug de este documento.

Estado: **endpoints públicos completos.** El panel de administración
(`/api/admin/*`) y la autogestión del cliente (`/api/mi-turno/*`) todavía no
existen — están montados pero vacíos.

Última actualización: 2026-08-17 · commit `df3047d`

---

## Índice

- [Reglas generales](#reglas-generales)
- [Tipos de dato](#tipos-de-dato)
- [`GET /api/negocio`](#get-apinegocio)
- [`GET /api/barberos`](#get-apibarberos)
- [`GET /api/servicios`](#get-apiservicios)
- [`GET /api/promos`](#get-apipromos)
- [`GET /api/catalogo`](#get-apicatalogo)
- [`GET /api/disponibilidad`](#get-apidisponibilidad)
- [`GET /api/disponibilidad/mes`](#get-apidisponibilidadmes)
- [`POST /api/reservas`](#post-apireservas)
- [Todos los mensajes de error](#todos-los-mensajes-de-error)
- [Flujo completo de reserva](#flujo-completo-de-reserva)
- [Lo que todavía no existe](#lo-que-todavía-no-existe)

---

## Reglas generales

### El sobre

**Toda** respuesta usa la misma envoltura, incluidos los errores:

```ts
type ApiResponse<T> =
  | { ok: true;  data: T }
  | { ok: false; error: string };
```

No hay respuestas sin sobre. No hay campos extra en el nivel superior.

### Códigos de estado

| Código | Cuándo |
|---|---|
| `200` | OK |
| `400` | Validación, regla de negocio, o el turno se ocupó |
| `404` | Ruta inexistente, o `negocio` sin configurar |
| `500` | Error no controlado |

**Importante para el frontend:** un slot ocupado devuelve **400**, no 409. Los
tres estados de error de la reserva (`datosInvalidos`, `noDisponible`,
`overlap`) colapsan en 400 y se distinguen **solo por el texto de `error`**.

Los códigos `401`, `403`, `409` y `429` están definidos en las convenciones pero
**ningún endpoint público los emite hoy**.

### Caché

| Endpoints | Header |
|---|---|
| `/negocio`, `/barberos`, `/servicios`, `/promos`, `/catalogo` | `Cache-Control: public, max-age=300` |
| `/disponibilidad`, `/disponibilidad/mes`, `POST /reservas` | `Cache-Control: no-store` |
| **Cualquier respuesta de error (4xx, 5xx)** | `Cache-Control: no-store` |

La disponibilidad **no se cachea nunca**: un slot se ocupa en cualquier momento.

Los errores tampoco, aunque vengan de un endpoint cacheable: un CDN que no ve
el header aplica su propia heurística y podría cachear un 404.

### Autenticación

Ninguno de estos endpoints la requiere. Todos son anónimos.

### Rate limit

**No implementado todavía** (tarea 2.6). Cuando exista: 10 requests por IP cada
15 minutos sobre `POST /api/reservas`, respondiendo `429` con
`Demasiados intentos. Intenta más tarde.`

---

## Tipos de dato

| Concepto | Formato | Ejemplo |
|---|---|---|
| ID | UUID v7 en string | `"01920000-0000-7000-8000-000000000001"` |
| Fecha | `"YYYY-MM-DD"` | `"2026-08-24"` |
| Hora | `"HH:mm"`, 5 caracteres con padding | `"09:30"` |
| Timestamp | ISO-8601 UTC | `"2026-08-17T14:30:00.000Z"` |
| Precio | **entero en centavos**, nunca float | `800000` = $8.000,00 |
| Booleano | `true` / `false` en JSON | |

### Precios

La API **nunca devuelve pesos**. El campo se llama `precioCentavos` justamente
para que no se pueda malinterpretar. Formateo en el cliente:

```ts
const formatear = (centavos: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' })
    .format(centavos / 100);
```

`precioCentavos` puede ser `null` (servicio o promo sin precio publicado).

### Zona horaria

Todas las fechas y horas de turnos son **hora de Argentina**
(`America/Argentina/Buenos_Aires`, UTC-3 fijo, sin horario de verano). No llevan
offset porque no son instantes: son la fecha y hora del turno tal como las ve el
cliente.

**El frontend no debe convertir zonas horarias.** Si el navegador está en otro
huso, mostrar los strings tal cual.

---

## `GET /api/negocio`

Configuración global y branding. Se usa para armar la landing y para saber los
límites de reserva antes de mostrar el calendario.

**Parámetros:** ninguno.

**200:**

```json
{
  "ok": true,
  "data": {
    "nombreNegocio": "Barbería Gebyanos",
    "timezone": "America/Argentina/Buenos_Aires",
    "slotDuracionMin": 30,
    "minutosAnticipacionMin": 30,
    "diasMaxAnticipacion": 14,
    "logoUrl": null,
    "colorPrimario": null,
    "colorSecundario": null
  }
}
```

| Campo | Tipo | Nota |
|---|---|---|
| `nombreNegocio` | `string` | |
| `timezone` | `string` | IANA. Siempre `America/Argentina/Buenos_Aires` |
| `slotDuracionMin` | `number` | Paso de la grilla de horarios |
| `minutosAnticipacionMin` | `number` | Margen mínimo para reservar hoy |
| `diasMaxAnticipacion` | `number` | Ventana máxima hacia adelante |
| `logoUrl` | `string \| null` | |
| `colorPrimario` | `string \| null` | |
| `colorSecundario` | `string \| null` | |

**404** — la fila de configuración no existe (base sin sembrar):

```json
{ "ok": false, "error": "No encontrado." }
```

---

## `GET /api/barberos`

Barberos que atienden, ordenados por `orden` y con desempate por `nombre`.

**Parámetros:** ninguno.

**200:**

```json
{
  "ok": true,
  "data": [
    { "id": "0192...001", "slug": "gaby", "nombre": "Gaby", "orden": 0 }
  ]
}
```

Solo devuelve barberos con `activo = 1`. Un barbero desactivado **desaparece de
esta lista y también de la disponibilidad**.

**No expone** `tel`, `calendarId`, `callmebotPhone`, `callmebotApikey` ni
`passwordHash`. Si necesitás alguno de esos, no es por acá.

---

## `GET /api/servicios`

Servicios reservables, ordenados por `orden` con desempate por `nombre`.

**Parámetros:** ninguno.

**200:**

```json
{
  "ok": true,
  "data": [
    {
      "id": "0192...101",
      "nombre": "Corte",
      "duracionMin": 30,
      "precioCentavos": 800000,
      "incluye": "Lavado y peinado",
      "orden": 0
    }
  ]
}
```

| Campo | Tipo |
|---|---|
| `id` | `string` |
| `nombre` | `string` |
| `duracionMin` | `number` |
| `precioCentavos` | `number \| null` |
| `incluye` | `string \| null` |
| `orden` | `number` |

Solo `activo = 1`.

⚠️ **`duracionMin` es la del catálogo.** Un barbero puede tener un override
propio para ese servicio. La duración real la devuelve
`GET /api/disponibilidad` en su campo `duracionMin` — **usá esa** para mostrarle
al cliente cuánto dura su turno.

---

## `GET /api/promos`

**Parámetros:** ninguno.

**200:**

```json
{
  "ok": true,
  "data": [
    {
      "id": "0192...",
      "nombre": "Combo padre e hijo",
      "precioCentavos": 1400000,
      "unidad": null,
      "nota": null,
      "badge": null,
      "orden": 1
    }
  ]
}
```

Solo `activo = 1`. Las promos son **informativas**: no se reservan.

---

## `GET /api/catalogo`

Vidriera de la landing. **No es lo mismo que `/servicios`** — el catálogo es
para mostrar, los servicios son los reservables.

**Parámetros:** ninguno.

**200:**

```json
{
  "ok": true,
  "data": [
    {
      "id": "0192...",
      "nombre": "Corte clásico",
      "incluye": "Lavado",
      "precioCentavos": 800000,
      "orden": 0
    }
  ]
}
```

Solo `activo = 1`.

---

## `GET /api/disponibilidad`

Horarios de inicio libres de un barbero en una fecha.

**Query params:**

| Param | Requerido | Formato | Nota |
|---|---|---|---|
| `barberoId` | **sí** | UUID | |
| `fecha` | **sí** | `YYYY-MM-DD` | |
| `servicioId` | no | UUID | Sin esto usa el paso de grilla como duración |

**200:**

```json
{
  "ok": true,
  "data": {
    "fecha": "2026-08-24",
    "slots": ["09:00", "09:30", "10:00", "12:00"],
    "duracionMin": 60
  }
}
```

| Campo | Tipo | Nota |
|---|---|---|
| `fecha` | `string` | Eco del parámetro |
| `slots` | `string[]` | Horas de inicio, ascendente, sin duplicados |
| `duracionMin` | `number` | **Duración real** del servicio para ese barbero |

**Pasá siempre `servicioId`.** Sin él, los slots se calculan con la duración
del paso de grilla y podés ofrecer horarios que después la reserva rechaza. Con
él, `duracionMin` ya contempla el override del barbero.

`slots` vacío es una respuesta **200 normal**, no un error. Pasa cuando:

- la fecha ya pasó
- la fecha está más allá de `diasMaxAnticipacion`
- el barbero no atiende ese día de la semana
- hay un feriado o cierre en esa fecha
- el día está lleno
- el servicio no entra en ningún bloque horario

**No hay forma de distinguir esos casos desde este endpoint.** Si necesitás
explicarle al cliente *por qué* no hay horarios, el mensaje aparece recién al
intentar reservar.

Lo que **sí** se distingue: un `barberoId` inexistente o desactivado devuelve
**400 `Barbero inválido.`**, el mismo mensaje que la reserva. Nunca vas a ver
una lista vacía por culpa de un ID mal escrito.

**400:**

| `error` | Cuándo |
|---|---|
| `barberoId es obligatorio.` | falta el param |
| `fecha es obligatoria.` | falta el param |
| `Formato de fecha inválido.` | no es `YYYY-MM-DD`, o la fecha no existe (`2026-02-30`) |
| `Barbero inválido.` | el barbero no existe o está desactivado |

---

## `GET /api/disponibilidad/mes`

Qué días de un mes tienen al menos un horario libre. Para pintar el calendario.

**Query params:**

| Param | Requerido | Formato |
|---|---|---|
| `barberoId` | **sí** | UUID |
| `anio` | **sí** | entero, 2000–2100 |
| `mes` | **sí** | entero, 1–12 |
| `servicioId` | no | UUID |

**200:**

```json
{
  "ok": true,
  "data": {
    "anio": 2026,
    "mes": 8,
    "diasDisponibles": ["2026-08-17", "2026-08-18", "2026-08-20"]
  }
}
```

`diasDisponibles` trae las fechas completas `YYYY-MM-DD`, no números de día.
Los días que no están en la lista deben pintarse como no disponibles.

**Coincide día por día con `GET /api/disponibilidad`**: hay un test que lo
verifica. Si un día está en la lista, ese día tiene al menos un slot.

Pasá el mismo `servicioId` que vayas a usar en la grilla — sin él, el calendario
se calcula con otra duración y puede pintar días que después no ofrecen nada.

**400:**

| `error` | Cuándo |
|---|---|
| `barberoId es obligatorio.` | falta el param |
| `Año inválido.` | no es entero, o fuera de 2000–2100 |
| `Mes inválido. Usá 1 a 12.` | no es entero, o fuera de 1–12 |
| `Barbero inválido.` | el barbero no existe o está desactivado |

---

## `POST /api/reservas`

Crea un turno. **El endpoint más importante del sistema.**

**Headers:** `Content-Type: application/json`

**Body:**

```json
{
  "barberoId": "0192...001",
  "servicioId": "0192...101",
  "fecha": "2026-08-24",
  "hora": "10:00",
  "clienteNombre": "Juan Pérez",
  "clienteTelefono": "3416513207",
  "mensaje": "Vengo con mi hijo"
}
```

| Campo | Requerido | Reglas |
|---|---|---|
| `barberoId` | **sí** | |
| `servicioId` | **sí** | |
| `fecha` | **sí** | `YYYY-MM-DD` |
| `hora` | **sí** | `HH:mm` con padding, hora real (`00:00`–`23:59`) |
| `clienteNombre` | **sí** | máx. 100 caracteres |
| `clienteTelefono` | **sí** | máx. 20 caracteres, número argentino válido |
| `mensaje` | no | máx. 500 caracteres |

Los strings se recortan (`trim`) antes de validar: `"  "` cuenta como vacío.

**200:**

```json
{
  "ok": true,
  "data": {
    "cancelToken": "01920000-0000-7000-8000-000000000abc",
    "mensaje": "Turno agendado exitosamente"
  }
}
```

⚠️ **Guardá el `cancelToken`.** Es lo único que le permite al cliente
consultar o cancelar su turno después, y **no se puede recuperar**. La API no
devuelve el id de la reserva.

### El teléfono se normaliza

Se guarda en forma canónica de 10 dígitos (código de área + número). Estos
formatos son **todos válidos** y llegan al mismo cliente:

```
3416513207        0341 15 6513207      +54 9 341 651-3207
341 651-3207      341 15 6513207       5493416513207
011 15 2345-6789  03416513207          543416513207
```

**El teléfono identifica al cliente.** Dos reservas con el mismo teléfono son
el mismo cliente, y el nombre de la última reserva pisa al anterior.

Se rechazan los números de otros países aunque sean válidos allá.

---

### Los errores de la reserva

Todos son **400** con el sobre `{ ok: false, error }`. En orden de evaluación —
**si dos condiciones fallan a la vez, se devuelve la primera de esta lista**:

| # | `error` | Cuándo |
|---|---|---|
| F1 | `Formato de solicitud inválido.` | el body no es JSON, o no es un objeto |
| F2 | `barberoId es obligatorio.` | vacío o ausente |
| F3 | `servicioId es obligatorio.` | vacío o ausente |
| F4 | `fecha es obligatoria.` | vacía o ausente |
| F5 | `Formato de hora inválido. Use HH:mm.` | ausente, sin padding (`9:00`), o imposible (`24:00`, `10:60`) |
| F6 | `clienteNombre es obligatorio.` | vacío o ausente |
| F7 | `El nombre no puede superar los 100 caracteres.` | |
| F8 | `clienteTelefono es obligatorio.` | vacío o ausente |
| F9 | `El teléfono no puede superar los 20 caracteres.` | |
| F10 | `El mensaje no puede superar los 500 caracteres.` | |
| 1 | `Formato de fecha inválido.` | no es `YYYY-MM-DD`, o no existe (`2026-02-30`) |
| 2 | `No se puede agendar un turno en el pasado.` | fecha anterior a hoy |
| 3 | `Solo se puede reservar con hasta {N} días de anticipación.` | `{N}` = `diasMaxAnticipacion` de `/api/negocio` |
| 4 | `No se puede agendar un turno en un horario que ya pasó.` | es hoy y la hora ya pasó |
| 5 | `Revisá el teléfono. Tiene que ser un número argentino válido con código de área.` | no normaliza a un número argentino |
| 6 | `Barbero inválido.` | no existe o está desactivado |
| 8a | `La barbería no atiende esa fecha (feriado o cierre).` | hay un override con `trabaja = false` |
| 8b | `La barbería no atiende ese día.` | el barbero no tiene horario ese día de la semana |
| 8c | `El horario elegido está fuera del horario de atención.` | la hora no entra en ningún bloque, **o el servicio no termina antes del cierre** |
| 9 | `Debés reservar con al menos {N} minutos de anticipación.` | `{N}` = `minutosAnticipacionMin` |
| 11 | `Lo sentimos, este turno acaba de ser reservado por alguien más.` | el slot se ocupó |

**El feriado gana sobre el día cerrado.** Un override con `trabaja = false`
devuelve `La barbería no atiende esa fecha (feriado o cierre).` **incluso si el
barbero tampoco tiene horario ese día de la semana**: el override negativo se
evalúa antes que los bloques.

Al revés no funciona: un override con `trabaja = true` **no abre** un día sin
horario configurado. El override es un booleano, no trae horas — solo puede
evitar que un `false` cierre el día. Un domingo sin horario sigue devolviendo
`La barbería no atiende ese día.` aunque tenga un override positivo.

**500:**

```json
{
  "ok": false,
  "error": "Ocurrió un error al procesar la reserva. Por favor, reintenta."
}
```

Este mensaje es exclusivo de este endpoint; el resto de las rutas devuelve
`Error interno.`

### Notas para el frontend

**El paso 7 no rechaza.** Si el `servicioId` no existe o está desactivado, la
reserva **se crea igual** con el nombre `"Servicio"` y la duración del paso de
grilla. No hay error para ese caso — se ve solo mirando el turno creado.

**Los mensajes `{N}` traen el número interpolado**, no la llave literal. Vienen
de `/api/negocio`, así que no los hardcodees.

**Distinguí `overlap` del resto.** Es el único error que amerita recargar la
disponibilidad y pedirle al cliente que elija otro horario; el resto son
problemas de su input.

**El backend valida disponibilidad aunque el frontend ya haya ocultado el
slot.** Ocultar horarios en la UI es una comodidad, no una garantía: entre que
la grilla se muestra y el cliente hace click, el slot puede ocuparse.

---

## Todos los mensajes de error

Lista completa, extraída del código. Son **transcripción textual** del sistema
en producción: si necesitás cambiarlos, hablalo antes — hay tests que los fijan
carácter por carácter.

| Mensaje | Código | Endpoint |
|---|---|---|
| `Año inválido.` | 400 | `/disponibilidad/mes` |
| `barberoId es obligatorio.` | 400 | `/disponibilidad`, `/disponibilidad/mes`, `POST /reservas` |
| `Barbero inválido.` | 400 | `/disponibilidad`, `/disponibilidad/mes`, `POST /reservas` |
| `clienteNombre es obligatorio.` | 400 | `POST /reservas` |
| `clienteTelefono es obligatorio.` | 400 | `POST /reservas` |
| `Debés reservar con al menos {N} minutos de anticipación.` | 400 | `POST /reservas` |
| `El horario elegido está fuera del horario de atención.` | 400 | `POST /reservas` |
| `El mensaje no puede superar los 500 caracteres.` | 400 | `POST /reservas` |
| `El nombre no puede superar los 100 caracteres.` | 400 | `POST /reservas` |
| `El teléfono no puede superar los 20 caracteres.` | 400 | `POST /reservas` |
| `Error interno.` | 500 | cualquiera menos `POST /reservas` |
| `fecha es obligatoria.` | 400 | `/disponibilidad`, `POST /reservas` |
| `Formato de fecha inválido.` | 400 | `/disponibilidad`, `POST /reservas` |
| `Formato de hora inválido. Use HH:mm.` | 400 | `POST /reservas` |
| `Formato de solicitud inválido.` | 400 | `POST /reservas` |
| `La barbería no atiende esa fecha (feriado o cierre).` | 400 | `POST /reservas` |
| `La barbería no atiende ese día.` | 400 | `POST /reservas` |
| `Lo sentimos, este turno acaba de ser reservado por alguien más.` | 400 | `POST /reservas` |
| `Mes inválido. Usá 1 a 12.` | 400 | `/disponibilidad/mes` |
| `No encontrado.` | 404 | ruta inexistente, `/negocio` sin datos |
| `No se puede agendar un turno en el pasado.` | 400 | `POST /reservas` |
| `No se puede agendar un turno en un horario que ya pasó.` | 400 | `POST /reservas` |
| `Ocurrió un error al procesar la reserva. Por favor, reintenta.` | 500 | `POST /reservas` |
| `Revisá el teléfono. Tiene que ser un número argentino válido con código de área.` | 400 | `POST /reservas` |
| `servicioId es obligatorio.` | 400 | `POST /reservas` |
| `Solo se puede reservar con hasta {N} días de anticipación.` | 400 | `POST /reservas` |

Dos mensajes existen en el código pero **hoy son inalcanzables**:
`Formato de hora inválido.` (sin el "Use HH:mm.") y `Turno no disponible.`

---

## Flujo completo de reserva

```
1. GET /api/negocio        → branding, y diasMaxAnticipacion para acotar el calendario
2. GET /api/barberos       → el cliente elige barbero
3. GET /api/servicios      → el cliente elige servicio
4. GET /api/disponibilidad/mes?barberoId&anio&mes&servicioId
                           → pintar el calendario
5. GET /api/disponibilidad?barberoId&fecha&servicioId
                           → grilla de horarios del día elegido
6. POST /api/reservas      → confirmar
7. Guardar el cancelToken
```

**Volvé a pedir el paso 5 antes de mostrar la confirmación** si pasó tiempo
desde que se cargó la grilla. No está cacheada justamente por eso.

**Ante un `overlap` en el paso 6:** recargá el paso 5 y pedile al cliente que
elija otro horario. No reintentes automáticamente con el mismo slot.

---

## Lo que todavía no existe

No inventes contratos para esto — se documenta cuando esté construido.

| Qué | Ruta | Tarea |
|---|---|---|
| Rate limit en la reserva | — | 2.6 |
| Login del panel | `POST /api/admin/auth` | 2.5 |
| Agenda y reservas del panel | `/api/admin/*` | 2.7 |
| Configuración (horarios, feriados, catálogos) | `/api/admin/*` | Fase 3 |
| Consulta y cancelación con magic link | `/api/mi-turno/*` | Fase 5 |

`/api/admin` y `/api/mi-turno` están montados pero sin rutas: cualquier request
devuelve **404** con `{ "ok": false, "error": "No encontrado." }`.
