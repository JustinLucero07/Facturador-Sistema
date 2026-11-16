import { writeFileSync } from 'node:fs';
import { sampleInvoice } from '../testing/fixtures';
import { renderInvoiceRide } from './ride';

const opts = {
  rateLabels: { '0': '0%', '4': '15%', '5': '5%', '6': 'NO OBJETO DE IVA', '7': 'EXENTO DE IVA' },
  paymentLabels: { '01': 'SIN UTILIZACION DEL SISTEMA FINANCIERO' },
  authorizationDate: '2026-11-16T10:05:00.000-05:00',
};

describe('RIDE de factura', () => {
  it('genera un PDF A4 válido', async () => {
    const pdf = await renderInvoiceRide(sampleInvoice(), opts);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(3000);
    if (process.env['RIDE_OUT']) writeFileSync(process.env['RIDE_OUT'], pdf);
  });

  it('soporta muchas líneas (salto de página)', async () => {
    const base = sampleInvoice();
    const lines = Array.from({ length: 80 }, () => base.lines[0]);
    const pdf = await renderInvoiceRide({ ...base, lines }, opts);
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)?.length).toBeGreaterThan(1);
  });
});
