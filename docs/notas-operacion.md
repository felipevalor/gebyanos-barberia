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

## ⚠️ PBKDF2 y el presupuesto de 10 ms de CPU del plan Free

**Medido, no estimado** (2026-08-17, workerd 1.20260811.1, promedio de 12
verificaciones sobre Apple Silicon):

| Iteraciones | ms por verificación | % del techo de 10 ms |
|---|---|---|
| 25.000 | 1,92 | 19% |
| **50.000** | **3,83** | **38%** ← el valor en uso |
| 75.000 | 5,67 | 57% |
| 100.000 | 7,58 | 76% |
| 150.000 | 11,25 | **112% — no entra** |

Es lineal: **~0,076 ms por cada 1.000 iteraciones**.

### Por qué 50.000 y no 100.000

La medición es sobre **una máquina de desarrollo**, y el CPU del edge de
Cloudflare puede ser más lento. Con 100.000 iteraciones (7,6 ms) un edge 30%
más lento daría ~9,9 ms: el login al borde de un `Worker exceeded CPU time`.
Con 50.000 el mismo escenario da ~5 ms y sigue habiendo margen.

**La pérdida de seguridad es menor de lo que parece.** OWASP recomienda hoy
~600.000 iteraciones para PBKDF2-SHA256: ni 50.000 ni 100.000 se acercan, o sea
que el presupuesto de CPU del plan Free nos deja debajo de la recomendación de
cualquier forma. Aceptado eso, un bit de factor de trabajo vale menos que un
login que no se cae.

**La compensación es el largo de la contraseña: mínimo 12 caracteres**
(`LARGO_MIN_PASSWORD`). Cada carácter extra multiplica el espacio de búsqueda;
duplicar las iteraciones solo lo duplica.

### Restricción de arquitectura, no nota al pie

**La recomendación estándar de subir las iteraciones con los años es imposible
en el plan Free.** 150.000 ya no entra en el presupuesto. Si en algún momento
hace falta más factor de trabajo, la salida no es un número más alto: es
**Workers Paid**, con 30 s de CPU por request.

### 🔴 MEDIDO EN PRODUCCIÓN: el edge es 3× más lento, y el techo NO es 10 ms

Medición del 2026-08-17 sobre el Worker deployado, leyendo `cpuTime` de
`wrangler tail`:

| Qué | Local (Apple Silicon) | **Cloudflare edge** | Factor |
|---|---|---|---|
| Una derivación PBKDF2 de 50.000 iteraciones | 3,83 ms | **~11,6 ms** | **3,0×** |
| Un request de login completo | — | **20–57 ms de CPU** | |

**El hardware del edge es tres veces más lento que la máquina de desarrollo.**
Con 100.000 iteraciones una derivación costaría ~23 ms.

**Y el techo real de este Worker no son 10 ms: son ~1,8 segundos.** Medido
haciendo N derivaciones en un request hasta que Cloudflare lo cortara:

```
n=150 derivaciones → 200 OK    (~1,2 s de CPU)
n=200 derivaciones → 503       outcome: exceededCpu, cpuTime: 1803
```

**Las dos cosas juntas cambian el análisis:**

1. Si el límite fuera realmente de 10 ms, **el login fallaría con cualquier
   configuración**: los 11,6 ms de la derivación ya lo superan, sin contar el
   resto del request. Funciona porque el límite efectivo es ~1,8 s.
2. O sea que **la restricción de 10 ms que motivó elegir PBKDF2 sobre BCrypt no
   aplica a este deployment.** Hay que averiguar por qué — lo más probable es
   que la cuenta esté en Workers Paid, lo que contradice el "free tier, sin
   excepciones" de `00-CONTEXTO.md`.

⚠️ **Pendiente de confirmar con el dueño de la cuenta: qué plan tiene.** Si
alguna vez pasa a un plan con techo real de 10 ms, el login se rompe con
50.000 iteraciones y también con 25.000.

### Cómo se midió, para poder repetirlo

`performance.now()` **está congelado dentro del Worker en producción**
(mitigación de Spectre): devuelve 0.000 siempre. No sirve para medir.

Lo que sí funciona:

