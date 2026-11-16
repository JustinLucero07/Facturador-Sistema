import forge from 'node-forge';

/**
 * Lectura del certificado de firma electrónica (.p12 / PKCS#12) emitido por las ECI de Ecuador
 * (Banco Central, Security Data, ANF, Uanataca, etc.). node-forge soporta los cifrados heredados
 * (3DES/RC2) que usan muchos .p12 y que OpenSSL 3 ya no habilita por defecto.
 */
export interface SigningIdentity {
  privateKeyPem: string;
  /** Certificado en DER codificado en base64 (sin saltos de línea). */
  certificateBase64: string;
  /** Nombre del emisor en formato RFC 2253 (para X509IssuerName). */
  issuerName: string;
  /** Número de serie en decimal (para X509SerialNumber). */
  serialNumber: string;
  modulusBase64: string;
  exponentBase64: string;
  subject: string;
  /** Cédula/RUC del titular si el certificado la incluye (OID 1.3.6.1.4.1.37746.3.x u otros). */
  holderName: string;
  notBefore: Date;
  notAfter: Date;
}

export class CertificateError extends Error {}

const RFC2253_SHORT: Record<string, string> = {
  commonName: 'CN',
  countryName: 'C',
  localityName: 'L',
  stateOrProvinceName: 'ST',
  organizationName: 'O',
  organizationalUnitName: 'OU',
  streetAddress: 'STREET',
  domainComponent: 'DC',
  userId: 'UID',
};

function escapeRfc2253(v: string): string {
  let s = v.replace(/([,+"\\<>;])/g, '\\$1');
  if (s.startsWith('#') || s.startsWith(' ')) s = `\\${s}`;
  if (s.endsWith(' ')) s = `${s.slice(0, -1)}\\ `;
  return s;
}

/** RFC 2253: atributos en orden inverso al ASN.1, separados por coma. */
export function rfc2253(attrs: forge.pki.CertificateField[]): string {
  return [...attrs]
    .reverse()
    .map((a) => {
      const key = (a.name && RFC2253_SHORT[a.name]) ?? a.shortName ?? a.type ?? '';
      const value = Array.isArray(a.value) ? a.value.join('') : String(a.value ?? '');
      return `${key}=${escapeRfc2253(value)}`;
    })
    .join(',');
}

function bigIntegerToBase64(n: forge.jsbn.BigInteger): string {
  let bytes = n.toByteArray();
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.slice(1);
  return Buffer.from(bytes.map((b) => b & 0xff)).toString('base64');
}

function hasDigitalSignature(cert: forge.pki.Certificate): boolean {
  const ku = cert.getExtension('keyUsage') as { digitalSignature?: boolean; nonRepudiation?: boolean } | null;
  return !ku || !!ku.digitalSignature || !!ku.nonRepudiation;
}

export function loadP12(p12: Buffer | Uint8Array, password: string): SigningIdentity {
  let parsed: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(p12).toString('binary')));
    parsed = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (/mac|password|invalid/i.test(msg)) throw new CertificateError('La contraseña de la firma electrónica es incorrecta');
    throw new CertificateError('El archivo no es un certificado .p12 válido');
  }

  const keys: forge.pki.rsa.PrivateKey[] = [];
  for (const type of [forge.pki.oids['pkcs8ShroudedKeyBag'], forge.pki.oids['keyBag']]) {
    for (const bag of parsed.getBags({ bagType: type })[type] ?? []) if (bag.key) keys.push(bag.key as forge.pki.rsa.PrivateKey);
  }
  const certs = (parsed.getBags({ bagType: forge.pki.oids['certBag'] })[forge.pki.oids['certBag']] ?? [])
    .map((b) => b.cert)
    .filter((c): c is forge.pki.Certificate => !!c);
  if (keys.length === 0) throw new CertificateError('El .p12 no contiene la clave privada');

  // Emparejar clave privada ↔ certificado por el módulo RSA; preferir el certificado de firma.
  const candidates: { key: forge.pki.rsa.PrivateKey; cert: forge.pki.Certificate }[] = [];
  for (const key of keys) {
    for (const cert of certs) {
      const pub = cert.publicKey as forge.pki.rsa.PublicKey;
      if (pub.n && pub.n.equals(key.n)) candidates.push({ key, cert });
    }
  }
  if (candidates.length === 0) throw new CertificateError('El .p12 no contiene el certificado que corresponde a la clave privada');
  const chosen = candidates.find((c) => hasDigitalSignature(c.cert)) ?? candidates[0];

  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(chosen.cert)).getBytes();
  const pub = chosen.cert.publicKey as forge.pki.rsa.PublicKey;
  const cn = chosen.cert.subject.getField('CN');
  return {
    privateKeyPem: forge.pki.privateKeyToPem(chosen.key),
    certificateBase64: Buffer.from(der, 'binary').toString('base64'),
    issuerName: rfc2253(chosen.cert.issuer.attributes),
    serialNumber: BigInt(`0x${chosen.cert.serialNumber}`).toString(10),
    modulusBase64: bigIntegerToBase64(pub.n),
    exponentBase64: bigIntegerToBase64(pub.e),
    subject: rfc2253(chosen.cert.subject.attributes),
    holderName: cn ? String(cn.value) : '',
    notBefore: chosen.cert.validity.notBefore,
    notAfter: chosen.cert.validity.notAfter,
  };
}
