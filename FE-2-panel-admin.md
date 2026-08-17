# FE-2 — Panel admin

> Requiere `00-CONTEXTO.md` y **la FE-1 cerrada** (los cimientos se reusan, no se rehacen).
> Del backend, requiere la **Fase 3 completa**.
> **Criterio de salida:** el barbero opera su día completo desde el panel, y el dueño configura el negocio sin tocar la base de datos.

---

## Qué construye esta fase

La herramienta de trabajo diaria. Nueve pantallas:

1. **Login**
2. **Dashboard** con las métricas del día
3. **Agenda** — la pantalla que más se usa
4. **Reservas** — crear, editar, cancelar, bloquear horarios
5. **Clientes** — listado, historial, importar, exportar
6. **Recurrentes** — los clientes con turno fijo
7. **Horarios y feriados**
8. **Configuración del negocio** (solo dueño)
9. **Catálogos** — barberos, servicios, promos (solo dueño)

**Reusá los cimientos de la FE-1.** El cliente de API, el formateo, los componentes base y el lenguaje visual ya existen. Si necesitás un componente nuevo que el sitio público también podría usar, ponelo en el mismo lugar compartido.

---

## Lo que hace distinta a esta fase

El sitio público lo usa un cliente una vez cada dos semanas. **Esto lo usa el barbero cincuenta veces por día.** Cambia las prioridades:

- **Velocidad sobre belleza.** Menos clicks, menos confirmaciones innecesarias, atajos de teclado donde tenga sentido.
- **Densidad de información.** El barbero quiere ver su día entero de un vistazo, no scrollear tarjetas.
- **Desktop primero, pero el celular tiene que funcionar.** El barbero mira la agenda del celular entre cortes. Priorizá que agenda y reservas anden bien en móvil; la configuración puede ser solo desktop.

---

## Tarea FE-2.1 — Login y sesión

`POST /admin/api/auth` con usuario y contraseña.

**La sesión vive en una cookie que el frontend no puede leer** (es `HttpOnly`, a propósito). Así que:

- **No guardes nada en `localStorage`.** No hay token que guardar.
- Para saber si hay sesión, llamá a `GET /admin/api/me`. Si responde 401, no hay sesión.
- Cerrar sesión es `DELETE /admin/api/auth`.

**Un 401 en cualquier llamada significa que la sesión venció.** Manejalo en un solo lugar —el cliente de API— redirigiendo al login. No lo repitas en cada pantalla.

La sesión dura 24 horas. Si vence a mitad de una operación, el cliente pierde lo que estaba escribiendo. Considerá avisar antes de que pase.

**El error de credenciales es `Usuario o contraseña incorrectos`**, igual para usuario inexistente y para contraseña mal. Es a propósito — no reveles cuál falló.

**Criterios de aceptación:**

- [ ] Login correcto entra al panel
- [ ] Nada de la sesión se guarda en `localStorage` ni `sessionStorage`
- [ ] Un 401 en cualquier pantalla redirige al login, manejado en un solo lugar
- [ ] Logout borra la sesión del servidor, no solo el estado local
- [ ] El error de credenciales es el del backend, textual

---

## Tarea FE-2.2 — Los dos roles

Hay `owner` y `barbero`, y el rol viene de `/admin/api/me`.

| Pantalla | `barbero` | `owner` |
|---|---|---|
| Agenda, reservas | Solo lo suyo | Todos, con filtro por barbero |
| Clientes | Los que atendió | Todos |
| Recurrentes | Los suyos | Todos |
| Horarios, feriados | Los suyos | De cualquier barbero |
| Métricas | Las suyas | Globales |
| Configuración del negocio | ❌ | ✅ |
| Barberos, servicios, promos | ❌ | ✅ |
| Importar | ❌ | ✅ |

**Ocultá lo que el rol no puede usar, no lo deshabilites.** Un menú con la mitad de las opciones grises es peor que un menú corto.

**Pero el frontend ocultar no es seguridad.** El backend valida todo y devuelve **403** si el rol no alcanza. Si aparece un 403, es un bug del frontend — mostrá algo claro y logueá.

**Criterios de aceptación:**

- [ ] Un `barbero` no ve las secciones de dueño en el menú
- [ ] Un `owner` ve el selector de barbero donde corresponde
- [ ] Un 403 se maneja con un mensaje claro, no una pantalla rota

---

## Tarea FE-2.3 — Agenda

