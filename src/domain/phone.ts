import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Normalizacion de telefonos argentinos. CERO I/O.
 *
 * FORMA CANONICA: 10 digitos = codigo de area + numero.
 * Sin +54, sin el 9 internacional, sin el 0 nacional, sin el 15 de celular.
 *
 * Se apoya en libphonenumber-js con region 'AR' y NO se hace a mano: el codigo
 * de area argentino tiene longitud variable (11 en Buenos Aires, 341 en
 * Rosario, 4 digitos en algunas zonas) y el 15 va DESPUES del area. Sin la
 * metadata real es imposible saber donde cortar.
 */

/**
 * Saca los prefijos internacionales/nacionales de una cadena de solo digitos.
 * Se aplica tanto al E.164 que devuelve la libreria como al fallback manual.
 */
function recortarPrefijos(digitos: string): string {
  if (digitos.length === 13 && digitos.startsWith('549')) return digitos.slice(3);
  if (digitos.length === 12 && digitos.startsWith('54')) return digitos.slice(2);
  if (digitos.length === 11 && digitos.startsWith('9')) return digitos.slice(1);
  return digitos;
}

/**
 * Normaliza a la forma canonica de 10 digitos.
 *
 * ⚠️ El segundo parametro de `parsePhoneNumberFromString` es el pais POR
 * DEFECTO, no una restriccion. Un "+1 212 555 1234" parsea como valido (US) y
 * un "+55 11 91234 5678" como valido (BR): sin chequear `country` se guardaban
 * 11 y 13 digitos como si fueran argentinos, corrompiendo el indice de
 * telefono y el envio de WhatsApp. Por eso el chequeo explicito de 'AR'.
 *
 * DECISION: un numero de otro pais se RECHAZA (devuelve ""), no se guarda tal
 * cual. Razones:
 *   - la forma canonica esta definida como 10 digitos argentinos; guardar otra
 *     cosa en la misma columna rompe las busquedas por telefono;
 *   - CallMeBot manda WhatsApp a numeros argentinos, asi que un numero
 *     extranjero no recibiria la confirmacion igual;
 *   - fallar visible en el borde es mejor que guardar algo que nadie va a
 *     poder usar despues.
 *
 * El llamador distingue "no vino telefono" de "vino uno invalido" mirando el
 * input, o usando `esTelefonoArgentino`.
 */
export function normalizeTel(raw: string | null | undefined): string {
  if (!raw) return '';

  const parsed = parsePhoneNumberFromString(raw, 'AR');

  if (parsed?.isValid()) {
    // Numero de otro pais: se rechaza.
    if (parsed.country !== 'AR') return '';

    // parsed.number es E.164: "+5493416513207". Resuelve el 0 y el 15, que es
    // justamente lo que el fallback manual no puede.
    return recortarPrefijos(parsed.number.replace(/\D/g, ''));
  }

  // Fallback manual: la libreria no pudo parsearlo. Se recortan los prefijos
  // conocidos y se devuelve lo que quede.
  return recortarPrefijos(raw.replace(/\D/g, ''));
}

/**
 * True si `raw` normaliza a un telefono argentino canonico de 10 digitos.
 *
 * Es lo que tiene que usar la validacion de borde: `normalizeTel` puede
 * devolver una cadena mas corta o mas larga cuando cae al fallback manual (un
 * numero mal tipeado, por ejemplo), y eso no deberia entrar a la base.
 */
export function esTelefonoArgentino(raw: string | null | undefined): boolean {
  return /^\d{10}$/.test(normalizeTel(raw));
}

/**
 * Enmascara un telefono para los logs: solo los ultimos 4 digitos.
 * Regla de oro 6 de 00-CONTEXTO.md.
 */
export function enmascararTel(raw: string | null | undefined): string {
  const digitos = (raw ?? '').replace(/\D/g, '');
  if (digitos.length <= 4) return '*'.repeat(digitos.length);
  return '*'.repeat(digitos.length - 4) + digitos.slice(-4);
}
