# FE-1 — Cimientos y sitio público

> Requiere `00-CONTEXTO.md` cargado. Del backend, requiere la **tarea 2.4 cerrada** (creación de reserva).
> Track de frontend, rama aparte. Corre en paralelo a las fases 3, 4 y 5 del backend.
> **Criterio de salida:** un cliente entra desde el celular, elige barbero y servicio, ve los horarios libres reales, reserva, y recibe el link para gestionar su turno.

---

## Qué construye esta fase

El sitio que ve el cliente. Dos cosas:

1. **Landing**: qué es la barbería, servicios con precios, promos, barberos.
2. **Flujo de reserva**: barbero → servicio → día → horario → datos → confirmación.
3. **Mi turno**: buscar el turno por teléfono, recibir el link, ver, reprogramar o cancelar.

Y los **cimientos** que después reusa el panel admin: cliente de API, formateo, componentes base, manejo de errores.

**Esta fase también define el lenguaje visual del producto.** El agente que haga el panel admin va a construir sobre lo que quede acá.

---

## Stack

| Capa | Elección | Por qué |
|---|---|---|
| Framework | **React 19** | Es lo que los agentes escriben mejor y lo que cualquier dev sabe mantener |
| Build | **Vite** | Rápido, sin configuración, salida estática lista para Cloudflare |
| Lenguaje | **TypeScript** estricto | Mismo criterio que el backend |
| Estilos | **Tailwind** | Sin decisiones de nombres, sin archivos CSS sueltos |
| Estado de API | **TanStack Query** | Caché, reintentos y estados de carga resueltos. Crítico para refrescar la grilla de horarios |
| Router | **React Router** | Alcanza y sobra |

**Sin meta-framework.** Nada de Next: no hace falta renderizado en servidor y complicaría el deploy a Static Assets.

**Sin librería de componentes.** Para ocho pantallas, Tailwind a mano sale más liviano que traer una librería entera y peleársela.

### Por qué no las otras opciones

Angular quedó afuera por peso y ceremonia para una app de este tamaño. Svelte es más elegante y liviano, pero el mercado de devs en Argentina es chico y este código lo va a mantener alguien más. HTML plano no aguanta el panel admin de la FE-2.

---

## Dónde vive

El frontend se sirve como **Static Assets del mismo Worker**. Eso resuelve dos cosas gratis: mismo origen (la cookie de sesión del admin funciona sin CORS) y un solo deploy.

```
web/                    # todo el frontend acá
  src/
    lib/
      api.ts            # cliente de API tipado
      formato.ts        # precios, fechas, teléfonos
    componentes/        # base: Boton, Input, Modal, Spinner, Alerta
    paginas/
      Landing.tsx
      Reservar.tsx
      MiTurno.tsx
    App.tsx
  index.html
  vite.config.ts
public/                 # salida del build, servida por el Worker
```

**No toques `src/` del backend.** Solo `wrangler.jsonc` (para activar el binding de assets) y `package.json`. Coordiná esos dos cambios con la sesión del backend antes de hacerlos.

---

## Tarea FE-1.1 — Setup y cimientos

Proyecto Vite + React + TS + Tailwind dentro de `web/`. Build que sale a `public/`.

**Activar el binding de assets** en `wrangler.jsonc`:

```jsonc
"assets": { "directory": "./public", "binding": "ASSETS" }
```

Está comentado en el archivo del backend, esperando esta fase.

**El cliente de API** (`lib/api.ts`) es la pieza más importante de la tarea. Requisitos:

- Tipado, con los tipos derivados del contrato (ver más abajo).
- Desenvuelve el sobre `{ ok, data }` y **tira un error tipado** cuando `ok: false`, con el mensaje del backend y el código HTTP. Que el resto de la app nunca vea el sobre crudo.
- Un tipo de error propio que distinga: validación (400), no autorizado (401), sin permiso (403), no encontrado (404), **conflicto (409, con su lista)**, rate limit (429), error del servidor (500).
- Mismo origen: las URLs son relativas (`/api/...`). Nada de variables de entorno con la URL base.

**El formateo** (`lib/formato.ts`):

- **Precios: llegan en centavos.** La API nunca devuelve pesos. Formateá con `Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' })` sobre `centavos / 100`.
- Fechas: la API usa `"YYYY-MM-DD"` y horas `"HH:mm"`. Para mostrar, formato argentino (`lunes 18 de agosto`).
- **Nunca uses `new Date(fecha)` sobre un `"YYYY-MM-DD"` para mostrarlo.** JavaScript lo interpreta como UTC y en Argentina te muestra el día anterior. Parseá los componentes a mano o usá `Intl` con la zona explícita.

**Componentes base:** `Boton` (con estado de carga), `Input`, `Select`, `Modal`, `Spinner`, `Alerta`. Nada más — los que hagan falta salen en las tareas siguientes.

**Criterios de aceptación:**

