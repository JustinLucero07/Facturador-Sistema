// Empaqueta los XSD de libs/sri-core/xsd en un módulo TS (funciona igual en la API, el worker y Electron).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'libs', 'sri-core', 'xsd');
const files = readdirSync(dir).filter((f) => f.endsWith('.xsd')).sort();
const body = files.map((f) => `  ${JSON.stringify(f)}: ${JSON.stringify(readFileSync(join(dir, f), 'utf8'))},`).join('\n');
const out = `// GENERADO por tools/xsd-bundle.mjs — no editar. Fuente: libs/sri-core/xsd/*.xsd\n/* eslint-disable */\nexport const XSD_FILES: Record<string, string> = {\n${body}\n};\n`;
writeFileSync(join(import.meta.dirname, '..', 'libs', 'sri-core', 'src', 'lib', 'xsd', 'bundle.generated.ts'), out);
console.log(`XSD empaquetados: ${files.join(', ')}`);
