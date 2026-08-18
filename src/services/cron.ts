import { lt } from 'drizzle-orm';
import { db } from '../db/client';
import { adminSessions, magicLinkTokens } from '../db/schema';
import { feriadosNacionales, type FeriadoNacional } from '../integrations/feriados-nacionales';

/**
 * Los dos jobs programados de la Fase 4.
 *
 * Corren desde el UNICO cron trigger horario. Los Cron Triggers son 5 por
 * CUENTA en el plan Free, no por Worker: consolidarlos deja lugar para 5
 * instancias del sistema (Fase 6) en vez de una sola.
 */

// ------------------------------------------------------------- limpieza

export interface ResultadoLimpieza {
  sesiones: number;
  magicLinks: number;
}

/**
 * Borra sesiones y magic links vencidos. BORRADO FISICO.
 *
 * Sin soft delete a proposito, a diferencia de las reservas: son datos
 * efimeros y sin valor historico. Una sesion vencida de hace tres meses no le
 * sirve a nadie, y conservarlas hace crecer la tabla para siempre — en D1 el
 * plan Free tiene tope de filas.
 *
 * ⚠️ El corte es `expires_at < ahora`, ESTRICTO. Una sesion que vence
 * exactamente ahora todavia vale: `buscarSesion` usa `expires_at > ahora`, y
 * si acá se usara `<=` habria un instante donde la sesion existe para el
 * login y no para la limpieza, o al reves.
 */
export async function limpiarVencidos(
  env: Env,
  ahora: Date = new Date(),
): Promise<ResultadoLimpieza> {
  const corte = ahora.toISOString();
  const cliente = db(env.DB);

  const [sesiones, magic] = await Promise.all([
    cliente.delete(adminSessions).where(lt(adminSessions.expiresAt, corte)),
    cliente.delete(magicLinkTokens).where(lt(magicLinkTokens.expiresAt, corte)),
  ]);

  return {
    sesiones: (sesiones as { meta?: { changes?: number } }).meta?.changes ?? 0,
    magicLinks: (magic as { meta?: { changes?: number } }).meta?.changes ?? 0,
  };
}

// ----------------------------------------------------- feriados en cache

/** 24 h de FRESCURA. Ojo: no es el TTL de KV. Ver abajo. */
export const FRESCURA_MS = 24 * 60 * 60 * 1000;

/**
 * ⚠️ EL TTL DE KV ES MUY MAS LARGO QUE LA FRESCURA, Y NO ES UN ERROR.
 *
 * La spec pide dos cosas que, tomadas literalmente, se contradicen:
 *
 *   a) "guardar en KV con TTL de 24 h"
 *   b) "si la API externa está caída, servir lo que haya en KV aunque esté
 *      vencido"
 *
 * Con `expirationTtl: 86400` la (b) es imposible: a las 24 h KV BORRA la
 * entrada, y lo vencido no existe para servirlo. Justo el dia que la API de
 * terceros se cae mas de un dia —que es cuando el fallback importa— no queda
 * nada.
 *
 * Se resuelve separando las dos ideas: KV guarda 30 dias, y la frescura de
 * 24 h viaja DENTRO del valor. Vencido significa "intentá refrescarlo", no
 * "tiralo".
 */
const TTL_KV_SEG = 30 * 24 * 60 * 60;

const claveFeriados = (anio: number) => `feriados:${anio}`;

interface FeriadosCacheados {
  anio: number;
  feriados: FeriadoNacional[];
  /** Epoch en ms. Pasado esto se reintenta la API, pero el dato sigue sirviendo. */
  frescoHastaMs: number;
}

/** Los años que se cachean: el actual y el siguiente. */
export const aniosACachear = (ahora: Date = new Date()): number[] => {
  // En diciembre la gente reserva para enero: sin el año siguiente, el panel
  // de feriados aparece vacio justo en la unica epoca donde se mira.
  const anio = Number(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Argentina/Buenos_Aires',
      year: 'numeric',
    }).format(ahora),
  );

  return [anio, anio + 1];
};

