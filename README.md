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

**El contrato de API se genera cuando cierre la tarea 2.4**, leyendo el código real. Hasta entonces el frontend no debe inventar contratos.

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
