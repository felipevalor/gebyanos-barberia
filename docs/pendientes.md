# Pendientes

Deuda declarada: cosas implementadas antes de tiempo, o postergadas a propósito,
que una fase posterior tiene que cerrar. **No cerrar una tarea asumiendo que un
ítem de acá ya está hecho.**

---

## ✅ Tarea 1.5 — tests de `addDays` — CERRADO 2026-08-15

`addDays` se había adelantado en la 1.3 sin tests. Cerrado en la 1.5: los cuatro
casos están en `test/domain/dates.test.ts`, incluidos los tres que importaban
(cruce de mes, cruce de año, bisiesto), más `n` negativo, identidad, y el caso
inverso de que 2026 **no** es bisiesto. El resto de `dates.ts` también quedó.

---

## ⚠️ Tarea 2.4 — el paso 10 de las validaciones es INALCANZABLE

**Decisión pendiente del autor de la spec.**

La tarea 2.4 numera las validaciones así:

```
 8. evaluarSlot() === 'abierto'   → mensaje de mensajeCliente()
 9. cumpleAnticipacion()          → "Debés reservar con al menos N minutos..."
10. Hora parseable HH:mm          → "Formato de hora inválido."
```

El paso 10 nunca se alcanza. Una hora que pasa el regex de forma
(`^\d{2}:\d{2}$`) pero es imposible — `"99:99"`, `"24:00"` — cae siempre en el
paso 8: `evaluarSlot` la calcula fuera de todos los bloques y devuelve
`fueraDeHorario`.

**Comportamiento real hoy:** `"99:99"` → `El horario elegido está fuera del
horario de atención.`

**Se dejó el orden de la spec** porque el criterio de aceptación lo pide
explícitamente y mover el paso cambiaría un mensaje que es contrato. El test
`test/services/reserva.test.ts` documenta el comportamiento real, no el
deseado.

Para que el paso 10 sirva, tendría que correr **antes** del 8.

---

## ✅ Tarea 2.6 — rate limit implementado — CERRADO 2026-08-17

`POST /api/reservas` (consume en cada request) y `POST /api/admin/auth`
(consume solo en los fallos), 10 por IP cada 15 min, con contadores
independientes por endpoint.

Se descartó el binding nativo: su ventana solo admite 10 o 60 segundos.
Razones completas en [`notas-operacion.md`](./notas-operacion.md).

---

## 🚀 ANTES DEL LANZAMIENTO — cargar el horario real de Gebyanos

**Producción tiene hoy un horario PLACEHOLDER: lunes a sábado, 9 a 20 corrido.**
Lo sembró `scripts/backfill-horarios.mjs` porque `gaby` no tenía ninguno y el
sistema no ofrecía un solo turno.

Eso significa que **la API está ofreciendo turnos a las 14:00**. Ninguna
barbería que cierre al mediodía va a honrar ese turno, y el cliente se entera
el día que llega y no hay nadie.

**Hay que preguntarle al dueño y cargarlo desde el panel** —
`PUT /api/admin/horarios/dia/:dow`. Lo que hay que preguntar:

- ¿a qué hora abre y a qué hora cierra?
- ¿corta al mediodía? Si sí, entre qué horas
- ¿el horario es igual todos los días, o el sábado es distinto?
- ¿trabaja los domingos? (hoy está inactivo)

**No inventar el horario.** Un placeholder que nadie corrigió es peor que un
día cerrado: el día cerrado se ve en el panel, el turno fantasma no.

---

## Desarrollo y producción tienen FORMAS distintas de horario

| Entorno | Forma |
|---|---|
| Seed de desarrollo | cortado: 9-13 y 16-20 |
| Producción (backfill) | continuo: 9-20 |

Los dos son válidos según lo escrito, pero **un bug que solo aparezca con un
bloque continuo no lo agarraría el seed**, y al revés.

Mitigado con tests que corren las mismas afirmaciones contra las dos formas
(`test/domain/disponibilidad.test.ts` → "las dos formas de horario"). Cuando se
cargue el horario real, revisar que la forma elegida siga cubierta.

---

## Tarea 5.2 — el warning de recurrentes no está implementado

El patrón Bloquear+Avisar tiene dos casos que **avisan pero NO bloquean**:
borrar y desactivar un cliente recurrente que ya tiene turnos futuros
generados. Devuelven **200 con `warning`**, no 409, porque esos turnos son
compromisos con clientes reales y borrar la regla de recurrencia no debería
cancelarlos.

