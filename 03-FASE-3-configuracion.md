# Fase 3 — Configuración y horarios

> Requiere `00-CONTEXTO.md` cargado y la **Fase 2 terminada**.
> **Criterio de salida:** el panel es autosuficiente — no hace falta tocar la base a mano para operar la barbería.

El corazón de esta fase es el patrón **Bloquear + Avisar** (tarea 3.2): impedir que un cambio de configuración deje turnos de clientes sin horario válido. Es lo que separa un panel usable de uno peligroso.

---

## Tarea 3.1 — Horarios semanales y feriados

| Método | Ruta | Nota |
|---|---|---|
| GET | `/admin/api/horarios?barberoId` | |
| PUT | `/admin/api/horarios/dia/:dow` | Reemplaza todos los bloques del día |
| PUT | `/admin/api/horarios/:id` | Edita un bloque puntual |
| GET | `/admin/api/feriados?anio&barberoId` | Combina nacionales + overrides |
| POST | `/admin/api/feriados` | Upsert por `(barbero, fecha)` |
| DELETE | `/admin/api/feriados/:id` | |

### Horarios

**Varios bloques por día = horario cortado.** `PUT /horarios/dia/:dow` recibe un array de bloques y reemplaza todos los del día.

`hora_inicio` y `hora_fin` son **enteros** (9, 20). Validá `hora_fin > hora_inicio` y el rango 0-24.

### Horarios de un barbero nuevo — decisión tomada, no la cambies

Hay un problema real acá y el sistema viejo lo resuelve mal. Vale entenderlo antes de implementar.

`evaluarSlot` devuelve `diaCerrado` cuando no hay bloques configurados. O sea: un barbero recién creado no puede recibir ninguna reserva, y nadie entiende por qué.

El sistema viejo lo parchea al revés: si el barbero no tiene **ninguna** fila de horario, `ScheduleAvailabilityService.EvaluarAsync` devuelve `abierto` sin evaluar nada. O sea que un barbero sin configurar está **abierto 24/7**. Es peor que el problema que resuelve.

**La decisión para este proyecto: sembrar los horarios al crear el barbero, y NO tocar `evaluarSlot`.**

- Al crear un barbero (tarea 3.4), insertar en la misma operación sus 7 filas de `barbero_horarios`: lunes a sábado activos de 9 a 20, domingo inactivo.
- `evaluarSlot` mantiene su regla 2 tal como está en la Fase 1: sin bloques → `diaCerrado`. **Sin excepciones.**
- El `GET /admin/api/horarios` no inventa nada: devuelve lo que hay en la base.

**Por qué así:** un barbero sin horarios cerrado es un estado comprensible y visible en el panel; un barbero abierto 24/7 es un bug esperando a que alguien reserve a las 4 de la mañana. Y mantener `evaluarSlot` como función pura sin casos especiales es lo que hace que sus 15 tests valgan algo.

**Para los barberos que ya existan** (por seed o por migración de datos), corré un script que les siembre los horarios si no los tienen.

### Feriados

Dos cosas distintas que se muestran juntas:

- **Feriados nacionales**: vienen de `https://api.argentinadatos.com/v1/feriados/{año}`. Son **informativos** — no cierran la barbería.
- **Overrides propios**: filas en `feriados_override`. `trabaja = 0` cierra la fecha, `trabaja = 1` la marca como excepción positiva.

**Lo que cierra la barbería es el override, no el feriado nacional.** El panel muestra los nacionales para que el barbero decida.

Recordá la regla contraintuitiva de `evaluarSlot`: **un override con `trabaja = 1` NO abre un día sin horario configurado.** Solo evita que un `trabaja = 0` lo cierre.

En esta fase, la API de feriados nacionales se puede llamar directo. El caché en KV viene en la Fase 4.

**Criterios de aceptación:**

