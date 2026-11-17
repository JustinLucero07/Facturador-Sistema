import { formatSequential, nextSequential, PrismaClient, uuidv7, withContext } from '@vektra/db';
import type { EDocStatusCode, WithholdingDraft, WithholdingParsed } from '@vektra/shared-contracts';
import { buildAccessKey, buildWithholdingXml, dec, MAX_SINGLE_DOCUMENT_BYTES, money, signXades, validateAgainstXsd, WithholdingDocument, withholdingAmount } from '@vektra/sri-core';
import { recordMovement } from '@vektra/accounts';
import { loadSigningIdentity } from './certificates';
import { EInvoiceError } from './errors';
import { ecuadorDate, IssueContext, IssueResult } from './issue';
import { loadSriSettings } from './settings';

const DEAD: EDocStatusCode[] = ['NOT_AUTHORIZED', 'RETURNED'];
const TAX_LABEL: Record<string, string> = { '1': 'Renta', '2': 'IVA', '6': 'ISD' };
const parts = (d: Date) => ({ day: d.getUTCDate(), month: d.getUTCMonth() + 1, year: d.getUTCFullYear() });

/** Datos de la compra para preparar la retención (y lo último que se retuvo a ese proveedor). */
export async function withholdingDraft(prisma: PrismaClient, tenantId: string, purchaseId: string): Promise<WithholdingDraft> {
  const sustento = await prisma.sriCatalog.findMany({ where: { catalog: 'ats_sustento', active: true }, orderBy: { sortOrder: 'asc' } });
  return withContext(prisma, { tenantId }, async (tx) => {
    const p = await tx.purchase.findFirst({ where: { id: purchaseId } });
    if (!p) throw new EInvoiceError('Compra no encontrada');
    const supplier = await tx.party.findFirstOrThrow({ where: { id: p.supplierId } });
    const iva = ((p.taxSummary as { taxCode: string; amount: string }[]) ?? []).filter((g) => g.taxCode === '2').reduce((a, g) => a.plus(g.amount), dec(0));
    const docs = await tx.document.findMany({ where: { docType: '07', purchaseId }, include: { electronic: true, establishment: true, emissionPoint: true } });
    const last = await tx.document.findFirst({
      where: { docType: '07', buyerId: supplier.identification },
      orderBy: { createdAt: 'desc' },
      include: { withholdings: true },
    });
    const lastCodes = last
      ? await tx.withholdingCode.findMany({ where: { OR: last.withholdings.map((w) => ({ tax: w.tax, code: w.code })) } })
      : [];
    const lastInfo = (last?.taxSummary ?? {}) as { sustentoCode?: string; paymentCode?: string };
    return {
      purchase: {
        id: p.id,
        number: p.number,
        docType: p.docType,
        issueDate: p.issueDate.toISOString().slice(0, 10),
        supplier: { id: supplier.id, idType: supplier.idType, identification: supplier.identification, name: supplier.name, email: supplier.email },
        subtotal: p.subtotal.toFixed(2),
        iva: money(iva),
        total: p.total.toFixed(2),
      },
      // Sugerencia: datos ATS de la compra y, si no hay, los de la última retención al proveedor
      previous:
        last || p.sustentoCode
        ? {
            sustentoCode: p.sustentoCode ?? lastInfo.sustentoCode ?? '',
            paymentCode: p.paymentCode ?? lastInfo.paymentCode ?? null,
            relatedParty: p.relatedParty || supplier.relatedParty,
            items: (last?.withholdings ?? [])
              .map((w) => ({ withholdingCodeId: lastCodes.find((c) => c.tax === w.tax && c.code === w.code && c.active)?.id ?? '', percentage: w.percentage.toString() }))
              .filter((x) => x.withholdingCodeId),
          }
        : null,
      existing: docs.map((d) => ({
        id: d.id,
        number: `${d.establishment.code}-${d.emissionPoint.code}-${formatSequential(d.sequential)}`,
        total: d.total.toFixed(2),
        status: (d.electronic?.status ?? 'DRAFT') as EDocStatusCode,
      })),
      sustento: sustento.map((s) => ({ code: s.code, description: s.description })),
    };
  });
}

/**
 * Emite el comprobante de retención (07, XML ATS v2.0.0) sobre una compra registrada.
 * Los códigos y porcentajes salen del catálogo en la BD (Catálogo ATS / Tabla 20 de la Ficha);
 * las bases no pueden superar el subtotal (renta) ni el IVA (IVA) de la compra.
 */
