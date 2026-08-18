import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { barberos } from '../db/schema';
import { claveMaestra, cifrar, descifrar, pistaDeApikey, hayClaveMaestra } from './cripto';
import {
  enviarWhatsApp,
  armarMensaje,
  esTelefonoInternacional,
  ERROR_TELEFONO_INVALIDO,
} from './whatsapp';

/**
 * Configuracion de CallMeBot por barbero. La `apikey` se guarda CIFRADA.
 *
 * ⚠️ LA KEY NUNCA SALE EN UNA RESPUESTA. El GET devuelve `tieneApikey` y una
 * pista de cuatro caracteres — suficiente para que el barbero reconozca cual
 * cargo, insuficiente para usarla. Devolverla "para que pueda verificarla"
 * convierte cualquier XSS en el panel en una filtracion de credenciales.
 */

export const ERROR_BARBERO_NO_ENCONTRADO = 'Barbero no encontrado.';
export const ERROR_TELEFONO_CALLMEBOT = ERROR_TELEFONO_INVALIDO;
export const ERROR_APIKEY_REQUERIDA = 'La API key es obligatoria.';
export const ERROR_SIN_CONFIGURACION =
  'Configurá primero el número y la API key de CallMeBot para poder probarlos.';

export interface ConfigCallmebot {
  barberoId: string;
  telefono: string | null;
  tieneApikey: boolean;
  /** `••••1234`, o `null` si no hay key. NUNCA la key entera. */
  pistaApikey: string | null;
}

export async function leerConfig(env: Env, barberoId: string): Promise<ConfigCallmebot | null> {
  const filas = await db(env.DB)
    .select({
      id: barberos.id,
      telefono: barberos.callmebotPhone,
      apikey: barberos.callmebotApikey,
    })
    .from(barberos)
    .where(eq(barberos.id, barberoId))
    .limit(1);

  const fila = filas[0];
  if (!fila) return null;

  /**
   * La PISTA sale de la key EN CLARO, asi que hay que descifrarla.
   *
   * Mostrar los ultimos caracteres del ciphertext no identificaria nada: son
   * bytes distintos en cada guardado aunque la key sea la misma, porque el IV
   * cambia siempre.
   */
  let pista: string | null = null;
  if (fila.apikey && hayClaveMaestra(env)) {
    const clara = await descifrar(fila.apikey, await claveMaestra(env)).catch(() => null);
    pista = pistaDeApikey(clara);
  }

  return {
    barberoId: fila.id,
    telefono: fila.telefono,
    tieneApikey: Boolean(fila.apikey),
    pistaApikey: pista,
  };
}

export type ResultadoConfig =
  | { estado: 'exito'; config: ConfigCallmebot }
  | { estado: 'error'; error: string }
  | { estado: 'noEncontrado' };

export interface EntradaCallmebot {
  telefono?: unknown;
  apikey?: unknown;
}

/**
 * Guarda la configuracion. Edicion parcial.
 *
 * Mandar `apikey: null` la BORRA; no mandarla la deja como esta. Es la
 * distincion que permite editar el telefono sin tener que reescribir la key
 * (que el panel no tiene, porque nunca se la devolvimos).
 */
export async function guardarConfig(
  env: Env,
  barberoId: string,
  entrada: EntradaCallmebot,
): Promise<ResultadoConfig> {
  const actual = await leerConfig(env, barberoId);
  if (!actual) return { estado: 'noEncontrado' };

  const cambios: Record<string, unknown> = {};

  if (entrada.telefono !== undefined) {
    const tel = typeof entrada.telefono === 'string' ? entrada.telefono.trim() : '';

    if (tel === '') {
      cambios.callmebotPhone = null;
    } else if (!esTelefonoInternacional(tel)) {
      return { estado: 'error', error: ERROR_TELEFONO_CALLMEBOT };
    } else {
      cambios.callmebotPhone = tel;
    }
  }

  if (entrada.apikey !== undefined) {
    if (entrada.apikey === null || entrada.apikey === '') {
      cambios.callmebotApikey = null;
    } else if (typeof entrada.apikey !== 'string' || entrada.apikey.trim() === '') {
      return { estado: 'error', error: ERROR_APIKEY_REQUERIDA };
    } else {
      // Si falta la clave maestra, `claveMaestra` LANZA. Es lo correcto:
      // guardar la key en claro seria peor que no guardarla.
      cambios.callmebotApikey = await cifrar(entrada.apikey.trim(), await claveMaestra(env));
    }
  }

  if (Object.keys(cambios).length > 0) {
    await db(env.DB).update(barberos).set(cambios).where(eq(barberos.id, barberoId));
  }

  const config = await leerConfig(env, barberoId);
  return config ? { estado: 'exito', config } : { estado: 'noEncontrado' };
}

/** Descifra la key de un barbero. Para el consumer de la cola. */
export async function apikeyDe(env: Env, guardada: string): Promise<string | null> {
  if (!hayClaveMaestra(env)) return null;
  return descifrar(guardada, await claveMaestra(env));
}

export type ResultadoTest =
  | { estado: 'enviado' }
  | { estado: 'fallo'; motivo: string }
  | { estado: 'sinConfigurar' }
  | { estado: 'noEncontrado' };

/**
 * Manda un mensaje de prueba y devuelve el RESULTADO REAL.
 *
 * Es la herramienta de diagnostico del barbero: si CallMeBot rechaza la key,
 * acá tiene que leer "APIKey is invalid" y no "no se pudo enviar". El motivo ya
 * viene redactado desde `enviarWhatsApp`.
 */
export async function probarEnvio(env: Env, barberoId: string): Promise<ResultadoTest> {
  const filas = await db(env.DB)
    .select({ tel: barberos.callmebotPhone, key: barberos.callmebotApikey, nombre: barberos.nombre })
    .from(barberos)
    .where(eq(barberos.id, barberoId))
    .limit(1);

  const fila = filas[0];
  if (!fila) return { estado: 'noEncontrado' };
  if (!fila.tel || !fila.key) return { estado: 'sinConfigurar' };

  const apikey = await apikeyDe(env, fila.key);
  if (!apikey) return { estado: 'sinConfigurar' };

  const texto = armarMensaje({
    tipo: 'creada',
    nombre: fila.nombre,
    telefono: fila.tel,
    servicio: 'Prueba de configuración',
    fecha: 'ahora',
    hora: '',
    extra: 'Si recibís esto, WhatsApp está configurado correctamente.',
  });

  const r = await enviarWhatsApp({ telefono: fila.tel, apikey }, texto);
  return r.ok ? { estado: 'enviado' } : { estado: 'fallo', motivo: r.motivo };
}
