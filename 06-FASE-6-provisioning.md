# Fase 6 — Una instancia por barbería

> Requiere `00-CONTEXTO.md` cargado y la **Fase 5 terminada**.
> **Criterio de salida:** dar de alta una barbería nueva es un comando, y actualizar todas las existentes es otro.

---

## Por qué esta fase existe

El sistema es single-tenant: una barbería, una base de datos, un Worker. Para atender varias barberías, **cada una tiene su propia instancia completa**.

Suena a más trabajo que un sistema multi-tenant, pero para esta escala es al revés:

| | Una instancia por barbería | Multi-tenant |
|---|---|---|
| Código de tenancy | Cero | Middleware de resolución, scoping en cada query |
| Riesgo de fuga entre clientes | Imposible — no comparten base | Un `WHERE` olvidado y una barbería ve datos de otra |
| Radio de daño de un deploy roto | Una barbería | Todas |
| Bindings de D1 | Estáticos y correctos | El problema que no tiene solución limpia hoy |
| Costo | $0 (Free tier alcanza) | $0 |
| Operación | N deploys, N migraciones | Uno |

**El único costo real es operativo, y esta fase existe para automatizarlo.** Sin automatización, a la quinta barbería lo estás haciendo a mano y odiando tu vida.

### Los límites del free tier

⚠️ **El plan gratuito da 10 bases D1 por cuenta.** O sea: **hasta 10 barberías por cuenta de Cloudflare**.

No es un problema hoy (tenés una), pero es el techo. Cuando se acerque, las opciones son otra cuenta de Cloudflare, o revisar si el volumen ya justifica pagar. **No lo resuelvas por anticipado** — anotalo y seguí.

Los demás límites (100.000 requests/día, 5 crons) son **por cuenta**, no por Worker. Con 10 barberías de bajo volumen seguís sobrando, pero los 5 Cron Triggers sí se comparten: con 3 crons por instancia, a partir de la segunda barbería no alcanzan. **Ver tarea 6.4.**

---

## Tarea 6.1 — Configuración por instancia

**Un solo repo. Nunca forkees el código por barbería.** Si a los seis meses tenés cinco copias con variaciones, ya perdiste: nadie se acuerda cuál tiene el fix del cálculo de slots.

Lo que varía entre instancias va **afuera del código**:

| Qué | Dónde |
|---|---|
| Nombre del Worker | `wrangler.jsonc` generado por instancia |
| ID de la base D1 | Idem |
| ID del namespace KV | Idem |
| Dominio | Idem |
| Secrets (firma de magic links, credenciales de Google y CallMeBot) | `wrangler secret`, por instancia |
| Nombre del negocio, branding, horarios | Tabla `negocio` de cada base |

**Estructura sugerida:**

```
clientes/
  gebyanos/
    wrangler.jsonc      # nombre, IDs de D1 y KV, dominio
    seed.json           # nombre del negocio, barbero owner, servicios iniciales
  otra-barberia/
    wrangler.jsonc
    seed.json
```

El código en `src/` es idéntico para todas. Un cambio se propaga a todas con un redeploy.

**Los secrets nunca van en el repo.** Se cargan con `wrangler secret put` al provisionar.

**Criterios de aceptación:**

- [ ] Existe una sola copia del código en `src/`
- [ ] Cada instancia tiene su carpeta con `wrangler.jsonc` y `seed.json`
- [ ] Ningún secret está commiteado
- [ ] Se puede deployar una instancia específica con un flag o variable

---

## Tarea 6.2 — Script de provisioning

**El corazón de la fase.** Dar de alta una barbería tiene que ser un comando:

```bash
npm run provision -- --slug=nuevabarberia --nombre="Barbería Nueva" \
                     --owner-email=dueño@ejemplo.com
```

### Qué hace el script, en orden

