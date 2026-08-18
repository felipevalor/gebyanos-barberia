# Contrato de API — Barbería Gebyanos

**Generado leyendo el código real**, no la spec. Si algo acá no coincide con el
comportamiento, es un bug de este documento.

Estado: **Fase 3 completa** — endpoints públicos, autenticación, panel de
agenda y reservas, horarios, feriados, Bloquear+Avisar, clientes, catálogos y
configuración del negocio.

Todavía no existen: integraciones (Fase 4) y la autogestión del cliente
(`/api/mi-turno/*`, Fase 5).

Última actualización: 2026-08-17 · tareas 3.3 y 3.4

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

**Panel de administración**

- [Autenticación](#autenticación)
- [El scoping por rol](#el-scoping-por-rol)
- [`GET /api/admin/agenda`](#get-apiadminagenda)
- [`GET /api/admin/reservas`](#get-apiadminreservas)
- [`POST /api/admin/reservas`](#post-apiadminreservas)
- [`PUT /api/admin/reservas/:id`](#put-apiadminreservasid)
- [`DELETE /api/admin/reservas/:id`](#delete-apiadminreservasid)
- [`POST /api/admin/reservas/importar`](#post-apiadminreservasimportar)
- [**Bloquear + Avisar — el 409 con lista**](#bloquear--avisar--el-409-con-lista)
- [`GET /api/admin/horarios`](#get-apiadminhorarios)
- [`PUT /api/admin/horarios/dia/:dow`](#put-apiadminhorariosdiadow)
- [`PUT /api/admin/horarios/:id`](#put-apiadminhorariosid)
- [`GET /api/admin/feriados`](#get-apiadminferiados)
- [`POST /api/admin/feriados`](#post-apiadminferiados)
- [`DELETE /api/admin/feriados/:id`](#delete-apiadminferiadosid)
- [`POST /api/admin/bloqueos`](#post-apiadminbloqueos)
- [`GET /api/admin/clientes`](#get-apiadminclientes)
- [`GET /api/admin/clientes/exportar`](#get-apiadminclientesexportar)
- [`GET /api/admin/clientes/:id/historial`](#get-apiadminclientesidhistorial)
- [`POST /api/admin/clientes`](#post-apiadminclientes)
- [`POST /api/admin/clientes/importar`](#post-apiadminclientesimportar)
- [**Solo dueños — el 403 que no es 401**](#solo-dueños--el-403-que-no-es-401)
- [`/api/admin/barberos`](#apiadminbarberos)
- [`/api/admin/servicios`](#apiadminservicios)
- [`/api/admin/promos` y `/api/admin/catalogo`](#apiadminpromos-y-apiadmincatalogo)
- [`/api/admin/negocio`](#apiadminnegocio)
- [`GET /api/admin/stats`](#get-apiadminstats)
- [`GET /api/admin/avisos-fallidos`](#get-apiadminavisos-fallidos)
- [`/api/admin/callmebot`](#apiadmincallmebot)

- [Todos los mensajes de error](#todos-los-mensajes-de-error)
- [Flujo completo de reserva](#flujo-completo-de-reserva)
- [Lo que todavía no existe](#lo-que-todavía-no-existe)

---

## Reglas generales

### El sobre

**Toda** respuesta usa la misma envoltura, incluidos los errores:

```ts
type ApiResponse<T> =
  | { ok: true;  data: T;        warning?: string }
  | { ok: false; error: string;  data?: unknown };
```

No hay respuestas sin sobre.

**Los dos campos opcionales son del patrón Bloquear+Avisar.** No están siempre;
se omiten cuando no aplican, así que un error común sigue siendo exactamente
`{ ok: false, error }`.

| Campo | Cuándo aparece | Qué trae |
|---|---|---|
| `data` en un **error** | solo en los **409** de Bloquear+Avisar | la lista de turnos en conflicto |
| `warning` en un **éxito** | la operación se hizo, pero algo quedó pendiente de atención humana | el texto para mostrarle al usuario |

⚠️ **Si tratás todo error como `{ ok, error }` y nada más, te vas a perder la
lista de conflictos** — que es justamente lo que le permite al dueño resolver
el 409. Ver [Bloquear + Avisar](#bloquear--avisar--el-409-con-lista).

### Códigos de estado

| Código | Cuándo |
|---|---|
| `200` | OK |
| `400` | Validación, regla de negocio, o el turno se ocupó |
| `403` | Autenticado pero sin permiso |
| `404` | Ruta inexistente, recurso inexistente, o `negocio` sin configurar |
| `409` | **Bloquear+Avisar**: el cambio dejaría turnos huérfanos. Trae la lista en `data` |
| `429` | Rate limit excedido |
| `500` | Error no controlado |

**Importante para el frontend:** un slot ocupado devuelve **400**, no 409. Los
tres estados de error de la reserva (`datosInvalidos`, `noDisponible`,
`overlap`) colapsan en 400 y se distinguen **solo por el texto de `error`**.

**El 409 solo lo emiten las operaciones de configuración**, nunca la reserva:
un slot ocupado es 400, un cambio de horario que rompería turnos es 409. La
diferencia importa porque el 409 **siempre trae `data`** y el 400 no.

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

**10 por IP cada 15 minutos**, con contadores independientes por endpoint:

| Endpoint | Qué consume cupo |
|---|---|
| `POST /api/reservas` | **cada request**, incluidos los rechazados |
| `POST /api/admin/auth` | **solo los intentos fallidos** — un login correcto no gasta nada |

Excedido → **429** con `Demasiados intentos. Intentá más tarde.` y un header
`Retry-After` en segundos.

Agotar el cupo de un endpoint **no** afecta al otro.

Los endpoints de lectura (catálogos y disponibilidad) **no tienen rate
limit**: son cacheables y no escriben nada.

El contador es por ventana fija, no deslizante: arranca en el primer request y
se reinicia entero a los 15 minutos.

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
| F5 | `Formato de hora inválido. Usá HH:mm.` | ausente, sin padding (`9:00`), o imposible (`24:00`, `10:60`) |
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
  "error": "Ocurrió un error al procesar la reserva. Por favor, reintentá."
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
| `Año inválido. Usá un año entre 2000 y 2100.` | 400 | `GET /api/admin/feriados` |
| `barberoId es obligatorio.` | 400 | `/disponibilidad`, `/disponibilidad/mes`, `POST /reservas` |
| `Barbero inválido.` | 400 | `/disponibilidad`, `/disponibilidad/mes`, `POST /reservas` |
| `Bloque de horario no encontrado.` | 404 | `PUT /api/admin/horarios/:id` |
| `Día de la semana inválido. Usá 0 (domingo) a 6 (sábado).` | 400 | `PUT /api/admin/horarios/dia/:dow` |
| `Formato de fecha inválido en desde. Usá YYYY-MM-DD.` | 400 | `GET /api/admin/agenda` |
| `limit inválido. Tiene que ser un número entre 1 y 200.` | 400 | `GET /api/admin/reservas` |
| `skip inválido. Tiene que ser un número entero mayor o igual a 0.` | 400 | `GET /api/admin/reservas` |
| `No autorizado` | 401 | todo `/api/admin/*` autenticado |
| **`No se puede borrar: el barbero tiene {n} turno(s) futuro(s). Reasignalos o cancelalos antes de borrarlo.`** | **409** | borrar barbero *(3.4)* |
| **`No se puede desactivar: el barbero tiene {n} turno(s) futuro(s). Reagendalos o cancelalos antes de desactivarlo.`** | **409** | desactivar barbero *(3.4)* |
| `No se pueden importar más de 500 filas por vez.` | 400 | `POST /api/admin/reservas/importar` |
| `Prohibido` | 403 | import sin ser owner; tocar la reserva de otro |
| `Reserva no encontrada.` | 404 | `PUT` / `DELETE` de reservas |
| `Servicio inválido.` | 400 | `PUT /api/admin/reservas/:id` |
| `Solo podés operar sobre tu propia agenda.` | 403 | endpoints del panel con `barberoId` de otro |
| `Se esperaba una lista de bloques.` | 400 | `PUT /api/admin/horarios/dia/:dow` |
| `Se esperaba una lista de reservas.` | 400 | `POST /api/admin/reservas/importar` |
| `Solo los dueños pueden importar reservas.` | 403 | `POST /api/admin/reservas/importar` |
| `Usuario o contraseña incorrectos` | 401 | `POST /api/admin/auth` |
| `Ya existe una reserva en ese horario.` | 400 | `POST /api/admin/bloqueos` |
| `Demasiados intentos. Intentá más tarde.` | 429 | `POST /reservas`, `POST /api/admin/auth` |
| `clienteNombre es obligatorio.` | 400 | `POST /reservas` |
| `clienteTelefono es obligatorio.` | 400 | `POST /reservas` |
| `Debés reservar con al menos {N} minutos de anticipación.` | 400 | `POST /reservas` |
| `El horario elegido está fuera del horario de atención.` | 400 | `POST /reservas`, `PUT /api/admin/reservas/:id` |
| `El mensaje no puede superar los 500 caracteres.` | 400 | `POST /reservas` |
| `El nombre no puede superar los 100 caracteres.` | 400 | `POST /reservas` |
| `El teléfono no puede superar los 20 caracteres.` | 400 | `POST /reservas` |
| `Error interno.` | 500 | cualquiera menos `POST /reservas` |
| `fecha es obligatoria.` | 400 | `/disponibilidad`, `POST /reservas` |
| `Formato de fecha inválido.` | 400 | `/disponibilidad`, `POST /reservas` |
| `Formato de hora inválido. Usá HH:mm.` | 400 | `POST /reservas` |
| `Feriado no encontrado.` | 404 | `DELETE /api/admin/feriados/:id` |
| `Formato de solicitud inválido.` | 400 | `POST /reservas`, varios del panel |
| **`Hay {n} turno(s) ese día. Reagendalos o cancelalos antes de marcarlo como cerrado.`** | **409** | `POST /api/admin/feriados` al cerrar |
| **`Hay {n} turno(s) que quedarían fuera del nuevo horario. Reagendalos o cancelalos antes de cambiar el horario.`** | **409** | `PUT /api/admin/horarios/dia/:dow`, `PUT /api/admin/horarios/:id` |
| `Horario inválido. La hora de fin tiene que ser mayor que la de inicio, y las dos entre 0 y 24.` | 400 | endpoints de horarios |
| `La fila no es un objeto.` | — | motivo por fila en el import; no es una respuesta HTTP |
| `La barbería no atiende esa fecha (feriado o cierre).` | 400 | `POST /reservas` |
| `La barbería no atiende ese día.` | 400 | `POST /reservas` |
| `Lo sentimos, este turno acaba de ser reservado por alguien más.` | 400 | `POST /reservas` |
| `Mes inválido. Usá 1 a 12.` | 400 | `/disponibilidad/mes` |
| `No encontrado.` | 404 | ruta inexistente, `/negocio` sin datos |
| `No se puede agendar un turno en el pasado.` | 400 | `POST /reservas` |
| `No se puede agendar un turno en un horario que ya pasó.` | 400 | `POST /reservas` |
| `Ocurrió un error al procesar la reserva. Por favor, reintentá.` | 500 | `POST /reservas` |
| `Revisá el teléfono. Tiene que ser un número argentino válido con código de área.` | 400 | `POST /reservas` |
| `servicioId es obligatorio.` | 400 | `POST /reservas` |
| `Solo se puede reservar con hasta {N} días de anticipación.` | 400 | `POST /reservas` |
| `trabaja es obligatorio y tiene que ser true o false.` | 400 | `POST /api/admin/feriados` |

Los `{n}` y `{N}` vienen interpolados con el número real, no con la llave.

Tres mensajes existen en el código pero **hoy son inalcanzables**:
`Formato de hora inválido.` (sin el "Usá HH:mm."), `Turno no disponible.` y
`La operación no produjo resultado.`

Y hay mensajes ya definidos cuyos endpoints todavía no existen: los de
recurrentes (Fase 5) y `La contraseña tiene que tener al menos 12 caracteres.`
(alta de barberos, 3.4).

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
| Google Calendar, WhatsApp, recordatorios | — | Fase 4 |
| Consulta y cancelación con magic link | `/api/mi-turno/*` | Fase 5 |
| Clientes recurrentes | `/api/admin/recurrentes*` | Fase 5 |

`/api/mi-turno` está montado pero sin rutas: cualquier request devuelve **404**
con `{ "ok": false, "error": "No encontrado." }`.

---

# Panel de administración

Todo bajo `/api/admin/*`. **Nada se cachea**: `Cache-Control: no-store` en
todas las respuestas, incluidas las de error.

## Autenticación

La sesión viaja en una cookie `admin_token`, `HttpOnly` + `Secure` +
`SameSite=Lax` + `Path=/`, con 24 h de vida.

⚠️ **El header `Authorization: Bearer` no se acepta.** Es deliberado: la cookie
es `HttpOnly` para que un script inyectado no pueda leerla, y el backend
tampoco acepta la otra vía. Un token válido enviado como header da **401**.

El frontend no necesita hacer nada con el token — el navegador manda la cookie
solo. **No intentes leerla desde JS: no vas a poder.** Usá `credentials:
'include'` si el frontend está en otro origen.

| Código | Cuándo |
|---|---|
| `401 No autorizado` | sin cookie, cookie inválida, o sesión vencida |
| `403 Prohibido` | autenticado pero sin permiso para eso |

### `POST /api/admin/auth`

Body `{ usuario, password }`. El usuario es el `slug` del barbero.

**200:** `{ ok: true, data: { user: { id, slug, nombre, rol } } }` — `rol` es
`"barbero"` o `"owner"`.

**El token NUNCA está en el body.**

| Error | Código |
|---|---|
| `Usuario o contraseña incorrectos` | 401 |
| `Demasiados intentos. Intentá más tarde.` | 429 |

Un usuario inexistente y una contraseña incorrecta devuelven **exactamente la
misma respuesta** — no se puede averiguar si un usuario existe.

**El rate limit solo cuenta los intentos fallidos:** 10 fallos por IP cada 15
min. Entrar bien no gasta cupo.

### `DELETE /api/admin/auth`

Cierra sesión. Borra la fila de la base, no solo la cookie. Responde `200`
siempre, incluso sin cookie o con la sesión ya vencida.

### `GET /api/admin/me`

**200:** `{ ok: true, data: { id, slug, nombre, rol } }`

---

## El scoping por rol

**Es la regla que gobierna todo el panel.**

| Rol | Qué ve y qué toca |
|---|---|
| `barbero` | **solo lo suyo**, siempre |
| `owner` | todo; con `?barberoId=` filtra por ese |

⚠️ **Un `barbero` que manda `?barberoId=` de otro recibe 403**, no una lista
filtrada:

```json
{ "ok": false, "error": "Solo podés operar sobre tu propia agenda." }
```

Vale para `GET /agenda`, `GET /reservas`, `POST /reservas` y `POST /bloqueos`.
Mandar el **propio** id explícitamente sí es válido.

Si tu UI tiene un selector de barbero, mostralo solo cuando `rol === 'owner'`.

Sobre una reserva puntual (editar, cancelar) el 403 dice `Prohibido`.

---

## `GET /api/admin/agenda`

Turnos **y bloqueos** en un rango. Es la vista de calendario del barbero.

| Param | Requerido | Default |
|---|---|---|
| `desde` | no | hoy − 30 días |
| `hasta` | no | hoy + 60 días |
| `barberoId` | no | según rol (ver scoping) |

**200:** lista de turnos, ordenada por fecha y hora, máximo 500.

```json
{ "ok": true, "data": [{
  "id": "0193...", "barberoId": "0193...", "barberoNombre": "Ana",
  "fecha": "2026-08-24", "hora": "10:00", "duracionMin": 30,
  "nombre": "Juan Pérez", "telefono": "3416513207", "servicio": "Corte",
  "estado": "activa", "tipo": "turno", "mensaje": null,
  "source": "web", "createdAt": "2026-08-17T14:30:00.000Z"
}] }
```

**Incluye los bloqueos** (`tipo: "bloqueo"`), porque ocupan lugar en la agenda.
Un bloqueo trae `nombre` y `telefono` vacíos.

Solo devuelve `estado: "activa"`. Los turnos cancelados no aparecen.

| Error | Código |
|---|---|
| `Formato de fecha inválido en desde. Usá YYYY-MM-DD.` / `en hasta.` | 400 |

## `GET /api/admin/reservas`

Listado paginado de **turnos de clientes**. A diferencia de la agenda,
**excluye los bloqueos** e incluye los cancelados.

| Param | Default | Máximo |
|---|---|---|
| `skip` | 0 | — |
| `limit` | 50 | 200 |
| `barberoId` | según rol | — |

**200:** `{ ok: true, data: { items: [...], total, skip, limit } }`

`total` es el total **sin paginar**: sirve para el paginador.

Ordenado por fecha y hora **descendente** — lo más reciente primero.

| Error | Código |
|---|---|
| `skip inválido. Tiene que ser un número entero mayor o igual a 0.` | 400 |
| `limit inválido. Tiene que ser un número entre 1 y 200.` | 400 |

## `POST /api/admin/reservas`

Alta desde el panel. Mismo body que `POST /api/reservas`, **sin `barberoId`**
(sale del scoping; un `owner` puede mandarlo para cargar en otra agenda).

**Diferencias con la reserva pública:**

| | Pública | Panel |
|---|---|---|
| Anticipación mínima (30 min) | sí | **no** |
| Anticipación máxima (14 días) | sí | **no** |
| Horario de atención | sí | sí |
| Fecha pasada | rechaza | rechaza |
| Solapamiento | sí | **sí** |
| `source` | `web` | `admin` |

**200:** `{ ok: true, data: { cancelToken, mensaje } }`

## `PUT /api/admin/reservas/:id`

Reprograma. Body `{ fecha, hora, servicioId? }`.

**Conserva el `id` y el `cancelToken`.** Es la misma reserva movida de horario,
no una nueva: los links de autogestión del cliente siguen sirviendo después de
reprogramar.

Reprogramar al **mismo** horario que ya tiene es válido (no choca consigo
misma).

Sigue validando fecha real, fecha no pasada y horario de atención, con la
duración del servicio. **No** valida anticipación, igual que el alta desde el
panel.

Si el destino está ocupado, **la original queda intacta** y se devuelve 400.

| Error | Código |
|---|---|
| `Formato de fecha inválido.` / `Formato de hora inválido. Usá HH:mm.` | 400 |
| `No se puede agendar un turno en el pasado.` | 400 |
| `El horario elegido está fuera del horario de atención.` | 400 |
| `Servicio inválido.` | 400 |
| `Lo sentimos, este turno acaba de ser reservado por alguien más.` | 400 |
| `Prohibido` | 403 |
| `Reserva no encontrada.` — inexistente, de otro barbero, o ya cancelada | 404 |

## `DELETE /api/admin/reservas/:id`

Cancela. **Soft delete**: la fila queda con `estado: "cancelada"` y
`cancelada_at`. Nunca se borra.

El slot **vuelve a estar disponible** inmediatamente.

**200:** `{ ok: true, data: null }`

| Error | Código |
|---|---|
| `Prohibido` | 403 |
| `Reserva no encontrada.` | 404 |

## `POST /api/admin/reservas/importar`

**Solo `owner`.** Un `barbero` recibe 403.

Body: `{ filas: [...] }` o directamente un array. Cada fila tiene la forma de
`POST /api/reservas`. **Máximo 500 por request.**

Las filas del import **saltean** la fecha pasada y el horario de atención — son
datos históricos, y el horario de hace un año no es el de hoy. **El
solapamiento se valida igual.**

**No dispara Google Calendar ni WhatsApp.**

**200:**

```json
{ "ok": true, "data": {
  "importadas": 3, "salteadas": 2,
  "errores": [
    { "fila": 3, "motivo": "Lo sentimos, este turno acaba de ser reservado por alguien más." },
    { "fila": 5, "motivo": "Revisá el teléfono. Tiene que ser un número argentino válido con código de área." }
  ]
} }
```

**Una fila que falla no aborta el lote.** `fila` es 1-based sobre el array que
mandaste, para poder ubicarla en el archivo original.

| Error | Código |
|---|---|
| `Prohibido` | 403 |
| `No se pueden importar más de 500 filas por vez.` | 400 |
| `Se esperaba una lista de reservas.` | 400 |

## Bloquear + Avisar — el 409 con lista

Cinco operaciones de configuración pueden dejar turnos ya agendados sin
cobertura. En vez de aplicarse y romper la agenda en silencio, devuelven
**409 con la lista de turnos en conflicto** en `data`:

```json
{
  "ok": false,
  "error": "Hay 2 turno(s) que quedarían fuera del nuevo horario. Reagendalos o cancelalos antes de cambiar el horario.",
  "data": [
    { "id": "0193...", "fecha": "2026-08-24", "hora": "18:00",
      "nombre": "Juan Pérez", "telefono": "3416513207",
      "servicio": "Corte", "duracionMin": 30 }
  ]
}
```

**Mostrá la lista.** Es lo que le permite al dueño saber qué reagendar; un
"no se pudo" pelado lo deja adivinando.

**Cuando hay 409, el cambio NO se aplicó.** Nada quedó a medias.

| Operación | Mensaje |
|---|---|
| Cambiar el horario de un día | `Hay {n} turno(s) que quedarían fuera del nuevo horario. Reagendalos o cancelalos antes de cambiar el horario.` |
| Editar un bloque puntual | el mismo |
| Cerrar una fecha | `Hay {n} turno(s) ese día. Reagendalos o cancelalos antes de marcarlo como cerrado.` |
| Desactivar un barbero | `No se puede desactivar: el barbero tiene {n} turno(s) futuro(s). Reagendalos o cancelalos antes de desactivarlo.` |
| Borrar un barbero | `No se puede borrar: el barbero tiene {n} turno(s) futuro(s). Reasignalos o cancelalos antes de borrarlo.` + ` Además tiene clientes recurrentes asociados que se perderían.` |

**Qué cuenta como conflicto:** solo turnos de cliente **futuros y activos**. No
cuentan los bloqueos administrativos, ni las reservas canceladas, ni los turnos
pasados.

**El último dueño es un 409 aparte, sin lista**: no es un problema de turnos
sino de acceso al panel. Ver [`/api/admin/barberos`](#apiadminbarberos).

---

## `GET /api/admin/horarios`

Bloques semanales del barbero. `?barberoId=` sigue las reglas de scoping.

**200:**

```json
{ "ok": true, "data": [
  { "id": "0193...", "dow": 1, "activo": 1, "horaInicio": 9, "horaFin": 20 }
] }
```

`dow`: **0 = domingo … 6 = sábado**. `horaInicio`/`horaFin` son **enteros**, no
`"HH:mm"`.

**Varias filas con el mismo `dow` = horario cortado** (mañana y tarde).

⚠️ **Devuelve lo que hay, sin inventar.** Un barbero sin horarios devuelve
`[]`, y ese barbero **no acepta ninguna reserva** — no está "abierto siempre".
Un barbero creado por el panel nace con lunes a sábado de 9 a 20.

## `PUT /api/admin/horarios/dia/:dow`

Reemplaza **todos** los bloques de ese día.

Body: `{ bloques: [{ horaInicio, horaFin, activo? }] }` o el array directo.
`activo` default `true`. **Una lista vacía deja el día cerrado.**

`horaFin` tiene que ser **mayor** que `horaInicio`, los dos enteros entre 0 y 24.

**409** si algún turno futuro de ese día de la semana queda fuera. Un bloque con
`activo: false` no cubre nada.

**200:** la lista completa de horarios ya actualizada.

| Error | Código |
|---|---|
| `Día de la semana inválido. Usá 0 (domingo) a 6 (sábado).` | 400 |
| `Horario inválido. La hora de fin tiene que ser mayor que la de inicio, y las dos entre 0 y 24.` | 400 |
| `Se esperaba una lista de bloques.` | 400 |

## `PUT /api/admin/horarios/:id`

Edita un bloque puntual. Body `{ horaInicio, horaFin, activo? }`.

El 409 se calcula sobre el día **completo** después del cambio: si otro bloque
del mismo día sigue cubriendo el turno, no hay conflicto.

| Error | Código |
|---|---|
| `Bloque de horario no encontrado.` | 404 |

## `GET /api/admin/feriados`

Query: `anio` (default: el actual), `barberoId`.

**200:**

```json
{ "ok": true, "data": {
  "anio": 2026,
  "nacionales": [{ "fecha": "2026-05-01", "nombre": "Día del Trabajador", "tipo": "inamovible" }],
  "propios": [{ "id": "0193...", "fecha": "2026-08-24", "trabaja": 0, "motivo": "Vacaciones" }]
} }
```

⚠️ **Son dos cosas distintas y llegan separadas a propósito.**

- **`nacionales`** — informativos. **No cierran la barbería.** Vienen de una API
  externa; si está caída llega `[]` y `propios` igual funciona.
- **`propios`** — lo que sí afecta la agenda. `trabaja: 0` cierra la fecha.

El frontend tiene que poder mostrar "es feriado nacional pero abrimos" y
"cerramos aunque no sea feriado": los dos casos existen.

## `POST /api/admin/feriados`

Body `{ fecha, trabaja, motivo?, barberoId? }`. **Upsert** por
`(barbero, fecha)`: mandarlo dos veces actualiza, no duplica.

⚠️ **`trabaja: true` NO abre un día sin horario configurado.** Solo evita que un
`trabaja: false` lo cierre — es un booleano, no trae horas.

**409** al cerrar (`trabaja: false`) una fecha con turnos. Abrir nunca da 409.

| Error | Código |
|---|---|
| `trabaja es obligatorio y tiene que ser true o false.` | 400 |
| `Formato de fecha inválido. Usá YYYY-MM-DD.` | 400 |

## `DELETE /api/admin/feriados/:id`

Borra el override. Nunca da 409: quitar un cierre solo puede **abrir** un día.

| Error | Código |
|---|---|
| `Feriado no encontrado.` | 404 |

---

## `POST /api/admin/bloqueos`

Bloquea un slot sin que sea el turno de nadie: un turno médico, un almuerzo.

Body `{ fecha, hora, motivo?, duracionMin?, barberoId? }`. `duracionMin`
default 30.

Crea una fila en `reservas` con `tipo: "bloqueo"`. **Ocupa el slot igual que un
turno** en `/api/disponibilidad`, y **no aparece** en
`GET /api/admin/reservas`.

**200:** `{ ok: true, data: null }`

| Error | Código |
|---|---|
| `Ya existe una reserva en ese horario.` | 400 |
| `Formato de fecha inválido.` / `Formato de hora inválido. Usá HH:mm.` | 400 |

---

# Clientes (tarea 3.3)

El **scoping es por pertenencia, no por una columna**: un `barbero` ve los
clientes que atendió al menos una vez, calculado con un `EXISTS` sobre
`reservas`. Un cliente no "es de" nadie. Un `owner` ve todos.

## `GET /api/admin/clientes`

Query: `skip` (≥ 0), `limit` (1–100), `barberoId` (solo `owner`).

**200:**

```json
{
  "ok": true,
  "data": {
    "items": [
      { "id": "…", "nombre": "Juan", "telefono": "+5493416513207",
        "email": null, "notas": null, "createdAt": "2026-08-17T12:00:00.000Z" }
    ],
    "total": 1, "skip": 0, "limit": 100
  }
}
```

## `GET /api/admin/clientes/exportar`

**No devuelve el sobre**: devuelve un CSV.

```
content-type: text/csv; charset=utf-8
content-disposition: attachment; filename="clientes-2026-08-17.csv"
```

Está armado **para Excel**, que es donde lo va a abrir el dueño: lleva BOM
UTF-8 (sin él, Excel en Windows muestra `PÃ©rez`), separador **`;`** (con coma,
Excel en español mete todo en una columna) y saltos CRLF. Todos los campos van
citados, porque `"López, Juan"` es un nombre normal.

Tope: 10.000 filas.

## `GET /api/admin/clientes/:id/historial`

Query: `skip`, `limit` (máx. 200). Un `barbero` ve **solo sus turnos** con ese
cliente, no el historial completo del cliente con otros barberos.

**200:** `{ items: [{ id, fecha, hora, servicio, estado, barberoId }], total, skip, limit }`

**404** `Cliente no encontrado.` — también cuando el cliente existe pero no es
de los suyos.

## `POST /api/admin/clientes`

**Solo `owner`.** Body `{ nombre, telefono?, email?, notas? }`.

| Error | Código |
|---|---|
| `Solo los dueños pueden crear clientes.` | **403** |
| `Ya existe un cliente con ese teléfono.` | 400 |
| `Revisá el teléfono. Tiene que ser un número argentino válido con código de área.` | 400 |

## `POST /api/admin/clientes/importar`

**Solo `owner`.** Body: lista, o `{ filas: [...] }`. Máximo **1.000**.

Dedup por **teléfono normalizado**: `"0341 15 6513207"` y
`"+54 9 341 651-3207"` son el mismo cliente. Los que ya existen se cuentan como
**salteados**, no como error — en una planilla exportada de otro sistema es lo
normal.

**200:** `{ importados, salteados, errores: [{ fila, motivo }] }`

| Error | Código |
|---|---|
| `Solo los dueños pueden importar clientes.` | **403** |
| `No se pueden importar más de 1000 clientes por vez.` | 400 |

---

# Catálogos y configuración (tarea 3.4)

## Solo dueños — el 403 que no es 401

Todo lo de esta sección es **solo `owner`**, salvo `GET /api/admin/negocio` y
`GET /api/admin/stats`.

🐛 **El rechazo es `403`, no `401`.** El sistema viejo devuelve 401 y está mal:
el usuario **está** autenticado, lo que le falta es permiso. Un 401 le dice al
frontend "volvé a loguearte", y volver a loguearse no cambia nada — el barbero
sigue sin ser dueño y el panel queda en loop de login.

```json
{ "ok": false, "error": "Prohibido" }
```

Sin cookie o con sesión vencida sí es **401**: ahí lo que falta es autenticarse.

## `/api/admin/barberos`

| Método | Ruta | Devuelve |
|---|---|---|
| GET | `/api/admin/barberos` | lista completa |
| POST | `/api/admin/barberos` | el barbero creado |
| PUT | `/api/admin/barberos/:id` | el barbero actualizado |
| DELETE | `/api/admin/barberos/:id` | `null` |

Los barberos **son los usuarios del panel**: el `slug` es el nombre de usuario
del login.

```json
{ "id": "…", "slug": "gaby", "nombre": "Gaby", "tel": null,
  "rol": "owner", "activo": 1, "orden": 0,
  "tienePassword": true, "createdAt": "…" }
```

`passwordHash` **nunca** sale. En su lugar va `tienePassword`, que es lo único
que el panel necesita saber.

**⚠️ Este listado incluye a los desactivados**, a diferencia del resto del
sistema. Es deliberado: el panel es donde se los reactiva. `GET /api/barberos`
(el público) sí filtra.

**POST** `{ slug, nombre, password?, rol?, tel?, orden?, activo? }`
- `slug`: minúsculas, `a-z 0-9 -`, 3 a 40 caracteres. Se normaliza solo.
- `password` es **opcional**: se puede crear el barbero para la agenda y darle
  acceso al panel después, o nunca. Mínimo 12 caracteres si viene.
- El barbero **nace con horario**: 7 días de 9 a 20, domingo inactivo. Sin eso
  no aparecería en la disponibilidad y nadie entendería por qué.

**PUT** es parcial: solo toca los campos presentes.

### 🔴 El último dueño

Tres operaciones dejarían el panel sin nadie que pueda entrar, y las tres dan
**409**:

| Operación | Mensaje |
|---|---|
| desactivar al único owner activo | `No se puede desactivar: es el único dueño y el panel quedaría sin acceso. Nombrá dueño a otro barbero antes.` |
| borrarlo | `No se puede borrar: …` |
| cambiarle el rol a `barbero` | `No se puede quitarle el rol de dueño: es el único que queda y el panel quedaría sin acceso. …` |

Un owner **desactivado no cuenta** como respaldo: no puede loguearse.

**Lo mejor es que el panel ni ofrezca el botón** cuando queda un solo dueño.
El 409 es la red, no la interfaz.

Además, desactivar o borrar a **cualquier** barbero con turnos futuros dispara
[Bloquear + Avisar](#bloquear--avisar--el-409-con-lista) con la lista.

| Error | Código |
|---|---|
| `Ya existe un barbero con ese usuario. Elegí otro.` | 400 |
| `El usuario solo puede tener letras, números y guiones, y al menos 3 caracteres.` | 400 |
| `Barbero no encontrado.` | 404 |

## `/api/admin/servicios`

GET / POST / PUT `:id` / DELETE `:id`. `nombre` es **único**.

```json
{ "id": "…", "nombre": "Corte", "duracionMin": 30,
  "precioCentavos": 800000, "incluye": null, "activo": 1, "orden": 0 }
```

- `duracionMin`: entero, 5 a 480.
- `precioCentavos`: entero ≥ 0. **Son centavos**: `800000` es $8.000. Un
  decimal se rechaza.
- Igual que barberos, el listado **incluye los desactivados**.

### ⚠️ El `warning` de la duración — mostralo sí o sí

Si el `PUT` cambia `duracionMin`, la respuesta trae:

```json
{ "ok": true, "data": { … }, "warning": "La nueva duración se aplica solo a los turnos que se creen de ahora en adelante. Los turnos ya agendados conservan la duración con la que se reservaron." }
```

Cada reserva guarda su **propia copia** de la duración, así que cambiar el
servicio no mueve ni un turno ya agendado. Es lo correcto —nadie quiere que le
corran la agenda de la semana por editar un precio— pero **no es obvio**: quien
alarga el corte de 30 a 45 minutos espera que mañana se reacomode solo, y no
va a pasar. Si el panel se come el `warning`, el dueño se entera el día del
turno.

Sólo aparece cuando la duración **cambió de verdad**; reenviar la misma no
avisa.

| Error | Código |
|---|---|
| `Ya existe un servicio con ese nombre. Elegí otro.` | 400 |
| `Duración inválida. Tiene que ser un número entero de minutos entre 5 y 480.` | 400 |
| `Servicio no encontrado.` | 404 |

## `/api/admin/promos` y `/api/admin/catalogo`

Las dos son la **vidriera**: se muestran y no participan de ninguna regla de
negocio. Nadie *reserva* una promo — lo reservable es `servicios`.

Por eso **no** tienen nombre único (dos promos "2x1" en meses distintos son
válidas) ni chequeos de conflicto.

GET / POST / PUT `:id` / DELETE `:id` en las dos.

- **promo**: `{ id, nombre, precioCentavos, unidad, nota, badge, activo, orden }`
- **catálogo**: `{ id, nombre, incluye, precioCentavos, activo, orden }` —
  `incluye` es `""` cuando está vacío, nunca `null`.

Orden del listado: `orden`, y a igualdad, `nombre`.

## `/api/admin/negocio`

**`GET`: cualquier usuario autenticado** — el panel arranca leyendo esto.
**`PUT`: solo `owner`**, y es parcial.

```json
{ "id": 1, "nombreNegocio": "Barbería Gebyanos",
  "slotDuracionMin": 30, "minutosAnticipacionMin": 30,
  "diasMaxAnticipacion": 14,
  "logoUrl": null, "colorPrimario": null, "colorSecundario": null }
```

Rangos, **inclusivos en los dos extremos**:

| Campo | Rango |
|---|---|
| `slotDuracionMin` | 5 a 240 |
| `minutosAnticipacionMin` | 0 a 10080 (una semana) |
| `diasMaxAnticipacion` | 1 a 365 |

### 🔴 `timezone` no existe en esta API

**No sale en la respuesta y no se puede mandar en el `PUT`.** Mandarla da 400:

```json
{ "ok": false, "error": "La zona horaria no es configurable: el sistema opera siempre en hora de Argentina." }
```

La columna sigue en la base pero es informativa: el cálculo de fechas tiene la
zona de Argentina fija en el código. Se sacó de la API justamente para que
nadie le crea — un campo que se guarda y no hace nada es peor que uno que no
está, porque alguien lo cambia, lo ve guardado y da por hecho que funcionó.

**No pongas un selector de zona horaria en el panel.**

Cambiar `slotDuracionMin` devuelve un `warning`: los turnos ya agendados
conservan su horario aunque no coincida con la grilla nueva.

| Error | Código |
|---|---|
| `slot_duracion_min inválido. Tiene que ser un número entero entre 5 y 240.` | 400 |
| `minutos_anticipacion_min inválido. … entre 0 y 10080.` | 400 |
| `dias_max_anticipacion inválido. … entre 1 y 365.` | 400 |
| `Zona horaria inválida. Usá un identificador IANA, por ejemplo America/Argentina/Buenos_Aires.` | 400 |

## `GET /api/admin/stats`

Scoped igual que la agenda: un `barbero` cuenta lo suyo y **no puede pedir** las
de otro (403). Un `owner` cuenta todo, o filtra con `?barberoId=`.

```json
{ "ok": true, "data": {
  "hoy": 4, "semana": 21, "mes": 88, "recurrentesActivos": 6,
  "rango": { "hoy": "2026-08-17", "semanaDesde": "2026-08-17",
             "semanaHasta": "2026-08-23", "mesDesde": "2026-08-01",
             "mesHasta": "2026-08-31" }
} }
```

Cuenta **turnos activos de cliente**: ni cancelados —no son un compromiso con
nadie— ni bloqueos administrativos, que son huecos que el barbero se reserva y
contarlos inflaría el número del día.

**"La semana" es la semana calendario, de lunes a domingo**, no los próximos 7
días: incluye el lunes y el martes que ya pasaron. El `rango` viene en la
respuesta para que el panel muestre los límites sin recalcularlos.

---

# Avisos de WhatsApp que no salieron (tarea 4.2)

## `GET /api/admin/avisos-fallidos`

Los avisos que agotaron los reintentos. Scoped por rol; un `owner` ve también
los huérfanos (los de un barbero que fue borrado). Máximo 100, del más nuevo al
más viejo.

```json
{ "ok": true, "data": [
  { "id": "…", "reservaId": "…", "tipo": "creada",
    "motivo": "APIKey is invalid",
    "intentos": 3,
    "resumen": "Juan Pérez — Corte — 2027-04-01 10:30",
    "createdAt": "2026-08-18T12:00:00.000Z" }
] }
```

**`motivo` es el texto crudo de CallMeBot y hay que mostrarlo tal cual.** Es lo
que hace accionable el registro: `not registered` se arregla registrando el
número en el bot, `APIKey is invalid` renovando la key. Un "falló" genérico no
le sirve a nadie.

`resumen` no depende de ninguna FK, así que la fila sigue diciendo de qué turno
hablaba aunque la reserva o el barbero ya no existan.

## `DELETE /api/admin/avisos-fallidos/:id`

Descartar = borrar. Es un tablero de pendientes, no un historial.

Un `barbero` solo descarta los suyos (404 si no). Los huérfanos son del `owner`.

---

## Sobre el envío en sí

**El endpoint encola y responde: nunca espera a CallMeBot.** Si el proveedor
está caído, el que espera no es el cliente que acaba de reservar.

⚠️ **CallMeBot devuelve HTTP 200 aunque el envío falle**, y describe el error en
el cuerpo. El sistema lo detecta parseando el texto; el frontend no participa de
esto, pero conviene saberlo al leer los `motivo`.

Los tres títulos salen de un **tipo explícito**, no de buscar palabras dentro
del texto como hacía el sistema viejo:

| Tipo | Título |
|---|---|
| `creada` | `✅ Nueva reserva:` |
| `recurrente` | `✅ Nueva reserva:` |
| `cancelada` | `❌ Turno cancelado:` |
| `modificada` | `✏️ Turno modificado:` |

`recurrente` comparte título con `creada` a propósito: para el barbero es una
reserva nueva igual, y se distingue por la nota.

---

# `/api/admin/callmebot` (tarea 4.3)

Configuración de WhatsApp por barbero. Scoped como la agenda: un barbero
configura la suya, el `owner` la de cualquiera con `?barberoId=`.

## 🔴 La API key NUNCA sale en una respuesta

Ni en el `GET`, ni en el `PUT`, ni en el mensaje de error del `test`.

```json
{ "ok": true, "data": {
  "barberoId": "…",
  "telefono": "+5493416513207",
  "tieneApikey": true,
  "pistaApikey": "••••9876"
} }
```

`pistaApikey` son los **últimos 4 caracteres de la key en claro** — alcanzan
para que el barbero reconozca cuál cargó, no para usarla. Devolver la key
entera "para que pueda verificarla" convierte cualquier XSS en el panel en una
filtración de credenciales.

En la base se guarda cifrada con AES-GCM, formato `v1:<iv>:<ciphertext>`. Un
`SELECT` no la muestra.

## `PUT /api/admin/callmebot`

Body `{ telefono?, apikey?, barberoId? }`. **Es parcial**, y la distinción
importa:

| Campo | Efecto |
|---|---|
| ausente | no se toca |
| `null` o `""` | se borra |
| un valor | se reemplaza |

El panel **no tiene** la key —nunca se la devolvimos— así que no puede
reenviarla. Si el `PUT` parcial la borrara, sería imposible editar el teléfono
sin perder la key.

`telefono` tiene que ser formato internacional (`^\+?\d{7,15}$`), si no da 400
con `Número inválido. Usá formato internacional, ej: +5491122334455 (país 54 +
9 + área + número).`

## `POST /api/admin/callmebot/test`

Manda un mensaje de prueba y devuelve **el resultado real del envío**.

```json
{ "ok": true, "data": { "enviado": false, "motivo": "APIKey is invalid. Please create a new one" } }
```

**Responde 200 aunque el envío falle**, con `enviado: false`. La operación de
diagnóstico funcionó; lo que falló es el envío. Un 500 haría pensar que se
rompió el panel.

**Mostrá el `motivo` tal cual.** Es la herramienta de diagnóstico del barbero:
`not registered` se arregla registrando el número en el bot, `APIKey is
invalid` renovando la key. El motivo viene con la key y los teléfonos ya
redactados.

Sin configurar da 400 con `Configurá primero el número y la API key de
CallMeBot para poder probarlos.` y no dispara ningún request.

---

# Autogestión del cliente — `/api/mi-turno` (tarea 5.1)

**El teléfono es toda la credencial.** No hay password. Por eso los rate limits
de esta sección son la defensa principal y el TTL del token es de 15 minutos.

## El flujo

```
1. POST /api/mi-turno/buscar        { telefono }        → lista de turnos
2. POST /api/mi-turno/access-link   { reservaId, telefono } → { token }
3. GET  /api/mi-turno?token=…                           → el turno
4. PUT  /api/mi-turno?token=…       { fecha, hora }      → reprogramado
5. POST /api/mi-turno/cancel?token=…                    → cancelado
```

| Endpoint | Límite / 15 min | Token |
|---|---|---|
| `POST /buscar` | 10 | — |
| `POST /access-link` | 20 | — |
| `GET /` | 30 | multi-uso |
| `PUT /` | 10 | multi-uso |
| `POST /cancel` | 10 | **single-use** |

Ver y reprogramar son **multi-uso** para que el cliente pueda refrescar la
pantalla sin quemar el link. Cancelar es **single-use** porque es irreversible.

## 🔴 `buscar` no devuelve el `cancel_token`

El sistema viejo lo hace y eso convierte la búsqueda en una puerta trasera: con
un teléfono alcanzaría para cancelar sin pasar nunca por el magic link. La
respuesta trae solo lo necesario para identificar el turno y pedir el link.

## 🔴 `access-link` devuelve el mismo 401 para todo

`No autorizado.` tanto si el teléfono no coincide como si la reserva no existe.
Distinguirlos convertiría el endpoint en un oráculo de qué reservas existen.

## Los errores del token

Todos dan **401** con el motivo exacto del paso que falló:

| Mensaje | Cuándo |
|---|---|
| `Token vacío` | no vino |
| `Formato de token inválido` | no son exactamente dos partes |
| `Firma inválida` | firma o payload alterados |
| `Payload inválido` | JSON roto o incompleto |
| `Token expirado` | por el `exp` firmado **o** por la fila |
| `Token no encontrado` | firma válida, sin fila |
| `Token revocado` | el turno se canceló |
| `Token ya utilizado` | link de cancelación reusado |

**Después de cancelar, todos los links anteriores quedan revocados** — menos el
que se usó, que sigue diciendo `Token ya utilizado`. Cada token dice la verdad
sobre sí mismo.

---

# `/api/admin/recurrentes` (tarea 5.2)

| Método | Ruta |
|---|---|
| GET / POST | `/api/admin/recurrentes` |
| PUT / DELETE | `/api/admin/recurrentes/:id` |
| PATCH | `/api/admin/recurrentes/:id/activo` |
| POST | `/api/admin/recurrentes/:id/generar` |

El listado trae `proximoTurno` y `ultimoTurnoReal` **derivados de `reservas`**,
no del campo `ultimoTurnoFecha`. Ese campo dice cuándo generó el sistema, no lo
que hay en la agenda: si el turno se canceló o se movió, el campo miente.

## ⏭️ El warning NO bloqueante

Borrar o desactivar un recurrente con turnos futuros ya generados devuelve
**200 con `warning`**, no 409:

```json
{
  "ok": true,
  "data": { "turnosFuturosCount": 2, "turnosFuturos": [...] },
  "warning": "El recurrente fue eliminado pero quedan 2 turno(s) futuro(s) agendado(s) que no se cancelaron automáticamente."
}
```

**Es el único de los cinco casos de Bloquear+Avisar que no bloquea**, y la
razón importa: esos turnos son compromisos con clientes reales. Borrar la regla
de recurrencia no debería cancelarlos. Bloquear obligaría al dueño a cancelar
turnos de gente que no pidió nada solo para dar de baja una regla.

**El panel tiene que mostrar el warning y la lista.** La operación ya se hizo;
lo que queda es una decisión humana sobre esos turnos.

## `POST /:id/generar`

Body opcional `{ fecha }`. **Con fecha explícita no corre el loop de 5 ciclos**:
el operador ya eligió el día y el sistema no se lo mueve.

| Error | Código |
|---|---|
| `Recurrente no válido o inactivo.` | 400 |
| `Cliente no tiene hora preferida.` | 400 |
| `Slot Ocupado. Intente mover manualmente.` | 409 |
| `No se generó: {motivo} Mové la fecha/hora manualmente.` | 400 |
