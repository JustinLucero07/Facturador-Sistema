// Genera el par de llaves Ed25519 del Vektra Hub para firmar licencias.
// La privada va SOLO en el Hub (LICENSE_PRIVATE_KEY); la pública en cada instancia (LICENSE_PUBLIC_KEY).
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const oneLine = (pem) => pem.trim().replace(/\n/g, '\\n');

console.log(`LICENSE_PRIVATE_KEY="${oneLine(privateKey.export({ type: 'pkcs8', format: 'pem' }))}"`);
console.log(`LICENSE_PUBLIC_KEY="${oneLine(publicKey.export({ type: 'spki', format: 'pem' }))}"`);
