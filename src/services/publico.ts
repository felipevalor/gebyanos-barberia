import { eq, asc } from 'drizzle-orm';
import { db } from '../db/client';
import { barberos, servicios, promos, catalogo, negocio } from '../db/schema';

/**
 * Lecturas publicas: negocio, barberos, servicios, promos y catalogo.
 *
 * NO pasan por el Durable Object. El DO serializa las ESCRITURAS de reservas
 * de un barbero; serializar consultas de solo lectura seria un cuello de
 * botella sin ninguna ventaja.
 *
 * PRECIOS: se guardan en centavos como INTEGER y se exponen en centavos, con
 * el nombre `precioCentavos`. Nunca se convierte a pesos acá — el formateo es
 * del frontend. Ver docs/convenciones-api.md.
 *
 * Cada funcion selecciona las columnas de forma explicita: `barberos` tiene
 * `password_hash` y `callmebot_apikey`, que no pueden salir nunca por un
 * endpoint anonimo.
 */

export interface NegocioDto {
  nombreNegocio: string;
  slotDuracionMin: number;
  minutosAnticipacionMin: number;
  diasMaxAnticipacion: number;
  logoUrl: string | null;
  colorPrimario: string | null;
  colorSecundario: string | null;
}

export interface BarberoDto {
  id: string;
  slug: string;
  nombre: string;
  orden: number;
}

export interface ServicioDto {
  id: string;
  nombre: string;
  duracionMin: number;
  precioCentavos: number | null;
  incluye: string | null;
  orden: number;
}

export interface PromoDto {
  id: string;
  nombre: string;
  precioCentavos: number | null;
  unidad: string | null;
  nota: string | null;
  badge: string | null;
  orden: number;
}

export interface CatalogoDto {
  id: string;
  nombre: string;
  incluye: string;
  precioCentavos: number | null;
  orden: number;
}

/** Fila unica de configuracion. `null` si todavia no se sembro la base. */
export async function getNegocio(d1: D1Database): Promise<NegocioDto | null> {
  const filas = await db(d1)
    .select({
      nombreNegocio: negocio.nombreNegocio,
      slotDuracionMin: negocio.slotDuracionMin,
      minutosAnticipacionMin: negocio.minutosAnticipacionMin,
      diasMaxAnticipacion: negocio.diasMaxAnticipacion,
      logoUrl: negocio.logoUrl,
      colorPrimario: negocio.colorPrimario,
      colorSecundario: negocio.colorSecundario,
    })
    .from(negocio)
    .where(eq(negocio.id, 1))
    .limit(1);

  return filas[0] ?? null;
}

export async function listarBarberos(d1: D1Database): Promise<BarberoDto[]> {
  return db(d1)
    .select({
      id: barberos.id,
      slug: barberos.slug,
      nombre: barberos.nombre,
      orden: barberos.orden,
    })
    .from(barberos)
    .where(eq(barberos.activo, 1))
    .orderBy(asc(barberos.orden), asc(barberos.nombre));
}

export async function listarServicios(d1: D1Database): Promise<ServicioDto[]> {
  return db(d1)
    .select({
      id: servicios.id,
      nombre: servicios.nombre,
      duracionMin: servicios.duracionMin,
      precioCentavos: servicios.precioCentavos,
      incluye: servicios.incluye,
      orden: servicios.orden,
    })
    .from(servicios)
    .where(eq(servicios.activo, 1))
    .orderBy(asc(servicios.orden), asc(servicios.nombre));
}

export async function listarPromos(d1: D1Database): Promise<PromoDto[]> {
  return db(d1)
    .select({
      id: promos.id,
      nombre: promos.nombre,
      precioCentavos: promos.precioCentavos,
      unidad: promos.unidad,
      nota: promos.nota,
      badge: promos.badge,
      orden: promos.orden,
    })
    .from(promos)
    .where(eq(promos.activo, 1))
    .orderBy(asc(promos.orden), asc(promos.nombre));
}

export async function listarCatalogo(d1: D1Database): Promise<CatalogoDto[]> {
  return db(d1)
    .select({
      id: catalogo.id,
      nombre: catalogo.nombre,
      incluye: catalogo.incluye,
      precioCentavos: catalogo.precioCentavos,
      orden: catalogo.orden,
    })
    .from(catalogo)
    .where(eq(catalogo.activo, 1))
    .orderBy(asc(catalogo.orden), asc(catalogo.nombre));
}
