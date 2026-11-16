import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { testUrls } from './test-env';

/**
 * Aplica las migraciones pendientes en `vektra_test` (no destructivo).
 * Cada ejecución crea empresas con RUC/correos únicos, así no hace falta borrar datos.
 */
export default function setup(): void {
  const { ownerUrl } = testUrls();
  execFileSync(resolve('node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: resolve('libs/db'),
    env: { ...process.env, DATABASE_OWNER_URL: ownerUrl },
    stdio: 'pipe',
  });
}
