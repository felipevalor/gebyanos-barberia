# Fase 5 — Magic links y recurrentes

> Requiere `00-CONTEXTO.md` cargado y la **Fase 4 terminada**.
> **Criterio de salida:** un cliente cancela su turno con un link sin haberse registrado nunca, y los turnos recurrentes se generan solos.

Dos features independientes. La primera es la que más cuida la seguridad; la segunda es la que el sistema viejo nunca terminó.

---

## Tarea 5.1 — Magic links

Cómo un cliente consulta y modifica su turno **sin tener cuenta**.

### El modelo de seguridad, en una frase

**El teléfono es la credencial.** No hay password ni otro secreto. Por eso los rate limits de esta sección son la única defensa contra enumeración, y por eso el TTL es corto.

Tenelo presente al implementar: cada decisión de acá está calibrada para que conocer un número de teléfono no alcance para hacer daño a escala.

### Formato del token

`{base64url(payloadJson)}.{base64url(hmacSha256)}` — un JWT minimalista sin header, firmado con HMAC-SHA256 vía `crypto.subtle`.

**Payload:**

```json
{ "jti": "uuid", "rid": "uuid-de-la-reserva", "exp": 1234567890, "purpose": "access" }
```

`exp` en epoch **segundos**. TTL default **15 minutos**.

La clave de firma viene de un secret (`MAGIC_LINK_SIGNING_KEY`), mínimo 32 caracteres. **Validá al arrancar** que exista y tenga largo suficiente; si no, falla el arranque. El sistema viejo hace exactamente esto y evita que una mala configuración llegue a producción con tokens forjables.

### Validación, en este orden exacto

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

**El paso 3 va antes de tocar la base, a propósito.** Un token forjado nunca llega a hacer una query — eso previene que alguien use los tiempos de respuesta para sondear qué `jti` existen.

Usá `crypto.subtle.verify`, que ya es constant-time:

```ts
const valida = await crypto.subtle.verify('HMAC', key, firmaRecibida, payloadBytes);
```

**No compares strings de firma con `===`.** Filtra información por timing.

**La fila en la base es la fuente de verdad final.** La firma solo prueba autoría; la revocación, la expiración real y el consumo viven en la tabla. Los pasos 5 y 8 chequean lo mismo dos veces a propósito: defensa en profundidad.

### Los cinco endpoints

| Endpoint | Rate limit | Single-use | Qué hace |
|---|---|---|---|
| `POST /api/mi-turno/buscar` | 10 | — | Busca turnos futuros por teléfono |
| `POST /api/mi-turno/access-link` | 20 | — | Emite el token. **Acá va el control de ownership** |
| `GET /api/mi-turno?token=` | 30 | ❌ multi-uso | Ver el turno |
| `PUT /api/mi-turno?token=` | 10 | ❌ multi-uso | Reprogramar |
| `POST /api/mi-turno/cancel?token=` | 10 | ✅ **single-use** | Cancelar |

**Ver y reprogramar son multi-uso** para que el cliente pueda refrescar la pantalla sin quemar el link. **Cancelar es single-use** porque es irreversible.

### El control de ownership

En `access-link`: normalizar el teléfono recibido y compararlo con `reserva.telefono`. Si no coincide → **`401 No autorizado.`**

Es todo el control de acceso de este flujo. De ahí la importancia de los rate limits.

### Buscar por teléfono

Body `{ telefono, nombre? }`. Requiere teléfono (si falta: `El teléfono es obligatorio.`).

Normalizar y buscar reservas **activas y futuras** (`fecha >= hoy AND estado = 'activa'`).

**No devuelvas el `cancel_token` en esta respuesta.** El sistema viejo lo hace y es una fuga: cualquiera con un teléfono y un nombre podría cancelar sin pasar por el magic link. Devolvé solo lo necesario para que el cliente identifique su turno y pida el link.

### Cancelar

1. Validar el token consumiéndolo.
2. Si el turno ya pasó → `400 No se puede cancelar un turno pasado.`
3. Borrar el evento de Calendar (best-effort).
4. **Revocar TODOS los tokens vivos de esa reserva**, no solo el usado (`revoked_at = now`). Si no, un link viejo en el historial del browser sigue sirviendo.
5. `estado = 'cancelada'`, `cancelada_at = now`. **Soft delete, nunca `DELETE`.**
6. Notificar por WhatsApp con `TURNO CANCELADO por el cliente.`

