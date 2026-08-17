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

## Tarea 2.6 — falta el rate limit en `POST /api/reservas`

El endpoint está sin rate limit. La spec de la 2.4 menciona
`429 Demasiados intentos. Intenta más tarde.` pero el `RateLimiter` es la
tarea 2.6. El seam está marcado con un comentario en `src/routes/public.ts`.

---

## Tarea 2.4 — un mensaje de error inventado

`Teléfono inválido. Ingresá un número argentino de 10 dígitos.`

Es el **único** string de error de este endpoint que no es transcripción
textual de la spec: la spec lista el paso 5 como "Normalizar teléfono" sin
mensaje de rechazo. Si hay un texto de producción para este caso, reemplazarlo.

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
