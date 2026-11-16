import { parseAuthorizationResponse, parseReceptionResponse, queryAuthorization, sendToReception, SriConnectionError } from './client';
import { explainMessages } from './messages';

// Respuestas con la forma exacta de los ejemplos del numeral 7.2.3 de la ficha
const RECIBIDA = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:validarComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.recepcion"><RespuestaRecepcionComprobante><estado>RECIBIDA</estado><comprobantes/></RespuestaRecepcionComprobante></ns2:validarComprobanteResponse></soap:Body></soap:Envelope>`;

const DEVUELTA = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:validarComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.recepcion"><RespuestaRecepcionComprobante><estado>DEVUELTA</estado><comprobantes><comprobante><claveAcceso>1702201205176001321000110010030001000011234567816</claveAcceso><mensajes><mensaje><identificador>35</identificador><mensaje>DOCUMENTO INVÁLIDO</mensaje><informacionAdicional>cvc-complex-type.2.4.a: Invalid content was found starting with element 'totalSinImpuestos'.</informacionAdicional><tipo>ERROR</tipo></mensaje></mensajes></comprobante></comprobantes></RespuestaRecepcionComprobante></ns2:validarComprobanteResponse></soap:Body></soap:Envelope>`;

const COMPROBANTE = '<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante" version="1.1.0"><x>a &amp; b</x></factura>';

const AUTORIZADO = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:autorizacionComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.autorizacion"><RespuestaAutorizacionComprobante><claveAccesoConsultada>0503201201176001321000110010030009900641234567814</claveAccesoConsultada><numeroComprobantes>1</numeroComprobantes><autorizaciones><autorizacion><estado>AUTORIZADO</estado><numeroAutorizacion>0503201201176001321000110010030009900641234567814</numeroAutorizacion><fechaAutorizacion>2012-03-05T16:57:34.997-05:00</fechaAutorizacion><ambiente>PRUEBAS</ambiente><comprobante><![CDATA[${COMPROBANTE}]]></comprobante><mensajes><mensaje><identificador>60</identificador><mensaje>ESTE PROCESO FUE REALIZADO EN EL AMBIENTE DE PRUEBAS</mensaje><tipo>ADVERTENCIA</tipo></mensaje></mensajes></autorizacion></autorizaciones></RespuestaAutorizacionComprobante></ns2:autorizacionComprobanteResponse></soap:Body></soap:Envelope>`;

const RECHAZADO = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:autorizacionComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.autorizacion"><RespuestaAutorizacionComprobante><claveAccesoConsultada>1302201201176001321000120010030000050431234567814</claveAccesoConsultada><numeroComprobantes>1</numeroComprobantes><autorizaciones><autorizacion><estado>NO AUTORIZADO</estado><fechaAutorizacion>2012-02-13T16:34:48.997-05:00</fechaAutorizacion><ambiente>PRUEBAS</ambiente><comprobante><![CDATA[${COMPROBANTE}]]></comprobante><mensajes><mensaje><identificador>46</identificador><mensaje> RUC no existe </mensaje><tipo>ERROR</tipo></mensaje></mensajes></autorizacion></autorizaciones></RespuestaAutorizacionComprobante></ns2:autorizacionComprobanteResponse></soap:Body></soap:Envelope>`;

const SIN_RESPUESTA = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:autorizacionComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.autorizacion"><RespuestaAutorizacionComprobante><claveAccesoConsultada>1302201201176001321000120010030000050431234567814</claveAccesoConsultada><numeroComprobantes>0</numeroComprobantes><autorizaciones/></RespuestaAutorizacionComprobante></ns2:autorizacionComprobanteResponse></soap:Body></soap:Envelope>`;

describe('respuestas de recepción', () => {
  it('RECIBIDA', () => {
    expect(parseReceptionResponse(RECIBIDA)).toMatchObject({ status: 'RECIBIDA', messages: [] });
  });

  it('DEVUELTA con mensajes', () => {
    const r = parseReceptionResponse(DEVUELTA);
    expect(r.status).toBe('DEVUELTA');
    expect(r.messages).toEqual([
      expect.objectContaining({ identifier: '35', message: 'DOCUMENTO INVÁLIDO', type: 'ERROR', additionalInfo: expect.stringContaining('totalSinImpuestos') }),
    ]);
    expect(explainMessages(r.messages)[0]).toMatchObject({ title: 'Documento inválido', isError: true });
  });
});

describe('respuestas de autorización', () => {
  it('AUTORIZADO: arma el XML autorizado con el comprobante en CDATA', () => {
    const r = parseAuthorizationResponse(AUTORIZADO);
    expect(r.status).toBe('AUTORIZADO');
    expect(r.authorizationNumber).toBe('0503201201176001321000110010030009900641234567814');
    expect(r.comprobante).toBe(COMPROBANTE);
    expect(r.messages[0]).toMatchObject({ identifier: '60', type: 'ADVERTENCIA' });
    expect(r.authorizedXml).toContain(`<comprobante><![CDATA[${COMPROBANTE}]]></comprobante>`);
    expect(r.authorizedXml).toContain('<estado>AUTORIZADO</estado>');
  });

  it('NO AUTORIZADO con motivo', () => {
    const r = parseAuthorizationResponse(RECHAZADO);
    expect(r.status).toBe('NO AUTORIZADO');
    expect(r.authorizedXml).toBeNull();
    expect(r.messages[0]).toMatchObject({ identifier: '46', message: 'RUC no existe' });
  });

  it('sin autorizaciones aún → EN PROCESO', () => {
    expect(parseAuthorizationResponse(SIN_RESPUESTA).status).toBe('EN PROCESO');
  });

  it('SOAP Fault → error de conexión (reintentable)', () => {
    const fault = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Server</faultcode><faultstring>Fallo</faultstring></soap:Fault></soap:Body></soap:Envelope>`;
    expect(() => parseAuthorizationResponse(fault)).toThrow(SriConnectionError);
  });
});

describe('llamadas HTTP', () => {
  it('envía el comprobante en base64 dentro de validarComprobante', async () => {
    let sent = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = String(init.body);
      return new Response(RECIBIDA, { status: 200 });
    }) as unknown as typeof fetch;
    const r = await sendToReception('<factura id="comprobante">ñ</factura>', 'https://celcer.example/Recepcion', { fetchImpl });
    expect(r.status).toBe('RECIBIDA');
    const b64 = /<xml>([^<]+)<\/xml>/.exec(sent)?.[1] ?? '';
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('<factura id="comprobante">ñ</factura>');
    expect(sent).toContain('xmlns:ec="http://ec.gob.sri.ws.recepcion"');
  });

  it('consulta la autorización por clave', async () => {
    let sent = '';
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sent = String(init.body);
      return new Response(AUTORIZADO, { status: 200 });
    }) as unknown as typeof fetch;
    const r = await queryAuthorization('0503201201176001321000110010030009900641234567814', 'https://x/Autorizacion', { fetchImpl });
    expect(sent).toContain('<claveAccesoComprobante>0503201201176001321000110010030009900641234567814</claveAccesoComprobante>');
    expect(r.status).toBe('AUTORIZADO');
  });

  it('caída de red → SriConnectionError', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(sendToReception('<a/>', 'https://x', { fetchImpl })).rejects.toThrow(SriConnectionError);
  });

  it('HTTP 503 sin SOAP → SriConnectionError', async () => {
    const fetchImpl = (async () => new Response('Service Unavailable', { status: 503 })) as unknown as typeof fetch;
    await expect(queryAuthorization('0503201201176001321000110010030009900641234567814', 'https://x', { fetchImpl })).rejects.toThrow(/503/);
  });
});
