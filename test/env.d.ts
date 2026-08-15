/**
 * Bindings que solo existen en los tests (ver vitest.config.ts).
 * Los de produccion los genera `wrangler types` en worker-configuration.d.ts.
 */
declare namespace Cloudflare {
  interface Env {
    /** Migraciones leidas de src/db/migrations, para applyD1Migrations(). */
    MIGRATIONS: { name: string; queries: string[] }[];
  }
}