**El mensaje ya está definido** en `src/services/conflictos.ts`
(`mensajeRecurrenteConTurnos`) y el sobre de la API ya soporta `warning`. Lo
que falta es el cableado, y vive en la **tarea 5.2** — los endpoints de
recurrentes no existen todavía.

```json
{
  "ok": true,
  "data": { "turnosFuturosCount": 2, "turnosFuturos": [...] },
  "warning": "El recurrente fue eliminado pero quedan 2 turno(s) futuro(s) agendado(s) que no se cancelaron automáticamente."
}
```

---

## Casos borde de baja prioridad — tareas 3.1 y 3.2

Los tres son conocidos y quedaron sin resolver a propósito. Ninguno corrompe
datos.

**1. Dos bloques del mismo día que se solapan entre sí no se rechazan.**
`PUT /horarios/dia/:dow` acepta `[{9,13}, {12,15}]` sin decir nada.
`generateSlotsFromBlocks` deduplica aguas abajo, así que la grilla sale bien —
pero el admin no se entera de que cargó algo sin sentido. Lo correcto sería
rechazarlo, o al menos devolver un `warning`.

**2. Un feriado para una fecha pasada se acepta.** No rompe nada: los turnos
pasados no se consultan y `evaluarSlot` solo mira el futuro. Es ruido en la
tabla.

**3. `PUT /horarios/:id` devuelve 404 antes de chequear pertenencia.** Un
barbero puede distinguir "existe y no es tuyo" (403) de "no existe" (404). Con
UUID v7 no adivinables el riesgo es mínimo; el orden correcto sería 404
después del chequeo de pertenencia, o 404 para los dos casos.

---

## Mensajes de error inventados

Strings que **no** son transcripción de la spec, porque la spec no define uno
para ese caso. Si aparece un texto de producción, reemplazarlos.

| Mensaje | Dónde |
|---|---|
| `Revisá el teléfono. Tiene que ser un número argentino válido con código de área.` | paso 5 de la reserva |
| `Solo podés operar sobre tu propia agenda.` | 403 del scoping del panel |
| `Servicio inválido.` | reprogramar con un `servicioId` que no existe |
| `Formato de fecha inválido en desde. Usá YYYY-MM-DD.` | `GET /api/admin/agenda` |
| `skip inválido. Tiene que ser un número entero mayor o igual a 0.` | `GET /api/admin/reservas` |
| `limit inválido. Tiene que ser un número entre 1 y 200.` | `GET /api/admin/reservas` |
| `Se esperaba una lista de reservas.` | import |
| `Ya existe un barbero con ese usuario. Elegí otro.` | alta de barbero, slug duplicado |
| `Ya existe un servicio con ese nombre. Elegí otro.` | alta de servicio |
| `No se puede desactivar: es el único dueño y el panel quedaría sin acceso. Nombrá dueño a otro barbero antes.` | `PUT /api/admin/barberos/:id` |
| `No se puede borrar: es el único dueño y el panel quedaría sin acceso. Nombrá dueño a otro barbero antes.` | `DELETE /api/admin/barberos/:id` |
| `No se puede quitarle el rol de dueño: es el único que queda y el panel quedaría sin acceso. Nombrá dueño a otro barbero antes.` | `PUT /api/admin/barberos/:id` |
| `Zona horaria inválida. Usá un identificador IANA, por ejemplo America/Argentina/Buenos_Aires.` | `PUT /api/admin/negocio` |
| `slot_duracion_min inválido. Tiene que ser un número entero entre 5 y 240.` (y sus dos hermanos) | `PUT /api/admin/negocio` |
| `El usuario solo puede tener letras, números y guiones, y al menos 3 caracteres.` | alta de barbero |
| `Duración inválida. Tiene que ser un número entero de minutos entre 5 y 480.` | alta/edición de servicio |
| `Precio inválido. Tiene que ser un número entero de centavos, sin decimales ni negativos.` | servicios, promos, catálogo |

Y los dos **avisos** (campo `warning`, no `error`), que el panel tiene que
mostrar sí o sí porque describen algo que NO pasa:

