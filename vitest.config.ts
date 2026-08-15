import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// Las migraciones se leen del disco y se inyectan como binding, para que los
// tests puedan levantar el schema con `applyD1Migrations(env.DB, env.MIGRATIONS)`.
const migrations = await readD1Migrations('./src/db/migrations');

export default defineConfig({
  plugins: [
    // Corre los tests dentro del runtime real de Workers (workerd),
    // con los bindings declarados en wrangler.jsonc.
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: { MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
