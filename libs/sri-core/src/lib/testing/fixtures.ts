import { buildAccessKey } from '../access-key';
import { computeInvoice } from '../calc';
import type { InvoiceDocument } from '../xml/invoice';

/** Factura de ejemplo para pruebas (datos ficticios del ambiente de pruebas). */
export function sampleInvoice(over: Partial<InvoiceDocument> = {}): InvoiceDocument {
  const { lines, totals } = computeInvoice([
    { mainCode: 'CEM-50', auxCode: 'F010401', description: 'Cemento Portland 50 kg', unit: 'saco', quantity: 2, unitPrice: '8.50', taxes: [{ taxCode: '2', percentageCode: '5', rate: 5 }] },
    { mainCode: 'MART-01', description: 'Martillo de uña 16 oz & mango "fibra"', quantity: 1, unitPrice: '12.00', discount: '1.00', taxes: [{ taxCode: '2', percentageCode: '4', rate: 15 }] },
  ]);
  const issueDate = { day: 16, month: 11, year: 2026 };
  return {
    version: '1.1.0',
    environment: 1,
    accessKey: buildAccessKey({
      issueDate,
      docType: '01',
      ruc: '1790012344001',
      environment: 1,
      establishment: '001',
      emissionPoint: '001',
      sequential: 1,
      numericCode: '12345678',
    }),
    establishment: '001',
    emissionPoint: '001',
    sequential: '1',
    issueDate,
    issuer: {
      ruc: '1790012344001',
      legalName: 'FERRETERIA DEMO S.A.',
      tradeName: 'Ferretería Demo',
      mainAddress: 'Av. Huayna Cápac y Calle Larga, Cuenca',
      establishmentAddress: 'Av. Huayna Cápac y Calle Larga, Cuenca',
      keepsAccounting: true,
    },
    buyer: { idType: '05', id: '1710034065', name: 'PRUEBAS SERVICIO DE RENTAS INTERNAS', address: 'Cuenca', email: 'cliente@example.com' },
    lines,
    totals,
    payments: [{ code: '01', amount: totals.total }],
    additionalInfo: [{ name: 'Email', value: 'cliente@example.com' }],
    currency: 'DOLAR',
    ...over,
  };
}
