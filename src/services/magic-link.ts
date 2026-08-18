import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { magicLinkTokens } from '../db/schema';
import { uuidv7 } from '../db/id';

/**
 * Magic links: como un cliente toca su turno SIN TENER CUENTA.
 *
 * ⚠️ EL MODELO DE SEGURIDAD, EN UNA FRASE: EL TELEFONO ES LA CREDENCIAL.
 *
 * No hay password ni ningun otro secreto. Todo lo de acá esta calibrado para
 * que conocer un numero de telefono no alcance para hacer daño a escala: por
 * eso el TTL es corto, por eso los rate limits de estos endpoints son la
 * defensa principal y no un extra, y por eso cancelar quema el token.
 *
 *
 * FORMATO: `base64url(payloadJson).base64url(hmacSha256)`
 *
 * Un JWT minimalista SIN HEADER. No llevar header es deliberado: el header de
 * un JWT es donde vive el ataque de `alg: none` y el de confusion de
 * algoritmos. Sin header no hay nada que negociar — el algoritmo lo decide el
 * servidor y punto.
 */

/** 15 minutos. Corto porque el telefono es toda la credencial. */
export const TTL_DEFAULT_MIN = 15;

/** Minimo del secret de firma. Menos que esto es forjable. */
export const LARGO_MIN_CLAVE = 32;

export const ERROR_CLAVE_DEBIL = `MAGIC_LINK_SECRET no está configurada o tiene menos de ${LARGO_MIN_CLAVE} caracteres. Sin ella los tokens serían forjables. Configurala con: wrangler secret put MAGIC_LINK_SECRET`;

/** Los mensajes de los 10 pasos. Transcripcion textual de la spec. */
export const ERRORES = {
  vacio: 'Token vacío',
  formato: 'Formato de token inválido',
  firma: 'Firma inválida',
  payload: 'Payload inválido',
  expirado: 'Token expirado',
  noEncontrado: 'Token no encontrado',
  revocado: 'Token revocado',
  usado: 'Token ya utilizado',
} as const;

export type MotivoInvalido = (typeof ERRORES)[keyof typeof ERRORES];

export type Proposito = 'access' | 'cancel';

export interface PayloadMagicLink {
  jti: string;
  rid: string;
  /** Epoch en SEGUNDOS, no milisegundos. */
  exp: number;
  purpose: Proposito;
}

// ------------------------------------------------------------ base64url

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function deB64url(s: string): Uint8Array {
  const normal = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(normal.padEnd(Math.ceil(normal.length / 4) * 4, '=')), (c) =>
    c.charCodeAt(0),
  );
}

// ----------------------------------------------------------------- clave

/**
 * ⚠️ LANZA SI FALTA O ES CORTA, Y ESO TIENE QUE PASAR AL ARRANQUE.
 *
 * Una clave debil no rompe nada visible: el sistema anda, emite tokens, y
 * cualquiera puede forjar uno. Es exactamente el tipo de mala configuracion
 * que llega a produccion sin que nadie la note, asi que el fallo tiene que ser
 * ruidoso e inmediato.
 */
export function validarClave(env: Env): void {
  const secreto = env.MAGIC_LINK_SECRET?.trim() ?? '';
  if (secreto.length < LARGO_MIN_CLAVE) throw new Error(ERROR_CLAVE_DEBIL);
}

export const claveConfigurada = (env: Env): boolean =>
  (env.MAGIC_LINK_SECRET?.trim().length ?? 0) >= LARGO_MIN_CLAVE;

