# Fase 4 — Integraciones

> Requiere `00-CONTEXTO.md` cargado y la **Fase 3 terminada**.
> **Criterio de salida:** una reserva aparece en el Google Calendar del barbero y le llega el WhatsApp.

**La regla que gobierna toda esta fase: las integraciones son best-effort.** Si Calendar o WhatsApp fallan, la reserva ya está confirmada. Log y seguir. Nunca tires una reserva por una integración caída.

---

## Tarea 4.1 — Google Calendar

**La tarea más cara de la fase**, porque no hay SDK que te resuelva el OAuth.

### Antes de escribir nada

**Este código ya existió en este proyecto.** El stack original en Cloudflare tenía exactamente esto en `functions/admin/api/_gcal.js` (líneas 1-208 según `migration/PLAN_MIGRACION.md`): el JWT manual de Google Calendar, ya resuelto una vez.

**Recuperalo del historial de git antes de escribirlo de nuevo.** Algo como:

```bash
git log --all --diff-filter=D --name-only -- '*_gcal.js'
git show <commit>:functions/admin/api/_gcal.js
```

Puede necesitar ajustes (era Pages Functions, no Workers), pero el flujo de firma del JWT es el mismo.

### El flujo de autenticación

Service Account, tres pasos:

1. Armar un JWT con `{ iss: client_email, scope: 'https://www.googleapis.com/auth/calendar', aud: 'https://oauth2.googleapis.com/token', exp, iat }`.
2. Firmarlo **RS256** con la private key del JSON de credenciales, usando `crypto.subtle.importKey` (formato PKCS#8) y `crypto.subtle.sign`.
3. Canjearlo por un access token en `POST https://oauth2.googleapis.com/token` con `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`.

**Cacheá el access token** — vale 1 hora. Guardalo en KV o en un DO; no pidas uno nuevo en cada request.

La private key viene en PEM dentro del JSON. Hay que sacarle los headers `-----BEGIN PRIVATE KEY-----`, decodificar el base64 y pasarlo como ArrayBuffer a `importKey`.

### Los campos del evento

- `summary`: `"{nombreCliente} - {servicio}"`, o `"{nombreCliente} (R) - {servicio}"` si viene de un recurrente
- `description`: `"Tel: {telefono}"`, o `"Generado Auto. Tel: {tel}"` para recurrentes
- `start` y `end`: objetos con `dateTime` en ISO-8601 **con offset explícito** y `timeZone: "America/Argentina/Buenos_Aires"`

Los timestamps salen de `buildEventTimes` de la Fase 1.

**El doble refuerzo del timezone (offset en el string Y campo `timeZone`) es deliberado:** garantiza que Google lo interprete bien sin importar su heurística.

### Las operaciones

| Operación | Cuándo | Guarda |
|---|---|---|
| Crear evento | Al crear una reserva | `calendar_event_id` en la reserva |
| Borrar evento | Al cancelar | — |
| Reprogramar | Al editar fecha/hora | Nuevo `calendar_event_id` |

Reprogramar puede ser borrar + crear (más simple) o un PATCH. El sistema viejo hace borrar + crear.

### Degradación silenciosa

Si `calendar_id` del barbero es null, o las credenciales no están configuradas: **la integración se deshabilita entera** y todas las operaciones devuelven null/false sin excepción. Un log de warning al arrancar y nada más.

**Criterios de aceptación:**

- [ ] Una reserva nueva aparece en el Calendar del barbero con el título y descripción correctos
- [ ] El evento cae en el horario correcto visto desde Argentina
- [ ] Cancelar una reserva borra el evento
- [ ] Reprogramar mueve el evento
- [ ] El access token se cachea y no se pide en cada request
- [ ] Sin `calendar_id`, la reserva se crea igual y no hay error
- [ ] Con credenciales inválidas, la reserva se crea igual y queda un log
- [ ] `calendar_event_id` queda guardado en la reserva

---

## Tarea 4.2 — WhatsApp con Queues

### Arquitectura

El endpoint **encola y responde**. Un consumer procesa. Ganás reintentos automáticos y persistencia — mejor que el `Channel` en memoria del sistema viejo, que pierde los mensajes pendientes en cada deploy.

📌 **Queues está en el plan gratuito:** 10.000 operaciones/día, retención 24 h ([doc oficial](https://developers.cloudflare.com/queues/platform/pricing/)). Una barbería usa menos de 200 operaciones diarias — sobra por 50x.

Si alguna herramienta te dice que Queues requiere Workers Paid, está desactualizada: pasó al Free plan en febrero de 2026. **No cambies el diseño por eso ni sugieras subir de plan** — el proyecto es free tier estricto (ver `00-CONTEXTO.md`).

**Configuración de reintentos:** dejá los reintentos automáticos de Queues activos. Si un mensaje falla las veces configuradas, que quede registrado con el motivo — el barbero tiene que poder ver en el panel qué avisos no salieron.

### El proveedor

CallMeBot: `GET https://api.callmebot.com/whatsapp.php?phone={tel}&text={texto}&apikey={key}`.

Cada barbero tiene su `callmebot_phone` y `callmebot_api_key`. Hay un fallback global en config.

**Timeout: 10 s.**

### Validación de teléfono

Regex `^\+?\d{7,15}$`. Si no pasa, no envía y devuelve:

`Número inválido. Usá formato internacional, ej: +5491122334455 (país 54 + 9 + área + número).`

### El template, exacto

```
{titulo}
  Nombre:   {nombre}
  Tel:      {telefono}
  Servicio: {servicio}
  Fecha:    {fecha} {hora}
  Nota:     {extra}        ← solo si hay extra
```

**Los tres títulos:**

| Tipo | Título |
|---|---|
| `cancelada` | `❌ Turno cancelado:` |
| `modificada` | `✏️ Turno modificado:` |
| `creada` | `✅ Nueva reserva:` |
| `recurrente` | `✅ Nueva reserva:` (mismo que `creada`) |

`recurrente` comparte el título de `creada` — para el barbero es una reserva nueva igual. Se distingue por el texto de la nota (`Tu turno recurrente ha sido cargado.`), no por el título.

🐛 **El sistema viejo elige el título buscando substrings** (`"CANCELADO"`, `"reagendado"`) en el texto del extra. Es frágil. **Pasá un tipo explícito** (`'creada' | 'cancelada' | 'modificada' | 'recurrente'`) y elegí el template por ahí. El resultado visible para el barbero es idéntico.

**Los textos de extra que usa el sistema:**

- `Reserva confirmada vía Web.`
- `Turno cargado desde el panel admin.`
- `TURNO CANCELADO por el cliente.`
- `TURNO CANCELADO desde el panel admin.`
- `Turno reagendado por el cliente.`
- `Turno reagendado desde el panel admin.`
- `Tu turno recurrente ha sido cargado.`

### La detección de errores, que es lo no obvio

**CallMeBot devuelve HTTP 200 incluso cuando falla**, y describe el error en el body.

Hay que parsear el texto buscando estas palabras, case-insensitive:

```
error · apikey · not allowed · not registered · invalid ·
no longer · you need to · wrong · fail
```

Si alguna aparece, tratalo como fallo. Limpiá el HTML del detalle y truncá a 300 caracteres.

Si el status no es 2xx: `CallMeBot respondió HTTP {status}: {detalle}`.
Si hay excepción de red: `Excepción al contactar CallMeBot: {mensaje}`.

**Nunca propagues la excepción.** Log y seguir.

### Logs

**Enmascará el teléfono: solo los últimos 4 dígitos.**

Y bajale el nivel de log al cliente HTTP de CallMeBot — la API key va en la query string (el servicio no soporta auth por header), así que un log de request completo la filtra.

**Criterios de aceptación:**

- [ ] Una reserva nueva encola un mensaje y el consumer lo procesa
- [ ] El template coincide carácter por carácter, incluidos los emojis
- [ ] Los tres títulos salen del tipo explícito, no de buscar substrings
- [ ] Un body de CallMeBot con la palabra `error` se trata como fallo aunque el status sea 200
- [ ] Un teléfono inválido no dispara el request y devuelve el mensaje exacto
- [ ] Los logs muestran solo los últimos 4 dígitos del teléfono
- [ ] La API key no aparece en ningún log
- [ ] Si CallMeBot está caído, la reserva igual queda confirmada

---

## Tarea 4.3 — Cifrado de las credenciales de CallMeBot

`callmebot_api_key` se guarda cifrada, no en claro.

El sistema viejo usa la Data Protection API de ASP.NET, que no existe en Workers. Reemplazo: **AES-GCM vía `crypto.subtle`** con la clave maestra en un secret de Wrangler.

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

**El prefijo de versión permite rotar el esquema más adelante** sin migrar todo de golpe.

**Un IV nuevo por cada cifrado.** Reusar el IV con AES-GCM rompe la seguridad del cifrado.

**La key nunca se devuelve en una respuesta de API.** Los endpoints de configuración devuelven un booleano tipo `tieneApiKey: true`, o los últimos caracteres si querés que el barbero identifique cuál cargó.

Endpoints (ya existen desde la Fase 3, acá se les agrega el cifrado):

| Método | Ruta |
|---|---|
| GET | `/admin/api/callmebot` |
| PUT | `/admin/api/callmebot` |
| POST | `/admin/api/callmebot/test` |

El `test` manda un mensaje de prueba y devuelve el resultado real del envío, con el detalle del error si falló. Es la herramienta de diagnóstico del barbero.

**Criterios de aceptación:**

- [ ] La key queda cifrada en la base — un `SELECT` no la muestra en claro
- [ ] Se descifra correctamente al usarla
- [ ] Cada cifrado usa un IV distinto
- [ ] El GET no devuelve la key en claro
- [ ] El endpoint de test devuelve el error real de CallMeBot cuando falla
- [ ] Sin la clave maestra configurada, el arranque falla con un mensaje claro (no silenciosamente)

---

## Tarea 4.4 — Tareas programadas

Dos Cron Triggers en esta fase. El tercero (generación de recurrentes) va en la Fase 5. Free plan permite 5 en total.

| Cron | Qué hace |
|---|---|
| `0 * * * *` | Limpieza: `admin_sessions` con `expires_at < now` y `magic_link_tokens` vencidos |
| `0 3 * * *` | Refrescar la caché KV de feriados nacionales |

### Limpieza

Borrado físico, son datos efímeros. Sin soft delete acá.

### Caché de feriados

Consultar `https://api.argentinadatos.com/v1/feriados/{año}` y guardar en KV con **TTL de 24 h**.

Traé el año actual y el siguiente — en diciembre la gente reserva para enero.

El sistema viejo cachea en memoria del proceso sin TTL. En Workers no hay memoria persistente, así que KV es el reemplazo.

**Si la API externa está caída:** servir lo que haya en KV aunque esté vencido, y loguear. Es mejor un feriado desactualizado que un panel roto.

**Criterios de aceptación:**

- [ ] El cron horario borra sesiones vencidas y deja las vigentes
- [ ] El cron de feriados guarda en KV con TTL
- [ ] Se cachean el año actual y el siguiente
- [ ] Con la API caída, el endpoint de feriados sigue respondiendo desde KV
- [ ] Los dos crons de esta fase están declarados en `wrangler.jsonc` y corren
- [ ] Cada cron loguea qué hizo (cuántas filas, qué años)

---

## Cierre de la Fase 4

- [ ] `npm test` en verde
- [ ] Una reserva de punta a punta: aparece en Calendar y llega el WhatsApp
- [ ] Con las dos integraciones caídas, las reservas se siguen creando
- [ ] Ningún secreto ni API key aparece en los logs
- [ ] Los dos crons de esta fase corren y dejan rastro