**La pantalla más usada del sistema.** Merece el mayor cuidado de diseño de todo el panel.

`GET /admin/api/agenda?desde&hasta&barberoId`.

**Vista día y vista semana.** El día es lo que se mira a la mañana; la semana, para planificar.

Cada turno tiene que mostrar de un vistazo: hora, cliente, servicio y duración. El teléfono a un click, no siempre visible.

**Distinguí visualmente los bloqueos de los turnos.** Un bloqueo (`tipo: 'bloqueo'`) no es un cliente — no debería verse igual. Y los turnos cancelados no van en la agenda.

**La duración importa visualmente.** Un turno de 60 minutos debería ocupar el doble de alto que uno de 30. Es lo que hace que el barbero entienda su día sin leer números.

**Desde la agenda, en un click:** crear un turno en un hueco, bloquear un horario, editar o cancelar un turno existente.

**Criterios de aceptación:**

- [ ] Vista día y semana, con navegación entre fechas
- [ ] Un turno de 60 min se ve del doble de alto que uno de 30
- [ ] Los bloqueos se distinguen de los turnos de clientes
- [ ] Los turnos cancelados no aparecen
- [ ] Un `owner` puede filtrar por barbero; un `barbero` ve solo lo suyo
- [ ] Funciona en 375px (aunque la semana pueda requerir scroll)
- [ ] Crear, editar y cancelar se hacen sin salir de la agenda

---

## Tarea FE-2.4 — Reservas y bloqueos

Crear, editar, cancelar. Y bloquear horarios.

**Crear desde el panel es distinto del público:** no aplica anticipación mínima ni máxima. El barbero puede cargar un turno para dentro de cinco minutos o para dentro de tres meses.

**Sí valida solapamiento.** Si el horario está ocupado, el backend rechaza. Mismo tratamiento que en el sitio público: mostrá el mensaje y refrescá.

**Bloquear un horario** es `POST /admin/api/bloqueos` con fecha, hora y motivo opcional. Es para el almuerzo, un trámite, lo que sea. Que sea rápido: dos clicks desde la agenda.

**Cancelar pide confirmación** y avisa que al cliente le llega un WhatsApp.

**Criterios de aceptación:**

- [ ] Crear un turno para dentro de 5 minutos funciona (sin anticipación mínima)
- [ ] Crear en un horario ocupado muestra el error del backend y refresca
- [ ] Bloquear un horario toma dos clicks desde la agenda
- [ ] Cancelar pide confirmación y avisa de la notificación
- [ ] Un `barbero` no puede editar la reserva de otro

---

## Tarea FE-2.5 — Horarios, feriados y los conflictos

**La pantalla con la interacción más delicada del panel.**

Horarios semanales con **varios bloques por día** (horario cortado: mañana y tarde). Feriados nacionales combinados con los cierres propios.

### El patrón de conflictos — leé esto con atención

Cinco operaciones pueden devolver **409 con una lista de turnos en conflicto**:

- Cambiar el horario de un día
- Editar un bloque
- Cerrar una fecha
- Desactivar un barbero
- Borrar un barbero

**Cuando llega un 409, la lista es el punto.** El backend devuelve en `data` cada turno que quedaría huérfano, con fecha, hora, nombre del cliente, teléfono y servicio.

**Mostrala.** Un "no se pudo guardar" pelado deja al dueño sin saber qué reagendar, y es exactamente el problema que este patrón vino a resolver. Mostrá la lista completa, y si podés, un link para ir a cada turno.

**Sobre los feriados nacionales:** son informativos. Un feriado nacional **no cierra la barbería** — muchas barberías abren. Lo que cierra es que el barbero lo marque. Que la interfaz lo deje claro: mostrá los nacionales como sugerencia, con un botón para cerrar ese día.

**Y una regla contraintuitiva del backend:** marcar un día como "sí trabajo" **no abre un día que no tiene horario configurado**. El override es un sí/no, no trae horarios. Si el dueño intenta abrir un domingo sin horario cargado, no va a funcionar — avisáselo en la interfaz antes de que se frustre.

**Criterios de aceptación:**

- [ ] Se pueden cargar dos bloques en un mismo día (horario cortado)
- [ ] Un 409 muestra la lista completa de turnos en conflicto, con los datos de cada cliente
- [ ] Los feriados nacionales se distinguen de los cierres propios
- [ ] La interfaz explica que marcar "trabajo" no abre un día sin horario cargado
- [ ] Cambiar un horario sin conflictos guarda sin fricción

