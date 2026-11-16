import { DOMParser } from '@xmldom/xmldom';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { SignedXml } from 'xml-crypto';

/**
 * SRI simulado para pruebas: implementa recepción y autorización con los formatos SOAP de la
 * Ficha Técnica v2.34 (numeral 7.2.3). Verifica de verdad la firma XAdES de cada comprobante recibido.
 */
export class FakeSri {
  private server!: Server;
  readonly received = new Map<string, string>();
  /** Respuestas forzadas por clave de acceso */
  receptionMode: 'ok' | 'down' | 'returned' = 'ok';
  authorizationMode: 'authorized' | 'processing' | 'rejected' = 'authorized';
  lastSignatureValid: boolean | null = null;

  get receptionUrl() {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/RecepcionComprobantesOffline`;
  }
  get authorizationUrl() {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/AutorizacionComprobantesOffline`;
  }

  start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('content-type', 'text/xml');
        if (req.url?.includes('Recepcion')) return res.end(this.reception(body));
        return res.end(this.authorization(body));
      });
    });
    return new Promise((r) => this.server.listen(0, '127.0.0.1', () => r()));
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }

  private reception(soap: string): string {
    if (this.receptionMode === 'down') return 'Service Unavailable';
    const b64 = /<xml>([^<]+)<\/xml>/.exec(soap)?.[1] ?? '';
    const xml = Buffer.from(b64, 'base64').toString('utf8');
    const key = /<claveAcceso>(\d{49})<\/claveAcceso>/.exec(xml)?.[1] ?? '';
    this.lastSignatureValid = verify(xml);
    const env = (inner: string) =>
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:validarComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.recepcion"><RespuestaRecepcionComprobante>${inner}</RespuestaRecepcionComprobante></ns2:validarComprobanteResponse></soap:Body></soap:Envelope>`;
    if (this.receptionMode === 'returned' || !this.lastSignatureValid) {
      return env(
        `<estado>DEVUELTA</estado><comprobantes><comprobante><claveAcceso>${key}</claveAcceso><mensajes><mensaje><identificador>39</identificador><mensaje>FIRMA INVALIDA</mensaje><tipo>ERROR</tipo></mensaje></mensajes></comprobante></comprobantes>`,
      );
    }
    this.received.set(key, xml);
    return env('<estado>RECIBIDA</estado><comprobantes/>');
  }

  private authorization(soap: string): string {
    const key = /<claveAccesoComprobante>(\d{49})<\/claveAccesoComprobante>/.exec(soap)?.[1] ?? '';
    const xml = this.received.get(key);
    const head = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:autorizacionComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.autorizacion"><RespuestaAutorizacionComprobante><claveAccesoConsultada>${key}</claveAccesoConsultada>`;
    const tail = '</RespuestaAutorizacionComprobante></ns2:autorizacionComprobanteResponse></soap:Body></soap:Envelope>';
    if (!xml || this.authorizationMode === 'processing') return `${head}<numeroComprobantes>0</numeroComprobantes><autorizaciones/>${tail}`;
    const estado = this.authorizationMode === 'authorized' ? 'AUTORIZADO' : 'NO AUTORIZADO';
    const msg =
      this.authorizationMode === 'authorized'
        ? '<mensaje><identificador>60</identificador><mensaje>ESTE PROCESO FUE REALIZADO EN EL AMBIENTE DE PRUEBAS</mensaje><tipo>ADVERTENCIA</tipo></mensaje>'
        : '<mensaje><identificador>52</identificador><mensaje>ERROR EN DIFERENCIAS</mensaje><tipo>ERROR</tipo></mensaje>';
    return `${head}<numeroComprobantes>1</numeroComprobantes><autorizaciones><autorizacion><estado>${estado}</estado>${
      estado === 'AUTORIZADO' ? `<numeroAutorizacion>${key}</numeroAutorizacion>` : ''
    }<fechaAutorizacion>2026-11-16T10:05:00.000-05:00</fechaAutorizacion><ambiente>PRUEBAS</ambiente><comprobante><![CDATA[${xml}]]></comprobante><mensajes>${msg}</mensajes></autorizacion></autorizaciones>${tail}`;
  }
}

function verify(xml: string): boolean {
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const sig = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0];
    const cert = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'X509Certificate')[0]?.textContent ?? '';
    const pem = `-----BEGIN CERTIFICATE-----\n${cert.match(/.{1,64}/g)?.join('\n')}\n-----END CERTIFICATE-----`;
    const v = new SignedXml({ publicCert: pem, getCertFromKeyInfo: () => null });
    v.loadSignature(sig as unknown as Node);
    return v.checkSignature(xml);
  } catch {
    return false;
  }
}
