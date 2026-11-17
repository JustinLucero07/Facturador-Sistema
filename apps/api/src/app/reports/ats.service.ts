import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { D } from '@vektra/accounts';
import type { AtsIssue, AtsPreview, AtsQuery } from '@vektra/shared-contracts';
import { atsFileName, AtsPurchase, AtsReport, AtsSale, buildAtsXml, validateAts, zipSingleFile } from '@vektra/sri-core';
import { PrismaService } from '../common/prisma.service';

type Dec = InstanceType<typeof D>;
type TaxGroup = { taxCode: string; percentageCode: string; rate: string; base: string; amount: string };

/** Parámetro "ats" (sri_setting): valores tributarios y criterios, nunca fijos en el código. */
interface AtsSettings {
  paymentFormThreshold: string;
  noWithholdingConcept: string;
  includeElectronicSales: boolean;
  electronicSalesInTotals: boolean;
}

const m2 = (v: Dec) => v.toDecimalPlaces(2).toFixed(2);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const parts = (d: Date) => ({ day: d.getUTCDate(), month: d.getUTCMonth() + 1, year: d.getUTCFullYear() });
/** Fecha local de Ecuador (UTC−5, sin horario de verano) de un instante. */
const localDay = (t: Date) =>
  new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit' }).format(t)}T00:00:00Z`);
const splitNumber = (n: string) => {
  const [establishment, emissionPoint, sequential] = n.split('-');
  return { establishment, emissionPoint, sequential };
};
const pad9 = (v: bigint | number) => String(v).padStart(9, '0');

/** Tabla 6 de la Ficha de comprobantes electrónicos → Tabla 2 del Catálogo ATS. */
const PURCHASE_ID_TYPE: Record<string, AtsPurchase['idType']> = { '04': '01', '05': '02', '06': '03', '08': '03' };
const SALE_ID_TYPE: Record<string, AtsSale['idType']> = { '04': '04', '05': '05', '06': '06', '08': '06', '07': '07' };
/** Porcentaje de retención de IVA → campo del ATS (Ficha ATS, numeral 2.2). */
const IVA_FIELDS = ['10', '20', '30', '50', '70', '100'] as const;

/** Bases del ATS por tarifa (Ficha de comprobantes electrónicos, Tabla 17: 6 no objeto, 7 exento). */
function bases(groups: TaxGroup[]) {
  const b = { noGra: new D(0), zero: new D(0), grav: new D(0), exempt: new D(0), iva: new D(0), ice: new D(0) };
  for (const g of groups) {
    if (g.taxCode === '3') b.ice = b.ice.plus(g.amount);
    if (g.taxCode !== '2') continue;
    if (g.percentageCode === '6') b.noGra = b.noGra.plus(g.base);
    else if (g.percentageCode === '7') b.exempt = b.exempt.plus(g.base);
    else if (new D(g.rate).gt(0)) b.grav = b.grav.plus(g.base);
    else b.zero = b.zero.plus(g.base);
    b.iva = b.iva.plus(g.amount);
  }
  return b;
}

/**
 * Anexo Transaccional Simplificado (Ficha técnica ATS del SRI + at.xsd del DIMM 1.19.0).
 * Compras: las registradas (fecha de registro contable = día en que se ingresaron al sistema) con su
 * retención emitida. Ventas: facturas (Tabla 4 código 18) y notas de crédito (04) autorizadas,
 * agrupadas por cliente, con las retenciones recibidas en el período.
 */
@Injectable()
export class AtsService {
  constructor(private readonly prisma: PrismaService) {}

  private async settings(): Promise<AtsSettings> {
    const row = await this.prisma.client.sriSetting.findUnique({ where: { key: 'ats' } });
    if (!row) throw new UnprocessableEntityException('Falta el parámetro "ats" del SRI. Ejecute el seed de la base de datos.');
    return row.value as unknown as AtsSettings;
  }

  private period(q: AtsQuery) {
    const startMonth = q.semiannual ? q.month - 5 : q.month;
    const from = new Date(Date.UTC(q.year, startMonth - 1, 1));
    const to = new Date(Date.UTC(q.year, q.month, 0));
    return { from, to };
  }

