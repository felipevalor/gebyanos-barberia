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

## Fase 2 — validar teléfono con `esTelefonoArgentino`, no con `normalizeTel`

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

## Tarea 2.5 — el seed no tiene password

`src/db/seed.sql` deja `barberos.password_hash` en NULL: el formato de hash
(PBKDF2) se define en la Fase 2, tarea 2.5. Hasta entonces el owner del seed no
puede loguearse. Al cerrar la 2.5, actualizar el seed con un hash real.