### Reprogramar

1. Validar el token (no consume).
2. Validar formato de fecha y hora.
3. Rechazar fecha pasada: `No se puede agendar un turno en el pasado.`
4. Rechazar si la reserva original ya pasó: `No se puede editar un turno pasado.`
5. Chequear solapamiento **excluyendo la propia reserva** — vía el Durable Object. Si hay conflicto: `Ese horario ya está ocupado. Elegí otro.`
6. Actualizar fecha, hora y mensaje.
7. Reprogramar el evento de Calendar.
8. Notificar por WhatsApp con `Turno reagendado por el cliente.`

**El paso 5 es donde se equivoca la gente:** si no excluís la reserva que estás editando, siempre va a chocar consigo misma.

**Criterios de aceptación:**

- [ ] Los 10 pasos de validación se ejecutan en orden y cada mensaje coincide
- [ ] Un token con la firma alterada da `Firma inválida` **sin hacer ninguna query**
- [ ] Un token expirado por payload y uno expirado por fila dan el mismo error
- [ ] Cancelar dos veces con el mismo token: la segunda da `Token ya utilizado`
- [ ] Ver el turno dos veces con el mismo token funciona (multi-uso)
- [ ] Después de cancelar, un link emitido antes queda revocado
- [ ] Pedir un access-link con el teléfono de otro da 401
- [ ] La búsqueda por teléfono **no** devuelve el `cancel_token`
- [ ] Reprogramar al mismo horario que ya tiene no da conflicto consigo misma
- [ ] Cancelar deja `estado = 'cancelada'`, la fila sigue en la base
- [ ] El slot cancelado vuelve a estar disponible
- [ ] Sin `MAGIC_LINK_SIGNING_KEY` o con menos de 32 caracteres, el arranque falla

---

## Tarea 5.2 — Clientes recurrentes

| Método | Ruta | Rol |
|---|---|---|
| GET | `/admin/api/recurrentes` | scoped |
| POST | `/admin/api/recurrentes` | scoped |
| PUT | `/admin/api/recurrentes/:id` | dueño u owner |
| DELETE | `/admin/api/recurrentes/:id` | dueño u owner |
| PATCH | `/admin/api/recurrentes/:id/activo` | dueño u owner |
| POST | `/admin/api/recurrentes/:id/generar` | dueño u owner |

### Generación manual

Usa `calcularProximaFecha` de la Fase 1 (tarea 1.6).

**Precondiciones:**

1. El recurrente existe y está `activo` → si no: `Recurrente no válido o inactivo.`
2. El caller es el dueño o `owner` → si no: **403**
3. Tiene `hora_preferida` → si no: `Cliente no tiene hora preferida.`

**Si se pasa una fecha explícita**, se usa esa y solo se valida disponibilidad puntual, sin el loop de 5 ciclos. Si está cerrada: `No se generó: {motivo} Mové la fecha/hora manualmente.`

**Al crear el turno:** pasa por el Durable Object del barbero. Si hay solapamiento: `Slot Ocupado. Intente mover manualmente.`

El turno queda con `source = 'admin'` y `turno_auto_fecha` = la fecha calculada (para auditoría). Actualizar `ultimo_turno_fecha` del recurrente.

Notificar por WhatsApp con `Tu turno recurrente ha sido cargado.`

### El listado

Enriquecelo con el próximo y el último turno **reales** (derivados de `reservas`), no solo con `ultimo_turno_fecha`. Es lo que el operador necesita ver para entender el estado de cada cliente.

### Borrado y desactivación

Aplican los warnings no bloqueantes de la Fase 3 (tarea 3.2): si quedan turnos futuros ya generados, devolver 200 con el warning y la lista.

**Criterios de aceptación:**

- [ ] La generación manual usa el algoritmo de la Fase 1 sin duplicar lógica
- [ ] Un recurrente inactivo no genera
- [ ] Sin `hora_preferida` no genera y da el mensaje exacto
- [ ] Un `barbero` no puede generar para el recurrente de otro (403)
- [ ] Con fecha explícita, no corre el loop de 5 ciclos
- [ ] El turno generado queda con `source = 'admin'` y `turno_auto_fecha` seteado
- [ ] `ultimo_turno_fecha` se actualiza después de generar
- [ ] El listado muestra el próximo turno real, no solo el último registrado

---

## Tarea 5.3 — Generación automática de recurrentes