| Aviso | Cuándo |
|---|---|
| `La nueva duración se aplica solo a los turnos que se creen de ahora en adelante. Los turnos ya agendados conservan la duración con la que se reservaron.` | `PUT /servicios/:id` cambia `duracionMin` |
| `El nuevo paso de la grilla se aplica a los turnos nuevos. Los ya agendados conservan su horario, aunque no coincida con la grilla nueva.` | `PUT /negocio` cambia `slotDuracionMin` |

---

## Fase 2 — validar teléfono con `esTelefonoArgentino`, no con `normalizeTel`

**✅ HECHO en la tarea 2.4** para `POST /api/reservas`. Queda pendiente para
los bordes de las fases 3 y 5 (alta de cliente desde el panel, carga de
recurrentes).

En el endpoint de reservas, la validación de teléfono tiene que usar
**`esTelefonoArgentino(raw)`**, no alcanza con `normalizeTel`.

`normalizeTel` cae a un fallback manual cuando libphonenumber no puede parsear,
y ese fallback devuelve los dígitos tal cual:

```ts
normalizeTel('123')  // → '123'   ← NO es la forma canónica de 10 dígitos
```

O sea que `normalizeTel` sola **no garantiza** el formato canónico. El 400 tiene
que salir de la validación explícita:

```ts
if (!esTelefonoArgentino(body.telefono)) return c.json(fail('...'), 400);
const telefono = normalizeTel(body.telefono);
```

Aplica a todo borde que reciba un teléfono: reserva pública, alta de cliente
desde el panel, y carga de recurrentes.

---

## ✅ Tarea 2.5 — el seed ya tiene password — CERRADO 2026-08-17

`src/db/seed.sql` trae el hash PBKDF2 real del owner. Credenciales de
desarrollo, documentadas en el propio archivo: `gaby` / `gebyanos-dev-2026`.
Hay un test que verifica que el comentario no miente sobre la password.

---

## ⚠️ Antes del primer deploy — medir el CPU real del login

PBKDF2 con 100.000 iteraciones consume **7,6 de los 10 ms** de CPU del plan
Free, medido en una máquina de desarrollo. Si el edge de Cloudflare fuera un
30% más lento, el login quedaría al borde de un `Worker exceeded CPU time`.

Al primer deploy: hacer un login real y mirar el CPU time en el dashboard. Si
supera ~8 ms, bajar `ITERACIONES` en `src/services/password.ts`. Bajarlas no
invalida los hashes existentes.

Detalle y tabla completa en [`notas-operacion.md`](./notas-operacion.md).

---

## ⚠️ Dos mensajes de la spec no están en voseo

Barrido de voz sobre los 26 mensajes del sistema (2026-08-17). Todo el sistema
habla en **voseo** — *Debés reservar*, *Revisá el teléfono*, *Configurá la
fecha ancla*, *Intentá más tarde*. Quedan dos excepciones, las dos
transcripción textual de la spec, así que **no se cambiaron sin confirmar**:

| Mensaje | Voz | Endpoint |
|---|---|---|
| `Formato de hora inválido. **Use** HH:mm.` | usted | `POST /api/reservas` |
| `Ocurrió un error al procesar la reserva. Por favor, **reintenta**.` | tuteo | `POST /api/reservas` |

En voseo serían `Usá HH:mm.` y `Por favor, reintentá.`

Un tercero — `Mes inválido. Use 1 a 12.` — era **mío**: le había copiado el
estilo al primero. Ya está corregido a `Mes inválido. Usá 1 a 12.`

Los dos que quedan son contrato: si se cambian, hay que actualizar el
contrato de API y los tests que los fijan.

---

## ✅ Tarea 2.6 — mensaje de rate limit unificado

Los dos textos de la spec diferían en una letra (`Intenta` contra `Intente`).
Unificados a **`Demasiados intentos. Intentá más tarde.`** — voseo, como el
resto del sistema. Aplica a `POST /api/reservas` y a `POST /api/admin/auth`.

La spec usa dos textos distintos para el mismo tipo de error:

| Endpoint | Mensaje |
|---|---|
| `POST /api/reservas` (2.4) | `Demasiados intentos. Intenta más tarde.` |
| `POST /api/admin/auth` (2.5) | `Demasiados intentos. Intent**e** más tarde.` |

