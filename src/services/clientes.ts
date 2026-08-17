import { and, eq, sql, desc, asc, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { clientes, reservas } from '../db/schema';
import { uuidv7 } from '../db/id';
import { normalizeTel, esTelefonoArgentino } from '../domain/phone';
import { esViolacionDeUnico } from '../db/errores';

/**
 * Clientes del panel.
 *
 * SCOPING: un `barbero` ve solo los clientes que atendio al menos una vez; un
 * `owner` ve todos. La pertenencia sale de las reservas, no de una columna:
 * un cliente no "es de" nadie, simplemente hay turnos que lo vinculan.
 */

export const LIMITE_LISTADO = 100;
export const LIMITE_HISTORIAL = 200;
export const LIMITE_EXPORT = 10_000;
export const MAX_FILAS_IMPORT_CLIENTES = 1_000;

export const ERROR_CLIENTE_NO_ENCONTRADO = 'Cliente no encontrado.';
export const ERROR_SOLO_OWNER_CLIENTES = 'Solo los dueños pueden crear clientes.';
export const ERROR_SOLO_OWNER_IMPORT_CLIENTES = 'Solo los dueños pueden importar clientes.';
export const ERROR_LOTE_CLIENTES = `No se pueden importar más de ${MAX_FILAS_IMPORT_CLIENTES} clientes por vez.`;
export const ERROR_TELEFONO_DUPLICADO = 'Ya existe un cliente con ese teléfono.';

export interface ClienteDelPanel {
  id: string;
  nombre: string;
  telefono: string | null;
  email: string | null;
  notas: string | null;
  createdAt: string;
}

const columnas = {
  id: clientes.id,
  nombre: clientes.nombre,
  telefono: clientes.telefono,
  email: clientes.email,
  notas: clientes.notas,
  createdAt: clientes.createdAt,
};

/**
 * Condicion de pertenencia para un `barbero`: el cliente tiene al menos una
 * reserva con él. Para `owner` (barberoId null) no filtra.
 */
const atendidoPor = (barberoId: string | null) =>
  barberoId
    ? sql`EXISTS (SELECT 1 FROM reservas r WHERE r.cliente_id = ${clientes.id} AND r.barbero_id = ${barberoId})`
    : undefined;

export interface ListadoClientes {
  items: ClienteDelPanel[];
  total: number;
  skip: number;
  limit: number;
}

export async function listarClientes(
  env: Env,
  filtros: { barberoId: string | null; skip?: number | undefined; limit?: number | undefined },
): Promise<ListadoClientes> {
  const skip = Math.max(0, Math.trunc(filtros.skip ?? 0));
  const limit = Math.min(LIMITE_LISTADO, Math.max(1, Math.trunc(filtros.limit ?? LIMITE_LISTADO)));

  const donde = atendidoPor(filtros.barberoId);
  const cliente = db(env.DB);

  const [items, conteo] = await Promise.all([
    cliente
      .select(columnas)
      .from(clientes)
      .where(donde)
      .orderBy(asc(clientes.nombre))
      .limit(limit)
      .offset(skip),
    cliente.select({ n: sql<number>`count(*)` }).from(clientes).where(donde),
  ]);

  return { items, total: conteo[0]?.n ?? 0, skip, limit };
}

/** Todos los clientes visibles, para el export. Sin paginar pero con tope. */
export async function clientesParaExportar(
  env: Env,
  barberoId: string | null,
): Promise<ClienteDelPanel[]> {
  return db(env.DB)
    .select(columnas)
    .from(clientes)
    .where(atendidoPor(barberoId))
    .orderBy(asc(clientes.nombre))
    .limit(LIMITE_EXPORT);
}

export async function buscarCliente(
  env: Env,
  id: string,
  barberoId: string | null,
): Promise<ClienteDelPanel | null> {
  const condiciones = [eq(clientes.id, id)];
  const pertenencia = atendidoPor(barberoId);
  if (pertenencia) condiciones.push(pertenencia);

  const filas = await db(env.DB)
    .select(columnas)
    .from(clientes)
    .where(and(...condiciones))
    .limit(1);

  return filas[0] ?? null;
}

export interface TurnoDelHistorial {
  id: string;
  fecha: string;
  hora: string;
  servicio: string;
  estado: string;
  barberoId: string | null;
}

/**
 * Historial de turnos de un cliente.
 *
 * Un `barbero` ve solo los turnos que le corresponden a él, no todo el
 * historial del cliente con otros barberos.
 */
export async function historialDeCliente(
  env: Env,
  clienteId: string,
  filtros: { barberoId: string | null; skip?: number | undefined; limit?: number | undefined },
): Promise<{ items: TurnoDelHistorial[]; total: number; skip: number; limit: number }> {
  const skip = Math.max(0, Math.trunc(filtros.skip ?? 0));
  const limit = Math.min(
    LIMITE_HISTORIAL,
    Math.max(1, Math.trunc(filtros.limit ?? LIMITE_HISTORIAL)),
  );

  const condiciones = [eq(reservas.clienteId, clienteId), eq(reservas.tipo, 'turno')];
  if (filtros.barberoId) condiciones.push(eq(reservas.barberoId, filtros.barberoId));
  const donde = and(...condiciones);

  const cliente = db(env.DB);

  const [items, conteo] = await Promise.all([
    cliente
      .select({
        id: reservas.id,
        fecha: reservas.fecha,
        hora: reservas.hora,
        servicio: reservas.servicio,
        estado: reservas.estado,
        barberoId: reservas.barberoId,
      })
      .from(reservas)
      .where(donde)
      .orderBy(desc(reservas.fecha), desc(reservas.hora))
      .limit(limit)
      .offset(skip),
    cliente.select({ n: sql<number>`count(*)` }).from(reservas).where(donde),
  ]);

  return { items, total: conteo[0]?.n ?? 0, skip, limit };
}

// -------------------------------------------------------------- escritura

export type ResultadoAlta =
  | { estado: 'exito'; cliente: ClienteDelPanel }
  | { estado: 'datosInvalidos'; error: string }
  | { estado: 'duplicado'; error: string };

export async function crearCliente(
  env: Env,
  datos: { nombre?: unknown; telefono?: unknown; email?: unknown; notas?: unknown },
): Promise<ResultadoAlta> {
  const nombre = typeof datos.nombre === 'string' ? datos.nombre.trim() : '';
  const telefonoCrudo = typeof datos.telefono === 'string' ? datos.telefono.trim() : '';

  if (!nombre) return { estado: 'datosInvalidos', error: 'El nombre es obligatorio.' };
  if (nombre.length > 100) {
    return { estado: 'datosInvalidos', error: 'El nombre no puede superar los 100 caracteres.' };
  }

  // El telefono es opcional, pero si viene tiene que ser valido: es la clave
  // con la que se deduplica y con la que se manda el WhatsApp.
  let telefono: string | null = null;
  if (telefonoCrudo) {
    if (!esTelefonoArgentino(telefonoCrudo)) {
      return {
        estado: 'datosInvalidos',
        error: 'Revisá el teléfono. Tiene que ser un número argentino válido con código de área.',
      };
    }
    telefono = normalizeTel(telefonoCrudo);
  }

  const ahora = new Date().toISOString();
  const id = uuidv7();

  try {
    await db(env.DB)
      .insert(clientes)
      .values({
        id,
        nombre,
        telefono,
        email: typeof datos.email === 'string' ? datos.email.trim() || null : null,
        notas: typeof datos.notas === 'string' ? datos.notas.trim() || null : null,
        createdAt: ahora,
        updatedAt: ahora,
      });
  } catch (e) {
    // El unico parcial sobre clientes.telefono.
    //
    // ⚠️ `esViolacionDeUnico` recorre la cadena de `cause`: Drizzle envuelve el
    // error de D1 y su `.message` no menciona el constraint. Un chequeo directo
    // sobre el mensaje devolveria 500 en vez de este 400.
    if (esViolacionDeUnico(e)) {
      return { estado: 'duplicado', error: ERROR_TELEFONO_DUPLICADO };
    }
    throw e;
  }

  return {
    estado: 'exito',
    cliente: {
      id,
      nombre,
      telefono,
      email: typeof datos.email === 'string' ? datos.email.trim() || null : null,
      notas: typeof datos.notas === 'string' ? datos.notas.trim() || null : null,
      createdAt: ahora,
    },
  };
}

export interface ResultadoImportClientes {
  importados: number;
  salteados: number;
  errores: { fila: number; motivo: string }[];
}

/**
 * Import masivo con DEDUP POR TELEFONO NORMALIZADO.
 *
 * "0341 15 6513207" y "+54 9 341 651-3207" son el mismo cliente: si entraran
 * dos veces, el sistema los trataria como personas distintas.
 *
 * ⚠️ QUIEN GARANTIZA EL DEDUP ES EL INDICE UNICO, no este pre-chequeo.
 *
 * `crearCliente` normaliza el telefono antes de insertar, asi que un duplicado
 * escrito distinto choca contra `idx_clientes_telefono` y vuelve como
 * `duplicado`. El pre-chequeo de abajo solo evita el viaje: sin él el
 * resultado es el mismo, con N inserts fallidos de mas.
 *
 * Verificado por mutacion: sacando la normalizacion del pre-chequeo, los tests
 * siguen en verde — porque la correccion no depende de él.
 *
 * Los telefonos ya existentes se cuentan como SALTEADOS, no como error: en una
 * planilla exportada de otro sistema es lo normal, no una falla.
 */
export async function importarClientes(
  env: Env,
  filas: unknown[],
): Promise<ResultadoImportClientes> {
  const errores: { fila: number; motivo: string }[] = [];
  let importados = 0;
  let salteados = 0;

  // Los telefonos que ya existen, de una. Evita una query por fila.
  const normalizados = filas.map((f) =>
    f && typeof f === 'object' ? normalizeTel(String((f as { telefono?: unknown }).telefono ?? '')) : '',
  );
  const candidatos = [...new Set(normalizados.filter(Boolean))];

  // ⚠️ EN LOTES DE 100. SQLite tiene un tope de variables por sentencia, y un
  // `IN (...)` con 1.000 telefonos lo pasa: la query explota justo en el import
  // grande, que es el unico caso donde importa.
  const TAMANIO_LOTE = 100;
  const yaExisten = new Set<string>();

  for (let i = 0; i < candidatos.length; i += TAMANIO_LOTE) {
    const lote = candidatos.slice(i, i + TAMANIO_LOTE);
    const filasExistentes = await db(env.DB)
      .select({ telefono: clientes.telefono })
      .from(clientes)
      .where(inArray(clientes.telefono, lote));

    for (const f of filasExistentes) if (f.telefono) yaExisten.add(f.telefono);
  }

  for (let i = 0; i < filas.length; i++) {
    const fila = filas[i];
    if (!fila || typeof fila !== 'object') {
      errores.push({ fila: i + 1, motivo: 'La fila no es un objeto.' });
      continue;
    }

    const telefono = normalizados[i]!;

    // Duplicado dentro del propio lote, o ya en la base.
    if (telefono && yaExisten.has(telefono)) {
      salteados += 1;
      continue;
    }

    const resultado = await crearCliente(env, fila as Record<string, unknown>);

    if (resultado.estado === 'exito') {
      importados += 1;
      if (telefono) yaExisten.add(telefono);
    } else if (resultado.estado === 'duplicado') {
      salteados += 1;
    } else {
      errores.push({ fila: i + 1, motivo: resultado.error });
    }
  }

  return { importados, salteados, errores };
}

// ------------------------------------------------------------------- CSV

/**
 * Escapa un campo CSV.
 *
 * Se citan SIEMPRE: un nombre con coma, con comillas o con salto de linea
 * rompe el archivo, y "López, Juan" es un nombre perfectamente normal.
 */
const campoCsv = (v: string | null): string => `"${(v ?? '').replaceAll('"', '""')}"`;

/**
 * CSV de clientes, listo para abrir en Excel.
 *
 * Dos decisiones que parecen detalles y no lo son:
 *
 *  - **BOM UTF-8 al principio.** Sin él, Excel en Windows abre el archivo en
 *    la codificacion local y "Pérez" se ve como "PÃ©rez".
 *  - **Separador `;`, no coma.** Excel en configuracion regional en español
 *    espera punto y coma; con coma mete todo en una sola columna.
 */
export function clientesACsv(lista: ClienteDelPanel[]): string {
  const encabezado = ['Nombre', 'Teléfono', 'Email', 'Notas', 'Alta'];
  const filas = lista.map((c) =>
    [c.nombre, c.telefono, c.email, c.notas, c.createdAt.slice(0, 10)].map(campoCsv).join(';'),
  );

  return '﻿' + [encabezado.map(campoCsv).join(';'), ...filas].join('\r\n') + '\r\n';
}