- [ ] `npm run dev` levanta el frontend y pega contra el Worker local
- [ ] `npm run build` deja la salida en `public/` y el Worker la sirve
- [ ] `tsc --noEmit` limpio con `strict: true`
- [ ] El cliente de API convierte `{ ok: false }` en un error tipado con el mensaje del backend
- [ ] Un precio de `800000` centavos se muestra como `$ 8.000,00`
- [ ] Una fecha `"2026-08-18"` se muestra como `lunes 18 de agosto` — **no** el 17

---

## Tarea FE-1.2 — Landing

Página pública. Consume `/api/negocio`, `/api/servicios`, `/api/promos`, `/api/catalogo`, `/api/barberos`.

**Mobile-first, sin discusión.** Los clientes de una barbería reservan del celular, parados en la calle. Diseñá para 375px de ancho y después ampliá.

Secciones: encabezado con el nombre y el logo del negocio, servicios con precio y duración, promos si hay, barberos, y un botón de reservar siempre visible.

**El branding sale de `/api/negocio`**: `nombreNegocio`, `logoUrl`, `colorPrimario`, `colorSecundario`. Aplicalos con variables CSS, no hardcodeados — el panel admin los puede cambiar.

**Manejo de estados:** carga (skeleton, no un spinner centrado), error (mensaje claro con opción de reintentar), vacío (si no hay promos, la sección no se muestra).

**Criterios de aceptación:**

- [ ] Se ve bien en 375px sin scroll horizontal
- [ ] Los colores y el logo vienen de la API, no del código
- [ ] Sin promos cargadas, la sección no aparece (no queda un hueco)
- [ ] Con la API caída, muestra un error accionable
- [ ] Los precios se muestran formateados en pesos

---

## Tarea FE-1.3 — Flujo de reserva

**El corazón del producto.** Cuatro pasos, en este orden: barbero → servicio → día → horario. Después datos del cliente y confirmación.

**Por qué ese orden:** el servicio determina la duración, y la duración determina qué horarios entran. Si el cliente elige el horario antes del servicio, hay que recalcular y sacarle opciones — mala experiencia.

**El paso del día** usa `/api/disponibilidad/mes?barberoId&anio&mes&servicioId` para pintar el calendario: los días sin nada libre van deshabilitados. Respetá la ventana de reserva — los días más allá de `diasMaxAnticipacion` no se pueden elegir.

**El paso del horario** usa `/api/disponibilidad?barberoId&fecha&servicioId`. Mostrá los slots como botones, agrupados por franja (mañana / tarde) si el día tiene horario cortado.

### Las tres reglas de UX que no son opcionales

**1. El slot se puede ocupar entre que lo mostrás y el cliente hace click.**

Es el caso más probable de todos y el que más frustra si se maneja mal. Cuando el backend responda `Lo sentimos, este turno acaba de ser reservado por alguien más.`:

- Mostrá ese mensaje, tal cual viene.
- **Refrescá la grilla de horarios automáticamente** (con TanStack Query es invalidar la query).
- Dejá al cliente en el paso del horario, con sus datos ya cargados. Que no vuelva a empezar.

**2. Nunca deshabilites el botón de reservar como única defensa.**

El backend valida todo de nuevo. Si el frontend cree que un slot está libre y el backend dice que no, el backend tiene razón.

**3. Los mensajes de error del backend se muestran tal cual.**

Están escritos para el cliente final, en español, y son contrato. No los reescribas ni los reemplaces por genéricos. La lista completa está en la tarea 2.4 del backend.

### El formulario de datos

Nombre (máx 100), teléfono (máx 20), mensaje opcional (máx 500).

**El teléfono es la credencial** con la que después el cliente recupera su turno. Decilo en la interfaz: *"Con este número vas a poder consultar o cancelar tu turno"*. Si el cliente pone un número equivocado, pierde el acceso.

Validá los largos en el frontend para dar feedback inmediato, pero el backend valida igual.

### La confirmación

Mostrá el turno confirmado: barbero, servicio, día, hora, precio. Y explicá cómo gestionarlo después — que puede volver con su teléfono.

**Criterios de aceptación:**

- [ ] Los cuatro pasos funcionan y se puede volver atrás sin perder lo elegido
- [ ] Un servicio de 60 min ofrece menos horarios que uno de 30 en el mismo día
- [ ] Los días sin disponibilidad están deshabilitados en el calendario
- [ ] Los días más allá de la ventana de anticipación no se pueden elegir
- [ ] Al recibir el error de slot ocupado: se muestra el mensaje, se refresca la grilla, no se pierden los datos del cliente
- [ ] Los mensajes de error son los del backend, textuales
- [ ] La interfaz avisa que el teléfono es lo que da acceso al turno
- [ ] Funciona completo en 375px

---

## Tarea FE-1.4 — Mi turno

Cómo el cliente gestiona su turno **sin tener cuenta**.

El flujo, en tres pasos:

