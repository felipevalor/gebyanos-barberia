import { Hono } from 'hono';

/**
 * Autogestion del cliente sin cuenta, via magic link firmado.
 * Fase 5, tarea 5.1.
 */
export const miTurnoRoutes = new Hono<{ Bindings: Env }>();
