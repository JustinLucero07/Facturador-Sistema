import { config } from 'dotenv';
import { join } from 'node:path';
import { defineConfig } from 'prisma/config';

config({ path: join(__dirname, '../../.env'), quiet: true });

// Las migraciones se ejecutan con el usuario DUEÑO del esquema (DATABASE_OWNER_URL).
// La aplicación se conecta con `vektra_app` (DATABASE_URL), que no puede saltarse RLS.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: '../../node_modules/.bin/tsx --tsconfig tsconfig.lib.json prisma/seed.ts',
  },
  datasource: {
    url: process.env['DATABASE_OWNER_URL'] ?? '',
  },
});