- [ ] Un día con dos bloques (9-13 y 16-20) genera slots en los dos rangos y ninguno en el hueco
- [ ] `hora_fin <= hora_inicio` se rechaza
- [ ] Un barbero sin horarios recibe los 7 días por default en el primer GET
- [ ] El upsert de feriado por `(barbero, fecha)` no duplica filas
- [ ] Un override con `trabaja = 0` hace que el día no ofrezca slots
- [ ] El GET de feriados combina nacionales y propios distinguiéndolos

---

## Tarea 3.2 — Bloquear + Avisar

**El patrón que impide dejar turnos huérfanos.** Cinco operaciones lo usan. Todas devuelven **409 con la lista de turnos en conflicto**, para que el admin vea exactamente qué reagendar.

| Operación | Qué chequea | Mensaje |
|---|---|---|
| Cambiar el horario de un día | Turnos futuros de ese `dow` que no encajan en los bloques nuevos | `Hay {n} turno(s) que quedarían fuera del nuevo horario. Reagendalos o cancelalos antes de cambiar el horario.` |
| Editar un bloque puntual | Igual, recalculando con el bloque editado | Mismo mensaje |
| Cerrar una fecha (feriado con `trabaja = 0`) | Turnos en esa fecha | `Hay {n} turno(s) ese día. Reagendalos o cancelalos antes de marcarlo como cerrado.` |
| Desactivar un barbero | Turnos futuros del barbero | `No se puede desactivar: el barbero tiene {n} turno(s) futuro(s). Reagendalos o cancelalos antes de desactivarlo.` |
| Borrar un barbero | Turnos futuros **y** recurrentes asociados | `No se puede borrar: el barbero tiene {n} turno(s) futuro(s). Reasignalos o cancelalos antes de borrarlo.` + ` Además tiene clientes recurrentes asociados que se perderían.` si aplica |

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

**Todas estas queries filtran igual:**

```sql
WHERE fecha >= {hoy} AND estado = 'activa' AND tipo = 'turno'
```

O sea: turno de cliente real, futuro, no cancelado, **no bloqueo administrativo**. Un bloqueo no debería impedirte cambiar tu propio horario.

### El caso del borrado de barbero

Es el más delicado: `reservas.barbero_id` es `SET NULL` (para preservar historial) pero `clientes_recurrentes.barbero_id` es `CASCADE`. O sea que borrar un barbero **borra sus recurrentes en silencio**. Por eso el chequeo mira las dos cosas.

### Casos que avisan pero NO bloquean

⏭️ **Estos dos se implementan en la tarea 5.2**, junto con el CRUD de recurrentes. Acá van solo el mensaje y el patrón; el cableado HTTP no existe hasta esa tarea. (Estaban listados en esta fase por error mío — los endpoints de recurrentes son de la Fase 5.)

Devuelven **200 con warning**, no 409:

- Borrar un recurrente que tiene turnos futuros ya generados
- Desactivar un recurrente en la misma situación

```json
{
  "ok": true,
  "data": { "turnosFuturosCount": 2, "turnosFuturos": [...] },
  "warning": "El recurrente fue eliminado pero quedan 2 turno(s) futuro(s) agendado(s) que no se cancelaron automáticamente."
}
```

**Por qué no bloquea:** los turnos ya generados son compromisos con clientes reales. Borrar la regla de recurrencia no debería cancelarlos.

**Criterios de aceptación:**

- [ ] Las 5 operaciones devuelven 409 con la lista cuando hay conflictos
- [ ] Los 5 mensajes coinciden textualmente
- [ ] El payload del 409 incluye `id`, `fecha`, `hora`, `nombre`, `telefono`, `servicio` de cada turno
- [ ] Un bloqueo administrativo NO cuenta como conflicto
- [ ] Una reserva cancelada NO cuenta como conflicto
- [ ] Un turno pasado NO cuenta como conflicto
- [ ] Borrar un barbero con recurrentes avisa de los recurrentes en el mensaje
- [ ] ⏭️ *(tarea 5.2)* Borrar un recurrente con turnos futuros devuelve 200 con warning, no 409

---

## Tarea 3.3 — Clientes