const leerCache = (env: Env, anio: number) =>
  env.CACHE.get<FeriadosCacheados>(claveFeriados(anio), 'json').catch(() => null);

async function guardarCache(env: Env, valor: FeriadosCacheados): Promise<void> {
  await env.CACHE.put(claveFeriados(valor.anio), JSON.stringify(valor), {
    expirationTtl: TTL_KV_SEG,
  }).catch(() => undefined);
}

export interface ResultadoFeriados {
  anio: number;
  origen: 'api' | 'cache' | 'cache-vencido' | 'vacio';
  cantidad: number;
}

/**
 * Feriados de un año, con KV adelante.
 *
 * ⚠️ EL ORDEN DE PREFERENCIA ES: cache fresco → API → CACHE VENCIDO → vacio.
 *
 * El penultimo escalon es el que importa: **es mejor un feriado
 * desactualizado que un panel roto**. Los feriados nacionales de un año casi
 * no cambian, asi que servir la copia del mes pasado es practicamente
 * inofensivo; que la pantalla aparezca vacia porque un servicio ajeno esta
 * caido, no.
 */
export async function feriadosDelAnio(
  env: Env,
  anio: number,
  ahora: Date = new Date(),
): Promise<{ feriados: FeriadoNacional[]; origen: ResultadoFeriados['origen'] }> {
  const cacheado = await leerCache(env, anio);

  if (cacheado && cacheado.frescoHastaMs > ahora.getTime()) {
    return { feriados: cacheado.feriados, origen: 'cache' };
  }

  const deLaApi = await feriadosNacionales(anio);

  if (deLaApi.length > 0) {
    await guardarCache(env, {
      anio,
      feriados: deLaApi,
      frescoHastaMs: ahora.getTime() + FRESCURA_MS,
    });
    return { feriados: deLaApi, origen: 'api' };
  }

  // La API no contesto o vino vacia. Lo viejo sirve mas que nada.
  if (cacheado) {
    console.warn('feriados: sirviendo cache vencido, la API no respondió', {
      anio,
      vencidoHaceMs: ahora.getTime() - cacheado.frescoHastaMs,
    });
    return { feriados: cacheado.feriados, origen: 'cache-vencido' };
  }

  return { feriados: [], origen: 'vacio' };
}

/** El job: refresca el año actual y el siguiente. */
export async function refrescarFeriados(
  env: Env,
  ahora: Date = new Date(),
): Promise<ResultadoFeriados[]> {
  const resultados: ResultadoFeriados[] = [];

  for (const anio of aniosACachear(ahora)) {
    const { feriados, origen } = await feriadosDelAnio(env, anio, ahora);
    resultados.push({ anio, origen, cantidad: feriados.length });
  }

  return resultados;
}

/**
 * Fuerza el refresco ignorando la frescura del cache.
 *
 * El job programado usa esto y no `feriadosDelAnio` a secas: si respetara la
 * frescura, un cron que corre una vez por dia encontraria el cache todavia
 * fresco por unos minutos y no refrescaria NUNCA.
 */
export async function refrescarFeriadosForzado(
  env: Env,
  ahora: Date = new Date(),
): Promise<ResultadoFeriados[]> {
  const resultados: ResultadoFeriados[] = [];

  for (const anio of aniosACachear(ahora)) {
    const deLaApi = await feriadosNacionales(anio);

    if (deLaApi.length > 0) {
      await guardarCache(env, {
        anio,
        feriados: deLaApi,
        frescoHastaMs: ahora.getTime() + FRESCURA_MS,
      });
      resultados.push({ anio, origen: 'api', cantidad: deLaApi.length });
      continue;
    }

    const cacheado = await leerCache(env, anio);
    resultados.push({
      anio,
      origen: cacheado ? 'cache-vencido' : 'vacio',
      cantidad: cacheado?.feriados.length ?? 0,
    });
  }

  return resultados;
}
