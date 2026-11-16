import { XMLParser } from 'fast-xml-parser';

/**
 * Cliente de los web services offline del SRI (Ficha Técnica v2.34, numeral 7 y WSDL publicados):
 *  - RecepcionComprobantesOffline.validarComprobante(xml: base64Binary) → RECIBIDA | DEVUELTA
 *  - AutorizacionComprobantesOffline.autorizacionComprobante(claveAccesoComprobante) → AUTORIZADO | NO AUTORIZADO | (vacío = en proceso)
 * Las URLs NO van fijas en el código (numeral 7.1.4): llegan desde la configuración (tabla sri_setting).
 */

export interface SriMessage {
  identifier: string;
  message: string;
  additionalInfo: string | null;
  type: string;
}

export interface ReceptionResult {
  status: string;
  messages: SriMessage[];
  raw: string;
}

export type AuthorizationStatus = 'AUTORIZADO' | 'NO AUTORIZADO' | 'EN PROCESO';

export interface AuthorizationResult {
  status: AuthorizationStatus;
  authorizationNumber: string | null;
  authorizationDate: string | null;
  environment: string | null;
  /** XML del comprobante tal como lo devuelve el SRI. */
  comprobante: string | null;
  messages: SriMessage[];
  /** Documento "XML autorizado" listo para entregar al cliente (elemento <autorizacion>). */
  authorizedXml: string | null;
  raw: string;
}

/** Error de comunicación (timeout, DNS, HTTP 5xx): el comprobante debe reintentarse. */
export class SriConnectionError extends Error {}

export interface SoapOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ['comprobante', 'mensaje', 'autorizacion'].includes(name),
});

const envelope = (ns: string, body: string) =>
  `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="${ns}"><soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;

async function post(url: string, body: string, opts: SoapOptions): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset=utf-8', SOAPAction: '' },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (e) {
    throw new SriConnectionError(`No se pudo conectar con el SRI: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (res.status >= 500 && !text.includes('Envelope')) throw new SriConnectionError(`El SRI respondió HTTP ${res.status}`);
  if (!text.includes('Envelope')) throw new SriConnectionError(`Respuesta inesperada del SRI (HTTP ${res.status})`);
  return text;
}

type Raw = Record<string, unknown>;
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined || v === null || (v as unknown) === '' ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));

function messagesOf(container: Raw | undefined): SriMessage[] {
  const mensajes = container?.['mensajes'] as Raw | undefined;
  return asArray(mensajes?.['mensaje'] as Raw | Raw[] | undefined).map((m) => ({
    identifier: str(m['identificador']) ?? '',
    message: str(m['mensaje']) ?? '',
    additionalInfo: str(m['informacionAdicional']),
    type: str(m['tipo']) ?? '',
  }));
}

function body(xml: string): Raw {
  const doc = parser.parse(xml) as Raw;
  const env = doc['Envelope'] as Raw | undefined;
  const b = env?.['Body'] as Raw | undefined;
  if (!b) throw new SriConnectionError('Respuesta SOAP sin cuerpo');
  if (b['Fault']) {
    const f = b['Fault'] as Raw;
    throw new SriConnectionError(`SOAP Fault del SRI: ${str(f['faultstring']) ?? 'desconocido'}`);
  }
  return b;
}

export function parseReceptionResponse(xml: string): ReceptionResult {
  const r = (body(xml)['validarComprobanteResponse'] as Raw | undefined)?.['RespuestaRecepcionComprobante'] as Raw | undefined;
  if (!r) throw new SriConnectionError('Respuesta de recepción sin RespuestaRecepcionComprobante');
  const comprobantes = asArray((r['comprobantes'] as Raw | undefined)?.['comprobante'] as Raw | Raw[] | undefined);
  return {
    status: str(r['estado']) ?? '',
    messages: comprobantes.flatMap((c) => messagesOf(c)),
    raw: xml,
  };
}