---

## Tarea FE-2.6 — Clientes y recurrentes

### Clientes

Listado paginado, historial por cliente, importar y exportar (las dos últimas solo dueño).

El **historial** es lo que más se usa: entra el cliente, el barbero quiere ver qué se hizo la última vez.

**El export es un CSV** — disparalo como descarga del navegador, no lo proceses en el frontend.

**El import** acepta hasta 1.000 registros y devuelve cuántos entraron y cuántos se saltearon. **Mostrá el detalle**, no solo el número: si se saltearon 40, el dueño quiere saber por qué.

### Recurrentes

Los clientes con turno fijo cada N días. Listado con el próximo y el último turno real.

**Generar turno manualmente** existe además de la generación automática. Si falla porque los cinco ciclos están cerrados, el backend devuelve un error que **lista cada fecha intentada con su motivo**. Mostralo — es lo que le permite entender por qué falló.

**Al borrar o desactivar un recurrente con turnos futuros ya generados**, el backend responde 200 con un aviso y la lista. Esos turnos **no se cancelan solos** porque son compromisos con clientes reales. Mostrá el aviso claramente: el dueño tiene que decidir qué hacer con ellos.

**Criterios de aceptación:**

- [ ] El historial de un cliente se abre en un click desde el listado
- [ ] El export descarga un CSV que abre bien en Excel
- [ ] El import muestra el detalle de lo que se salteó, no solo el conteo
- [ ] El error de "5 ciclos cerrados" muestra las fechas intentadas con su motivo
- [ ] El aviso de turnos futuros al borrar un recurrente se muestra completo
- [ ] Un `barbero` solo ve sus propios recurrentes

---

## Tarea FE-2.7 — Configuración y catálogos

Solo dueño. Barberos, servicios, promos, catálogo, y la configuración del negocio.

**Configuración del negocio:** nombre, zona horaria, duración de slot, anticipación mínima y máxima, y el branding (logo y colores).

⚠️ **Advertí sobre el impacto de estos cambios.** Cambiar la duración del slot altera los horarios que se ofrecen a todos los clientes. No es una preferencia estética — que la interfaz lo diga.

**Barberos:** alta con usuario y contraseña inicial. Baja y desactivación pasan por el patrón de conflictos (FE-2.5).

**No se puede desactivar al único dueño** — el backend lo rechaza. Mejor: no ofrezcas el botón cuando queda un solo dueño.

**Servicios:** el nombre es único. Cambiar la duración **no afecta los turnos ya creados** (tienen su copia). Decilo, porque no es obvio.

**Criterios de aceptación:**

- [ ] Un `barbero` no llega a estas pantallas
- [ ] Cambiar la duración del slot advierte del impacto
- [ ] No se ofrece desactivar al único dueño
- [ ] Un nombre de servicio duplicado muestra un error claro
- [ ] La interfaz aclara que cambiar la duración no altera turnos existentes
- [ ] El branding se aplica al sitio público sin recompilar

---

## Tarea FE-2.8 — Dashboard

`GET /admin/api/stats`. Lo más simple de la fase, y lo primero que ve el barbero al entrar.

Turnos de hoy, de la semana, del mes, y recurrentes activos. Scoped por rol.

**Lo más útil no son los números sino el próximo turno.** Poné arriba "tu próximo turno es a las 15:30 con Juan" — es lo que el barbero quiere saber al abrir el panel.

**Criterios de aceptación:**

- [ ] Los conteos coinciden con lo que muestra la agenda
- [ ] Un `barbero` ve sus números; un `owner` los globales
- [ ] El próximo turno está visible sin scroll
- [ ] Sin turnos hoy, el vacío tiene un mensaje razonable

---

## Cierre de la FE-2

- [ ] Un barbero opera su día completo: ve la agenda, carga turnos, bloquea horarios
- [ ] Un dueño configura todo el negocio sin tocar la base de datos
- [ ] Los cinco casos de conflicto muestran su lista de turnos afectados
- [ ] Los dos roles ven solo lo que les corresponde
- [ ] Agenda y reservas funcionan en celular
- [ ] `tsc --noEmit` limpio
- [ ] No se duplicó ningún componente ni utilidad de la FE-1

**Con esto el producto está completo:** sitio público, panel admin, y el backend de las cinco fases.