export async function issueWithholding(prisma: PrismaClient, ctx: IssueContext, input: WithholdingParsed): Promise<IssueResult> {
  const now = ctx.now ?? new Date();
  const issueDate = ecuadorDate(now);
  const issueDay = new Date(Date.UTC(issueDate.year, issueDate.month - 1, issueDate.day));
  const settings = await loadSriSettings(prisma);
  const codes = await prisma.withholdingCode.findMany({ where: { id: { in: input.items.map((i) => i.withholdingCodeId) } } });
  const sustento = await prisma.sriCatalog.findFirst({ where: { catalog: 'ats_sustento', code: input.sustentoCode, active: true } });
  if (!sustento) throw new EInvoiceError('Sustento tributario inválido (Tabla 5 del Catálogo ATS)');
  const payment = await prisma.sriCatalog.findFirst({ where: { catalog: 'payment_method', code: input.paymentCode, active: true } });
  if (!payment) throw new EInvoiceError('Forma de pago inválida');

  return withContext(prisma, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } });
    const point = await tx.emissionPoint.findFirst({ where: { id: input.emissionPointId }, include: { establishment: true } });
    if (!point || !point.active || !point.establishment.active) throw new EInvoiceError('El punto de emisión no existe o está inactivo');
    if (point.kind === 'DESKTOP') throw new EInvoiceError('Las retenciones se emiten desde un punto de emisión web');

    const p = await tx.purchase.findFirst({ where: { id: input.purchaseId } });
    if (!p || p.status !== 'REGISTERED') throw new EInvoiceError('La compra no existe o está anulada');
    const supplier = await tx.party.findFirstOrThrow({ where: { id: p.supplierId } });
    if (supplier.idType === '07') throw new EInvoiceError('El proveedor debe estar identificado');
    const prev = await tx.document.findMany({ where: { docType: '07', purchaseId: p.id }, include: { electronic: true } });
    if (prev.some((d) => !DEAD.includes((d.electronic?.status ?? 'SIGNED') as EDocStatusCode))) {
      throw new EInvoiceError('Esta compra ya tiene un comprobante de retención vigente');
    }

    // Bases y porcentajes
    const taxGroups = (p.taxSummary as { taxCode: string; percentageCode: string; base: string; rate: string; amount: string }[]) ?? [];
    const iva = taxGroups.filter((g) => g.taxCode === '2').reduce((a, g) => a.plus(g.amount), dec(0));
    const items = input.items.map((it, k) => {
      const c = codes.find((x) => x.id === it.withholdingCodeId);
      if (!c || !c.active) throw new EInvoiceError(`Retención ${k + 1}: código inactivo o inexistente`);
      if ((c.validFrom && c.validFrom > issueDay) || (c.validTo && c.validTo < issueDay)) throw new EInvoiceError(`El código ${c.code} no está vigente`);
      if (c.residence !== 'RESIDENT') throw new EInvoiceError('Las retenciones por pagos al exterior aún no se emiten desde el sistema');
      let pct: string;
      if (c.percentage !== null) {
        pct = c.percentage.toString();
        if (it.percentage != null && !dec(it.percentage).eq(pct)) throw new EInvoiceError(`El código ${c.code} retiene el ${dec(pct).toString()}%`);
      } else {
        if (it.percentage == null) throw new EInvoiceError(`El código ${c.code} tiene porcentaje variable (${c.percentageNote ?? 'según normativa'}): ingrese el porcentaje`);
        pct = it.percentage;
      }
      if (dec(pct).gt(100)) throw new EInvoiceError('El porcentaje no puede superar 100');
      const limit = c.tax === '2' ? iva : dec(p.subtotal.toString());
      if (dec(it.base).gt(limit)) {
        throw new EInvoiceError(`La base de ${TAX_LABEL[c.tax]} (${it.base}) no puede superar ${c.tax === '2' ? 'el IVA' : 'el subtotal'} de la compra (${money(limit)})`);
      }
      return { tax: c.tax as '1' | '2' | '6', code: c.code, description: c.description, base: money(it.base), percentage: pct, amount: withholdingAmount(money(it.base), pct) };
    });
    for (const tax of ['1', '2']) {
      const sum = items.filter((i) => i.tax === tax).reduce((a, i) => a.plus(i.base), dec(0));
      const limit = tax === '2' ? iva : dec(p.subtotal.toString());
      if (sum.gt(limit)) throw new EInvoiceError(`La suma de bases de ${TAX_LABEL[tax]} supera ${tax === '2' ? 'el IVA' : 'el subtotal'} de la compra`);
    }
    // Un valor retenido de 0 (p. ej. 332 o IVA código 8) es válido: también se informa al SRI.
    const total = items.reduce((a, i) => a.plus(i.amount), dec(0));

    const identity = await loadSigningIdentity(tx, ctx.masterKey, now);
    const docType = '07';
    const sequential = await nextSequential(tx, point.id, docType);
    const environment = tenant.environment === 2 ? 2 : 1;
    const accessKey = buildAccessKey({ issueDate, docType, ruc: tenant.ruc, environment, establishment: point.establishment.code, emissionPoint: point.code, sequential });
    const additionalInfo: { name: string; value: string }[] = [];
    if (supplier.email) additionalInfo.push({ name: 'Email', value: supplier.email });
    if (settings.providerRuc) additionalInfo.push({ name: 'RUC Proveedor', value: settings.providerRuc });

    const doc: WithholdingDocument = {
      version: settings.xmlVersions[docType] ?? '2.0.0',
      environment,
      accessKey,
      establishment: point.establishment.code,
      emissionPoint: point.code,
      sequential: formatSequential(sequential),
      issueDate,
      issuer: {
        ruc: tenant.ruc,
        legalName: tenant.legalName,
        tradeName: tenant.tradeName,
        mainAddress: tenant.mainAddress,
        establishmentAddress: point.establishment.address,
        specialTaxpayerNumber: tenant.specialTaxpayerNumber,
        keepsAccounting: tenant.keepsAccounting,
        withholdingAgentNumber: tenant.withholdingAgentNumber,
        rimpeLegend: settings.rimpeLegends[tenant.taxRegime] ?? null,
      },
      subject: { idType: supplier.idType, id: supplier.identification, name: supplier.name, relatedParty: input.relatedParty },
      fiscalPeriod: { month: issueDate.month, year: issueDate.year },
      support: {
        sustentoCode: input.sustentoCode,
        docType: p.docType,
        number: p.number,
        issueDate: parts(p.issueDate),
        authorization: p.authorization,
        subtotal: p.subtotal.toFixed(2),
        total: p.total.toFixed(2),
        taxes: taxGroups.map((g) => ({ taxCode: g.taxCode, percentageCode: g.percentageCode, base: g.base, rate: g.rate, amount: g.amount })),
        payments: [{ code: input.paymentCode, amount: p.total.toFixed(2) }],
      },
      items,
      additionalInfo,
    };
    const xml = buildWithholdingXml(doc);
    const xsd = await validateAgainstXsd(xml, 'comprobanteRetencion', doc.version);
    if (!xsd.valid) throw new EInvoiceError('El comprobante de retención no cumple el esquema XSD del SRI', xsd.errors);
    const signed = signXades(xml, identity, { signingTime: now });
    if (Buffer.byteLength(signed, 'utf8') > MAX_SINGLE_DOCUMENT_BYTES) throw new EInvoiceError('El comprobante supera el tamaño máximo de 320 KB del SRI');

    const documentId = uuidv7();
    const number = `${point.establishment.code}-${point.code}-${formatSequential(sequential)}`;
    const baseSum = items.reduce((a, i) => a.plus(i.base), dec(0));
    await tx.document.create({
      data: {
        id: documentId,
        tenantId: ctx.tenantId,
        docType,
        establishmentId: point.establishmentId,
        emissionPointId: point.id,
        sequential,
        issueDate: issueDay,
        buyerIdType: supplier.idType,
        buyerId: supplier.identification,
        buyerName: supplier.name,
        buyerAddress: supplier.address,
        buyerEmail: supplier.email,
        buyerPhone: supplier.phone,
        subtotal: money(baseSum),
        totalDiscount: '0',
        totalTax: '0',
        total: money(total),
        // Para sugerir la próxima retención al mismo proveedor (no va en el XML)
        taxSummary: { sustentoCode: input.sustentoCode, paymentCode: input.paymentCode, relatedParty: input.relatedParty },
        additionalInfo,
        purchaseId: p.id,
        createdBy: ctx.userId,
      },
    });
    // Los datos ATS de la retención quedan también en la compra (anexo transaccional)
    await tx.purchase.update({ where: { id: p.id }, data: { sustentoCode: input.sustentoCode, paymentCode: input.paymentCode, relatedParty: input.relatedParty } });
    await tx.withholdingLine.createMany({
      data: items.map((i, k) => ({ id: uuidv7(), tenantId: ctx.tenantId, documentId, lineNo: k + 1, tax: i.tax, code: i.code, description: i.description, base: i.base, percentage: i.percentage, amount: i.amount })),
    });
    if (total.gt(0)) {
      const item = await tx.accountItem.findFirst({ where: { side: 'AP', sourceType: 'PURCHASE', sourceId: p.id } });
      const apply = item && item.status === 'OPEN' ? (total.lte(item.balance.toString()) ? money(total) : item.balance.toFixed(2)) : null;
      await recordMovement(tx, {
        tenantId: ctx.tenantId,
        side: 'AP',
        partyId: supplier.id,
        kind: 'WITHHOLDING',
        date: issueDay,
        amount: money(total),
        reference: number,
        documentId,
        userId: ctx.userId,
        allocations: item && apply && dec(apply).gt(0) ? [{ itemId: item.id, amount: apply }] : 'none',
      });
    }
    await tx.electronicDocument.create({
      data: { documentId, tenantId: ctx.tenantId, accessKey, environment, docType, xmlVersion: doc.version, status: 'SIGNED', signedXml: signed, emailStatus: supplier.email ? 'PENDING' : 'SKIPPED' },
    });
    await tx.electronicDocumentEvent.create({
      data: { id: uuidv7(), tenantId: ctx.tenantId, documentId, fromStatus: null, toStatus: 'SIGNED', note: `Retención sobre la compra ${p.number}: generada, validada con el XSD y firmada` },
    });
    return { documentId, accessKey, number, total: money(total) };
  });
}
