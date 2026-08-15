import { Hono } from 'hono';

/**
 * Rutas publicas (cliente anonimo): barberos, servicios, disponibilidad, reserva.
 * Fase 2, tareas 2.2 a 2.4.
 */
export const publicRoutes = new Hono<{ Bindings: Env }>();