`Intenta` contra `Intente`. Puede ser deliberado (tuteo con el cliente, usted
con el barbero) o un typo arrastrado del sistema viejo. **Confirmar antes de
implementar la 2.6**, porque una vez que el frontend los matchee son contrato.

---

## ✅ Tarea 3.4 — `negocio.timezone` — CERRADO 2026-08-17

**Hallazgo, no decisión.** El campo se valida como IANA, se guarda, se muestra
en el panel y sale en `/api/negocio`... y no cambia absolutamente nada.

`src/domain/dates.ts` tiene la zona **hardcodeada**:

```ts
export const TZ = 'America/Argentina/Buenos_Aires';
export const OFFSET_ARGENTINA = '-03:00';
```

y es de ahí que salen `todayArgentina`, `timeNowArgentina` y `slotAMs`. O sea
que alguien puede poner `Europe/Madrid` en el panel, verlo guardado, y los
turnos se siguen calculando en hora de Argentina. Nadie se entera hasta que un
horario no cierra.

Las dos salidas honestas:

1. **Conectarlo**: que `dates.ts` reciba la zona en vez de tenerla fija. Es más
   trabajo del que parece — el offset fijo `-03:00` de `slotAMs` deja de valer
   apenas la zona tenga horario de verano, y ahí hay que usar `Intl` en un
   camino caliente.
2. **Sacarlo de la interfaz**: dejar la columna (el sistema es multi-barbería en
   la Fase 6) pero no ofrecerla como una perilla editable hasta que 1 exista.

**Se tomó la opción 2.** `timezone` salió del `PUT` **y de la respuesta** de
`/api/admin/negocio` y `/api/negocio`: si quedaba en la respuesta, el frontend
podía leerlo y creerle. Mandarlo en el `PUT` ahora da 400 con un mensaje que
explica por qué, en vez de ignorarlo en silencio — el silencio se lee como
éxito.

La columna queda en la base, con un comentario en `schema.ts` y otro en
`domain/dates.ts` que apunta al motivo: el trabajo real no es "leer la
columna", es sacar el offset fijo `-03:00` de todo el sistema para que tolere
horario de verano. Mucho riesgo en la parte más sensible del código, para un
problema que una barbería argentina no tiene.

---

## Tarea 3.4 — decisiones que la spec no define

**1. "La semana" de las stats es la semana CALENDARIO (lunes a domingo).**
La spec dice "reservas de hoy, de la semana, del mes" sin definir la semana.
Se eligió calendario y no "próximos 7 días" porque es lo que el dueño tiene en
la cabeza cuando mira el panel un jueves: quiere saber cómo viene *esta*
semana, con el lunes y el martes que ya pasaron adentro. Con una ventana móvil
el número baja todos los días sin que pase nada. Si el cliente lo lee al revés,
se cambia en una función (`lunesDeLaSemana`) y sus tests.

**2. Degradar al único dueño se bloquea igual que desactivarlo.**
La spec nombra desactivar y borrar. `PUT /barberos/:id` con `rol: 'barbero'`
sobre el único owner hace exactamente el mismo daño —el panel queda sin nadie
que pueda entrar— y no estaba contemplado. Se agregó con su propio mensaje.

**3. El listado de barberos y el de servicios NO filtran `activo = 1`.**
Es la excepción deliberada a la regla de oro. El panel es justamente donde se
reactiva algo dado de baja; si el listado lo escondiera, no habría forma de
volver a darlo de alta sin tocar la base. Lo público (`services/publico.ts`) sí
filtra, y hay tests de las dos cosas.

**4. Un owner desactivado no cuenta como respaldo.** `esUltimoOwner` filtra
`activo = 1`: una cuenta que no puede loguearse no salva a nadie del bloqueo.

---

## 🔴 Tarea 4.1 — `_gcal.js` NO está en el historial de ningún repo

La spec dice de recuperarlo antes de escribirlo de nuevo. Se buscó y **no
existe**:

```
barberiagebyanos.BE:  0 coincidencias (182 commits)
barberiagebyanos.FE:  0 coincidencias (191 commits)
gebyanos:             0 coincidencias (1 commit)
```

Se buscó por nombre de archivo en toda la historia (`--diff-filter=D` incluido)
y por contenido (`oauth2.googleapis.com`, `RS256`, `calendar/v3`) en todos los
commits. Nada. Tampoco está `migration/PLAN_MIGRACION.md`, que es de donde la
spec saca la cita de "líneas 1-208". Vivía en el repo original de Cloudflare
Pages, que no está entre los tres que sobreviven.