const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function parseAuthorizationResponse(xml: string): AuthorizationResult {
  const r = (body(xml)['autorizacionComprobanteResponse'] as Raw | undefined)?.['RespuestaAutorizacionComprobante'] as Raw | undefined;
  if (!r) throw new SriConnectionError('Respuesta de autorización sin RespuestaAutorizacionComprobante');
  const auths = asArray((r['autorizaciones'] as Raw | undefined)?.['autorizacion'] as Raw | Raw[] | undefined);
  const empty: AuthorizationResult = {
    status: 'EN PROCESO',
    authorizationNumber: null,
    authorizationDate: null,
    environment: null,
    comprobante: null,
    messages: [],
    authorizedXml: null,
    raw: xml,
  };
  if (auths.length === 0) return empty; // aún sin respuesta (PPR)

  // Si hay varias, la autorizada prevalece; si no, el último estado (numeral 5.11).
  const a = auths.find((x) => str(x['estado']) === 'AUTORIZADO') ?? auths[auths.length - 1];
  const estado = (str(a['estado']) ?? '').toUpperCase();
  const comprobante = Array.isArray(a['comprobante']) ? str((a['comprobante'] as unknown[])[0]) : str(a['comprobante']);
  const status: AuthorizationStatus = estado === 'AUTORIZADO' ? 'AUTORIZADO' : estado === 'EN PROCESO' || estado === 'PPR' ? 'EN PROCESO' : 'NO AUTORIZADO';
  const result: AuthorizationResult = {
    status,
    authorizationNumber: str(a['numeroAutorizacion']),
    authorizationDate: str(a['fechaAutorizacion']),
    environment: str(a['ambiente']),
    comprobante,
    messages: messagesOf(a),
    authorizedXml: null,
    raw: xml,
  };
  if (status === 'AUTORIZADO' && comprobante) {
    const mensajes = result.messages
      .map(
        (m) =>
          `<mensaje><identificador>${esc(m.identifier)}</identificador><mensaje>${esc(m.message)}</mensaje>${
            m.additionalInfo ? `<informacionAdicional>${esc(m.additionalInfo)}</informacionAdicional>` : ''
          }<tipo>${esc(m.type)}</tipo></mensaje>`,
      )
      .join('');
    result.authorizedXml =
      `<?xml version="1.0" encoding="UTF-8"?>\n<autorizacion><estado>AUTORIZADO</estado>` +
      `<numeroAutorizacion>${esc(result.authorizationNumber ?? '')}</numeroAutorizacion>` +
      `<fechaAutorizacion>${esc(result.authorizationDate ?? '')}</fechaAutorizacion>` +
      `<ambiente>${esc(result.environment ?? '')}</ambiente>` +
      `<comprobante>${cdata(comprobante)}</comprobante><mensajes>${mensajes}</mensajes></autorizacion>`;
  }
  return result;
}

/** Envía el comprobante firmado al WS de recepción. */
export async function sendToReception(signedXml: string, url: string, opts: SoapOptions = {}): Promise<ReceptionResult> {
  const b64 = Buffer.from(signedXml, 'utf8').toString('base64');
  const xml = await post(url, envelope('http://ec.gob.sri.ws.recepcion', `<ec:validarComprobante><xml>${b64}</xml></ec:validarComprobante>`), opts);
  return parseReceptionResponse(xml);
}

/** Consulta la autorización por clave de acceso. */
export async function queryAuthorization(accessKey: string, url: string, opts: SoapOptions = {}): Promise<AuthorizationResult> {
  if (!/^\d{49}$/.test(accessKey)) throw new Error('Clave de acceso inválida');
  const xml = await post(
    url,
    envelope('http://ec.gob.sri.ws.autorizacion', `<ec:autorizacionComprobante><claveAccesoComprobante>${accessKey}</claveAccesoComprobante></ec:autorizacionComprobante>`),
    opts,
  );
  return parseAuthorizationResponse(xml);
}

/** Tamaño máximo de envío individual (numeral 7.5). */
export const MAX_SINGLE_DOCUMENT_BYTES = 320 * 1024;
