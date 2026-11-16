import { nestVitestConfig } from '../../tools/vitest-nest.mts';

// Pruebas contra PostgreSQL real (base vektra_test). Requiere `docker compose -f docker-compose.dev.yml up -d`.
export default nestVitestConfig({
  include: ['apps/api/test/**/*.e2e-spec.ts'],
  globalSetup: 'apps/api/test/global-setup.ts',
  sequential: true,
  testTimeout: 30_000,
});
