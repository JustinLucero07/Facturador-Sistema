/** Error de negocio con mensaje para el usuario (se traduce a HTTP 422 en la API). */
export class EInvoiceError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

/** Error temporal: el trabajo debe reintentarse (SRI caído, comprobante en proceso…). */
export class RetryLaterError extends Error {}