  async generate(q: AtsQuery): Promise<{ preview: AtsPreview; xml: string }> {
    const settings = await this.settings();
    const { from, to } = this.period(q);
    const issues: AtsIssue[] = [];
    const err = (message: string, link?: string) => issues.push({ level: 'error', message, link: link ?? null });
    const warn = (message: string, link?: string) => issues.push({ level: 'warning', message, link: link ?? null });
    const threshold = new D(settings.paymentFormThreshold);

    const data = await this.prisma.tx(async (tx) => {
      const tenant = await tx.tenant.findFirstOrThrow({ select: { ruc: true, legalName: true, taxRegime: true } });
      const establishments = await tx.establishment.findMany({ where: { active: true }, orderBy: { code: 'asc' }, select: { id: true, code: true } });
      // Registro contable: día (Ecuador) en que se ingresó la compra; se toma un margen de un día en UTC
      const purchases = await tx.purchase.findMany({
        where: { status: 'REGISTERED', createdAt: { gte: new Date(from.getTime() - 86400000), lt: new Date(to.getTime() + 2 * 86400000) } },
        orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
      });
      const withholdings = await tx.document.findMany({
        where: { docType: '07', status: 'ISSUED', purchaseId: { in: purchases.map((p) => p.id) } },
        include: { withholdings: true, electronic: true, establishment: true, emissionPoint: true },
        orderBy: { createdAt: 'asc' },
      });
      const sales = await tx.document.findMany({
        where: { docType: { in: ['01', '04'] }, status: 'ISSUED', issueDate: { gte: from, lte: to } },
        select: {
          id: true,
          docType: true,
          establishmentId: true,
          buyerIdType: true,
          buyerId: true,
          buyerName: true,
          sequential: true,
          taxSummary: true,
          electronic: { select: { status: true } },
          establishment: { select: { code: true } },
          emissionPoint: { select: { code: true } },
          payments: { select: { sriCode: true } },
        },
      });
      const received = await tx.accountMovement.findMany({ where: { side: 'AR', kind: 'WITHHOLDING', voidedAt: null, date: { gte: from, lte: to } } });
      const partyIds = [...new Set([...purchases.map((p) => p.supplierId), ...received.map((r) => r.partyId)])];
      const identifications = [...new Set(sales.map((s) => s.buyerId))];
      const parties = await tx.party.findMany({
        where: { OR: [{ id: { in: partyIds } }, { identification: { in: identifications } }] },
        select: { id: true, idType: true, identification: true, name: true, personType: true, relatedParty: true },
      });
      return { tenant, establishments, purchases, withholdings, sales, received, parties };
    });

    const { tenant, establishments } = data;
    const partyById = new Map(data.parties.map((p) => [p.id, p]));
    const partyByIdent = new Map(data.parties.map((p) => [p.identification, p]));
    if (q.semiannual && tenant.taxRegime === 'GENERAL') err('El ATS semestral solo lo presentan los contribuyentes del régimen RIMPE.');

    // ─── Compras ───
    const atsPurchases: AtsPurchase[] = [];
    const pTotals = { base: new D(0), iva: new D(0), ivaW: new D(0), rentaW: new D(0) };
    for (const p of data.purchases) {
      const accountingDay = localDay(p.createdAt);
      if (accountingDay < from || accountingDay > to) continue;
      const link = `/compras?ver=${p.id}`;
      const label = `Compra ${p.number}`;
      const sup = partyById.get(p.supplierId);
      if (!sup) {
        err(`${label}: proveedor no encontrado.`, link);
        continue;
      }
      const idType = PURCHASE_ID_TYPE[sup.idType];
      if (!idType) err(`${label}: tipo de identificación del proveedor no admitido en compras.`, link);
      if (idType === '03' && !sup.personType) err(`${label}: indique si el proveedor ${sup.name} es persona natural o sociedad (pasaporte / exterior).`);
      const w = data.withholdings.filter((d) => d.purchaseId === p.id);
      const live = w.filter((d) => d.electronic?.status !== 'NOT_AUTHORIZED' && d.electronic?.status !== 'RETURNED');
      const ret = live.find((d) => d.electronic?.status === 'AUTHORIZED') ?? null;
      for (const d of live) {
        if (d.electronic?.status !== 'AUTHORIZED') {
          warn(`${label}: la retención ${d.establishment.code}-${d.emissionPoint.code}-${pad9(d.sequential)} aún no está autorizada por el SRI; no se incluye.`, `/facturacion/comprobantes/${d.id}`);
        }
      }
      const retInfo = (ret?.taxSummary ?? {}) as { sustentoCode?: string; paymentCode?: string; relatedParty?: boolean };
      const sustento = p.sustentoCode ?? retInfo.sustentoCode ?? null;
      if (!sustento) err(`${label} de ${sup.name}: falta el sustento tributario.`, link);
      const b = bases((p.taxSummary as TaxGroup[]) ?? []);
      const totalWithTax = b.noGra.plus(b.zero).plus(b.grav).plus(b.exempt).plus(b.iva).plus(b.ice);
      const paymentCode = p.paymentCode ?? retInfo.paymentCode ?? null;
      const needsPayment = totalWithTax.gt(threshold);
      if (needsPayment && !paymentCode) err(`${label} de ${sup.name}: falta la forma de pago (obligatoria sobre USD ${threshold.toFixed(2)}).`, link);
      if (!p.authorization) err(`${label} de ${sup.name}: falta el número de autorización.`, link);
      else if (!/^\d{3,49}$/.test(p.authorization)) err(`${label}: el número de autorización solo puede tener dígitos.`, link);
      if (b.noGra.plus(b.zero).plus(b.grav).lte(0)) warn(`${label}: el SRI exige que al menos una base (no objeto, 0 % o gravada) sea mayor a cero.`, link);

      const ivaW: AtsPurchase['ivaWithholding'] = {};
      const air: AtsPurchase['air'] = [];
      for (const l of ret?.withholdings ?? []) {
        if (l.tax === '2') {
          const key = new D(l.percentage.toString()).toString() as (typeof IVA_FIELDS)[number];
          if (!IVA_FIELDS.includes(key)) {
            if (new D(l.amount.toString()).gt(0)) err(`${label}: el ATS no tiene campo para retención de IVA del ${key} %.`, link);
            continue;
          }
          ivaW[key] = m2(new D(ivaW[key] ?? 0).plus(l.amount.toString()));
          pTotals.ivaW = pTotals.ivaW.plus(l.amount.toString());
        } else if (l.tax === '1') {
          air.push({ code: l.code, base: l.base.toString(), percentage: l.percentage.toString(), amount: l.amount.toString() });
          pTotals.rentaW = pTotals.rentaW.plus(l.amount.toString());
        }
      }
      // Ficha ATS: sin retención de renta se informa el concepto de "otras compras no sujetas a retención"
      if (!air.length) air.push({ code: settings.noWithholdingConcept, base: m2(b.noGra.plus(b.zero).plus(b.grav).plus(b.exempt)), percentage: '0', amount: '0' });

      const n = splitNumber(p.number);
      const issueDay = p.issueDate;
      if (issueDay > accountingDay) err(`${label}: la fecha de emisión es posterior a la fecha de registro.`, link);
      atsPurchases.push({
        sustentoCode: sustento ?? '00',
        idType: idType ?? '01',
        id: sup.identification.slice(0, 13),
        personType: sup.personType,
        name: sup.name,
        relatedParty: p.relatedParty || sup.relatedParty,
        docType: p.docType,
        accountingDate: parts(accountingDay),
        establishment: n.establishment,
        emissionPoint: n.emissionPoint,
        sequential: n.sequential,
        issueDate: parts(issueDay),
        authorization: p.authorization ?? '000',
        baseNoGraIva: m2(b.noGra),
        baseImponible: m2(b.zero),
        baseImpGrav: m2(b.grav),
        baseImpExe: m2(b.exempt),
        montoIce: m2(b.ice),
        montoIva: m2(b.iva),
        ivaWithholding: ivaW,
        paymentForms: needsPayment && paymentCode ? [paymentCode] : [],
        air,
        withholding: ret
          ? {
              establishment: ret.establishment.code,
              emissionPoint: ret.emissionPoint.code,
              sequential: pad9(ret.sequential),
              authorization: ret.electronic?.authorizationNumber ?? ret.electronic?.accessKey ?? '000',
              issueDate: parts(ret.issueDate),
            }
          : null,
      });
      pTotals.base = pTotals.base.plus(b.noGra).plus(b.zero).plus(b.grav).plus(b.exempt);
      pTotals.iva = pTotals.iva.plus(b.iva);
    }

    // ─── Ventas (agrupadas por cliente, tipo de comprobante y tipo de emisión) ───
    const rows = new Map<string, AtsSale>();
    const emptyRow = (idType: AtsSale['idType'], id: string, name: string, party: { personType: string | null; relatedParty: boolean } | undefined, docType: string): AtsSale => ({
      idType,
      id,
      personType: party?.personType ?? null,
      name,
      relatedParty: party?.relatedParty ?? false,
      docType,
      emission: 'E',
      count: 0,
      baseNoGraIva: '0',
      baseImponible: '0',
      baseImpGrav: '0',
      montoIva: '0',
      montoIce: '0',
      ivaWithheld: '0',
      rentaWithheld: '0',
      paymentForms: [],
    });
    const byEstab = new Map<string, Dec>(establishments.map((e) => [e.code, new D(0)]));
    let totalSales = new D(0);
    const sTotals = { docs: 0, base: new D(0), iva: new D(0), ncDocs: 0, ncBase: new D(0) };
    let pending = 0;
    let exempt = new D(0);
    for (const s of data.sales) {
      const st = s.electronic?.status;
      if (st === 'NOT_AUTHORIZED' || st === 'RETURNED') continue;
      if (st !== 'AUTHORIZED') {
        pending++;
        continue;
      }
      const idType = SALE_ID_TYPE[s.buyerIdType] ?? '07';
      const party = partyByIdent.get(s.buyerId);
      const docType = s.docType === '04' ? '04' : '18';
      const key = `${idType}|${s.buyerId}|${docType}|E`;
      const b = bases((s.taxSummary as TaxGroup[]) ?? []);
      exempt = exempt.plus(b.exempt);
      const base = b.noGra.plus(b.zero).plus(b.exempt).plus(b.grav);
      let r = rows.get(key);
      if (!r) {
        r = emptyRow(idType, idType === '07' ? '9999999999999' : s.buyerId.slice(0, 13), s.buyerName, party, docType);
        rows.set(key, r);
      }
      r.count++;
      r.baseNoGraIva = m2(new D(r.baseNoGraIva).plus(b.noGra));
      // El módulo de ventas no tiene campo de exentos: se suman a tarifa 0 % (ver advertencia)
      r.baseImponible = m2(new D(r.baseImponible).plus(b.zero).plus(b.exempt));
      r.baseImpGrav = m2(new D(r.baseImpGrav).plus(b.grav));
      r.montoIva = m2(new D(r.montoIva).plus(b.iva));
      r.montoIce = m2(new D(r.montoIce).plus(b.ice));
      if (docType === '18') r.paymentForms = [...new Set([...r.paymentForms, ...s.payments.map((x) => x.sriCode)])];
      const signed = docType === '04' ? base.neg() : base;
      if (settings.electronicSalesInTotals) {
        totalSales = totalSales.plus(signed);
        byEstab.set(s.establishment.code, (byEstab.get(s.establishment.code) ?? new D(0)).plus(signed));
      }
      if (docType === '04') {
        sTotals.ncDocs++;
        sTotals.ncBase = sTotals.ncBase.plus(base);
      } else {
        sTotals.docs++;
        sTotals.base = sTotals.base.plus(base);
        sTotals.iva = sTotals.iva.plus(b.iva);
      }
    }
    if (pending) warn(`${pending} comprobante(s) de venta del período aún no están autorizados por el SRI y no se incluyen. Revise Comprobantes electrónicos.`, '/facturacion/comprobantes');
    if (exempt.gt(0)) warn(`Hay ventas exentas de IVA por USD ${m2(exempt)}: el módulo de ventas del ATS no tiene campo para exentos y se informan en "Base imponible tarifa 0%". Confírmelo con su contador.`);

    // Retenciones recibidas en el período: se suman a la fila de facturas del cliente
    const ret = { iva: new D(0), renta: new D(0) };
    for (const mv of data.received) {
      const party = partyById.get(mv.partyId);
      if (!party) continue;
      const items = ((mv.data as { items?: { tax: string; amount: string }[] } | null)?.items ?? []) as { tax: string; amount: string }[];
      const iva = items.filter((i) => i.tax === '2').reduce((a, i) => a.plus(i.amount), new D(0));
      const renta = items.filter((i) => i.tax === '1').reduce((a, i) => a.plus(i.amount), new D(0));
      const idType = SALE_ID_TYPE[party.idType] ?? '04';
      const key = `${idType}|${party.identification}|18|E`;
      let r = rows.get(key);
      if (!r) {
        warn(`Retención recibida de ${party.name} sin facturas de ese cliente en el período: se informa con 0 comprobantes. Revísela en el DIMM.`);
        r = emptyRow(idType, party.identification.slice(0, 13), party.name, party, '18');
        rows.set(key, r);
      }
      r.ivaWithheld = m2(new D(r.ivaWithheld).plus(iva));
      r.rentaWithheld = m2(new D(r.rentaWithheld).plus(renta));
      ret.iva = ret.iva.plus(iva);
      ret.renta = ret.renta.plus(renta);
    }

    let saleRows = [...rows.values()];
    // Sin detalle de ventas electrónicas: solo las filas que informan retenciones recibidas (Ficha ATS 2.3)
    if (!settings.includeElectronicSales) saleRows = saleRows.filter((r) => new D(r.ivaWithheld).gt(0) || new D(r.rentaWithheld).gt(0));
    for (const r of saleRows) {
      if (r.idType === '06' && !r.personType) err(`Cliente ${r.name} (${r.id}): indique si es persona natural o sociedad (pasaporte / exterior).`);
    }
    const sales = saleRows.sort((a, b) => (a.id + a.docType).localeCompare(b.id + b.docType));

    if (!establishments.length) err('No hay establecimientos activos registrados.', '/estructura');
    const report: AtsReport = {
      ruc: tenant.ruc,
      name: tenant.legalName,
      year: q.year,
      month: q.month,
      semiannual: q.semiannual,
      establishmentsCount: Math.max(establishments.length, 1),
      totalSales: m2(totalSales),
      purchases: atsPurchases,
      sales,
      salesByEstablishment: [...byEstab.entries()].map(([code, total]) => ({ code, total: m2(total) })),
      // Los comprobantes electrónicos se anulan en el portal del SRI y la Ficha ATS (2.5) los excluye
      voided: [],
    };
    const xml = buildAtsXml(report);
    const xsd = await validateAts(xml);

    const preview: AtsPreview = {
      year: q.year,
      month: q.month,
      semiannual: q.semiannual,
      fileName: atsFileName(q.year, q.month),
      from: iso(from),
      to: iso(to),
      establishmentsCount: report.establishmentsCount,
      totalSales: report.totalSales,
      purchases: { count: atsPurchases.length, base: m2(pTotals.base), iva: m2(pTotals.iva), ivaWithheld: m2(pTotals.ivaW), rentaWithheld: m2(pTotals.rentaW) },
      sales: { rows: sales.length, documents: sTotals.docs, base: m2(sTotals.base), iva: m2(sTotals.iva), ivaWithheld: m2(ret.iva), rentaWithheld: m2(ret.renta) },
      creditNotes: { documents: sTotals.ncDocs, base: m2(sTotals.ncBase) },
      salesByEstablishment: report.salesByEstablishment,
      options: { includeElectronicSales: settings.includeElectronicSales, electronicSalesInTotals: settings.electronicSalesInTotals },
      issues,
      valid: xsd.valid && !issues.some((i) => i.level === 'error'),
      xsdErrors: xsd.errors,
    };
    return { preview, xml };
  }

  /** Archivo para el DIMM (XML) o para la carga en SRI en línea (ATmmaaaa.zip). */
  async file(q: AtsQuery): Promise<{ name: string; type: string; content: Buffer }> {
    const { preview, xml } = await this.generate(q);
    if (!preview.valid) {
      const first = preview.issues.find((i) => i.level === 'error')?.message ?? preview.xsdErrors[0] ?? 'El anexo tiene errores';
      throw new UnprocessableEntityException(`No se puede generar el ATS: ${first}`);
    }
    const content = Buffer.from(xml, 'latin1');
    if (q.format === 'zip') return { name: `${preview.fileName}.zip`, type: 'application/zip', content: zipSingleFile(`${preview.fileName}.xml`, content) };
    return { name: `${preview.fileName}.xml`, type: 'application/xml', content };
  }
}

