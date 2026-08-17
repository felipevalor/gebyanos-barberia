# Convenciones de la API

## Sobre / envoltorio

Toda respuesta usa el mismo sobre:

```ts
type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };
```

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

## Precios: siempre centavos, siempre enteros

**Se guardan en centavos como `INTEGER` y se exponen en centavos, en un campo
llamado `precioCentavos`.** La API nunca devuelve pesos.

```json
{ "nombre": "Corte", "precioCentavos": 800000 }
```

`800000` centavos = `$8.000,00`.

**Por qué centavos y no pesos:** un precio en pesos como número JSON es un
`double`, y ahí empiezan los `8000.000000001`. El entero no tiene ese problema.

**Por qué el nombre lleva la unidad:** un campo `precio: 800000` se lee como
ochocientos mil pesos y alguien lo va a mostrar así. `precioCentavos` no se
puede malinterpretar.

**El formateo es del frontend.** La API no sabe de locale ni de símbolo de
moneda:

```ts
const formatear = (centavos: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' })
    .format(centavos / 100);
```

Un precio puede ser `null` (servicio o promo sin precio publicado). El frontend
tiene que contemplarlo.

---

## Fechas y horas

| Concepto | Formato | Ejemplo |
|---|---|---|
| Fecha | `"YYYY-MM-DD"` | `"2026-08-15"` |
| Hora | `"HH:mm"` (5 caracteres, con padding) | `"09:30"` |
| Timestamp | ISO-8601 UTC | `"2026-08-15T14:30:00.000Z"` |

Las fechas y horas de turnos son **hora de Argentina**
(`America/Argentina/Buenos_Aires`, UTC-3 fijo). No llevan offset porque no son
instantes: son la fecha y la hora del turno tal como las ve el cliente.

Los timestamps de auditoría (`created_at`, `cancelada_at`) sí son instantes y
van en UTC.

---

## Caché

Los cinco endpoints de catálogo son anónimos y cambian poco:

```
Cache-Control: public, max-age=300
```

Se aplica solo a `GET` con respuesta exitosa. Disponibilidad y reservas **no se
cachean**: un slot puede ocuparse en cualquier momento.

---

## Regla del `activo = 1`

**Toda consulta a una tabla con columna `activo` tiene que filtrarla, salvo que
sea explícitamente una vista de administración.**

Tablas con `activo`: `barberos`, `servicios`, `barbero_horarios`, `promos`,
`catalogo`, `clientes_recurrentes`.

Olvidarlo no rompe nada visiblemente: la consulta devuelve datos de más y el
sistema **se contradice a sí mismo** en otro lado. Los dos casos que ya pasaron:

| Olvido | Síntoma |
|---|---|
| `barberos.activo` en disponibilidad | Un barbero dado de baja seguía ofreciendo horarios, y al reservar rebotaba con `Barbero inválido.` |
| `servicios.activo` en disponibilidad y en la reserva | Un servicio discontinuado se podía reservar, y además imponía su duración |

### El barrido

Para chequear el sistema entero:

```bash
python3 - <<'PY'
import re, pathlib
tablas = {'barberos','servicios','barberoHorarios','promos','catalogo','clientesRecurrentes'}
for p in sorted(pathlib.Path('src').rglob('*.ts')):
    s = p.read_text()
    for m in re.finditer(r'\.from\((\w+)\)', s):
        t = m.group(1)
        if t not in tablas: continue
        v = s[m.start(): m.start()+700]
        sig = v.find('.from(', 6)
        if sig > 0: v = v[:sig]
        marca = 'OK ' if f'{t}.activo' in v else '❌ '
        print(f"{marca}{p}:{s[:m.start()].count(chr(10))+1}  .from({t})")
PY
```

### Qué hacer con lo desactivado

**No rechazar por eso solo.** Un servicio dado de baja no debería impedir
reservar: se trata como inexistente y se cae al default (`"Servicio"`, duración
del slot). Un barbero desactivado sí es `Barbero inválido.`, porque sin barbero
no hay turno posible.

---

## Qué NO sale por endpoints anónimos

Las queries seleccionan columnas de forma explícita, nunca `SELECT *`. En
`barberos` conviven con los datos públicos:

- `password_hash`
- `callmebot_apikey`
- `callmebot_phone`
- `tel`
- `calendar_id`

Ninguno de esos sale por `/api/barberos`. Hay test que lo verifica.
