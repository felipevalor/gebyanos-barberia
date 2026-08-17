/**
 * Hashing de passwords con PBKDF2 via `crypto.subtle`.
 *
 * POR QUE NO BCRYPT: el sistema viejo usa BCrypt cost 12, que no entra en los
 * 10 ms de CPU por request del plan Free de Workers y obligaria a pasar a
 * Workers Paid. Como este sistema arranca de cero no hay hashes legacy que
 * soportar, asi que PBKDF2 es la opcion correcta: nativo, sin dependencias, y
 * saca la dependencia del plan pago de un endpoint de login.
 *
 * FORMATO ALMACENADO: `pbkdf2$<iteraciones>$<salt-b64>$<hash-b64>`
 *
 * El prefijo de esquema y las iteraciones van EN el hash, no en una constante:
 * asi se puede subir el costo o cambiar de algoritmo sin invalidar los hashes
 * viejos. Cada hash se verifica con los parametros con los que se creo.
 */

/** Iteraciones para hashes nuevos. Ver docs/notas-operacion.md para el CPU medido. */
export const ITERACIONES = 100_000;

const LARGO_SALT = 16;
const LARGO_HASH = 32;
const ESQUEMA = 'pbkdf2';

const aB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

const deB64 = (s: string): Uint8Array =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derivar(
  password: string,
  salt: Uint8Array,
  iteraciones: number,
): Promise<Uint8Array> {
  const clave = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: iteraciones },
    clave,
    LARGO_HASH * 8,
  );

  return new Uint8Array(bits);
}

/** Hashea una password para guardar. Genera una sal nueva cada vez. */
export async function hashPassword(
  password: string,
  iteraciones: number = ITERACIONES,
): Promise<string> {
  const salt = new Uint8Array(LARGO_SALT);
  crypto.getRandomValues(salt);

  const hash = await derivar(password, salt, iteraciones);
  return `${ESQUEMA}$${iteraciones}$${aB64(salt)}$${aB64(hash)}`;
}

/**
 * Comparacion en tiempo constante.
 *
 * Un `===` sobre strings corta en el primer byte distinto, y esa diferencia de
 * tiempo filtra informacion del hash. Con hashes de 32 bytes el riesgo es
 * teorico, pero el costo de hacerlo bien es cero.
 */
function igualesEnTiempoConstante(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Verifica una password contra un hash almacenado.
 *
 * Devuelve false ante cualquier hash mal formado en vez de tirar: un registro
 * corrupto en la base tiene que fallar el login, no tumbar el endpoint.
 */
export async function verificarPassword(
  password: string,
  almacenado: string | null | undefined,
): Promise<boolean> {
  if (!almacenado) return false;

  const partes = almacenado.split('$');
  if (partes.length !== 4) return false;

  const [esquema, iterStr, saltB64, hashB64] = partes as [string, string, string, string];
  if (esquema !== ESQUEMA) return false;

  const iteraciones = Number(iterStr);
  if (!Number.isInteger(iteraciones) || iteraciones <= 0) return false;

  try {
    const salt = deB64(saltB64);
    const esperado = deB64(hashB64);
    const calculado = await derivar(password, salt, iteraciones);

    return igualesEnTiempoConstante(calculado, esperado);
  } catch {
    return false;
  }
}

/** True si el hash usa menos iteraciones que las actuales: conviene re-hashear. */
export function necesitaRehash(almacenado: string | null | undefined): boolean {
  if (!almacenado) return false;

  const partes = almacenado.split('$');
  if (partes.length !== 4 || partes[0] !== ESQUEMA) return true;

  return Number(partes[1]) < ITERACIONES;
}
