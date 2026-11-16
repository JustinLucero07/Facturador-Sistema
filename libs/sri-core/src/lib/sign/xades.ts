import { createHash, createSign, randomInt } from 'node:crypto';
import { el, serialize, txt, XML_DECLARATION, XmlElement } from '../xml/writer';
import type { SigningIdentity } from './p12';

/**
 * Firma XAdES-BES enveloped — Ficha Técnica offline v2.34, numeral 6 y Anexo 14:
 *  - XAdES 1.3.2, codificación UTF-8, firma ENVELOPED.
 *  - RSA-SHA1, digest SHA1, canonicalización C14N 1.0 (inclusiva, sin comentarios).
 *  - Se firman: el comprobante (#comprobante), las SignedProperties y el KeyInfo con el certificado.
 *
 * El comprobante llega ya en forma canónica (ver xml/writer.ts), por lo que su digest con la
 * transformación enveloped es el SHA1 del mismo texto. Para los nodos dentro de <ds:Signature>, la
 * forma canónica de un subconjunto incluye en el elemento raíz del subconjunto las declaraciones de
 * espacios de nombres heredadas (xmlns:ds y xmlns:etsi), y así se calculan sus digests.
 */

export const NS_DS = 'http://www.w3.org/2000/09/xmldsig#';
export const NS_ETSI = 'http://uri.etsi.org/01903/v1.3.2#';
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
const SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const SIGNED_PROPS_TYPE = 'http://uri.etsi.org/01903#SignedProperties';

const sha1b64 = (data: string | Buffer) => createHash('sha1').update(data).digest('base64');

/** Fecha ISO 8601 con desplazamiento de Ecuador continental (-05:00), sin milisegundos. */
export function ecuadorIso(d: Date): string {
  const local = new Date(d.getTime() - 5 * 3600_000);
  return `${local.toISOString().slice(0, 19)}-05:00`;
}

const withNs = (e: XmlElement): XmlElement => ({ ...e, ns: { ds: NS_DS, etsi: NS_ETSI } });

export interface SignOptions {
  signingTime?: Date;
  /** Para pruebas deterministas. */
  idSeed?: () => number;
}

/**
 * Firma un comprobante. `xml` es el elemento raíz serializado en forma canónica (sin declaración XML),
 * con atributo id="comprobante". Devuelve el documento completo con declaración XML y firma.
 */
export function signXades(xml: string, identity: SigningIdentity, opts: SignOptions = {}): string {
  const rootMatch = /^<([a-zA-Z]+)[\s>]/.exec(xml);
  if (!rootMatch || !xml.includes('id="comprobante"')) throw new Error('El comprobante debe tener el atributo id="comprobante"');
  const rootName = rootMatch[1];
  const closing = `</${rootName}>`;
  if (!xml.endsWith(closing)) throw new Error('XML del comprobante mal formado');

  const rnd = opts.idSeed ?? (() => randomInt(100000, 999999));
  const n = rnd();
  const ids = {
    signature: `Signature${n}`,
    signedInfo: `Signature-SignedInfo${rnd()}`,
    signedProps: `Signature${n}-SignedProperties${rnd()}`,
    signedPropsRef: `SignedPropertiesID${rnd()}`,
    certificate: `Certificate${rnd()}`,
    reference: `Reference-ID-${rnd()}`,
    signatureValue: `SignatureValue${rnd()}`,
    object: `Signature${n}-Object${rnd()}`,
  };

  // 1. Digest del comprobante (enveloped: la firma aún no existe en el texto).
  const docDigest = sha1b64(xml);

  // 2. KeyInfo con el certificado (se firma para impedir su sustitución, numeral 6.5).
  const keyInfo: XmlElement = el(
    'ds:KeyInfo',
    { Id: ids.certificate },
    el('ds:X509Data', null, txt('ds:X509Certificate', identity.certificateBase64)),
    el('ds:KeyValue', null, el('ds:RSAKeyValue', null, txt('ds:Modulus', identity.modulusBase64), txt('ds:Exponent', identity.exponentBase64))),
  );

  // 3. SignedProperties (XAdES-BES).
  const certDigest = sha1b64(Buffer.from(identity.certificateBase64, 'base64'));
  const signedProps: XmlElement = el(
    'etsi:SignedProperties',
    { Id: ids.signedProps },
    el(
      'etsi:SignedSignatureProperties',
      null,
      txt('etsi:SigningTime', ecuadorIso(opts.signingTime ?? new Date())),
      el(
        'etsi:SigningCertificate',
        null,
        el(
          'etsi:Cert',
          null,
          el('etsi:CertDigest', null, el('ds:DigestMethod', { Algorithm: SHA1 }), txt('ds:DigestValue', certDigest)),
          el('etsi:IssuerSerial', null, txt('ds:X509IssuerName', identity.issuerName), txt('ds:X509SerialNumber', identity.serialNumber)),
        ),
      ),
    ),
    el(
      'etsi:SignedDataObjectProperties',
      null,
      el('etsi:DataObjectFormat', { ObjectReference: `#${ids.reference}` }, txt('etsi:Description', 'contenido comprobante'), txt('etsi:MimeType', 'text/xml')),
    ),
  );

  // 4. SignedInfo con las tres referencias.
  const signedInfo: XmlElement = el(
    'ds:SignedInfo',
    { Id: ids.signedInfo },
    el('ds:CanonicalizationMethod', { Algorithm: C14N }),
    el('ds:SignatureMethod', { Algorithm: RSA_SHA1 }),
    el(
      'ds:Reference',
      { Id: ids.signedPropsRef, Type: SIGNED_PROPS_TYPE, URI: `#${ids.signedProps}` },
      el('ds:DigestMethod', { Algorithm: SHA1 }),
      txt('ds:DigestValue', sha1b64(serialize(withNs(signedProps)))),
    ),
    el('ds:Reference', { URI: `#${ids.certificate}` }, el('ds:DigestMethod', { Algorithm: SHA1 }), txt('ds:DigestValue', sha1b64(serialize(withNs(keyInfo))))),
    el(
      'ds:Reference',
      { Id: ids.reference, URI: '#comprobante' },
      el('ds:Transforms', null, el('ds:Transform', { Algorithm: ENVELOPED })),
      el('ds:DigestMethod', { Algorithm: SHA1 }),
      txt('ds:DigestValue', docDigest),
    ),
  );

  // 5. Valor de la firma: RSA-SHA1 sobre la forma canónica de SignedInfo.
  const signatureValue = createSign('RSA-SHA1').update(serialize(withNs(signedInfo))).sign(identity.privateKeyPem, 'base64');

  const signature: XmlElement = {
    name: 'ds:Signature',
    ns: { ds: NS_DS, etsi: NS_ETSI },
    attrs: { Id: ids.signature },
    children: [
      signedInfo,
      el('ds:SignatureValue', { Id: ids.signatureValue }, signatureValue),
      keyInfo,
      el('ds:Object', { Id: ids.object }, el('etsi:QualifyingProperties', { Target: `#${ids.signature}` }, signedProps)),
    ],
  };

  return `${XML_DECLARATION}\n${xml.slice(0, -closing.length)}${serialize(signature)}${closing}`;
}
