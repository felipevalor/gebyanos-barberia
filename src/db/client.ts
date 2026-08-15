import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

/** Cliente Drizzle sobre el binding de D1. */
export const db = (d1: D1Database) => drizzle(d1, { schema });

export type Db = ReturnType<typeof db>;
