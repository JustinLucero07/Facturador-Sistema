import { generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';

/** Genera un .p12 autofirmado para pruebas (estructura similar a los emitidos por ECI de Ecuador). */
export function createTestP12(password: string, opts: { days?: number; cn?: string } = {}): Buffer {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const fKey = forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }).toString());
  const fPub = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }).toString());

  const cert = forge.pki.createCertificate();
  cert.publicKey = fPub;
  cert.serialNumber = '4ec3a1f2';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + (opts.days ?? 365) * 86_400_000);
  const subject = [
    { name: 'countryName', value: 'EC' },
    { name: 'organizationName', value: 'VEKTRA PRUEBAS' },
    { name: 'commonName', value: opts.cn ?? 'JUAN PEREZ PRUEBAS' },
  ];
  const issuer = [
    { name: 'countryName', value: 'EC' },
    { name: 'organizationName', value: 'ENTIDAD DE PRUEBA, S.A.' },
    { name: 'organizationalUnitName', value: 'ENTIDAD DE CERTIFICACION DE INFORMACION' },
    { name: 'commonName', value: 'AC PRUEBAS VEKTRA' },
  ];
  cert.setSubject(subject);
  cert.setIssuer(issuer);
  cert.setExtensions([{ name: 'keyUsage', digitalSignature: true, nonRepudiation: true }]);
  cert.sign(fKey, forge.md.sha256.create());

  const p12 = forge.pkcs12.toPkcs12Asn1(fKey, [cert], password, { algorithm: '3des', friendlyName: 'Signing Key' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
}