🆕 **Esto el sistema viejo nunca lo tuvo.** Hoy un humano tiene que apretar el botón para cada cliente, uno por uno. Está listado como pendiente en `docs/EDGE_CASES.md`.

En Cloudflare es un Cron Trigger y es una de las mejores relaciones esfuerzo/valor de todo el proyecto.

### El cron

`0 9 * * *` — todos los días a las 9 (hora UTC; ajustá si querés las 9 de Argentina).

Lógica:

1. Traer todos los `clientes_recurrentes` con `activo = 1`.
2. Para cada uno, calcular la próxima fecha con `calcularProximaFecha`.
3. **Si la próxima fecha cae dentro de los próximos 14 días**, generar el turno.
4. Si no, saltear — todavía es temprano, se genera en una corrida futura.

### Por qué 14 días — decisión tomada

**Anticipación: 14 días**, alineada con `negocio.dias_max_anticipacion`.

El razonamiento: el turno del recurrente se crea apenas entra en la ventana en que cualquiera podría reservar. Así **el cliente recurrente tiene su lugar asegurado** — nadie se lo puede tomar porque ya está ocupado.

Si se generara con menos anticipación (2 o 7 días), el horario habitual del recurrente quedaría libre para clientes ocasionales durante días, y el recurrente podría perder su lugar de siempre. Que es justamente lo que se quiere evitar teniendo recurrentes.

**Usá el valor de `negocio.dias_max_anticipacion`, no un 14 hardcodeado.** Si el negocio cambia su ventana de reserva, la generación de recurrentes tiene que seguirla.

### Idempotencia: la parte crítica

**El cron va a correr todos los días. Sin idempotencia, genera un turno duplicado por día.**

Antes de crear, verificá que no exista ya un turno para ese recurrente en ese ciclo. Dos formas:

- Chequear que no haya una reserva activa con el mismo `turno_auto_fecha`
- O apoyarse en `ultimo_turno_fecha`: si ya es >= la fecha calculada, no generar

Hacé las dos. El costo es una query y el beneficio es no llenarle la agenda al barbero.

### Manejo de errores

**Un recurrente que falla no debe frenar los demás.** Envolvé cada uno en su propio try/catch.

Al final, logueá un resumen: cuántos se generaron, cuántos se saltearon y **cuáles fallaron con qué motivo**. Ese log es la herramienta de diagnóstico del operador — sin él, un recurrente que dejó de generar pasa desapercibido durante semanas.

**Considerá notificar los fallos.** Si un recurrente falla 5 ciclos seguidos porque el barbero cambió su horario, alguien tiene que enterarse.

**Criterios de aceptación:**

- [ ] El cron genera turnos de los recurrentes activos que entran en la ventana
- [ ] Los inactivos se saltean
- [ ] Los que caen fuera de la ventana se saltean
- [ ] **Correr el cron dos veces el mismo día no duplica turnos**
- [ ] Un recurrente que falla no impide que los demás se generen
- [ ] El log final dice cuántos se generaron, saltearon y fallaron, con motivos
- [ ] Los turnos generados pasan por el DO y respetan el anti-doble-reserva
- [ ] El WhatsApp de turno recurrente llega

---

## Cierre de la Fase 5

- [ ] `npm test` en verde
- [ ] Flujo completo del cliente: reserva → recibe link → reprograma → cancela, sin cuenta
- [ ] El cron de recurrentes corre dos veces sin duplicar
- [ ] Los rate limits de los 5 endpoints de mi-turno están puestos

---

## Y con esto, el backend está completo

Repaso de lo que quedó funcionando:

- Reservas con anti-doble-reserva serializado por barbero
- Panel admin con dos roles y scoping
- Horarios, feriados y protección contra turnos huérfanos
- Google Calendar y WhatsApp, ambos best-effort
- Magic links para clientes sin cuenta
- Recurrentes con generación automática

**Lo que falta y quedó fuera de alcance:** el frontend (puede arrancar en paralelo desde la Fase 2), y multi-tenant si algún día vuelve.

**Antes de salir a producción,** dos cosas de la spec que no son código:

1. Rotar la credencial de Google que está en texto plano en el repo viejo (`Barberia.Api/appsettings.Development.json`).
2. Decidir si se migran los datos de producción de Azure. Si Gebyanos sigue operando allá, hay clientes y reservas reales que necesitan un script de export/import y una ventana de cutover. `Barberia.Migrator/` tiene el molde del mapeo de IDs en la dirección inversa.
