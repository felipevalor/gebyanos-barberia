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

## Qué NO sale por endpoints anónimos

Las queries seleccionan columnas de forma explícita, nunca `SELECT *`. En
`barberos` conviven con los datos públicos:

- `password_hash`
- `callmebot_apikey`
- `callmebot_phone`
- `tel`
- `calendar_id`

Ninguno de esos sale por `/api/barberos`. Hay test que lo verifica.
