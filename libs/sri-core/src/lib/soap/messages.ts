import type { SriMessage } from './client';

/**
 * Códigos de error y advertencia del SRI — Ficha Técnica offline v2.34, numeral 11.
 * `hint` es una explicación en lenguaje sencillo para el usuario del negocio.
 */
export const SRI_ERROR_CODES: Record<string, { title: string; hint: string; retryable?: boolean }> = {
  '2': { title: 'RUC del emisor no activo', hint: 'Su RUC no está ACTIVO en el SRI. Regularícelo antes de volver a enviar.' },
  '10': { title: 'Establecimiento clausurado', hint: 'El establecimiento emisor está clausurado; se habilitará al concluir la clausura.' },
  '26': { title: 'Tamaño máximo superado', hint: 'El comprobante supera 320 KB. Reduzca el número de líneas o la información adicional.' },
  '27': { title: 'Clase no permitida', hint: 'Su tipo de contribuyente no puede emitir comprobantes electrónicos.' },
  '28': { title: 'Acuerdo de medios electrónicos no aceptado', hint: 'Acepte el acuerdo de medios electrónicos en SRI en línea.' },
  '35': { title: 'Documento inválido', hint: 'El XML no cumple el esquema del SRI. Revise el detalle técnico y comuníquelo a Soporte Vektra.' },
  '36': { title: 'Versión de esquema descontinuada', hint: 'La versión del XML ya no es aceptada. Actualice la versión en la configuración tributaria.' },
  '37': { title: 'RUC sin autorización de emisión', hint: 'Solicite en SRI en línea la autorización para emitir comprobantes electrónicos (ambiente de pruebas y producción).' },
  '39': { title: 'Firma inválida', hint: 'La firma electrónica no es válida. Verifique que el certificado .p12 esté vigente y corresponda al RUC.' },
  '40': { title: 'Error en el certificado', hint: 'No se pudo leer el certificado de firma. Vuelva a cargar el archivo .p12.' },
  '42': { title: 'Certificado revocado o caducado', hint: 'Su firma electrónica caducó o fue revocada. Renueve la firma con su entidad certificadora.' },
  '43': { title: 'Clave de acceso registrada', hint: 'El SRI ya tiene este comprobante; se consultará su autorización.', retryable: true },
  '45': { title: 'Secuencial registrado', hint: 'Ese número de comprobante ya fue usado en el SRI. Revise los secuenciales del punto de emisión.' },
  '46': { title: 'RUC no existe', hint: 'El RUC del emisor no existe en el SRI.' },
  '47': { title: 'Tipo de comprobante no existe', hint: 'Tipo de comprobante no reconocido por el SRI.' },
  '48': { title: 'Esquema XSD no existe', hint: 'No existe esquema para el tipo de comprobante enviado.' },
  '49': { title: 'Argumentos nulos', hint: 'El envío llegó vacío al SRI. Se reintentará.', retryable: true },
  '50': { title: 'Error interno del SRI', hint: 'Falla temporal del SRI. Se reintentará automáticamente.', retryable: true },
  '52': { title: 'Error en diferencias', hint: 'Los cálculos del comprobante no cuadran (subtotales, impuestos o total).' },
  '56': { title: 'Establecimiento cerrado', hint: 'El establecimiento desde el que emite está cerrado en el RUC.' },
  '57': { title: 'Autorización suspendida', hint: 'Su autorización de emisión electrónica está suspendida por el SRI.' },
  '58': { title: 'Error en la estructura de la clave de acceso', hint: 'La clave de acceso no coincide con los datos del comprobante.' },
  '63': { title: 'RUC clausurado', hint: 'El RUC del emisor está clausurado por el SRI.' },
  '65': { title: 'Fecha de emisión extemporánea', hint: 'El comprobante se envió fuera del plazo permitido desde su fecha de emisión.' },
  '67': { title: 'Fecha inválida', hint: 'La fecha del comprobante tiene un formato incorrecto.' },
  '70': { title: 'Clave de acceso en procesamiento', hint: 'El SRI aún procesa este comprobante (hasta 24 h). No se debe reenviar; se consultará más tarde.', retryable: true },
  '80': { title: 'Error en la estructura de la clave de acceso', hint: 'La clave de acceso consultada es inválida.' },
  '92': { title: 'Error al validar monto de devolución del IVA', hint: 'El valor de devolución del IVA no corresponde al autorizado.' },
  // Advertencias
  '59': { title: 'Identificación no existe', hint: 'Advertencia: la identificación del comprador no existe en el SRI.' },
  '60': { title: 'Ambiente de pruebas', hint: 'Advertencia: comprobante emitido en ambiente de PRUEBAS, sin validez tributaria.' },
  '62': { title: 'Identificación incorrecta', hint: 'Advertencia: la identificación del comprador no es correcta (dígito verificador).' },
  '68': { title: 'Documento sustento', hint: 'Advertencia: el comprobante relacionado no existe como electrónico.' },
};

export interface ExplainedMessage extends SriMessage {
  title: string;
  hint: string;
  isError: boolean;
}

export function explainMessages(messages: SriMessage[]): ExplainedMessage[] {
  return messages.map((m) => {
    const known = SRI_ERROR_CODES[m.identifier];
    return {
      ...m,
      title: known?.title ?? m.message,
      hint: known?.hint ?? m.additionalInfo ?? m.message,
      isError: m.type.toUpperCase() === 'ERROR',
    };
  });
}

export function hasCode(messages: SriMessage[], code: string): boolean {
  return messages.some((m) => m.identifier === code);
}