| Método | Ruta | Rol |
|---|---|---|
| GET | `/admin/api/clientes` | scoped |
| GET | `/admin/api/clientes/exportar` | scoped, CSV |
| GET | `/admin/api/clientes/:id/historial?skip&limit` | scoped |
| POST | `/admin/api/clientes` | **owner** |
| POST | `/admin/api/clientes/importar` | **owner** |

**Scoping:** un `barbero` ve solo los clientes que tienen al menos una reserva con él. Un `owner` ve todos.

**Límites:** listado 100 por página, historial máx 200, export máx 10.000, import máx 1.000 por request.

**Dedup en el import:** por teléfono normalizado. Devolver `{ importados, salteados }`.

**El export es CSV** con `Content-Type: text/csv` y `Content-Disposition: attachment`.

**Criterios de aceptación:**

- [ ] Un `barbero` no ve clientes que nunca atendió
- [ ] El import saltea duplicados por teléfono normalizado y los cuenta
- [ ] Importar 1.001 registros se rechaza
- [ ] El CSV abre correctamente en Excel (encoding y separador)
- [ ] El historial devuelve el total en un header o en el payload
- [ ] Un `barbero` que intenta crear un cliente recibe **403** (no 401)

---

## Tarea 3.4 — Catálogos y configuración

| Método | Ruta | Rol |
|---|---|---|
| GET/POST | `/admin/api/barberos` | **owner** |
| PUT/DELETE | `/admin/api/barberos/:id` | **owner**, 409 |
| GET/POST | `/admin/api/servicios` | **owner** |
| PUT/DELETE | `/admin/api/servicios/:id` | **owner** |
| GET/POST/PUT/DELETE | `/admin/api/promos[/:id]` | **owner** |
| GET/POST/PUT | `/admin/api/catalogo[/:id]` | **owner** |
| GET | `/admin/api/negocio` | cualquiera |
| PUT | `/admin/api/negocio` | **owner** |
| GET | `/admin/api/stats` | scoped |

🐛 **Los chequeos de "solo owner" devuelven 403, no 401.** El sistema viejo usa 401 y está mal: el usuario está autenticado, lo que le falta es permiso.

### Barberos

Alta con `slug` único (es el usuario de login) y password inicial. Baja y desactivación pasan por Bloquear+Avisar (tarea 3.2).

**Cuidado con el último owner:** no permitas desactivar o borrar al único barbero con rol `owner`, o el panel queda inaccesible. El sistema viejo no valida esto — agregalo.

### Servicios

`nombre` único. Manejá el conflicto con un mensaje claro, no con un 500.

`duracion_min` es la que se usa para calcular solapamiento en las reservas nuevas. Cambiarla **no** afecta las reservas ya creadas (tienen su snapshot).

### Configuración del negocio

Validá rangos: `slot_duracion_min` entre 5 y 240, `minutos_anticipacion_min` entre 0 y 10080, `dias_max_anticipacion` entre 1 y 365.

`timezone` tiene que ser un identificador **IANA** válido. Validalo contra `Intl.supportedValuesOf('timeZone')` si está disponible.

### Stats

Conteos: reservas de hoy, de la semana, del mes, y recurrentes activos. Scoped por rol.

**Criterios de aceptación:**

- [ ] Un `barbero` en cualquier endpoint de owner recibe **403**
- [ ] `slug` duplicado al crear un barbero da 400 con mensaje claro, no 500
- [ ] `nombre` duplicado al crear un servicio da 400 con mensaje claro
- [ ] Desactivar al único owner se rechaza
- [ ] Cambiar la duración de un servicio no altera reservas existentes
- [ ] Un `timezone` inválido se rechaza
- [ ] Las stats de un `barbero` solo cuentan lo suyo

---

## Cierre de la Fase 3

- [ ] `npm test` en verde
- [ ] Se puede operar la barbería completa desde la API sin tocar la base
- [ ] Los 5 casos de Bloquear+Avisar devuelven 409 con su lista
- [ ] Todos los chequeos de permiso devuelven 403, ninguno 401
