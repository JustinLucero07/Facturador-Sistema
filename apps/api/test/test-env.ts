import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export function testUrls() {
  const owner = process.env['DATABASE_OWNER_URL'];
  const app = process.env['DATABASE_URL'];
  if (!owner || !app) throw new Error('Configure DATABASE_OWNER_URL y DATABASE_URL en .env');
  return { ownerUrl: withDb(owner, 'vektra_test'), appUrl: withDb(app, 'vektra_test') };
}

/** Variables para la app bajo prueba: base de pruebas, sin llave de licencia (modo desarrollo). */
export function applyTestEnv(overrides: Record<string, string> = {}): void {
  const { appUrl } = testUrls();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: appUrl,
    LICENSE_PUBLIC_KEY: '',
    INSTALLATION_ID: '',
    AUTH_MAX_FAILED_ATTEMPTS: '5',
    AUTH_LOCK_MINUTES: '15',
    REDIS_URL: 'redis://127.0.0.1:6390/5',
    ...overrides,
  });
}
