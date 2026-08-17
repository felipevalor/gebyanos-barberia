import { DurableObject } from 'cloudflare:workers';

/**
 * Rate limiting con ventana fija. Un DO por clave `{ip}:{endpoint}`.
 *
 *
 * ⚠️ POR QUE UN DO Y NO EL BINDING NATIVO DE RATE LIMITING
 *
 * Se evaluo `env.RATE_LIMITER.limit({ key })` primero, que es mas simple y no
 * requiere escribir nada. NO SIRVE para este caso, por tres razones, en orden
 * de peso:
 *
 * 1. LA VENTANA NO ES EXPRESABLE. `simple.period` "must be either 10 or 60"
 *    segundos. La ventana de este sistema es de 15 minutos (900 s). No hay
 *    forma de configurarla.
 *
 * 2. EL CONTADOR ES POR UBICACION DE CLOUDFLARE. "For each unique key you pass
 *    to your rate limiting binding, there is a unique limit per Cloudflare
 *    location." Contra fuerza bruta sobre el login eso es fatal: un atacante
 *    que rote de PoP multiplica el cupo por la cantidad de ubicaciones.
 *
 * 3. ES DELIBERADAMENTE INEXACTO. "permissive, eventually consistent, and
 *    intentionally designed to not be used as an accurate accounting system."
 *
 * Un DO da la ventana que se quiera y un unico contador global por clave.
 *
 *
 * EL CONTADOR VIVE EN MEMORIA Y SE PIERDE. A proposito.
 *
 * No se usa `ctx.storage`: cuando el DO se evicta por inactividad, o hay un
 * deploy, el contador arranca de cero. Eso esta bien — la defensa real contra
 * el doble booking es el Durable Object de reservas mas el indice unico, no
 * esto. El rate limit solo encarece el abuso.
 *
 * Persistirlo agregaria escrituras a storage en cada request para proteger un
 * dato que no vale nada a los 15 minutos.
 */

export interface EstadoLimite {
  permitido: boolean;
  /** Cuantos quedan en la ventana actual. 0 si ya se paso. */
  restantes: number;
  /** Milisegundos hasta que la ventana se reinicia. */
  resetEnMs: number;
}

export class RateLimiter extends DurableObject<Env> {
  /** Inicio de la ventana vigente, en epoch ms. */
  #ventanaInicio = 0;
  #contador = 0;

  /**
   * Alinea la ventana con `ahoraMs`, reiniciando si vencio.
   *
   * `ahoraMs` viene del llamador y no de `Date.now()` de acá adentro: en un DO
   * sin I/O el reloj puede no avanzar, y ademas asi los tests controlan el
   * paso del tiempo sin esperar 15 minutos.
   */
  #alinear(ahoraMs: number, ventanaMs: number): void {
    if (ahoraMs - this.#ventanaInicio >= ventanaMs) {
      this.#ventanaInicio = ahoraMs;
      this.#contador = 0;
    }
  }

  /**
   * ⚠️ `permitido` significa "ESTA operacion es valida", y por eso la
   * comparacion cambia segun cuando se pregunte:
   *
   *   - despues de consumir  → `contador <= limite`. Con limite 10, el
   *     request 10 deja el contador en 10 y todavia vale; el 11 lo deja en 11
   *     y no.
   *   - antes de consumir    → `contador < limite`. Con 10 fallos previos el
   *     contador ya vale 10, y el intento 11 tiene que rebotar sin siquiera
   *     probarse.
   *
   * Usar la misma comparacion en los dos lados regala un intento.
   */
  #estado(limite: number, ventanaMs: number, ahoraMs: number, yaConsumido: boolean): EstadoLimite {
    return {
      permitido: yaConsumido ? this.#contador <= limite : this.#contador < limite,
      restantes: Math.max(0, limite - this.#contador),
      resetEnMs: Math.max(0, this.#ventanaInicio + ventanaMs - ahoraMs),
    };
  }

  /**
   * Mira el estado SIN consumir cupo.
   *
   * Lo usa el login: hay que rechazar a quien ya se paso antes de gastar los
   * 3,8 ms de CPU que cuesta verificar una password.
   */
  async chequear(limite: number, ventanaMs: number, ahoraMs: number): Promise<EstadoLimite> {
    this.#alinear(ahoraMs, ventanaMs);
    return this.#estado(limite, ventanaMs, ahoraMs, false);
  }

  /** Consume un intento y devuelve el estado resultante. */
  async consumir(limite: number, ventanaMs: number, ahoraMs: number): Promise<EstadoLimite> {
    this.#alinear(ahoraMs, ventanaMs);
    this.#contador += 1;
    return this.#estado(limite, ventanaMs, ahoraMs, true);
  }

  /** Devuelve el cupo entero. */
  async reiniciar(): Promise<void> {
    this.#ventanaInicio = 0;
    this.#contador = 0;
  }
}