1. Un endpoint temporal que corre N derivaciones en un request.
2. `wrangler tail --format json` y leer `cpuTime` de cada evento.
3. La pendiente entre dos valores de N da el costo por derivación:
   `(cpu(n=100) − cpu(n=10)) / 90`.
4. Subir N hasta que aparezca `outcome: exceededCpu` da el techo real.

El endpoint de diagnóstico se borró apenas terminó la medición.

### Verificación del primer deploy — HECHA

Si se cambian las iteraciones, repetir la medición con el método de arriba.

Cambiar el número **no invalida ningún hash existente**: las iteraciones viven
dentro del hash (`pbkdf2$50000$sal$hash`) y cada uno se verifica con las suyas.
Es lo que permitió bajar de 100.000 a 50.000 sin que nadie perdiera su
contraseña. Hay tests que lo fijan.

### El canario

`test/services/password.test.ts` falla si una verificación supera **6 ms** — no
10. Con el umbral en 10 recién avisaría cuando ya no queda margen para el resto
del request, y la medición local es optimista respecto del edge.

---

## 🔴 El seed es SOLO local. Nunca contra una base alcanzable.

`src/db/seed.sql` trae credenciales de desarrollo **en texto plano en el
repositorio público**: `gaby` / `gebyanos-dev-2026`.

**Si esa base queda alcanzable con ese usuario cargado, cualquiera que lea el
repo entra al panel.** No hace falta ningún ataque: la contraseña está escrita
en el archivo.

```bash
wrangler d1 execute barberia --local  --file=./src/db/seed.sql   # ✅ siempre
wrangler d1 execute barberia --remote --file=./src/db/seed.sql   # 🔴 NUNCA
```

Lo mismo vale para cualquier base de staging o preview que tenga una URL
pública. El seed existe para levantar el entorno local en un comando, nada más.

**El script `db:seed:local` de `package.json` ya lleva `--local` fijo.** No
agregar una variante remota.

### Cómo se crean los usuarios reales

Uno por uno, generando la contraseña en el momento y guardando **solo el hash**
en la base:

1. generar una contraseña aleatoria fuerte (≥ 20 caracteres)
2. hashearla con `hashPassword()` — PBKDF2, 50.000 iteraciones
3. `INSERT` del barbero con el hash, nunca con el texto plano
4. entregar la contraseña por un canal fuera de banda y borrarla de donde
   quedó

La contraseña en claro no va al repositorio, ni a un commit, ni a un log.

---

## El binding nativo de Rate Limiting no sirve para este sistema

Se evaluó `env.RATE_LIMITER.limit({ key })` antes de escribir el Durable
Object. Es más simple y no requiere código propio. **No alcanza**, por tres
razones, en orden de peso:

**1. La ventana no es expresable.** De la doc:

> `simple.period` — The duration of the rate limit window, in seconds. **Must
> be either 10 or 60.**

La ventana de este sistema es de **15 minutos** (900 s). No hay configuración
que la produzca, y aproximarla con 60 s cambia la regla de negocio.

**2. El contador es por ubicación de Cloudflare.**

> For each unique key you pass to your rate limiting binding, there is a unique
> limit **per Cloudflare location**.

Contra fuerza bruta sobre el login eso es fatal: un atacante que rote de PoP
multiplica el cupo por la cantidad de ubicaciones.

**3. Es deliberadamente inexacto.**

> permissive, eventually consistent, and **intentionally designed to not be
> used as an accurate accounting system**.

### Lo que sí conviene saber del binding

Si alguna vez encaja para otro caso: comparte contadores entre Workers de la
misma cuenta cuando comparten `namespace_id`, y **no es visible en el
dashboard**.

La doc además desaconseja limitar por IP, porque muchos usuarios pueden
compartirla. Acá se hace igual: el cliente es anónimo y no hay identidad que
usar. Es una limitación conocida — una barbería con wifi compartido puede
autobloquearse — y la mitigación es que la ventana es corta y el límite alto
para un uso normal.

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


---

## CallMeBot devuelve HTTP 200 cuando falla

Es el comportamiento menos obvio de toda la Fase 4 y merece quedar escrito
fuera del código.

`GET https://api.callmebot.com/whatsapp.php?phone=…&text=…&apikey=…` responde
**200 con el error en el cuerpo**, en inglés y en prosa. Ejemplos reales:

- `You need to ask for an API key first`
- `APIKey is invalid`
- `The phone number is not registered in the bot`

Un cliente que mire el status da por enviado un mensaje que nunca salió, y el
barbero se entera cuando el cliente no aparece.

La detección es una heurística sobre nueve palabras
(`error`, `apikey`, `not allowed`, `not registered`, `invalid`, `no longer`,
`you need to`, `wrong`, `fail`), case-insensitive, sobre el cuerpo ya limpio de
HTML y truncado a 300 caracteres.

### CallMeBot refleja el request — verificado, no supuesto

Probado contra el servicio real el **2026-08-18**, con una apikey inválida y un
marcador en el texto:

```
GET .../whatsapp.php?phone=%2B10000000000&text=ZZMARCADORZZ%20Nombre%3A%20Juan&apikey=999999999

HTTP 203
<p>Message to: +10000000000
<p>Text to send: ZZMARCADORZZ Nombre: Juan
<p style="color:red"><b>APIKey is invalid.</b> Please create a new one or contact support if you lost it.
```

Tres cosas, todas con consecuencias:

**1. El texto enviado vuelve.** El falso positivo de la heurística no era
hipotético. De los seis campos del mensaje, el único que controla el cliente es
`nombre` — el servicio sale del catálogo y la nota es uno de siete strings
fijos — así que el escenario real es alguien llamándose **"Error"**, que además
de ser una de las nueve palabras es una palabra española corriente.

Resuelto sin tocar el trade-off: las nueve palabras se buscan sobre la
respuesta **menos el eco del request** (`quitarEco`). El `motivo` que ve el
barbero conserva el cuerpo entero, porque el eco ayuda a saber de qué mensaje
se habla.

**2. El teléfono vuelve.** Y el cuerpo termina persistido como `motivo` y
expuesto por `GET /api/admin/avisos-fallidos`. Se enmascara.

**3. La apikey NO vuelve** — pero se redacta igual. Cuesta cero, y el día que
CallMeBot cambie el formato la alternativa es una credencial dentro de una
respuesta HTTP que cualquier barbero autenticado puede leer.

**El status del error fue 203, no 200.** La spec decía 200. Los dos son 2xx así
que el código no cambia, pero confirma que mirar el status no sirve de nada.

### La API key va en la query string

CallMeBot **no soporta autenticación por header**. Eso hace que la URL completa
sea un secreto:

- la URL no se loguea nunca, ni en el camino de error;
- de la excepción se toma sólo `e.message`, no el error entero: un `TypeError`
  de `fetch` puede traer la URL en su `cause`;
- de los teléfonos se loguean sólo los últimos 4 dígitos.

Hay un test que falla si cualquiera de esas tres cosas se rompe.


---

## `ENCRYPTION_KEY` es obligatoria y su ausencia es un fallo ruidoso

Cifra las API keys de CallMeBot (AES-GCM 256). **Sin ella, el `PUT` de
`/api/admin/callmebot` devuelve 500 y no guarda nada.**

Es deliberado. La alternativa —caer a una clave por defecto o vacía— produce
datos que *parecen* cifrados y no lo están: se descubre tarde, con la base
entera comprometida. Un 500 con un mensaje que dice qué hacer se arregla en un
minuto:

```bash
wrangler secret put ENCRYPTION_KEY
```

Puede ser cualquier string: se le aplica SHA-256 para llegar a los 32 bytes que
AES-256 necesita, así que no hace falta generarla en un formato particular.

### Rotarla invalida las keys guardadas

No hay re-cifrado automático. Si se cambia `ENCRYPTION_KEY`, las
`callmebot_apikey` existentes dejan de descifrarse: `descifrar` devuelve `null`
y el sistema degrada a "este barbero no tiene credencial" — no explota, pero
los avisos dejan de salir en silencio. Hay que volver a cargarlas desde el
panel.

El formato lleva prefijo de versión (`v1:iv:ciphertext`) para poder rotar el
**esquema** sin migrar todo de golpe. Rotar la **clave** es otra cosa y hoy no
está resuelto: si llega a hacer falta, el camino es un `v2` que intente primero
la clave nueva y caiga a la vieja.
