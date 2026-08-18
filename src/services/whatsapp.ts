/**
 * WhatsApp via CallMeBot.
 *
 * ⚠️ LO MENOS OBVIO DE TODA LA INTEGRACION: CALLMEBOT DEVUELVE HTTP 200 CUANDO
 * FALLA. El error viaja en el CUERPO, en ingles y en prosa. Un cliente que se
 * fie del status da por enviado un mensaje que nunca salio, y el barbero se
 * entera cuando el cliente no aparece.
 *
 * Por eso `interpretarRespuesta` mira el texto y no el codigo.
 *
 *
 * LA API KEY VA EN LA QUERY STRING
 *
 * CallMeBot no soporta autenticacion por header. Eso significa que la URL
 * COMPLETA ES UN SECRETO: no se loguea nunca, ni en un error. Todo lo que sale
 * de acá hacia un log pasa por `paraLog`.
 */

const BASE = 'https://api.callmebot.com/whatsapp.php';

/** La spec fija 10 s. */
export const TIMEOUT_MS = 10_000;

/** `^\+?\d{7,15}$` — formato internacional, con o sin el `+`. */
const RE_INTERNACIONAL = /^\+?\d{7,15}$/;

export const ERROR_TELEFONO_INVALIDO =
  'Número inválido. Usá formato internacional, ej: +5491122334455 (país 54 + 9 + área + número).';

export const esTelefonoInternacional = (tel: string | null | undefined): boolean =>
  typeof tel === 'string' && RE_INTERNACIONAL.test(tel.trim());

// ------------------------------------------------------------- el template

export type TipoAviso = 'creada' | 'cancelada' | 'modificada' | 'recurrente';

/**
 * 🐛 EL TITULO SALE DEL TIPO, NO DE BUSCAR SUBSTRINGS.
 *
 * El sistema viejo elegia el template buscando `"CANCELADO"` o `"reagendado"`
 * DENTRO del texto de la nota. Es fragil de las dos puntas: un cliente que se
 * llame "Reagendado" —o una nota que alguien reescriba— cambia el titulo del
 * mensaje. Acá el tipo es un parametro explicito.
 *
 * `recurrente` comparte titulo con `creada` a proposito: para el barbero es
 * una reserva nueva igual. Se distingue por la nota, no por el titulo.
 */
const TITULOS: Record<TipoAviso, string> = {
  creada: '✅ Nueva reserva:',
  recurrente: '✅ Nueva reserva:',
  cancelada: '❌ Turno cancelado:',
  modificada: '✏️ Turno modificado:',
};

export interface DatosAviso {
  tipo: TipoAviso;
  nombre: string;
  telefono: string;
  servicio: string;
  fecha: string;
  hora: string;
  /** La nota. Si no hay, la linea entera no aparece. */
  extra?: string | undefined;
}

/** Las etiquetas se alinean a 10 caracteres. Copiado del sistema viejo. */
const linea = (etiqueta: string, valor: string) => `  ${`${etiqueta}:`.padEnd(10)}${valor}`;

export function armarMensaje(d: DatosAviso): string {
  const lineas = [
    TITULOS[d.tipo],
    linea('Nombre', d.nombre),
    linea('Tel', d.telefono),
    linea('Servicio', d.servicio),
    linea('Fecha', `${d.fecha} ${d.hora}`),
  ];

  if (d.extra) lineas.push(linea('Nota', d.extra));

  return lineas.join('\n');
}

/** Las notas que usa el sistema. Transcripcion textual de la spec. */
export const NOTAS = {
  web: 'Reserva confirmada vía Web.',
  panel: 'Turno cargado desde el panel admin.',
  canceladaCliente: 'TURNO CANCELADO por el cliente.',
  canceladaPanel: 'TURNO CANCELADO desde el panel admin.',
  reagendadaCliente: 'Turno reagendado por el cliente.',
  reagendadaPanel: 'Turno reagendado desde el panel admin.',
  recurrente: 'Tu turno recurrente ha sido cargado.',
} as const;

// -------------------------------------------------- la deteccion de errores

/**
 * Las nueve señales de fallo, case-insensitive.
 *
 * Son las que usa el sistema viejo. Cubren los casos reales de CallMeBot: la
 * apikey mal, el numero no registrado en el bot, el bot dado de baja.
 *
 * ⚠️ Es una heuristica sobre prosa en ingles y puede tener FALSOS POSITIVOS: si
 * el texto del mensaje enviado apareciera reflejado en la respuesta y el
 * cliente se llamara "Wrong", esto lo leeria como error. El costo del falso
 * positivo es un aviso marcado como fallido que en realidad salio; el del
 * falso negativo es un turno del que el barbero nunca se entera. Se prefiere
 * equivocarse para el lado ruidoso.
 */
const SEÑALES_DE_FALLO = [
  'error',
  'apikey',
  'not allowed',
  'not registered',
  'invalid',
  'no longer',
  'you need to',
  'wrong',
  'fail',
] as const;

/** Saca tags HTML y aprieta los espacios: CallMeBot contesta con HTML. */
export function limpiarDetalle(texto: string): string {
  return texto
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export type Resultado =
  | { ok: true }
  | { ok: false; motivo: string };

/**
 * Decide si la respuesta fue un exito, mirando el CUERPO.
 *
 * Un 200 con "You need to ask for an API key" es un fallo.
 */
export function interpretarRespuesta(status: number, cuerpo: string): Resultado {
  const detalle = limpiarDetalle(cuerpo);

  if (status < 200 || status >= 300) {
    return { ok: false, motivo: `CallMeBot respondió HTTP ${status}: ${detalle}` };
  }

  const enMinusculas = detalle.toLowerCase();
  const señal = SEÑALES_DE_FALLO.find((s) => enMinusculas.includes(s));

  if (señal) return { ok: false, motivo: detalle };
  return { ok: true };
}

// ------------------------------------------------------------------ envio

export interface Destino {
  telefono: string;
  apikey: string;
}

/**
 * Manda el mensaje. NUNCA lanza: devuelve el motivo.
 *
 * El motivo es lo que ve el barbero en el panel, asi que dice qué paso y no
 * "hubo un error".
 */
export async function enviarWhatsApp(destino: Destino, texto: string): Promise<Resultado> {
  if (!esTelefonoInternacional(destino.telefono)) {
    // No se dispara el request: un numero mal formado no va a mejorar por
    // reintentarlo, y CallMeBot cobra la operacion igual.
    return { ok: false, motivo: ERROR_TELEFONO_INVALIDO };
  }

  const url = new URL(BASE);
  url.searchParams.set('phone', destino.telefono.trim());
  url.searchParams.set('text', texto);
  url.searchParams.set('apikey', destino.apikey);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return interpretarRespuesta(res.status, await res.text().catch(() => ''));
  } catch (e) {
    // ⚠️ El mensaje de la excepcion, NO el error entero: un `TypeError` de
    // fetch puede traer la URL —con la apikey— en su `cause`.
    return {
      ok: false,
      motivo: `Excepción al contactar CallMeBot: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
