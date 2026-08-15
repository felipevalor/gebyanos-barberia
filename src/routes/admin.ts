import { Hono } from 'hono';

/**
 * Panel de administracion (roles `barbero` y `owner`).
 * Fase 2 (auth y agenda) y Fase 3 (configuracion).
 */
export const adminRoutes = new Hono<{ Bindings: Env }>();
