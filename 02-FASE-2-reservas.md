# Fase 2 — Reservas de punta a punta

> Requiere `00-CONTEXTO.md` cargado y la **Fase 1 terminada con tests verdes**.
> **Criterio de salida:** un cliente reserva por API, el barbero lo ve en su agenda, y el test de concurrencia demuestra que N requests simultáneos al mismo slot dejan exactamente una reserva.

Esta es la fase del invariante: **dos clientes no pueden terminar con el mismo turno.** Todo lo demás de esta fase es plomería alrededor de eso.

---

## Tarea 2.1 — Durable Object `BarberoAgenda`

**Hacé esta tarea primero y validala con el test de concurrencia antes de construir encima.**

### El problema

El sistema viejo se defiende del doble booking con una transacción SQL en `IsolationLevel.RepeatableRead` más un índice único como red. **D1 no tiene transacciones interactivas ni niveles de aislamiento** — solo `db.batch()`, que es atómico pero no permite lógica JS entre statements.

Y el flujo necesita justamente eso: leer las reservas del día, decidir en código si hay solapamiento, escribir.

### La solución

Un Durable Object por barbero. Pero **cuidado con la premisa**, porque es donde casi se cuela un doble booking real.

⚠️ **Un DO NO serializa automáticamente cuando los datos están en D1.**

Es fácil creer que sí. La garantía de "un request a la vez" viene de las *input gates*, y esas protegen las operaciones de `ctx.storage` del propio DO. **D1 no es storage del DO: es una llamada externa, igual que un `fetch()`.** En cada `await env.DB...` el event loop cede y otro request entra.