**Lo que sí existe** es el puerto a .NET,
`barberiagebyanos.BE/Barberia.Api/Services/GoogleCalendarService.cs`, cuyo
docstring dice ser "puerto de las funciones de Google Calendar en _gcal.js
(líneas 1–208)". De ahí salieron:

- los strings exactos del evento (`"{nombre} - {servicio}"`, `"Tel: {tel}"`),
  leídos del llamador en `ReservaService.cs:169`;
- el `timeZone: "America/Argentina/Buenos_Aires"` en `start` y `end`;
- el comportamiento ante error: cada método atrapa y devuelve `null`/`false`/`[]`,
  nunca propaga.

Lo único sin referencia previa es la firma del JWT: en .NET la hace el SDK de
Google, así que el `crypto.subtle` de Workers se escribió de cero. Está probado
firmando y **verificando con la clave pública**, no mirando que el string tenga
tres partes.

### Un bug del helper .NET que acá no está

`SlotHelper.BuildEventTimes` arma la hora de fin como `totalEnd / 60`, sin
normalizar el pasaje de medianoche: un turno de 23:30 + 30 min produce
`"24:00:00-03:00"`, que no es una hora ISO válida. Nuestro `buildEventTimes` de
la Fase 1 ya rota al día siguiente y tiene tests de eso
(`2027-04-01T23:30 + 30 → 2027-04-02T00:00:00-03:00`). No hay nada que
arreglar, queda anotado para que no se "corrija" hacia el comportamiento viejo.

---

## Tarea 4.3 — rotar `ENCRYPTION_KEY` no está resuelto

El formato `v1:iv:ciphertext` permite rotar el **esquema** de cifrado sin
migrar todo de golpe. Rotar la **clave maestra** es un problema distinto y hoy
no tiene solución: cambiarla deja las `callmebot_apikey` existentes
indescifrables, y el sistema degrada a "sin credencial" **en silencio** — los
avisos dejan de salir y nadie recibe un error.

Mitigación actual: ninguna, más allá de que no explota. Hay que volver a cargar
las keys desde el panel.

Si alguna vez hace falta rotar de verdad, el camino es un `v2` que intente
primero con la clave nueva y caiga a la vieja, más un job que reescriba las
filas. No se implementó porque hoy hay una sola barbería y dos barberos.

**Lo que sí conviene agregar antes:** que el panel muestre un cartel cuando
`tieneApikey` es `true` pero `pistaApikey` es `null`. Esa combinación significa
exactamente "hay una key guardada que no se puede descifrar", que es el síntoma
de una clave maestra rotada o mal configurada.

---

## 💡 Idea post-lanzamiento — recordatorio del turno al cliente

**No es deuda técnica: es una función que hoy no se puede construir.**

Recordarle el turno al cliente el día anterior es lo que más reduce las
ausencias en cualquier negocio con agenda. Vale tenerlo escrito para cuando
exista un canal que lo permita.

### Por qué no se puede hoy

**CallMeBot exige que el destinatario haya autorizado al bot y tenga su propia
API key.** No se le puede escribir a un número arbitrario. Todo el WhatsApp de
este sistema va **al barbero**, que sí configuró la suya.

La evidencia está en el sistema viejo: `NotificarClienteAsync` existe, está
escrita, y es un **no-op** — sale por el `return` temprano porque el cliente
nunca tiene `apiKey`. O sea que ya se intentó y no funcionó.

Por eso tampoco existe el job de recordatorios en el cron: ese slot venía del
andamio de la tarea 1.1, no de la spec.

### Qué haría falta

Un canal que permita iniciar conversación con un número que no optó in:

- **WhatsApp Business API** (Meta o un proveedor como Twilio): permite
  plantillas pre-aprobadas hacia números que no escribieron primero. Tiene
  costo por mensaje y aprobación de plantillas — sale del objetivo $0.
- **SMS**: más caro por mensaje, sin aprobación previa.
- **Email**: gratis y sin fricción, pero la tasa de apertura de un recordatorio
  de turno por mail es mucho más baja que la de un WhatsApp.

Si algún día se agrega, el enganche es limpio: hay un cron horario con despacho
por hora y la infraestructura de cola ya existe.