async function claveHmac(env: Env): Promise<CryptoKey> {
  validarClave(env);

  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.MAGIC_LINK_SECRET.trim()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Minutos de vida, del entorno o el default. */
export function ttlMinutos(env: Env): number {
  const crudo = Number(env.MAGIC_LINK_TTL_MIN);
  if (!Number.isFinite(crudo) || crudo <= 0 || crudo > 1440) return TTL_DEFAULT_MIN;
  return Math.trunc(crudo);
}

// ------------------------------------------------------------- emision

export interface TokenEmitido {
  token: string;
  jti: string;
  expiraEn: Date;
}

/**
 * Emite un token y GUARDA SU FILA.
 *
 * La fila es la que permite revocar y consumir: la firma sola solo prueba
 * autoria, y un token firmado sin fila en la base seria irrevocable hasta que
 * expire.
 */
export async function emitirToken(
  env: Env,
  reservaId: string,
  purpose: Proposito = 'access',
  ahora: Date = new Date(),
): Promise<TokenEmitido> {
  const clave = await claveHmac(env);
  const jti = uuidv7();
  const expiraEn = new Date(ahora.getTime() + ttlMinutos(env) * 60_000);

  const payload: PayloadMagicLink = {
    jti,
    rid: reservaId,
    exp: Math.floor(expiraEn.getTime() / 1000),
    purpose,
  };

  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const firma = await crypto.subtle.sign('HMAC', clave, new TextEncoder().encode(payloadB64));

  await db(env.DB).insert(magicLinkTokens).values({
    jti,
    reservaId,
    purpose,
    expiresAt: expiraEn.toISOString(),
  });

  return { token: `${payloadB64}.${b64url(new Uint8Array(firma))}`, jti, expiraEn };
}

// ---------------------------------------------------------- validacion

export type ResultadoValidacion =
  | { ok: true; payload: PayloadMagicLink }
  | { ok: false; motivo: MotivoInvalido };

/**
 * Los diez pasos, EN ESTE ORDEN EXACTO.
 *
 * ⚠️ EL PASO 3 —la firma— VA ANTES DE TOCAR LA BASE, Y ES LO MAS IMPORTANTE
 * DE ESTA FUNCION.
 *
 * Un token forjado nunca llega a hacer una query. Si el orden fuera al reves,
 * los tiempos de respuesta permitirian sondear qué `jti` existen: un jti real
 * tardaria distinto que uno inventado, y con eso se enumera la tabla sin
 * conocer un solo telefono.
 *
 * La firma se verifica con `crypto.subtle.verify`, que ya es constant-time.
 * NUNCA comparar firmas con `===`: eso filtra informacion por timing byte a
 * byte.
 *
 * Los pasos 5 y 8 chequean lo mismo dos veces —el `exp` del payload y el
 * `expires_at` de la fila— a proposito: defensa en profundidad. La firma
 * prueba autoria; la FILA es la fuente de verdad final, y es donde viven la
 * revocacion y el consumo.
 */
export async function validarToken(
  env: Env,
  token: string | undefined | null,
  opciones: { consumir?: boolean; ahora?: Date } = {},
): Promise<ResultadoValidacion> {
  const ahora = opciones.ahora ?? new Date();

  // 1. Token no vacio.
  if (!token || token.trim() === '') return { ok: false, motivo: ERRORES.vacio };

  // 2. Un solo punto, ninguna mitad vacia.
  const partes = token.split('.');
  if (partes.length !== 2 || !partes[0] || !partes[1]) {
    return { ok: false, motivo: ERRORES.formato };
  }
  const [payloadB64, firmaB64] = partes as [string, string];

  // 3. FIRMA. Antes de cualquier acceso a la base.
  let firmaValida = false;
  try {
    firmaValida = await crypto.subtle.verify(
      'HMAC',
      await claveHmac(env),
      deB64url(firmaB64),
      new TextEncoder().encode(payloadB64),
    );
  } catch {
    // Base64 corrupto en la firma. Es indistinguible de una firma mala, y
    // tiene que serlo: decir "tu base64 esta mal" es informacion gratis.
    firmaValida = false;
  }
  if (!firmaValida) return { ok: false, motivo: ERRORES.firma };

  // 4. Payload deserializable.
  let payload: PayloadMagicLink;
  try {
    payload = JSON.parse(new TextDecoder().decode(deB64url(payloadB64))) as PayloadMagicLink;
    if (!payload?.jti || !payload.rid || typeof payload.exp !== 'number') {
      return { ok: false, motivo: ERRORES.payload };
    }
  } catch {
    return { ok: false, motivo: ERRORES.payload };
  }

  // 5. `exp` del payload.
  if (payload.exp * 1000 <= ahora.getTime()) return { ok: false, motivo: ERRORES.expirado };

  // 6. Existe la fila.
  const filas = await db(env.DB)
    .select({
      jti: magicLinkTokens.jti,
      reservaId: magicLinkTokens.reservaId,
      purpose: magicLinkTokens.purpose,
      expiresAt: magicLinkTokens.expiresAt,
      usedAt: magicLinkTokens.usedAt,
      revokedAt: magicLinkTokens.revokedAt,
    })
    .from(magicLinkTokens)
    .where(eq(magicLinkTokens.jti, payload.jti))
    .limit(1);

  const fila = filas[0];
  if (!fila) return { ok: false, motivo: ERRORES.noEncontrado };

  // 7. No revocado.
  if (fila.revokedAt) return { ok: false, motivo: ERRORES.revocado };

  // 8. `expires_at` de la fila. El mismo chequeo que el 5, contra la fuente
  //    de verdad: si alguien tocara el reloj o la fila, este lo agarra.
  if (new Date(fila.expiresAt).getTime() <= ahora.getTime()) {
    return { ok: false, motivo: ERRORES.expirado };
  }

  // 9. Single-use: no usado.
  if (opciones.consumir && fila.usedAt) return { ok: false, motivo: ERRORES.usado };

  // 10. Single-use: marcarlo.
  if (opciones.consumir) {
    /**
     * ⚠️ El UPDATE lleva `used_at IS NULL` en el WHERE, no solo el jti.
     *
     * Es un compare-and-set: dos cancelaciones simultaneas con el mismo token
     * pasan las dos el chequeo del paso 9 —leen antes de que la otra
     * escriba— y sin esta condicion las dos seguirian. Con ella, la segunda
     * no afecta ninguna fila y se rechaza.
     */
    const r = await db(env.DB)
      .update(magicLinkTokens)
      .set({ usedAt: ahora.toISOString() })
      .where(and(eq(magicLinkTokens.jti, payload.jti), isNull(magicLinkTokens.usedAt)));

    const cambios = (r as { meta?: { changes?: number } }).meta?.changes ?? 0;
    if (cambios === 0) return { ok: false, motivo: ERRORES.usado };
  }

  return { ok: true, payload };
}

/**
 * Revoca los tokens vivos de una reserva.
 *
 * ⚠️ No alcanza con quemar el que se uso: un link viejo en el historial del
 * browser —o reenviado por WhatsApp— seguiria sirviendo para ver un turno que
 * ya se cancelo.
 *
 * ⚠️ PERO EL TOKEN RECIEN CONSUMIDO SE EXCLUYE, y no es un detalle cosmetico.
 *
 * La spec pide dos cosas a la vez:
 *
 *   - "cancelar dos veces con el mismo token: la segunda da `Token ya
 *     utilizado`"
 *   - "despues de cancelar, un link emitido antes queda revocado"
 *
 * Si la revocacion se llevara puesto tambien al token usado, el paso 7
 * (revocado) se evaluaria ANTES que el 9 (usado) y el reintento diria "Token
 * revocado": el primer criterio se rompe. Excluyendolo, cada token dice la
 * verdad sobre si mismo — el que usaste, que ya lo usaste; los otros, que
 * fueron revocados.
 *
 * No se pierde nada de seguridad: el token excluido ya tiene `used_at`, asi
 * que no sirve para nada igual.
 */
export async function revocarTokensDe(
  env: Env,
  reservaId: string,
  ahora: Date = new Date(),
  exceptoJti?: string,
): Promise<number> {
  const condiciones = [
    eq(magicLinkTokens.reservaId, reservaId),
    isNull(magicLinkTokens.revokedAt),
    sql`${magicLinkTokens.expiresAt} > ${ahora.toISOString()}`,
  ];
  if (exceptoJti) condiciones.push(ne(magicLinkTokens.jti, exceptoJti));

  const r = await db(env.DB)
    .update(magicLinkTokens)
    .set({ revokedAt: ahora.toISOString() })
    .where(and(...condiciones));

  return (r as { meta?: { changes?: number } }).meta?.changes ?? 0;
}
