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

/**
 * Iteraciones para hashes nuevos.
 *
 * 50.000 = 3,8 ms de los 10 ms de CPU del plan Free (38%). Medido, ver
 * docs/notas-operacion.md.
 *
 * ⚠️ NO SUBIR SIN MEDIR. 150.000 ya no entra en el presupuesto (11,25 ms) y
 * el login se caeria con "Worker exceeded CPU time". La recomendacion habitual
 * de subir iteraciones con los anios NO es aplicable en el plan Free: la
 * salida es Workers Paid, con 30 s de CPU.
 *
 * Se eligio 50.000 sobre 100.000 (7,6 ms, 76% del presupuesto) porque la
 * medicion es sobre una maquina de desarrollo: si el edge de Cloudflare fuera
 * un 30% mas lento, 100.000 dejaria el login al borde. Ni 50.000 ni 100.000 se
 * acercan a las ~600.000 que recomienda OWASP hoy, asi que el free tier nos
 * deja debajo igual: aceptado eso, un bit de factor de trabajo vale menos que
 * un login que no se cae.
 *
 * LA COMPENSACION ES EL LARGO DE LA PASSWORD, que rinde mas que duplicar
 * iteraciones. Ver `LARGO_MIN_PASSWORD`.
 */
export const ITERACIONES = 50_000;

/**
 * Largo minimo de password.
 *
 * Compensa el factor de trabajo acotado por el presupuesto de CPU: cada
 * caracter extra multiplica el espacio de busqueda, mientras que duplicar las
 * iteraciones solo lo duplica.
 */
export const LARGO_MIN_PASSWORD = 12;

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

/**
 * Valida el largo minimo. Devuelve el mensaje de rechazo, o null si esta bien.
 *
 * Se usa en el alta y el cambio de password (Fase 3). NO se usa en el login:
 * ahi hay que aceptar cualquier cosa que el usuario tipee y compararla, porque
 * rechazar por largo delataria la politica vigente cuando se creo la cuenta.
 */
export function validarLargoPassword(password: string): string | null {
  return password.length < LARGO_MIN_PASSWORD
    ? `La contraseña tiene que tener al menos ${LARGO_MIN_PASSWORD} caracteres.`
    : null;
}

/** True si el hash usa menos iteraciones que las actuales: conviene re-hashear. */
export function necesitaRehash(almacenado: string | null | undefined): boolean {
  if (!almacenado) return false;

  const partes = almacenado.split('$');
  if (partes.length !== 4 || partes[0] !== ESQUEMA) return true;

  return Number(partes[1]) < ITERACIONES;
}