De la [documentación oficial](https://developers.cloudflare.com/durable-objects/api/state/):

> "For asynchronous KV storage operations, input gates already prevent other requests from interleaving during storage calls."
>
> "Reserve `blockConcurrencyWhile` outside the constructor for cases where you make external async calls (such as `fetch()`) and cannot tolerate state changes while the event loop yields."

Sin protección, 50 requests simultáneos leen todos la misma foto "no hay nada reservado", deciden todos que no hay solapamiento, y recién chocan en el INSERT. Para el **mismo** `(fecha, hora)` los ataja el índice único — pero **dos turnos que se solapan parcialmente no comparten esa clave** (uno de 30 min a las 10:00 contra uno de 60 min a las 09:30) y entran los dos.

**La sección crítica completa va adentro de `blockConcurrencyWhile`:**

```ts
export class BarberoAgenda extends DurableObject<Env> {
  async reservar(input: ReservaInput): Promise<ReservaResult> {
    let resultado: ReservaResult = { estado: 'error', detalle: 'sin resultado' };

    // Bloquea la entrega de cualquier otro evento hasta que termina.
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        const existentes = await this.reservasActivas(input.barberoId, input.fecha);
        const { overlap, conflicto } = checkOverlap(
          input.hora, input.duracionMin, existentes
        );
        if (overlap) { resultado = { estado: 'overlap', conflicto }; return; }

        resultado = await this.insertarReserva(input);  // el UNIQUE queda de red
      } catch (e) {
        // Una excepción que escape del callback RESETEA el DO.
        // Se atrapa adentro y se devuelve como valor.
        resultado = esColisionDeSlot(e)
          ? { estado: 'overlap', conflicto: input.hora }
          : { estado: 'error', detalle: String(e) };
      }
    });

    return resultado;
  }
}
```

**Dos detalles que no son opcionales:**

- **La excepción no puede escapar del callback.** Si se propaga, el DO se resetea. Atrapala adentro y devolvela como valor.
- **Verificá por mutación, no por confianza.** Sacá el `blockConcurrencyWhile`, corré los tests y confirmá que el de solapamiento parcial **falla**. Si pasa igual, tu test no está probando lo que creés.

El DO se direcciona con `idFromName(barberoId)`.

**Qué pasa por el DO:** toda escritura de reservas de ese barbero — crear (pública y admin), reprogramar, bloqueos administrativos, generación de recurrentes.

**Qué NO pasa por el DO:** las lecturas de solo consulta (agenda, disponibilidad, listados). Van directo a D1 para no serializar innecesariamente.

**Mantené el índice único parcial de todas formas.** Defensa en dos capas: si un bug de routing deja pasar una escritura sin el DO, el constraint la ataja. Mapeá el error de constraint de D1 (el texto que anotaste en el spike de la Fase 1) al mismo resultado `overlap`.

### El test de concurrencia

**Es el test más importante de todo el proyecto.**

- Lanzar 50 requests simultáneos al mismo `(barbero, fecha, hora)`.
- Verificar que **exactamente uno** devuelve éxito.
- Verificar que en la base quedó **exactamente una** reserva activa para ese slot.
- Los otros 49 devuelven `overlap` con el mensaje correcto.

Repetilo con dos slots que se solapan parcialmente (uno de 30 min a las 10:00 y otro de 60 min a las 09:30) — no comparten `(fecha, hora)` exacta, así que el índice único no los atrapa: los tiene que atrapar el `checkOverlap` dentro del DO.

**Criterios de aceptación:**

- [ ] 50 requests concurrentes al mismo slot → exactamente 1 reserva activa
- [ ] Dos turnos que se solapan parcialmente → el segundo se rechaza
- [ ] El error de constraint de D1 se mapea a `overlap`, no a 500
- [ ] Las lecturas de disponibilidad no pasan por el DO

---

## Tarea 2.2 — Endpoints públicos de lectura

| Método | Ruta | Devuelve |
|---|---|---|
| GET | `/api/negocio` | Nombre, timezone, branding, duración de slot |
| GET | `/api/barberos` | Barberos activos, ordenados por `orden` |
| GET | `/api/servicios` | Servicios activos con duración y precio |
| GET | `/api/promos` | Promos activas |
| GET | `/api/catalogo` | Catálogo de la landing |

Todos anónimos, todos cacheables 300 s.

**Precios:** se guardan en centavos, se exponen en la unidad que consuma el frontend. Definí la convención una vez y documentala.

**Criterios de aceptación:**

- [ ] Los 5 endpoints responden con la forma `{ ok: true, data: [...] }`
- [ ] Solo devuelven registros con `activo = 1`
- [ ] El orden respeta la columna `orden`
- [ ] Los headers de caché están puestos

---

## Tarea 2.3 — Cálculo de disponibilidad

| Método | Ruta |
|---|---|
| GET | `/api/disponibilidad?barberoId&fecha&servicioId` |
| GET | `/api/disponibilidad/mes?barberoId&anio&mes&servicioId` |

### El algoritmo del endpoint de día

Cuatro cortes tempranos y dos filtros:

1. Si `fecha < hoy` → `[]`.
2. `dow = getDay()` de la fecha. Traer bloques con ese `dow` y `activo = 1`.
3. Si no hay bloques → `[]`.
4. Traer overrides de esa fecha, combinar con `combinarOverrides`. Si da `false` → `[]`.
5. Leer `negocio`: `minutosAnticipacion` (default 30) y `slotDuracion` (default 30).
6. Generar la grilla con `generateSlotsFromBlocks(bloques, slotDuracion)`.
7. Traer reservas **activas** de ese barbero y fecha (incluyendo los bloqueos — ocupan igual).
8. Para cada slot candidato:
   - **Si `fecha === hoy`**, descartar si no cumple la anticipación. Si la fecha es futura, no se aplica.
   - Descartar si `checkOverlap(slot, duracion, reservas).overlap`.
9. Devolver los que sobrevivieron.

🐛 **Dos bugs del original a NO copiar:**

1. Genera la grilla con **30 hardcodeado**, ignorando `negocio.slot_duracion_min`, pero usa el valor configurado para el solapamiento. **Pasá `slotDuracion` en los dos lados** (pasos 6 y 8).
2. Valida el solapamiento con la **duración global** en vez de la del servicio elegido. Con un servicio de 60 min puede ofrecer un slot que pisa el siguiente. **Si viene `servicioId`, usá la duración de ese servicio** (considerando el override de `servicios_barbero` si existe).

### El endpoint de mes

Devuelve qué días del mes tienen al menos un slot libre, para que el frontend pinte el calendario. No hace falta devolver los slots de cada día — solo el flag.

**Ojo con la performance:** no llames 31 veces al endpoint de día. Traé los bloques, los overrides y las reservas del mes entero en 3 queries y calculá en memoria.

**Respetá `dias_max_anticipacion`:** los días más allá de la ventana no están disponibles aunque el horario esté abierto.

**Criterios de aceptación:**

- [ ] Fecha pasada → `[]`
- [ ] Día sin horario configurado → `[]`
- [ ] Día con feriado (`trabaja = 0`) → `[]`
- [ ] Con un servicio de 60 min, no ofrece slots que se pasen del cierre
- [ ] Hoy, los slots que no cumplen la anticipación de 30 min no aparecen
- [ ] Un turno existente de 60 min tapa dos slots de 30
- [ ] Los bloqueos administrativos ocupan el slot igual que un turno
- [ ] El endpoint de mes no hace más de 5 queries a D1
- [ ] Los días más allá de la ventana de 14 días no están disponibles

---

## Tarea 2.4 — Creación de reserva

`POST /api/reservas`. **El flujo más crítico del sistema.**

> Nota: en el sistema viejo es `POST /api/reserva` (singular) y el campo de fecha es `fechaIso`. Los contratos son libres; los **mensajes de error** son transcripción textual y hay que conservarlos.

### Validación de forma

| Campo | Regla | Mensaje |
|---|---|---|
| `barberoId` | requerido | `barberoId es obligatorio.` |
| `servicioId` | requerido | `servicioId es obligatorio.` |
| `fecha` | requerido | `fecha es obligatoria.` |
| `hora` | requerido, regex `^\d{2}:\d{2}$` | `Formato de hora inválido. Use HH:mm.` |
| `clienteNombre` | requerido, máx 100 | `clienteNombre es obligatorio.` / `El nombre no puede superar los 100 caracteres.` |
| `clienteTelefono` | requerido, máx 20 | `clienteTelefono es obligatorio.` / `El teléfono no puede superar los 20 caracteres.` |
| `mensaje` | máx 500 | `El mensaje no puede superar los 500 caracteres.` |

**Rate limit:** 10 por IP en 15 min → `429 Demasiados intentos. Intenta más tarde.`

### Las once validaciones de negocio, en orden

| # | Chequeo | Mensaje de rechazo |
|---|---|---|
| 1 | Fecha parseable `YYYY-MM-DD` | `Formato de fecha inválido.` |
| 2 | `fecha >= hoy` | `No se puede agendar un turno en el pasado.` |
| 3 | `fecha <= hoy + diasMaxAnticipacion` | `Solo se puede reservar con hasta {N} días de anticipación.` |
| 4 | Si es hoy, la hora no pasó | `No se puede agendar un turno en un horario que ya pasó.` |
| 5 | Normalizar teléfono | — |
| 6 | Barbero existe y activo | `Barbero inválido.` |
| 7 | Servicio existe | Si no, usar nombre `"Servicio"` y duración default. **No rechaza** |
| 8 | `evaluarSlot() === 'abierto'` | El mensaje de `mensajeCliente()` |
| 9 | `cumpleAnticipacion()` | `Debés reservar con al menos {N} minutos de anticipación.` |
| 10 | Hora parseable `HH:mm` | `Formato de hora inválido.` |
| 11 | Sin solapamiento — **vía el DO** | `Lo sentimos, este turno acaba de ser reservado por alguien más.` |

**El paso 8 es la regla de oro: el backend valida disponibilidad aunque el frontend ya haya ocultado el slot.** Nunca confíes en el cliente.

**El paso 7 no rechaza a propósito** — un servicio borrado no debería impedir reservar.

### Dentro de la operación serializada

- Upsert del `cliente` por teléfono normalizado: si existe, actualizar el nombre; si no, crear.
- Insertar la `reserva` con `source = 'web'`, `estado = 'activa'`, `tipo = 'turno'`, un `cancel_token` nuevo, y los **snapshots** de `nombre`, `telefono`, `servicio` y `duracion_min`.
- `mensaje` default: `"{servicio} el {fecha} a las {hora}"`.

### Post-commit, best-effort

**Si estos fallan, la reserva YA está confirmada. Log y seguir.**

- Si el barbero tiene `calendar_id`: crear el evento en Calendar. (Fase 4 — dejá el hook.)
- Encolar la notificación de WhatsApp con el texto `Reserva confirmada vía Web.` (Fase 4 — dejá el hook.)

### Estados de resultado

`exito` | `overlap` | `datosInvalidos` | `noDisponible`. Los tres de error → **400**. Excepción no controlada → **500** con `Ocurrió un error al procesar la reserva. Por favor, reintenta.`

**Respuesta OK:** `{ ok: true, data: { cancelToken, mensaje: "Turno agendado exitosamente" } }`.

**Criterios de aceptación:**

- [ ] Las 11 validaciones se ejecutan en ese orden y cada mensaje coincide textualmente
- [ ] Reservar en un día cerrado por API directa (sin pasar por la UI) se rechaza
- [ ] Reservar a 15 días con ventana de 14 se rechaza
- [ ] Reservar hoy con menos de 30 min de anticipación se rechaza
- [ ] Un servicio inexistente no rechaza: usa la duración default
- [ ] El teléfono queda guardado normalizado a 10 dígitos
- [ ] Reservar dos veces el mismo slot: la segunda da `overlap` con el mensaje exacto
- [ ] Si el hook de Calendar tira excepción, la reserva igual queda confirmada

---

## Tarea 2.5 — Autenticación del panel

### Login — `POST /admin/api/auth`

Body `{ usuario, password }`.

1. Normalizar `usuario`: `trim().toLowerCase()`.
2. Buscar en `barberos` por `slug = usuario AND activo = 1`. **Los barberos son los usuarios.**
3. Si no existe o no tiene hash → contar como fallo y devolver la respuesta genérica (**anti-enumeración**: nunca revelar si el usuario existe).
4. Verificar la password.
5. Generar el token: **16 bytes de `crypto.getRandomValues`**, no un UUID predecible.
6. Insertar `admin_sessions` con `expires_at = now + 24h`.
7. Setear la cookie.

**La cookie, exactamente:**

```
Set-Cookie: admin_token={token}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires={expiresAt}
```

**El token NUNCA va en el body.** Respuesta: `{ ok: true, data: { user: { id, slug, nombre, rol } } }`.

### Hashing

**Usá PBKDF2 vía `crypto.subtle`** con al menos 100.000 iteraciones y sal de 16 bytes.

El sistema viejo usa BCrypt cost 12, pero **BCrypt no entra en los 10 ms de CPU del plan Free** de Workers y obligaría a Workers Paid. Como arrancás de cero no hay hashes legacy que soportar, así que PBKDF2 es la opción correcta: nativo, sin dependencias, y elimina la dependencia del plan pago para un endpoint de login.

Guardá el hash con un prefijo de esquema (ej. `pbkdf2$100000$...`) para poder rotar más adelante.

### El middleware de auth

**Lee SOLO la cookie.** Ignorá deliberadamente el header `Authorization: Bearer`.

Es la mitigación de XSS del diseño: si un script roba el token, no puede reenviarlo como header porque el backend no acepta esa vía, y la cookie es `HttpOnly` así que JS no la ve.

Buscar la sesión por `id = token AND expires_at > now`. Poner en el contexto: `barberoId`, `rol`, `sessionId`.

Errores: `401 { ok: false, error: "No autorizado" }` y `403 { ok: false, error: "Prohibido" }`.

### Rate limit de login

**10 fallos por IP en 15 min, y solo se consume en los intentos fallidos** — un login correcto no gasta cupo.

Excedido: `429 Demasiados intentos. Intente más tarde.`
Credenciales malas: `401 Usuario o contraseña incorrectos`.

### Logout — `DELETE /admin/api/auth`

Leer el token **directo de la cookie** (no del contexto, por si la sesión ya expiró), borrar la fila, borrar la cookie con las mismas opciones. Responder `{ ok: true }` siempre.

### `GET /admin/api/me`

Devuelve `{ id, slug, nombre, rol }` del barbero autenticado.

**Criterios de aceptación:**

- [ ] Login correcto setea la cookie con los 5 atributos exactos
- [ ] El token no aparece en el body de ninguna respuesta
- [ ] Un usuario inexistente y una password incorrecta dan la **misma** respuesta
- [ ] Enviar el token como `Authorization: Bearer` da 401
- [ ] 10 logins fallidos bloquean; 10 correctos no
- [ ] Logout borra la fila de la base, no solo la cookie
- [ ] Una sesión expirada da 401 aunque la cookie exista

---

## Tarea 2.6 — Rate limiting

Durable Object `RateLimiter` con ventana fija de 15 min y clave `{ip}:{endpoint}`.

El sistema viejo usa un diccionario en memoria del proceso, que en Workers no persiste entre invocaciones. Un DO sí mantiene estado.

**Alternativa a evaluar:** el binding nativo de Rate Limiting de Workers es más simple pero da menos control sobre la clave y la ventana. Si lo usás, documentá la decisión.

Límites por endpoint (los de la Fase 2; los de mi-turno vienen en la Fase 5):

| Endpoint | Límite |
|---|---|
| `POST /api/reservas` | 10 |
| `POST /admin/api/auth` | 10 (solo fallos) |

**El contador se pierde en cada deploy y está bien.** La defensa real contra el doble booking es el DO más el índice único, no el rate limit.

**Criterios de aceptación:**

- [ ] El request 11 en la ventana da 429
- [ ] Pasada la ventana, el contador se resetea
- [ ] Dos IPs distintas tienen contadores independientes
- [ ] El mismo IP en dos endpoints distintos tiene contadores independientes

---

## Tarea 2.7 — Agenda y reservas del panel

| Método | Ruta | Rol |
|---|---|---|
| GET | `/admin/api/agenda?desde&hasta&barberoId` | scoped |
| GET | `/admin/api/reservas?skip&limit` | scoped |
| POST | `/admin/api/reservas` | scoped |
| PUT | `/admin/api/reservas/:id` | dueño u owner |
| DELETE | `/admin/api/reservas/:id` | dueño u owner |
| POST | `/admin/api/reservas/importar` | **owner** |
| POST | `/admin/api/bloqueos` | scoped |

### El scoping por rol

**Es la regla que más se olvida.** Un `barbero` ve solo lo suyo; un `owner` ve todo.

- **`barbero`**: siempre forzado a `barbero_id = {suBarberoId}`. No puede pasar `?barberoId=` de otro.
- **`owner`**: ve todos, y si pasa `?barberoId=` filtra por ese.

Patrón: resolver el barbero objetivo una vez, al inicio del handler.

**Defaults de la agenda:** rango −30/+60 días, límite 500 registros.

### Crear reserva desde el panel

Igual que la pública pero: `source = 'admin'`, **sin las validaciones de anticipación mínima ni máxima** (el admin puede cargar un turno para hoy en 5 minutos, o para dentro de 3 meses). Sí valida solapamiento vía el DO.

### Cancelar

**Soft delete:** `estado = 'cancelada'` + `cancelada_at`. Nunca `DELETE`.

### Import masivo de reservas

`POST /admin/api/reservas/importar`. **Solo `owner`** → si no, 403 con `Solo los dueños pueden importar reservas.`

Máximo **500 filas** por request. Cada fila pasa por la validación de solapamiento vía el DO; las que chocan se reportan en vez de abortar todo el lote.

`source = 'import'` en las reservas creadas.

Devolver `{ importadas, salteadas, errores: [{ fila, motivo }] }`. El operador necesita saber qué no entró y por qué — un "importé 340 de 500" sin detalle es inútil.

**No dispares Calendar ni WhatsApp en el import.** Son datos históricos o cargas masivas; notificar 500 turnos por WhatsApp sería un desastre.

### Bloqueos administrativos

`POST /admin/api/bloqueos` con `{ fecha, hora, motivo? }`.

Crea una fila en `reservas` con **`tipo = 'bloqueo'`**, `nombre` y `telefono` vacíos o placeholder, `source = 'admin'`.

🐛 **El sistema viejo usa un string mágico** (`servicio = "Bloqueo Administrativo"`, `nombre = "BLOQUEDAO"` con typo) y todas las queries de "turnos reales" tienen que acordarse de excluirlo. **Usá la columna `tipo`.**

Consecuencia: las queries de disponibilidad cuentan los dos tipos (el slot está ocupado igual); las de "turnos de clientes" filtran `tipo = 'turno'`.

Pasa por el DO igual que una reserva. Si el slot está ocupado: `400 Ya existe una reserva en ese horario.`

**Criterios de aceptación:**

- [ ] Un `barbero` que pasa `?barberoId=` de otro sigue viendo solo lo suyo
- [ ] Un `owner` sin `?barberoId=` ve las reservas de todos
- [ ] Un `barbero` no puede editar ni borrar una reserva de otro (403)
- [ ] Cancelar deja `estado = 'cancelada'`, la fila sigue en la base
- [ ] Un slot con reserva cancelada vuelve a estar disponible
- [ ] Un bloqueo ocupa el slot en el endpoint de disponibilidad
- [ ] Un bloqueo NO aparece en las queries de turnos de clientes
- [ ] Crear desde el panel no aplica la anticipación mínima
- [ ] Un `barbero` que intenta importar recibe 403
- [ ] Importar 501 filas se rechaza
- [ ] En un lote con 3 filas que chocan, las otras entran y las 3 se reportan con su motivo
- [ ] El import no dispara Calendar ni WhatsApp

---

## Cierre de la Fase 2

- [ ] `npm test` en verde, **incluido el test de concurrencia**
- [ ] Un cliente reserva por API y aparece en la agenda del barbero
- [ ] El scoping por rol funciona en los 4 endpoints que lo usan
- [ ] Los mensajes de error coinciden textualmente con las tablas
- [ ] Los hooks de Calendar y WhatsApp están declarados aunque no implementados
