// Configuración Vitest compartida para apps NestJS (api, hub-api, worker).
// NestJS 12 es ESM y Jest no lo soporta; SWC emite los metadatos de decoradores que Nest necesita.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const root = resolve(import.meta.dirname, '..');
const paths: Record<string, string[]> = JSON.parse(readFileSync(resolve(root, 'tsconfig.base.json'), 'utf8')).compilerOptions.paths;
const alias = Object.fromEntries(Object.entries(paths).map(([k, [v]]) => [k, resolve(root, v)]));

export function nestVitestConfig(opts: { include: string[]; globalSetup?: string; sequential?: boolean; testTimeout?: number }) {
  return defineConfig({
    root,
    plugins: [swc.vite({ module: { type: 'es6' }, jsc: { target: 'es2022', parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } } })],
    resolve: { alias },
    test: {
      globals: true,
      environment: 'node',
      include: opts.include,
      globalSetup: opts.globalSetup,
      fileParallelism: !opts.sequential,
      testTimeout: opts.testTimeout ?? 15_000,
      hookTimeout: 60_000,
    },
  });
}
