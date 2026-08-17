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
