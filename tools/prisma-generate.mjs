// Genera los clientes Prisma de la instancia y del Hub (postinstall y `pnpm db:generate`).
// Si un esquema no existe (p. ej. en la etapa `deps` de Docker) se omite sin fallar.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const prisma = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma');

for (const lib of ['libs/db', 'libs/hub-db']) {
  const cwd = join(root, lib);
  if (!existsSync(join(cwd, 'prisma', 'schema.prisma')) || !existsSync(prisma)) {
    console.log(`[prisma-generate] se omite ${lib}`);
    continue;
  }
  execFileSync(prisma, ['generate'], { cwd, stdio: 'inherit' });
}
