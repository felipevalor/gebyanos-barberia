# Edge Cases — Barbería Gebyanos

Grounded in actual code. Status: 🔴 bug/gap · 🟡 risk · 🟢 handled.
**Criticos VERIFICADOS leyendo código (2026-06-06).** Confirmaciones abajo.

## Estado de corrección (2026-06-06, branch develop)
- ✅ **CORREGIDO** — Backend POST /reserva valida día/horario/feriado (`ScheduleAvailabilityService` + `ScheduleHelper`, estado `NoDisponible`).
- ✅ **CORREGIDO** — Recurrentes `GenerarTurno` valida día abierto antes de crear.
- ✅ **CORREGIDO** — Cancelar/Editar (mi-turno legacy + magic link) sincronizan Google Calendar (borran/reprograman evento).
- ✅ **CORREGIDO (Bloquear+Avisar)** — Cerrar día / cambiar horario / feriado con turnos existentes ahora devuelve **409** con la lista de turnos en conflicto; el admin los reagenda/cancela antes de aplicar. Esto previene de raíz que el cliente vea un turno en día cerrado.
- ⏳ Pendiente (no en este lote): job automático de recurrentes, soft-delete/estado Cancelado, slot duración variable por servicio, anticipación hardcoded, barbero delete SetNull, rate limit por IP compartida.

Tests: 165/165 verde. Nuevos: `ScheduleHelperTests` (10), `ScheduleAvailabilityServiceTests` (5), reserva no-disponible (4).

## Verificación criticos (confirmado en código)
- ✅ **Día cerrado/horario cambiado con turnos**: `HorariosAdminController.UpdateHorariosDia` (L91 `RemoveRange`) y `UpdateHorario` (L122-124 set `Activo=false`) NUNCA tocan `Reservas`. `MiTurnoController.Buscar` (L62) filtra solo `FechaIso >= hoy` → cliente sigue viendo turno. **REAL.**
- ✅ **POST /reserva no valida horario/día**: `ReservaService.CrearReservaAsync` solo valida formato, pasado, barbero existe, overlap. CERO check vs `BarberoHorario`/feriado. POST directo a domingo cerrado u hora fuera de bloque ENTRA. **REAL.**
- ✅ **Recurrentes generan en día cerrado**: `RecurrentesController.GenerarTurno` (L187-198) solo checa overlap, no horario/feriado. **REAL.** Además NO hay job automático — solo endpoint manual `/generar-turno`. **REAL.**
- ✅ **Hard delete**: `Cancelar` (L137) y `CancelSecure` (L309) `_db.Reservas.Remove`. Sin estado `Cancelado`, sin historial. **REAL.**
- ✅ **Cancelar/Editar NO sincroniza Google Calendar**: ni `Cancelar`/`CancelSecure` borran evento, ni `Editar`/`EditSecure` lo mueven (solo update DB). → evento fantasma en calendar del barbero. **REAL.**
- ✅ **Slot 30min hardcoded**: `SlotHelper.SlotDuracionMin=30`. CheckOverlap usa 30min fijo para reservas existentes, ignora duración real del servicio. Servicio 45/60min calcula overlap mal. **REAL.**
- 🟡 **Anticipación hardcoded**: `HorariosController` L108 usa `AddMinutes(30)` literal, NO lee `Configuracion.MinutosAnticipacionMin`. Config no tiene efecto.
- ⚠️ **Barbero delete SetNull**: nav `Reserva.Barbero` nullable confirmado; endpoint delete no leído aún. Pendiente confirmar comportamiento exacto.

## 1. Config cambia con reservas existentes

- 🔴 **Día abierto→cerrado con turnos creados.** Switch `Activo=false` no toca reservas. Cliente sigue viendo turno; barbero no lo espera. (caso original)
- 🔴 **Cambio de horario deja turnos fuera de rango.** Bloque 9–20 → 9–13, turno 18:00 queda huérfano. Sin validación ni aviso.
- 🔴 **Feriado override `Trabaja=false` sobre día con turnos.** Mismo problema: turnos persisten, slots desaparecen.
- 🔴 **Barbero borrado/desactivado.** `SetNull` en BarberoId → reservas huérfanas sin barbero. Cliente ve turno "sin barbero". Recurrentes apuntan a barbero muerto.
- 🟡 **Borrar bloque que parte un día split** (mañana/tarde) puede dejar turnos de la tarde sin cobertura.

## 2. Creación de reserva