1. **Valida el slug**: regex `^[a-z0-9-]{3,30}$`. Verifica que no exista ya una instancia con ese nombre.
2. **Crea la base D1**: `wrangler d1 create barberia-{slug}`. Captura el `database_id` que devuelve.
3. **Crea el namespace KV**: `wrangler kv namespace create CACHE-{slug}`. Captura el ID.
4. **Genera `clientes/{slug}/wrangler.jsonc`** a partir de una plantilla, con los IDs reales.
5. **Corre las migraciones** contra la base nueva.
6. **Siembra los datos iniciales:** la fila de `negocio` (con el nombre y el timezone), el barbero `owner` con una password temporal generada, y los horarios de ese barbero (lunes a sábado, 9 a 20 — ver Fase 3, tarea 3.1).
7. **Genera y carga los secrets:** la clave de firma de magic links (32+ caracteres aleatorios) y la clave maestra de cifrado. Las de Google y CallMeBot quedan pendientes de carga manual, porque son credenciales externas.
8. **Deploya el Worker.**
9. **Verifica:** llama a `/health` y a `/api/negocio` en la URL nueva y confirma que respondan.
10. **Imprime el resumen:** URL, usuario owner, password temporal, y qué quedó pendiente.

### Reglas del script

**Idempotente por slug.** Si lo corrés dos veces con el mismo slug, detecta lo que ya existe y no lo pisa. Debe poder retomar desde donde falló.

**Transaccional en lo posible.** Si falla el paso 6, no dejes una base huérfana sin datos y un `wrangler.jsonc` a medias. Cuando algo falle, mostrá exactamente qué recursos se crearon y qué comando corre la limpieza.

**La password temporal se muestra una sola vez** y hay que cambiarla al primer login. Generala con CSPRNG, no con algo predecible.

**Ojo con el límite de 10 bases D1.** Antes de crear, contá cuántas hay. Si el alta va a ser la número 10, avisá; si ya hay 10, fallá con un mensaje claro en vez de un error críptico de la API.

**Criterios de aceptación:**

- [ ] Un comando crea una barbería funcionando de punta a punta
- [ ] Correrlo dos veces con el mismo slug no rompe nada
- [ ] Si falla a mitad de camino, dice qué se creó y cómo limpiarlo
- [ ] La password temporal se genera con CSPRNG y se muestra una sola vez
- [ ] Al llegar a 10 bases D1, avisa antes de fallar
- [ ] Un slug inválido se rechaza antes de crear ningún recurso
- [ ] El owner puede entrar al panel inmediatamente después

---

## Tarea 6.3 — Migraciones sobre N instancias

Cuando cambia el schema, hay que aplicarlo a todas las bases.

```bash
npm run migrate:all
```

### Qué hace

1. Lee la lista de instancias de `clientes/`.
2. Para cada una, corre las migraciones pendientes.
3. **Sigue aunque una falle.** Una barbería rota no debe frenar a las otras.
4. Al final, reporta: cuántas se migraron, cuántas ya estaban al día, cuáles fallaron y con qué error.

### Reglas

**Las migraciones son forward-only e idempotentes.** Correr `migrate:all` dos veces no debe cambiar nada la segunda vez.

**Nunca migres a ciegas sobre todas.** El comando debería aceptar `--dry-run` para mostrar qué se aplicaría, y `--slug=x` para probar en una sola primero.

**Orden recomendado en producción:** una instancia de prueba, verificar, después el resto.

**El reporte final es lo más importante del comando.** Si tres barberías fallaron y el script termina en silencio, alguien se entera en dos semanas cuando un cliente reporta un error raro.

**Criterios de aceptación:**

- [ ] `migrate:all` aplica las migraciones pendientes a todas las instancias
- [ ] Una instancia que falla no frena las demás
- [ ] El reporte final lista éxitos, sin-cambios y fallos con su error
- [ ] `--dry-run` muestra qué se haría sin hacerlo
- [ ] `--slug=x` corre sobre una sola
- [ ] Correrlo dos veces seguidas no cambia nada la segunda vez

---

## Tarea 6.4 — El problema de los Cron Triggers

⚠️ **Esto hay que resolverlo antes de la segunda barbería.**

El plan gratuito da **5 Cron Triggers por cuenta**, no por Worker. El sistema usa 3 (limpieza, feriados, recurrentes). Con dos barberías serían 6 — **no entran**.

### Tres salidas

**A. Un Worker orquestador de crons** ⭐

Un Worker aparte con los 3 crons. Cuando se dispara, recorre todas las instancias y llama a un endpoint interno de cada una que hace el trabajo.

- A favor: 3 crons en total sin importar cuántas barberías haya. Escala sin límite.
- En contra: hay que autenticar la llamada entre Workers (un secret compartido) y manejar que una instancia caída no frene a las demás.

