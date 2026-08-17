import { buildEventTimes } from '../domain/slots';
import { TZ } from '../domain/dates';

/**
 * Google Calendar con Service Account. BEST-EFFORT, SIEMPRE.
 *
 * ⚠️ NINGUNA funcion de este archivo lanza. Todas devuelven `null`, `false` o
 * `[]`. Cuando esto corre, la reserva YA esta confirmada en la base: tirarla
 * porque Google no contesta seria cambiar un problema de sincronizacion por
 * uno de negocio.
 *
 *
 * POR QUE ESTA ESCRITO A MANO Y NO CON UN SDK
 *
 * El SDK de Google es Node: usa `crypto` nativo y streams. En Workers hay que
 * firmar el JWT con `crypto.subtle`. Son ~60 lineas y no hay atajo.
 *
 * El sistema original en Cloudflare Pages tenia esto resuelto en
 * `functions/admin/api/_gcal.js`, pero ESE ARCHIVO NO ESTA en el historial de
 * ninguno de los tres repos que sobreviven (BE, FE, gebyanos: 0 coincidencias
 * en 374 commits). La referencia que sí existe es el puerto a .NET,
 * `Barberia.Api/Services/GoogleCalendarService.cs`, que dice ser "puerto de las
 * funciones de _gcal.js (lineas 1-208)" y de ahi salen los strings exactos del
 * evento y el comportamiento ante error.
 *
 *
 * LAS CREDENCIALES SON DOS SECRETS, NO EL JSON ENTERO
 *
 * `GOOGLE_SA_EMAIL` y `GOOGLE_SA_PRIVATE_KEY`, que es lo que ya estaba
 * declarado en `.dev.vars.example`. El JSON de la service account trae ademas
 * `project_id`, `private_key_id`, `client_id` y tres URLs que no se usan para
 * nada: guardarlo entero es guardar mas secreto del necesario.
 */

const SCOPE = 'https://www.googleapis.com/auth/calendar';
const AUD = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';

/** Clave de KV donde vive el access token compartido. */
const CLAVE_TOKEN = 'gcal:access-token';

/** Margen antes del vencimiento: no estrenar un token que muere en 30 s. */
const MARGEN_SEGUNDOS = 120;

/** Google no responde en 10 s si algo anda mal: no vale la pena esperar mas. */
const TIMEOUT_MS = 10_000;

export interface CredencialesGoogle {
  email: string;
  privateKeyPem: string;
}

/**
 * Lee las credenciales. `null` si no estan configuradas.
 *
 * DESACTIVAR LA INTEGRACION ES UN ESTADO VALIDO, no un error: en desarrollo y
 * en los tests no hay service account, y el sistema tiene que funcionar igual.
 */
export function leerCredenciales(env: Env): CredencialesGoogle | null {
  const email = env.GOOGLE_SA_EMAIL?.trim();
  const key = env.GOOGLE_SA_PRIVATE_KEY?.trim();

  if (!email || !key) return null;
  return { email, privateKeyPem: key };
}

export const calendarHabilitado = (env: Env): boolean => leerCredenciales(env) !== null;

// ------------------------------------------------------------------- base64

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const textoAB64url = (s: string): string => b64url(new TextEncoder().encode(s));

/**
 * PEM PKCS#8 → ArrayBuffer DER.
 *
 * ⚠️ El `\n` literal es el detalle que arruina la tarde. Una private key
 * pegada en un secret de Wrangler suele llegar con los saltos escapados como
 * los dos caracteres `\` y `n`, no como saltos reales: sin des-escaparlos, el
 * base64 sale con basura y `importKey` tira un error que no dice nada util.
 */
export function pemADer(pem: string): ArrayBuffer {
  const limpio = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');

  const binario = atob(limpio);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);

  return bytes.buffer;
}

// --------------------------------------------------------------------- JWT

