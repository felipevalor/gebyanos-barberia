/**
 * Cifrado en reposo de las credenciales de CallMeBot. AES-GCM 256.
 *
 * El sistema viejo usa la Data Protection API de ASP.NET, que no existe en
 * Workers. El reemplazo es `crypto.subtle` con la clave maestra en un secret
 * de Wrangler.
 *
 *
 * FORMATO: `v1:<iv-b64>:<ciphertext-b64>`
 *
 * El prefijo de version permite ROTAR el esquema sin migrar todo de golpe: el
 * dia que haya un `v2`, `descifrar` sigue leyendo los `v1` guardados y solo lo
 * que se reescribe sale con el formato nuevo. Sin el prefijo, cambiar de
 * algoritmo obliga a reescribir todas las filas en una sola operacion, y si
 * esa operacion se corta a la mitad no hay forma de saber que quedo en cada
 * formato.
 */

/** El unico esquema que existe hoy. */
export const VERSION = 'v1';

/** AES-GCM manda 96 bits. Ni mas ni menos: es lo que asume la construccion. */
const LARGO_IV = 12;

export const ERROR_SIN_CLAVE_MAESTRA =
  'ENCRYPTION_KEY no está configurada. Sin ella no se pueden guardar ni leer las credenciales de CallMeBot. Configurala con: wrangler secret put ENCRYPTION_KEY';

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

const deB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Deriva la clave maestra del secret.
 *
 * ⚠️ LANZA SI FALTA, Y ESO ES DELIBERADO. La alternativa —cifrar con una clave
 * vacia o derivada de un string por defecto— produce datos que PARECEN
 * cifrados y no lo estan. Un fallo ruidoso al arrancar se arregla en un minuto;
 * una base entera cifrada con la clave vacia se descubre tarde.
 *
 * El secret puede ser cualquier string: se le aplica SHA-256 para llegar a los
 * 32 bytes exactos que AES-256 necesita, asi que no hay que generar una clave
 * en un formato especifico.
 */
export async function claveMaestra(env: Env): Promise<CryptoKey> {
  const secreto = env.ENCRYPTION_KEY?.trim();
  if (!secreto) throw new Error(ERROR_SIN_CLAVE_MAESTRA);

  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secreto));

  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export const hayClaveMaestra = (env: Env): boolean => Boolean(env.ENCRYPTION_KEY?.trim());

/**
 * Cifra. UN IV NUEVO POR CADA LLAMADA, sin excepcion.
 *
 * ⚠️ Reusar el IV con AES-GCM no debilita el cifrado: LO ROMPE. Con dos
 * mensajes cifrados bajo la misma clave y el mismo IV, el XOR de los
 * ciphertexts es el XOR de los plaintexts —el keystream se cancela— y ademas
 * se puede recuperar la clave de autenticacion y falsificar tags. No es un
 * margen de seguridad que se achica; es la garantia que desaparece.
 *
 * Por eso el IV sale de `crypto.getRandomValues` acá adentro y no se recibe
 * como parametro: no hay forma de que un llamador lo fije por error.
 */
export async function cifrar(texto: string, clave: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(LARGO_IV));

  const cifrado = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    clave,
    new TextEncoder().encode(texto),
  );

  return `${VERSION}:${b64(iv)}:${b64(new Uint8Array(cifrado))}`;
}

/**
 * Descifra. Devuelve `null` ante cualquier problema, no lanza.
 *
 * Un valor corrupto, de otra version, o cifrado con una clave maestra vieja
 * tiene que degradar a "este barbero no tiene credencial", no tumbar el
 * consumer de la cola.
 */
export async function descifrar(guardado: string, clave: CryptoKey): Promise<string | null> {
  const partes = guardado.split(':');
  if (partes.length !== 3) return null;

  const [version, ivB64, cifradoB64] = partes as [string, string, string];
  if (version !== VERSION) return null;

  try {
    const plano = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: deB64(ivB64) },
      clave,
      deB64(cifradoB64),
    );
    return new TextDecoder().decode(plano);
  } catch {
    // El tag de GCM no verifico: o el dato se altero, o la clave no es la que
    // lo cifro. Las dos cosas significan lo mismo acá.
    return null;
  }
}

/**
 * Lo que se le muestra al barbero para que identifique la key que cargo.
 *
 * NUNCA la key entera. Cuatro caracteres alcanzan para distinguir dos keys y
 * no alcanzan para usarlas.
 */
export function pistaDeApikey(apikey: string | null | undefined): string | null {
  if (!apikey) return null;
  const limpia = apikey.trim();
  if (limpia.length <= 4) return '••••';

  return `••••${limpia.slice(-4)}`;
}