1. **Buscar**: `POST /api/mi-turno/buscar` con el teléfono. Devuelve los turnos futuros.
2. **Pedir acceso**: `POST /api/mi-turno/access-link` con el turno elegido y el teléfono. Devuelve un link firmado.
3. **Gestionar**: con el token del link, ver (`GET`), reprogramar (`PUT`) o cancelar (`POST /cancel`).

### Lo que hay que entender del diseño

**El link vence en 15 minutos.** Si el cliente lo abre después, el backend responde `Token expirado`. **No muestres un error genérico** — ofrecé pedir uno nuevo, que es un click.

**Cancelar consume el link.** Un segundo intento da `Token ya utilizado`. Si el cliente refresca la página después de cancelar, mostrá "tu turno ya fue cancelado", no un error.

**Ver y reprogramar no lo consumen**, así que el cliente puede refrescar tranquilo.

**Reprogramar reusa el selector de día y horario de la FE-1.3.** Mismo componente, no lo dupliques.

**Confirmá antes de cancelar.** Es irreversible y el cliente pierde su turno. Un modal con el turno a la vista y dos botones claros.

**Criterios de aceptación:**

- [ ] Buscar por teléfono muestra los turnos futuros
- [ ] Un teléfono sin turnos muestra un vacío claro, no un error
- [ ] Con el token vencido, se ofrece pedir uno nuevo en vez de un error pelado
- [ ] Cancelar pide confirmación mostrando el turno
- [ ] Después de cancelar, refrescar la página no muestra un error
- [ ] Reprogramar usa el mismo selector de horarios que la reserva
- [ ] Reprogramar a un horario ocupado muestra `Ese horario ya está ocupado. Elegí otro.` y refresca

---

## El contrato de API

✅ **Ya existe: `docs/contrato-api.md`.** Está generado leyendo el código real, no propuesto — con cada endpoint, sus parámetros, la forma exacta de cada respuesta y los 26 mensajes de error textuales.

**Es la fuente de verdad. Leelo completo antes de escribir el cliente de API, y no inventes nada que no esté ahí.** Si encontrás un hueco, preguntá en vez de asumir: el backend está vivo y se puede corregir.

Documenta también cosas que no se deducen del código y te van a ahorrar tiempo: que el error de solapamiento es 400 y no 409, que `slots: []` es un 200 normal con siete causas distintas, que hay que pasar `servicioId` a disponibilidad porque el barbero puede tener una duración propia para ese servicio, y que el `cancelToken` no se puede recuperar después de crearlo.

Lo esencial, resumido acá para que no tengas que ir y volver:

**El sobre de respuesta:**

```ts
type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };
```

**Los códigos:**

| Código | Significa |
|---|---|
| 200 | OK |
| 400 | Validación o regla de negocio — el mensaje es para el cliente |
| 401 | Sin autenticar |
| 403 | Autenticado sin permiso |
| 404 | No encontrado |
| 409 | Conflicto, **con lista de conflictos en `data`** |
| 429 | Demasiados intentos |
| 500 | Error del servidor |

**Los formatos:** fechas `"YYYY-MM-DD"`, horas `"HH:mm"`, precios en **centavos** (entero).

**Los endpoints públicos:** `/api/negocio`, `/api/barberos`, `/api/servicios`, `/api/promos`, `/api/catalogo`, `/api/disponibilidad`, `/api/disponibilidad/mes`, `/api/reservas`, y los cinco de `/api/mi-turno`.

El detalle de cada payload sale del contrato cuando esté. `docs/convenciones-api.md` del backend es la fuente provisional.

---

## Reglas para todo el frontend

1. **Mobile-first.** El cliente reserva del celular. Diseñá para 375px.
2. **Los mensajes de error del backend se muestran tal cual.** Son contrato y están escritos para el cliente final.
3. **El backend siempre tiene razón.** El frontend filtra por experiencia, no por seguridad.
4. **Estados de carga en todo.** Nada de pantallas en blanco: skeletons para contenido, spinner en botones.
5. **Los vacíos son parte del diseño.** Sin turnos, sin promos, sin horarios libres — cada uno con su mensaje.
6. **Accesibilidad básica:** etiquetas en los inputs, foco visible, contraste suficiente, navegación con teclado en el flujo de reserva.
7. **Cero secretos en el frontend.** Todo lo sensible vive en el Worker.

---

## Cierre de la FE-1

- [ ] El build sale a `public/` y el Worker lo sirve en el mismo origen
- [ ] Un cliente reserva de punta a punta desde el celular
- [ ] Un cliente recupera y cancela su turno con el teléfono, sin cuenta
- [ ] El caso del slot ocupado a mitad del flujo está manejado
- [ ] Los cimientos (cliente de API, formateo, componentes) están listos para que la FE-2 los reuse
- [ ] `tsc --noEmit` limpio

**Cuando esto cierre, avisale a la sesión del backend** que el sitio público está andando y qué problemas de contrato encontraste. Son los que ningún test del backend detecta.