/** JWT firmado RS256, listo para canjear por un access token. */
export async function firmarJwt(cred: CredencialesGoogle, ahoraSeg: number): Promise<string> {
  const header = textoAB64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = textoAB64url(
    JSON.stringify({
      iss: cred.email,
      scope: SCOPE,
      aud: AUD,
      // Google acepta hasta 1 h de vida. Mas que eso lo rechaza.
      exp: ahoraSeg + 3600,
      iat: ahoraSeg,
    }),
  );

  const clave = await crypto.subtle.importKey(
    'pkcs8',
    pemADer(cred.privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const firma = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    clave,
    new TextEncoder().encode(`${header}.${claim}`),
  );

  return `${header}.${claim}.${b64url(new Uint8Array(firma))}`;
}

// ------------------------------------------------------------ access token

interface TokenCacheado {
  token: string;
  /** Epoch en milisegundos. */
  venceMs: number;
}

/**
 * Access token, cacheado en KV.
 *
 * Vale una hora y lo comparten TODAS las invocaciones del Worker: pedir uno
 * nuevo en cada reserva serian dos round-trips extra a Google por turno, y
 * Google tiene cuota de emision de tokens.
 *
 * La consistencia eventual de KV no molesta acá: el peor caso es que dos
 * isolates pidan un token cada uno, y los dos son validos — Google no invalida
 * el anterior al emitir otro.
 */
export async function obtenerAccessToken(env: Env, ahora: Date = new Date()): Promise<string | null> {
  const cred = leerCredenciales(env);
  if (!cred) return null;

  const cacheado = await env.CACHE.get<TokenCacheado>(CLAVE_TOKEN, 'json').catch(() => null);
  if (cacheado && cacheado.venceMs - ahora.getTime() > MARGEN_SEGUNDOS * 1000) {
    return cacheado.token;
  }

  try {
    const jwt = await firmarJwt(cred, Math.floor(ahora.getTime() / 1000));

    const res = await fetch(AUD, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      // El body de Google trae `error_description`, que dice si es la clave, el
      // reloj o el scope. Sin eso, depurar esto es adivinar.
      console.warn('gcal: no se pudo obtener el access token', {
        status: res.status,
        detalle: (await res.text().catch(() => '')).slice(0, 300),
      });
      return null;
    }

    const cuerpo = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!cuerpo.access_token) return null;

    const vidaSeg = cuerpo.expires_in ?? 3600;
    const valor: TokenCacheado = { token: cuerpo.access_token, venceMs: ahora.getTime() + vidaSeg * 1000 };

    // El TTL de KV es el piso: si el token muere antes, el chequeo de `venceMs`
    // lo descarta igual. El TTL solo evita que quede basura para siempre.
    await env.CACHE.put(CLAVE_TOKEN, JSON.stringify(valor), {
      expirationTtl: Math.max(60, vidaSeg),
    }).catch(() => undefined);

    return cuerpo.access_token;
  } catch (e) {
    console.warn('gcal: excepcion al obtener el access token', {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

// ---------------------------------------------------------------- eventos

export interface EntradaEvento {
  calendarId: string;
  /** `"{nombre} - {servicio}"`, o con `(R)` si sale de un recurrente. */
  summary: string;
  /** `"Tel: {telefono}"`, o `"Generado Auto. Tel: {telefono}"`. */
  description: string;
  fecha: string;
  hora: string;
  duracionMin: number;
}

/** `"Juan - Corte"`, o `"Juan (R) - Corte"` si viene de un recurrente. */
export const tituloEvento = (nombre: string, servicio: string, recurrente = false): string =>
  `${nombre}${recurrente ? ' (R)' : ''} - ${servicio}`;

export const descripcionEvento = (telefono: string, recurrente = false): string =>
  `${recurrente ? 'Generado Auto. ' : ''}Tel: ${telefono}`;

/**
 * Crea el evento. Devuelve el `eventId` de Google, o `null` si no se pudo.
 *
 * ⚠️ EL TIMEZONE VA DOS VECES A PROPOSITO: el offset explicito dentro del
 * string ISO (`...T10:00:00-03:00`) Y el campo `timeZone`. Google interpreta
 * el `dateTime` con su propia heuristica cuando falta uno de los dos, y un
 * turno que aparece tres horas corrido en el celular del barbero es un
 * problema que se descubre tarde y mal.
 */
export async function crearEvento(env: Env, entrada: EntradaEvento): Promise<string | null> {
  const token = await obtenerAccessToken(env);
  if (!token) return null;

  const { startIso, endIso } = buildEventTimes(entrada.fecha, entrada.hora, entrada.duracionMin);

  try {
    const res = await fetch(`${API}/calendars/${encodeURIComponent(entrada.calendarId)}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        summary: entrada.summary,
        description: entrada.description,
        start: { dateTime: startIso, timeZone: TZ },
        end: { dateTime: endIso, timeZone: TZ },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn('gcal: no se pudo crear el evento', {
        status: res.status,
        calendarId: entrada.calendarId,
        detalle: (await res.text().catch(() => '')).slice(0, 300),
      });
      return null;
    }

    const cuerpo = (await res.json()) as { id?: string };
    return cuerpo.id ?? null;
  } catch (e) {
    console.warn('gcal: excepcion al crear el evento', {
      calendarId: entrada.calendarId,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Borra el evento. `true` si se borro o si YA NO ESTABA.
 *
 * Un 404 o un 410 cuentan como exito: el objetivo es que el evento no exista,
 * y no existe. Tratarlos como fallo haria que cancelar dos veces —o cancelar
 * un turno cuyo evento el barbero borro a mano— quedara registrado como error
 * para siempre.
 */
export async function borrarEvento(
  env: Env,
  calendarId: string,
  eventId: string,
): Promise<boolean> {
  const token = await obtenerAccessToken(env);
  if (!token) return false;

  try {
    const res = await fetch(
      `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );

    if (res.ok || res.status === 404 || res.status === 410) return true;

    console.warn('gcal: no se pudo borrar el evento', {
      status: res.status,
      calendarId,
      detalle: (await res.text().catch(() => '')).slice(0, 300),
    });
    return false;
  } catch (e) {
    console.warn('gcal: excepcion al borrar el evento', {
      calendarId,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Reprogramar = borrar + crear, como el sistema viejo.
 *
 * Un PATCH seria un request menos, pero si falla a mitad de camino deja el
 * evento en un estado que no coincide ni con antes ni con despues. Con
 * borrar+crear, el peor caso es un evento de menos —visible y arreglable— en
 * vez de uno con la hora vieja que el barbero va a creer buena.
 *
 * Devuelve el `eventId` nuevo, o `null`.
 */
export async function reprogramarEvento(
  env: Env,
  eventIdViejo: string | null,
  entrada: EntradaEvento,
): Promise<string | null> {
  if (eventIdViejo) await borrarEvento(env, entrada.calendarId, eventIdViejo);
  return crearEvento(env, entrada);
}