**B. Un solo cron que hace todo**

Reducir de 3 a 1: un cron diario que hace la limpieza, refresca feriados y genera recurrentes en secuencia.

- A favor: lo más simple. 5 crons alcanzan para 5 barberías.
- En contra: pierde granularidad (la limpieza horaria pasa a diaria), y el techo sigue estando.

**C. Cron externo**

Un servicio gratuito de cron que llame endpoints HTTP.

- A favor: cero consumo de crons de Cloudflare.
- En contra: una dependencia externa más, y hay que proteger esos endpoints.

### Recomendación

**Opción A.** Es la única que escala de verdad y el costo de implementación es una tarde. Con el orquestador, agregar la barbería número 20 no cambia nada.

Detalle importante: el orquestador debe llamar a las instancias **en paralelo con un límite de concurrencia**, y **loguear cuáles fallaron**. Si una barbería no generó sus recurrentes, alguien tiene que enterarse.

**Criterios de aceptación:**

- [ ] Con N barberías, se usan 3 Cron Triggers en total
- [ ] Los endpoints internos están autenticados y no son accesibles desde afuera
- [ ] Una instancia caída no impide que las demás corran su tarea
- [ ] El log del orquestador dice qué instancias corrieron y cuáles fallaron

---

## Tarea 6.5 — Runbook de operación

Documentación en `docs/runbook.md`. **No es opcional** — es lo que permite que alguien que no sos vos opere el sistema.

### Qué tiene que cubrir

**Alta de una barbería.** El comando, qué pedirle al cliente antes (nombre, datos del owner, si quiere Google Calendar y WhatsApp), y qué entregarle después (URL, usuario, password temporal).

**Configurar las integraciones.** Cómo obtener el `calendar_id` de Google y compartir el calendario con la service account. Cómo obtiene el barbero su API key de CallMeBot. Ambas son manuales porque dependen de que el cliente haga algo de su lado.

**Actualizar el sistema.** Cómo deployar un cambio a una instancia y cómo a todas. Cuándo correr migraciones y en qué orden.

**Baja de una barbería.** Cómo suspender (dejar de servir pero conservar los datos) y cómo eliminar. **Exportá los datos antes de borrar nada** — y dejá escrito cómo.

**Diagnóstico.** Qué mirar cuando el cliente dice "no me llegan los WhatsApp", "no aparecen los turnos en el calendario", "no puedo entrar al panel". Los tres son las consultas más frecuentes y los tres tienen causas conocidas.

**Límites y cuándo se acercan.** Los 10 bases D1, los 5 crons, los 10 ms de CPU. Qué hacer al llegar a cada uno.

**Criterios de aceptación:**

- [ ] Alguien que no construyó el sistema puede dar de alta una barbería siguiendo el runbook
- [ ] Están documentadas las tres consultas frecuentes con sus causas conocidas
- [ ] El procedimiento de baja incluye exportar los datos primero
- [ ] Los límites del free tier están listados con su plan de acción

---

## Cierre de la Fase 6

- [ ] Dar de alta una barbería es un comando y funciona de punta a punta
- [ ] Actualizar todas las instancias es otro comando y reporta fallos
- [ ] Los crons no escalan con la cantidad de barberías
- [ ] El runbook permite operar sin haber construido el sistema
- [ ] Todo sigue dentro del free tier

---

## Lo que queda como techo conocido

No son problemas de hoy. Están anotados para que nadie se sorprenda:

| Límite | Techo | Qué hacer al llegar |
|---|---|---|
| Bases D1 por cuenta | **10 barberías** | Otra cuenta de Cloudflare, o evaluar si el volumen justifica pagar |
| Requests por cuenta | 100.000/día compartidos | Con barberías chicas, muy lejos |
| Cron Triggers | 5 por cuenta | Resuelto con el orquestador (tarea 6.4) |

**Y una advertencia sobre el modelo:** una instancia por cliente funciona muy bien hasta unas 10-20 instancias. Más allá, el overhead operativo empieza a superar lo que costaría un multi-tenant bien hecho. **Si el negocio crece a ese punto, es momento de replantear la arquitectura** — pero llegar ahí sería un buen problema, y para entonces vas a tener datos reales para decidir en vez de suposiciones.
