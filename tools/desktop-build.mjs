// Compila la caja de escritorio (proceso principal + preload) en dist/apps/desktop/app.
// Uso: node tools/desktop-build.mjs [--production]
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist/apps/desktop/app');
const production = process.argv.includes('--production');
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  tsconfig: resolve(root, 'tsconfig.base.json'),
  sourcemap: production ? false : 'inline',
  minify: production,
  legalComments: 'none',
  logLevel: 'warning',
};

await build({ ...common, entryPoints: [resolve(root, 'apps/desktop/src/main.ts')], outfile: resolve(out, 'main.js') });
await build({ ...common, entryPoints: [resolve(root, 'apps/desktop/src/preload.ts')], outfile: resolve(out, 'preload.js') });

const pkg = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8'));
writeFileSync(resolve(out, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, author: pkg.author, main: 'main.js' }, null, 2));
console.log(`Caja de escritorio compilada en ${out}`);
