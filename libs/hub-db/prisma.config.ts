import { config } from 'dotenv';
import { join } from 'node:path';
import { defineConfig } from 'prisma/config';

config({ path: join(__dirname, '../../.env'), quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: '../../node_modules/.bin/tsx --tsconfig tsconfig.lib.json prisma/seed.ts',
  },
  datasource: {
    url: process.env['HUB_DATABASE_OWNER_URL'] ?? '',
  },
});
