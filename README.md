# Tareas — Barbería Gebyanos v2

Estos archivos están hechos para tirarlos en Claude Code de a uno.

## Cómo usarlos

**Cada sesión arranca con dos archivos:** `00-CONTEXTO.md` y el archivo de la fase en la que estés.

```
> Leé 00-CONTEXTO.md y 01-FASE-1-cimientos.md. Empezá por la tarea 1.1.
```

Y después, tarea por tarea:

```
> Ahora la tarea 1.2.
```

**Por qué así y no un archivo por tarea:** las tareas de una fase comparten contexto (el schema, los helpers, las convenciones). Si le tirás una tarea aislada, Claude Code reinventa decisiones que ya estaban tomadas en la anterior.

**Por qué `00-CONTEXTO.md` siempre:** tiene las constantes, las convenciones de datos, el manejo de timezone y los seis bugs del sistema viejo que no hay que copiar. Sin eso, cada sesión los reintroduce.

## Los archivos

| Archivo | Contenido | Tareas |
|---|---|---|
| `00-CONTEXTO.md` | Reglas del proyecto. **Va en toda sesión** | — |
| `01-FASE-1-cimientos.md` | Setup, schema, lógica pura con tests | 1.1 a 1.6 |
| `02-FASE-2-reservas.md` | Durable Object, reserva punta a punta, auth | 2.1 a 2.7 |
| `03-FASE-3-configuracion.md` | Horarios, feriados, bloquear+avisar, catálogos | 3.1 a 3.4 |
| `04-FASE-4-integraciones.md` | Calendar, WhatsApp, cifrado, crons | 4.1 a 4.4 |
| `05-FASE-5-magic-links-recurrentes.md` | Magic links, recurrentes, cron automático | 5.1 a 5.3 |
| `06-FASE-6-provisioning.md` | Una instancia por barbería: provisioning y operación | 6.1 a 6.5 |

### Track de frontend — agente y rama aparte

| Archivo | Contenido | Tareas |
|---|---|---|
| `FE-1-cimientos-y-sitio-publico.md` | Stack, cliente de API, landing, flujo de reserva, mi-turno | FE-1.1 a FE-1.4 |
| `FE-2-panel-admin.md` | Login, agenda, reservas, clientes, recurrentes, config | FE-2.1 a FE-2.8 |

**41 tareas en total** (29 de backend + 12 de frontend).

## El orden real, que no es el de los números

Las dependencias no son lineales. Esto es lo que desbloquea qué:

| Cuando cierra | Se desbloquea |
|---|---|
| Backend tarea **2.4** | **FE-1** — el flujo de reserva completo |
| Backend **Fase 3** | **FE-2** — el panel admin |
| Aparece una segunda barbería | **Fase 6** — provisioning |

O sea: el frontend corre **en paralelo** a las fases 3, 4 y 5 del backend, en otra rama y con otro agente. Y la Fase 6 no es "lo último", es "cuando haga falta" — sin frontend no lanzás nada, sin provisioning sí.

✅ **El contrato de API ya existe: `docs/contrato-api.md`**, generado leyendo el código real. Es la fuente de verdad para el frontend — no inventar nada que no esté ahí.

## Estado

| | Estado |
|---|---|
| **Backend, fases 1 a 5** | ✅ Completo, deployado, 788 tests |
| **Fase 6 — provisioning** | ⏸️ Espera a que exista una segunda barbería |
| **FE-1 — sitio público** | ⬜ Desbloqueado, sin empezar |
| **FE-2 — panel admin** | ⬜ Desbloqueado, sin empezar |

**Lo único en el camino crítico es el frontend.** El backend está completo; sin interfaz no hay producto.

### Pendientes de lanzamiento, no de código

- 🔴 **Rotar la credencial de Google** que está en texto plano en `barberiagebyanos.BE/appsettings.Development.json`. Es una exposición activa, no un ítem de checklist.
- **Cargar el horario real de Gebyanos.** Hoy producción tiene un placeholder de 9 a 20 corrido, así que ofrece turnos a las 14:00. Lo tiene que decir el cliente.
- **Decidir si se migran los datos de Azure.** Primero hay que saber si el sistema viejo sigue en uso con turnos reales.

## El orden importa

Cada fase declara su criterio de salida. **No arranques una fase sin la anterior terminada** — las dependencias son reales, no burocracia.

Dos puntos donde conviene frenar y revisar antes de seguir:

**Fase 1, tarea 1.2.** Hay un spike: verificar que D1 acepte `CREATE UNIQUE INDEX ... WHERE`. SQLite lo soporta pero la doc de Cloudflare no lo confirma. Si no funciona, cambia el diseño del anti-doble-reserva de la Fase 2.

**Fase 2, tarea 2.1.** El Durable Object y su test de concurrencia. Es el invariante del sistema: 50 requests al mismo slot, exactamente uno gana. **Validalo antes de construir encima.**

## Restricción de costo

**Free tier estricto: no se paga nada.** Está explicado en `00-CONTEXTO.md` con los límites y el consumo estimado.

Si Claude Code sugiere pasar a un plan pago, la respuesta es no — hay alternativa gratuita para todo lo que necesita este sistema. Un caso ya apareció: dijo que Cloudflare Queues requería plan pago, y no es cierto (está en el Free plan desde febrero de 2026, 10.000 operaciones diarias). Verificá antes de aceptar ese tipo de afirmación.

## Referencias

- **Spec completa:** `docs/spec-barberia-cloudflare.md` — cuando un archivo de fase no alcance
- **Código viejo:** `barberiagebyanos.BE/` — la fuente de verdad de las reglas
- **Casos borde:** `docs/EDGE_CASES.md` — leelo completo antes de la Fase 2

## Un consejo

Los mensajes de error de estos archivos son transcripción textual del sistema en producción. Cuando Claude Code te los quiera "mejorar", decile que no: el frontend y los tests dependen de ellos.

---

## Emergencia: el owner no puede entrar

**Cuándo aplica.** Un barbero no puede loguearse y no es que se equivoque de
password:

- su `password_hash` quedó corrupto (vas a ver líneas `HASH_INVALIDO` en
  `wrangler tail`, con el `barberoId`);
- o nunca se le cargó una y no hay otro owner que pueda hacerlo;
- o se perdió la password del único owner.

**Por qué hace falta un procedimiento.** El endpoint que cambia la password
**exige estar logueado**. Si el que quedó afuera es el único owner, el panel es
inaccesible y no hay ninguna puerta desde la aplicación. La única salida es
escribir el hash directo contra la base.

### Los tres pasos

**1. Confirmá que es esto y no otra cosa.** Si es un hash corrupto, el log lo
dice:

```bash
./node_modules/.bin/wrangler tail --format pretty | grep HASH_INVALIDO
```

La línea trae el `barberoId` y el motivo. **Nunca trae el hash ni la
password** — si aparecieran ahí, eso sería un bug aparte.

**2. Generá el hash nuevo:**

```bash
node scripts/hash-password.mjs 'una-password-nueva-y-larga'
```

Mínimo 12 caracteres, igual que el alta normal. El script imprime el hash por
stdout y el comando listo por stderr.

⚠️ **La password queda en el historial del shell.** Borrala después
(`history -d`), o poné un espacio adelante del comando si tu shell respeta
`HISTCONTROL=ignorespace`.

**3. Escribilo. Probá primero en local, sin `--remote`:**

```bash
./node_modules/.bin/wrangler d1 execute barberia --local --command \
  "UPDATE barberos SET password_hash = 'pbkdf2$...' WHERE slug = 'gaby'"
```

y recién después contra producción:

```bash
./node_modules/.bin/wrangler d1 execute barberia --remote --command \
  "UPDATE barberos SET password_hash = 'pbkdf2$...' WHERE slug = 'gaby'"
```

El hash lleva base64, o sea `+`, `/` y `=`. Van bien dentro de comillas simples
en SQL — verificado con un round-trip contra la base local: vuelve idéntico.

**Después de entrar, cambiá la password desde el panel.** El hash que escribiste
a mano quedó en el historial del shell y en el buffer de la terminal.

### Por qué el script y no un hash a mano

El formato es `pbkdf2$<iteraciones>$<salt-b64>$<hash-b64>` y tiene que coincidir
**carácter por carácter** con `src/services/password.ts`: mismo separador, mismo
esquema, 50.000 iteraciones, SHA-256, salt de 16 bytes y 32 bytes derivados.

Un hash con otra forma **no falla al escribirlo**. Falla después, en el login, y
para entonces nadie relaciona las dos cosas — te queda un barbero afuera con el
mismo síntoma que viniste a arreglar.

Hay un test que verifica un hash real generado por el script, y otro que falla
si las constantes del script y las de `password.ts` se separan.