- 🟡 **Reserva en día cerrado vía API directa.** ReservaService NO valida contra BarberoHorario/feriado — solo overlap + pasado. Slots ocultos en FE, pero POST directo entra. Doble check faltante backend.
- 🟡 **Reserva fuera de horario** (ej. 22:00 día que cierra 20:00) — mismo: backend no valida límites de bloque.
- 🟡 **Sin tope máximo de anticipación.** Cliente reserva a 2 años. Sin límite max-days.
- 🟢 Pasado / hoy-ya-pasó → rechazado.
- 🟢 Overlap → tx Serializable + índice único (BarberoId,FechaIso,Hora).
- 🟡 **Servicio con duración variable + overlap.** Verificar CheckOverlap usa duración real del servicio, no slot fijo 30min.
- 🟡 **Anticipación: race.** Slot pasa el corte (now+MinAntic) entre que FE muestra y POST llega → reserva último-minuto inconsistente con FE.
- 🟡 **Cambio de timezone / DST.** Hora guardada como float/string local. DST shift puede correr turnos 1h.

## 3. Recurrentes / autoreserva

- 🔴 **No hay job automático.** Generación es manual (`/generar-turno`). Si admin no corre, recurrente nunca se crea.
- 🔴 **Recurrente cae en día cerrado/feriado.** GenerarTurno solo checa overlap, no horario. Crea turno en domingo cerrado.
- 🟡 **Recurrente choca con overlap** → ¿qué pasa? ¿skip, error, siguiente slot? Definir.
- 🟡 **Barbero del recurrente desactivado** → genera turno huérfano o falla.
- 🟡 **FrecuenciaDias + anchor viejo** → si anchor muy atrás, loop avanza muchos múltiplos (perf menor, ok).
- 🟡 **Doble generación** (correr endpoint 2x) → UltimoTurnoFecha protege? Verificar idempotencia.

## 4. Cancelación / mi-turno

- 🔴 **Hard delete.** Remove() permanente. Sin historial, sin auditoría, sin "cancelado" status. Borra registro histórico (contradice CLAUDE.md "protección contra borrado").
- 🟡 **Cancelar turno ya pasado** → bloqueado por `!past`, ok. Pero ¿turno hoy en curso?
- 🟡 **Token JWT expirado / reusado** tras cancelar — segundo click ¿error claro?
- 🟡 **Race cancel + admin edit** mismo turno.

## 5. Vista cliente (buscar/mi-turno)

- 🔴 **Cliente ve turno en día cerrado** (caso original) — buscar filtra solo `FechaIso >= today`, no estado del día.
- 🟡 **Buscar por teléfono normalizado** — números con/sin +54, 0, 15 → ¿NormalizeTel cubre todas variantes? Cliente no encuentra su turno.
- 🟡 **Homónimos / mismo teléfono compartido** (familia) → ve turnos de otro.
- 🟡 **CancelToken expuesto en DTO de buscar** → cualquiera con teléfono+nombre cancela.

## 6. Slots / disponibilidad

- 🟡 **Feriado LIKE "DD/MM/YYYY"** búsqueda legacy frágil — formato mal escrito = override ignorado silencioso.
- 🟡 **Mes sin bloques (día Dow sin config)** → día entero sin slots, ¿intencional?
- 🟡 **Slots 30min hardcoded** vs servicios de 15/45/60min → desalineación.
- 🟡 **Reserva existente más larga que slot** → CheckOverlap debe tapar varios slots; verificar.

## 7. Rate limit / abuso

- 🟡 **10/15min por IP** — NAT/wifi compartido (barbería misma) bloquea clientes legítimos.
- 🟡 **Rate limit solo IP** → sin captcha, bot rota IP.

## 8. Integraciones (best-effort)

- 🟡 **Google Calendar falla post-commit** → reserva existe en DB pero no en calendar. Barbero no la ve. Sin reintento/cola visible.
- 🟡 **WhatsApp falla** → cliente sin confirmación, cree que no reservó → doble reserva.
- 🔴 **Cancelar reserva NO borra evento Calendar** (verificar) → barbero ve turno fantasma.
- 🔴 **Editar/mover turno admin NO actualiza Calendar/WhatsApp** (verificar).

## Prioridad sugerida
1. Día cerrado / horario cambiado con turnos existentes (caso original + variantes) — afecta confianza cliente y barbero.
2. Backend valida horario en POST /reserva (no confiar solo en FE).
3. Soft-delete + estado `Cancelado/Reprogramado` en vez de hard delete.
4. Sync Calendar/WhatsApp en cancelar/editar.
5. Recurrentes: job automático + validar día abierto.
