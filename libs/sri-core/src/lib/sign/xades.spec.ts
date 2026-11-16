import { DOMParser } from '@xmldom/xmldom';
import { createVerify } from 'node:crypto';
import forge from 'node-forge';
import { SignedXml } from 'xml-crypto';
import { createTestP12 } from '../testing/test-p12';
import { sampleInvoice } from '../testing/fixtures';
import { buildInvoiceXml } from '../xml/invoice';
import { validateAgainstXsd } from '../xsd/validate';
import { CertificateError, loadP12 } from './p12';
import { ecuadorIso, NS_DS, signXades } from './xades';

const PASSWORD = 'clave-de-prueba';
const p12 = createTestP12(PASSWORD);
const identity = loadP12(p12, PASSWORD);
const certPem = () => forge.pki.certificateToPem(forge.pki.certificateFromAsn1(forge.asn1.fromDer(Buffer.from(identity.certificateBase64, 'base64').toString('binary'))));

function verifyWithXmlCrypto(signed: string): boolean {
  const doc = new DOMParser().parseFromString(signed, 'text/xml');
  const sigNode = doc.getElementsByTagNameNS(NS_DS, 'Signature')[0];
  const verifier = new SignedXml({ publicCert: certPem(), getCertFromKeyInfo: () => null });
  verifier.loadSignature(sigNode as unknown as Node);
  try {
    return verifier.checkSignature(signed);
  } catch {
    return false;
  }
}

describe('loadP12', () => {
  it('lee clave y certificado', () => {
    expect(identity.holderName).toBe('JUAN PEREZ PRUEBAS');
    expect(identity.serialNumber).toBe(String(0x4ec3a1f2));
    // RFC 2253: orden inverso y comas escapadas
    expect(identity.issuerName).toBe('CN=AC PRUEBAS VEKTRA,OU=ENTIDAD DE CERTIFICACION DE INFORMACION,O=ENTIDAD DE PRUEBA\\, S.A.,C=EC');
    expect(identity.exponentBase64).toBe('AQAB');
    expect(identity.notAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it('contraseña incorrecta → mensaje claro', () => {
    expect(() => loadP12(p12, 'otra')).toThrow(CertificateError);
    expect(() => loadP12(p12, 'otra')).toThrow(/contraseña/);
  });

  it('archivo inválido', () => {
    expect(() => loadP12(Buffer.from('no es un p12'), 'x')).toThrow(/no es un certificado/);
  });
});

describe('signXades', () => {
  const xml = buildInvoiceXml(sampleInvoice());
  const signed = signXades(xml, identity, { signingTime: new Date('2026-11-16T15:00:00Z') });

  it('estructura del Anexo 14: enveloped, RSA-SHA1, C14N, 3 referencias', () => {
    expect(signed.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<factura id="comprobante" version="1.1.0">')).toBe(true);
    expect(signed).toMatch(/<ds:Signature xmlns:ds="http:\/\/www.w3.org\/2000\/09\/xmldsig#" xmlns:etsi="http:\/\/uri.etsi.org\/01903\/v1.3.2#" Id="Signature\d+">/);
    expect(signed).toContain('<ds:SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1">');
    expect(signed).toContain('<ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315">');
    expect(signed).toContain('<ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature">');
    expect(signed.match(/<ds:Reference /g)).toHaveLength(3);
    expect(signed).toContain('<etsi:SigningTime>2026-11-16T10:00:00-05:00</etsi:SigningTime>');
    expect(signed.endsWith('</ds:Signature></factura>')).toBe(true);
  });

  it('la firma la verifica una implementación independiente (xml-crypto)', () => {
    expect(verifyWithXmlCrypto(signed)).toBe(true);
  });

  it('detecta cualquier alteración del comprobante', () => {
    expect(verifyWithXmlCrypto(signed.replace('<importeTotal>', '<importeTotal>1'))).toBe(false);
  });

  it('detecta alteración de las propiedades firmadas (SigningTime)', () => {
    expect(verifyWithXmlCrypto(signed.replace('2026-11-16T10:00:00-05:00', '2026-11-17T10:00:00-05:00'))).toBe(false);
  });

  it('SignatureValue corresponde al certificado del KeyInfo (verificación RSA directa)', () => {
    const signedInfo = /<ds:SignedInfo[\s\S]*?<\/ds:SignedInfo>/.exec(signed)?.[0] ?? '';
    const canonical = signedInfo.replace('<ds:SignedInfo ', `<ds:SignedInfo xmlns:ds="${NS_DS}" xmlns:etsi="http://uri.etsi.org/01903/v1.3.2#" `);
    const value = /<ds:SignatureValue[^>]*>([^<]+)</.exec(signed)?.[1] ?? '';
    expect(createVerify('RSA-SHA1').update(canonical).verify(certPem(), value, 'base64')).toBe(true);
  });

  it('el documento firmado sigue cumpliendo el XSD (incluye ds:Signature)', async () => {
    const r = await validateAgainstXsd(signed.replace(/^<\?xml[^>]+>\n/, ''), 'factura', '1.1.0');
    expect(r.errors).toEqual([]);
  });

  it('exige id="comprobante"', () => {
    expect(() => signXades('<factura version="1.1.0"></factura>', identity)).toThrow(/comprobante/);
  });
});

describe('ecuadorIso', () => {
  it('convierte a hora de Ecuador con -05:00', () => {
    expect(ecuadorIso(new Date('2026-01-01T03:30:15.123Z'))).toBe('2025-12-31T22:30:15-05:00');
  });
});
