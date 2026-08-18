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
 * Marcador grepeable en `wrangler tail`.
 *
 * Existe para que un hash corrupto NO se confunda con una password mal
 * tipeada: los dos devuelven lo mismo al cliente, asi que la unica forma de
 * distinguirlos es que uno deje una linea propia en el log.
 */
export const MARCA_HASH_INVALIDO = 'HASH_INVALIDO';

/**
 * Marcador propio para el barbero que EXISTE y no tiene password usable.
 *
 * ⚠️ Va aparte de `HASH_INVALIDO` porque el sintoma es el mismo pero el
 * arreglo no: un hash corrupto se reescribe, y esto se resuelve poniendole una
 * password. Y va aparte del silencio del slug inexistente porque son
 * situaciones opuestas — un usuario que no existe es ruido, y un barbero que
 * existe y no puede entrar NUNCA es exactamente lo que hay que gritar.
 */
export const MARCA_SIN_PASSWORD = 'BARBERO_SIN_PASSWORD';

/** Deja constancia sin filtrar NUNCA el hash ni la password. */
function avisar(marca: string, barberoId: string | undefined, motivo: string): false {
  console.error(marca, {
    barberoId: barberoId ?? '(desconocido)',
    motivo,
    accion: 'Ver el procedimiento de emergencia en el README: hay que reescribir el hash por wrangler d1 execute.',
  });
  return false;
}

const avisarHashInvalido = (barberoId: string | undefined, motivo: string) =>
  avisar(MARCA_HASH_INVALIDO, barberoId, motivo);

/**
 * Verifica una password contra un hash almacenado.
 *
 * ⚠️ LA UNICA EXCEPCION A LA REGLA DE ORO DE LOS CATCH, Y ES DELIBERADA.
 *
 * Un hash corrupto es un error del SERVIDOR y aun asi se responde
 * `Usuario o contraseña incorrectos`, igual que una password mal tipeada.
 * Responder distinto seria un canal de enumeracion: probando usuarios se
 * podria distinguir "existe pero esta roto" de "no existe".
 *
 * Lo que compensa la excepcion es el LOG: cada camino de hash malformado deja
 * una linea marcada con `HASH_INVALIDO` y el id del barbero. Sin eso, el modo
 * de fallo es invisible — el dueño queda afuera del panel con un mensaje que
 * lo culpa a él.
 *
 * ⚠️ Y OJO: diagnosticable no es arreglable. Un hash corrupto deja al barbero
 * afuera PARA SIEMPRE, porque el endpoint que cambia la password exige estar
 * logueado. Si le pasa al unico owner, el panel queda inaccesible y la unica
 * puerta es reescribir el hash contra la base. El procedimiento esta en el
 * README, sección "Emergencia: el owner no puede entrar".
 */
export async function verificarPassword(
  password: string,
  almacenado: string | null | undefined,
  barberoId?: string,
): Promise<boolean> {
  /**
   * ⚠️ SIN HASH SON DOS SITUACIONES DISTINTAS, Y CONFUNDIRLAS DEJA ABIERTO
   * JUSTO EL AGUJERO QUE EL MARCADOR VINO A TAPAR.
   *
   *   - NO HAY FILA para ese slug → `barberoId` llega `undefined`. Es un
   *     usuario inexistente: ruido, no se loguea. Marcarlo convertiria el log
   *     en un contador de tipeos y volveria inutil al marcador.
   *
   *   - HAY FILA con `password_hash` NULL → `barberoId` llega con valor. Es un
   *     barbero que EXISTE y no va a poder entrar nunca. El sintoma es
   *     identico al del hash corrupto y hay que gritarlo igual.
   *
   * El llamador ya pasa `barbero?.id`, asi que la diferencia entre los dos
   * casos esta a mano: es el unico dato que hace falta para distinguirlos.
   */
  if (!almacenado) {
    if (barberoId) {
      return avisar(
        MARCA_SIN_PASSWORD,
        barberoId,
        'el barbero existe pero no tiene password_hash: no puede entrar al panel',
      );
    }
    return false;
  }

  const partes = almacenado.split('$');
  if (partes.length !== 4) {
    return avisarHashInvalido(barberoId, `el hash no tiene 4 partes, tiene ${partes.length}`);
  }

  const [esquema, iterStr, saltB64, hashB64] = partes as [string, string, string, string];
  if (esquema !== ESQUEMA) {
    return avisarHashInvalido(barberoId, `esquema desconocido: se esperaba ${ESQUEMA}`);
  }

  const iteraciones = Number(iterStr);
  if (!Number.isInteger(iteraciones) || iteraciones <= 0) {
    return avisarHashInvalido(barberoId, 'las iteraciones no son un entero positivo');
  }

  try {
    const salt = deB64(saltB64);
    const esperado = deB64(hashB64);
    const calculado = await derivar(password, salt, iteraciones);

    return igualesEnTiempoConstante(calculado, esperado);
  } catch (e) {
    // Base64 corrupto en el salt o el hash, o una falla de `crypto.subtle`.
    // Ninguna de las dos puede ser culpa de quien intenta loguearse.
    return avisarHashInvalido(barberoId, e instanceof Error ? e.message : String(e));
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
