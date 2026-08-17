import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { fail } from '../api';
import type { EstadoLimite } from '../do/RateLimiter';

/**
 * Rate limiting por IP y endpoint.
 *
 * Constantes de negocio (00-CONTEXTO.md): 10 requests por IP cada 15 minutos.
 */

export const LIMITE_POR_VENTANA = 10;
export const VENTANA_MS = 15 * 60 * 1000;

/** Transcripcion textual, en voseo como el resto del sistema. */
export const ERROR_RATE_LIMIT = 'Demasiados intentos. Intentá más tarde.';

/**
 * IP del cliente.
 *
 * `CF-Connecting-IP` lo pone Cloudflare y no se puede falsificar desde afuera:
 * el borde lo sobrescribe. `X-Forwarded-For` SI se puede, asi que no se usa.
 *
 * Sin header — solo pasa en tests o en dev local — se cae a una clave fija.
 * Comparten cupo entre si, que es lo correcto: es preferible a que cada
 * request sin IP tenga cupo propio y el limite no exista.
 */
export function ipDelCliente(c: Context): string {
  return c.req.header('cf-connecting-ip') ?? 'sin-ip';
}

/**
 * Un DO por `{ip}:{endpoint}`.
 *
 * El endpoint va en la clave para que el cupo del login y el de las reservas
 * sean independientes: agotar uno no puede dejar sin servicio al otro.
 */
function contador(env: Env, ip: string, endpoint: string) {
  return env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`${ip}:${endpoint}`));
}

/** Segundos hasta el reinicio, para el header `Retry-After`. */
const retryAfter = (estado: EstadoLimite): string =>
  String(Math.max(1, Math.ceil(estado.resetEnMs / 1000)));

function respuesta429(c: Context, estado: EstadoLimite): Response {
  return c.json(fail(ERROR_RATE_LIMIT), 429, { 'Retry-After': retryAfter(estado) });
}

/**
 * Consume cupo en CADA request. Para endpoints donde el request en si es el
 * costo, como la creacion de reservas.
 */
export const limitarPorIp = (endpoint: string, limite = LIMITE_POR_VENTANA) =>
  createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const estado = await contador(c.env, ipDelCliente(c), endpoint).consumir(
      limite,
      VENTANA_MS,
      Date.now(),
    );

    if (!estado.permitido) return respuesta429(c, estado);
    await next();
  });

/**
 * Rate limit de intentos FALLIDOS.
 *
 * El cupo NO se consume al entrar: solo cuando el handler avisa que el intento
 * fallo. Un login correcto no gasta nada, asi que alguien que se loguea diez
 * veces al dia no se autobloquea.
 *
 * El chequeo previo si es necesario: si ya se paso, hay que rechazarlo ANTES
 * de gastar los 3,8 ms de CPU de verificar la password.
 *
 * El handler llama a `c.get('registrarFallo')()` en su camino de error.
 */
export interface VariablesRateLimit {
  registrarFallo: () => Promise<void>;
}

export const limitarFallosPorIp = (endpoint: string, limite = LIMITE_POR_VENTANA) =>
  createMiddleware<{ Bindings: Env; Variables: VariablesRateLimit }>(async (c, next) => {
    const stub = contador(c.env, ipDelCliente(c), endpoint);

    const previo = await stub.chequear(limite, VENTANA_MS, Date.now());
    if (!previo.permitido) return respuesta429(c, previo);

    c.set('registrarFallo', async () => {
      await stub.consumir(limite, VENTANA_MS, Date.now());
    });

    await next();
  });
