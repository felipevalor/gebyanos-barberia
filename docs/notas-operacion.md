# Notas de operación

Cosas del tooling que ya nos mordieron una vez. Provisorio: cuando exista el
runbook de la Fase 6, esto se muda ahí.

---

## `-y` no existe en `wrangler d1 migrations apply`

**Síntoma:** el comando imprime un texto largo que parece informativo, no aplica
ninguna migración, y sale con **exit code 1**.

```bash
wrangler d1 migrations apply barberia --remote -y   # ❌ no migra nada
wrangler d1 migrations apply barberia --remote      # ✅
```

**Causa:** `-y` / `--yes` **sí existe** en `wrangler d1 execute`, pero **no** en
`wrangler d1 migrations apply`. Es una inconsistencia entre dos subcomandos de la
misma familia, y es lo que la hace fácil de arrastrar: copiás el flag de un
comando al otro y parece razonable.

El error real está ahí, pero enterrado arriba de ~10 líneas de texto de ayuda:

```
✘ [ERROR] Unknown argument: y
```

**No hace falta el flag.** En un entorno no interactivo (CI, o cualquier shell
sin TTY) `migrations apply` ya saltea la confirmación solo:

```
? About to apply 1 migration(s) ... continue?
🤖 Using fallback value in non-interactive context: yes
```

**En CI:** el exit code 1 hace que el job falle, así que no pasa en verde sin
migrar — pero el output *parece* de ayuda, no de error, y se diagnostica mal.
Si el paso de migración está detrás de un `|| true`, un `continue-on-error`, o
dentro de un script que no propaga el código de salida, ahí sí pasa silencioso.

**Verificación** (2026-08-15, wrangler 4.123.0):

| Comando | Migraciones aplicadas | Exit code |
|---|---|---|
| `d1 migrations apply --local -y` | 0 tablas creadas | 1 |
| `d1 migrations apply --local` | 13 tablas creadas | 0 |

Para chequear que realmente migró, no alcanza con el exit code:

```bash
wrangler d1 migrations list barberia --remote   # vacío = todo aplicado
```

---

## ⚠️ PBKDF2 usa el 76% del presupuesto de CPU del login

**Medido, no estimado** (2026-08-17, workerd 1.20260811.1, promedio de 12
verificaciones sobre Apple Silicon):

| Iteraciones | ms por verificación | % del techo de 10 ms |
|---|---|---|
| 25.000 | 1,92 | 19% |
| 50.000 | 3,83 | 38% |
| 75.000 | 5,67 | 57% |
| **100.000** | **7,58** | **76%** ← el valor en uso |
| 150.000 | 11,25 | **112% — no entra** |

Es lineal: **~0,076 ms por cada 1.000 iteraciones**.

### Lo que esto significa

**El plan Free da 10 ms de CPU por request.** Un login con 100.000 iteraciones
consume 7,6 de esos 10. Quedan ~2,4 ms para todo lo demás: parseo del JSON,
routing, la query a `barberos`, el insert de la sesión y el armado de la
cookie. Entra, pero sin lugar para descuidos.

**No hay margen para subir el costo.** 150.000 iteraciones ya no entran, así
que la recomendación habitual de aumentar las iteraciones con el tiempo **no es
aplicable en el plan Free**. Si en algún momento hace falta más costo, hay que
cambiar de estrategia, no de número.

### ⚠️ El riesgo que no se puede medir desde acá

La medición es sobre **una máquina de desarrollo**, y el CPU del edge de
Cloudflare puede ser más lento. Si lo fuera un 30%, 100.000 iteraciones darían
~9,9 ms y el login quedaría al borde de un
`Worker exceeded CPU time limit`.

**Verificar en producción antes de confiar.** Al primer deploy, hacer un login
real y mirar el CPU time en los logs del dashboard. Si supera ~8 ms, bajar
`ITERACIONES` en `src/services/password.ts` a 75.000 (5,7 ms) o 50.000
(3,8 ms).

Bajar iteraciones **no invalida los hashes existentes**: cada hash guarda las
suyas y se verifica con esas. `necesitaRehash()` detecta los que quedaron
distintos de la constante actual.

### El canario

`test/services/password.test.ts` tiene un test que falla si una verificación
supera los 10 ms. No sustituye la medición en producción, pero avisa si alguien
sube las iteraciones sin medir.

---

## Un Durable Object NO serializa las llamadas a D1

**"Un DO procesa un request a la vez" vale para `ctx.storage`, no para llamadas
externas.** Las input gates del DO gatean las operaciones de su propio storage.
D1 es un binding externo: cada `await env.DB...` cede el event loop y otro
request puede entrar.

Consecuencia en `BarberoAgenda`: 50 requests simultáneos pueden leer todos la
misma foto "no hay nada reservado", decidir todos que no hay overlap, y recién
chocar en el `INSERT`.

- Mismo `(fecha, hora)` exacto → lo ataja el índice único parcial.
- Solapamiento **parcial** (10:00 de 30 min contra 09:30 de 60) → no comparten
  clave, **el índice no los ve, y entran los dos**.

**Solución:** la sección crítica leer-decidir-escribir va dentro de
`ctx.blockConcurrencyWhile()`. La doc lo dice explícito:

> Reserve `blockConcurrencyWhile` [...] for cases where you make external async
> calls (such as `fetch()`) and cannot tolerate state changes while the event
> loop yields.

**No dejar que una excepción escape del callback** — hace que el DO se resetee.
Atrapar adentro y devolver el error como valor.

**Verificado por mutación** (2026-08-15): sacando el `blockConcurrencyWhile`, el
test de solapamiento parcial da **2 ganadores en vez de 1**. El de mismo slot
exacto sigue pasando, porque ahí actúa el índice. Si alguien "simplifica" esa
llamada, el test que se rompe es
`test/do/barbero-agenda.test.ts > concurrencia > 50 simultaneos con solapamiento PARCIAL`.

---

## Usar el wrangler del proyecto, no el global

Hay un wrangler global instalado que está atrasado (4.72 vs 4.123 del proyecto).
Con el viejo aparecieron errores de auth que con el local no pasan.

```bash
./node_modules/.bin/wrangler ...   # ✅
npx wrangler ...                   # ⚠️ depende del PATH
```

Los scripts de `package.json` ya resuelven al binario local.

---

## Texto de los errores de constraint de D1

El mismo error se ve distinto según desde dónde se lo mire — importa para
matchear en el código. Detalle completo en
[`spike-indice-unico-parcial.md`](./spike-indice-unico-parcial.md).

| Origen | Texto |
|---|---|
| Worker (`env.DB`) | `D1_ERROR: UNIQUE constraint failed: ...` |
| `wrangler d1 execute --local` | `UNIQUE constraint failed: ...` |
| `wrangler d1 execute --remote` | `UNIQUE constraint failed: ... [code: 7500]` |

Lo estable para matchear es `UNIQUE constraint failed`. El prefijo y el
`[code: 7500]` son envoltorios de capa.
