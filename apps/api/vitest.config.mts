import { nestVitestConfig } from '../../tools/vitest-nest.mts';

export default nestVitestConfig({ include: ['apps/api/src/**/*.spec.ts'] });
