import { claimSequential, formatSequential, nextSequential, PrismaClient, Tx, uuidv7, withContext } from '@vektra/db';
import { applyMovement, defaultWarehouseId, InventoryError } from '@vektra/inventory';
import type { CreditableInvoice, CreditNoteParsed, EDocStatusCode } from '@vektra/shared-contracts';
import {
  buildAccessKey,
  buildCreditNoteXml,
  CalculationError,
  computeInvoice,
  CreditNoteDocument,
  creditLine,
  dec,
  MAX_SINGLE_DOCUMENT_BYTES,
  signXades,
  validateAgainstXsd,
} from '@vektra/sri-core';
import { recordMovement } from '@vektra/accounts';
import { loadSigningIdentity } from './certificates';
import { EInvoiceError } from './errors';
import { ecuadorDate, IssueContext, IssueResult, validateBuyer } from './issue';
import { loadSriSettings } from './settings';

/** Estados del SRI que anulan una nota de crédito para efectos del saldo acreditable. */
const DEAD: EDocStatusCode[] = ['NOT_AUTHORIZED', 'RETURNED'];

const fmtNumber = (estab: string, pto: string, seq: bigint | number) => `${estab}-${pto}-${formatSequential(seq)}`;

/** Cantidades y descuentos ya acreditados por línea de factura (notas vigentes). */
async function creditedByLine(tx: Tx, invoiceId: string): Promise<Map<string, { quantity: string; discount: string }>> {
  const rows = await tx.$queryRaw<{ source_line_id: string; quantity: string; discount: string }[]>`
    SELECT l.source_line_id, SUM(l.quantity)::text AS quantity, SUM(l.discount)::text AS discount
    FROM document_line l
    JOIN document d ON d.id = l.document_id
    LEFT JOIN electronic_document e ON e.document_id = d.id
    WHERE d.related_document_id = ${invoiceId}::uuid AND d.doc_type = '04' AND d.status = 'ISSUED'
      AND (e.status IS NULL OR e.status::text NOT IN ('NOT_AUTHORIZED', 'RETURNED'))
      AND l.source_line_id IS NOT NULL
    GROUP BY l.source_line_id`;
  return new Map(rows.map((r) => [r.source_line_id, { quantity: r.quantity, discount: r.discount }]));
}

/** Factura con lo que aún se puede devolver (para la pantalla de devolución). */
export async function creditableInvoice(prisma: PrismaClient, tenantId: string, invoiceId: string): Promise<CreditableInvoice> {
  const rates = await prisma.taxRate.findMany({ where: { taxCode: '2' } });
  return withContext(prisma, { tenantId }, async (tx) => {
    const inv = await tx.document.findFirst({
      where: { id: invoiceId, docType: '01' },
      include: {
        electronic: true,
        emissionPoint: { include: { establishment: true } },
        lines: { include: { taxes: true }, orderBy: { lineNo: 'asc' } },
        creditNotes: { include: { electronic: true, emissionPoint: { include: { establishment: true } } }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!inv) throw new EInvoiceError('Factura no encontrada');
    const credited = await creditedByLine(tx, inv.id);
    const ep = inv.emissionPoint;
    const live = inv.creditNotes.filter((n) => n.status === 'ISSUED' && !DEAD.includes((n.electronic?.status ?? 'SIGNED') as EDocStatusCode));
    return {
      id: inv.id,
      number: fmtNumber(ep.establishment.code, ep.code, inv.sequential),
      issueDate: inv.issueDate.toISOString().slice(0, 10),
      status: (inv.electronic?.status ?? 'DRAFT') as EDocStatusCode,
      buyer: { idType: inv.buyerIdType, id: inv.buyerId, name: inv.buyerName, email: inv.buyerEmail, phone: inv.buyerPhone, address: inv.buyerAddress },
      total: inv.total.toFixed(2),
      credited: live.reduce((a, n) => a.plus(n.total.toString()), dec(0)).toFixed(2),
      lines: inv.lines.map((l) => {
        const c = credited.get(l.id);
        const t = l.taxes.find((x) => x.taxCode === '2') ?? l.taxes[0];
        return {
          id: l.id,
          mainCode: l.mainCode,
          description: l.description,
          quantity: dec(l.quantity.toString()).toString(),
          unitPrice: l.unitPrice.toString(),
          discount: l.discount.toFixed(2),
          subtotal: l.subtotal.toFixed(2),
          taxLabel: t ? (rates.find((r) => r.percentageCode === t.percentageCode)?.label ?? `${Number(t.rate)}%`) : '',
          taxRate: t ? t.rate.toString() : '0',
          productId: l.productId,
          credited: dec(c?.quantity ?? 0).toString(),
          creditedDiscount: dec(c?.discount ?? 0).toFixed(2),
          remaining: dec(l.quantity.toString()).minus(c?.quantity ?? 0).toString(),
        };
      }),
      creditNotes: inv.creditNotes.map((n) => ({
        id: n.id,
        number: fmtNumber(n.emissionPoint.establishment.code, n.emissionPoint.code, n.sequential),
        total: n.total.toFixed(2),
        status: (n.electronic?.status ?? 'DRAFT') as EDocStatusCode,
        reason: n.reason,
        issueDate: n.issueDate.toISOString().slice(0, 10),
      })),
    };
  });
}

/**
 * Emite una nota de crédito (04) sobre una factura: devolución total o parcial por líneas.
 * Precio e impuestos salen de la factura (Ficha: tarifa vigente a la fecha del documento de
 * sustento); no se puede acreditar más de lo facturado. Reingresa el stock al costo con que salió
 * en esa venta y, si el reembolso es en efectivo con caja abierta, registra el egreso de caja.
 * Todo en una transacción: si algo falla, el secuencial no se consume.
 */
export async function issueCreditNote(prisma: PrismaClient, ctx: IssueContext, input: CreditNoteParsed): Promise<IssueResult> {
  const now = ctx.now ?? new Date();
  const offline = ctx.offline;
  const issueDate = ecuadorDate(offline?.issuedAt ?? now);
  const issueDateOnly = new Date(Date.UTC(issueDate.year, issueDate.month - 1, issueDate.day));
  const settings = await loadSriSettings(prisma);

  return withContext(prisma, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } });
    const point = await tx.emissionPoint.findFirst({ where: { id: input.emissionPointId }, include: { establishment: true } });
    if (!point || !point.active || !point.establishment.active) throw new EInvoiceError('El punto de emisión no existe o está inactivo');
    if (point.kind === 'DESKTOP' && !ctx.allowDesktopPoint && !offline) {
      throw new EInvoiceError('Ese punto de emisión pertenece a una caja de escritorio; elija un punto de emisión web');
    }

    const inv = await tx.document.findFirst({
      where: { id: input.invoiceId, docType: '01' },
      include: { electronic: true, emissionPoint: { include: { establishment: true } }, lines: { include: { taxes: true } } },
    });
    if (!inv || inv.status !== 'ISSUED') throw new EInvoiceError('Factura no encontrada');
    const invStatus = inv.electronic?.status;
    if (invStatus && DEAD.includes(invStatus as EDocStatusCode)) {
      throw new EInvoiceError('La factura no fue autorizada por el SRI: no se le puede emitir nota de crédito');
    }

    // Receptor: el de la factura; si fue consumidor final hay que identificarlo (Tabla 6).
    const buyer =
      inv.buyerIdType === '07'
        ? input.buyer
        : { idType: inv.buyerIdType as '04', id: inv.buyerId, name: inv.buyerName, email: input.buyer?.email ?? inv.buyerEmail, phone: inv.buyerPhone, address: inv.buyerAddress };
    if (!buyer) throw new EInvoiceError('La venta fue a consumidor final: para la nota de crédito ingrese la cédula o RUC del cliente');
    validateBuyer(buyer, settings.finalConsumer.id);

    const credited = await creditedByLine(tx, inv.id);
    const byId = new Map(inv.lines.map((l) => [l.id, l]));
    const seen = new Set<string>();
    const picked = input.lines.map((sel) => {
      const src = byId.get(sel.sourceLineId);
      if (!src) throw new EInvoiceError('Una de las líneas no pertenece a la factura');
      if (seen.has(src.id)) throw new EInvoiceError(`"${src.description}" está repetida`);
      seen.add(src.id);
      return { sel, src };
    });

    let computed;
    try {
      computed = computeInvoice(
        picked.map(({ sel, src }) => {
          const c = credited.get(src.id);
          return creditLine(
            {
              mainCode: src.mainCode,
              auxCode: src.auxCode,
              description: src.description,
              quantity: src.quantity.toString(),
              unitPrice: src.unitPrice.toString(),
              discount: src.discount.toString(),
              taxes: src.taxes.map((t) => ({ taxCode: t.taxCode, percentageCode: t.percentageCode, rate: t.rate.toString() })),
              creditedQuantity: c?.quantity ?? '0',
              creditedDiscount: c?.discount ?? '0',
            },
            sel.quantity,
          );
        }),
      );
    } catch (e) {
      if (e instanceof CalculationError) throw new EInvoiceError(e.message);
      throw e;
    }

    // Reembolso en efectivo de una caja abierta del mismo punto
    const methodDef = settings.paymentMethods.find((m) => m.method === input.refund.method);
    let refundSessionId: string | null = null;
    if (methodDef?.cash && input.refund.cashSessionId) {
      const s = await tx.cashSession.findFirst({ where: { id: input.refund.cashSessionId } });
      if (!s || (s.status !== 'OPEN' && !offline)) throw new EInvoiceError('La caja está cerrada: abra la caja para devolver el efectivo');
      refundSessionId = s.id;
    }

    const identity = await loadSigningIdentity(tx, ctx.masterKey, now);
    const docType = '04';
    let sequential: bigint;
    if (offline) {
      sequential = BigInt(offline.sequential);
      const taken = await tx.document.findFirst({ where: { emissionPointId: point.id, docType, sequential }, select: { id: true } });
      if (taken) throw new EInvoiceError(`El secuencial ${formatSequential(sequential)} ya está usado en este punto de emisión`);
      await claimSequential(tx, point.id, docType, sequential);
    } else {
      sequential = await nextSequential(tx, point.id, docType);
    }
    const environment = tenant.environment === 2 ? 2 : 1;
    const accessKey = buildAccessKey({
      issueDate,
      docType,
      ruc: tenant.ruc,
      environment,
      establishment: point.establishment.code,
      emissionPoint: point.code,
      sequential,
      ...(offline ? { numericCode: offline.accessKey.slice(39, 47) } : {}),
    });
    if (offline && offline.accessKey !== accessKey) {
      throw new EInvoiceError('La clave de acceso de la caja no coincide con la del servidor (¿cambió el RUC, el ambiente o el punto de emisión?)');
    }

    const invNumber = fmtNumber(inv.emissionPoint.establishment.code, inv.emissionPoint.code, inv.sequential);
    const invDate = { day: inv.issueDate.getUTCDate(), month: inv.issueDate.getUTCMonth() + 1, year: inv.issueDate.getUTCFullYear() };
    const additionalInfo = [{ name: 'Reembolso', value: methodDef?.label ?? input.refund.method }];
    if (buyer.email) additionalInfo.push({ name: 'Email', value: buyer.email });
    if (settings.providerRuc) additionalInfo.push({ name: 'RUC Proveedor', value: settings.providerRuc });

    const doc: CreditNoteDocument = {
      version: settings.xmlVersions[docType] ?? '1.1.0',
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
      buyer,
      modified: { docType: '01', number: invNumber, issueDate: invDate },
      reason: input.reason,
      lines: computed.lines,
      totals: computed.totals,
      additionalInfo,
      currency: settings.currency,
    };
    const xml = buildCreditNoteXml(doc);
    const xsd = await validateAgainstXsd(xml, 'notaCredito', doc.version);
    if (!xsd.valid) throw new EInvoiceError('La nota de crédito no cumple el esquema XSD del SRI', xsd.errors);
    const signed = signXades(xml, identity, { signingTime: now });
    if (Buffer.byteLength(signed, 'utf8') > MAX_SINGLE_DOCUMENT_BYTES) throw new EInvoiceError('El comprobante supera el tamaño máximo de 320 KB del SRI');

    const documentId = offline?.documentId ?? uuidv7();
    const number = fmtNumber(point.establishment.code, point.code, sequential);
    await tx.document.create({
      data: {
        id: documentId,
        tenantId: ctx.tenantId,
        docType,
        establishmentId: point.establishmentId,
        emissionPointId: point.id,
        sequential,
        issueDate: issueDateOnly,
        buyerIdType: buyer.idType,
        buyerId: buyer.id,
        buyerName: buyer.name,
        buyerAddress: buyer.address ?? null,
        buyerEmail: buyer.email ?? null,
        buyerPhone: buyer.phone ?? null,
        subtotal: computed.totals.subtotal,
        totalDiscount: computed.totals.totalDiscount,
        totalTax: computed.totals.totalTax,
        total: computed.totals.total,
        taxSummary: computed.totals.taxGroups as object[],
        additionalInfo,
        relatedDocumentId: inv.id,
        reason: input.reason,
        deviceId: offline?.deviceId ?? null,
        createdBy: ctx.userId,
        ...(offline ? { createdAt: offline.issuedAt } : {}),
      },
    });

    const warehouseId = picked.some(({ sel, src }) => sel.restock && src.productId)
      ? await defaultWarehouseId(tx, inv.establishmentId).catch((e: Error) => {
          throw new EInvoiceError(e.message);
        })
      : null;
    for (const [k, line] of computed.lines.entries()) {
      const { sel, src } = picked[k];
      await tx.documentLine.create({
        data: {
          id: uuidv7(),
          tenantId: ctx.tenantId,
          documentId,
          lineNo: k + 1,
          productId: src.productId,
          productUnitId: src.productUnitId,
          unitFactor: src.unitFactor,
          mainCode: line.mainCode,
          auxCode: line.auxCode,
          description: line.description,
          unit: src.unit,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discount: line.discount,
          subtotal: line.subtotal,
          sourceLineId: src.id,
          restock: sel.restock,
          taxes: {
            create: line.taxes.map((t, j) => ({
              id: uuidv7(),
              tenantId: ctx.tenantId,
              taxRateId: src.taxes[j]?.taxRateId ?? null,
              taxCode: t.taxCode,
              percentageCode: t.percentageCode,
              rate: t.rate,
              base: t.base,
              amount: t.amount,
            })),
          },
        },
      });
      // La mercadería vuelve al stock al costo con que salió en esa venta.
      if (sel.restock && src.productId && warehouseId) {
        const sale = await tx.inventoryMovement.findFirst({ where: { documentId: inv.id, productId: src.productId, type: 'SALE' }, select: { unitCost: true } });
        try {
          await applyMovement(tx, {
            tenantId: ctx.tenantId,
            productId: src.productId,
            warehouseId,
            type: 'SALE_RETURN',
            quantity: dec(line.quantity).times(src.unitFactor.toString()).toString(),
            unitCost: sale?.unitCost.toString() ?? null,
            allowNegative: true,
            documentId,
            reason: `Devolución NC ${number} (factura ${invNumber})`,
            userId: ctx.userId,
          });
        } catch (e) {
          if (e instanceof InventoryError) throw new EInvoiceError(e.message);
          throw e;
        }
      }
    }

    if (refundSessionId) {
      await tx.cashMovement.create({
        data: {
          id: offline?.cashMovementId ?? uuidv7(),
          tenantId: ctx.tenantId,
          sessionId: refundSessionId,
          type: 'OUT',
          amount: computed.totals.total,
          reason: `Devolución NC ${number} (factura ${invNumber})`,
          createdBy: ctx.userId as string,
          documentId,
          ...(offline ? { at: offline.issuedAt } : {}),
        },
      });
    }

    if (methodDef?.credit) {
      let party = await tx.party.findFirst({ where: { identification: buyer.id } });
      if (!party) {
        party = await tx.party.create({
          data: { id: uuidv7(), tenantId: ctx.tenantId, idType: buyer.idType, identification: buyer.id, name: buyer.name, email: buyer.email ?? null, isCustomer: true },
        });
      }
      const invItem = await tx.accountItem.findFirst({ where: { side: 'AR', sourceType: 'INVOICE', sourceId: inv.id, status: 'OPEN', partyId: party.id } });
      const toInvoice = invItem ? dec(computed.totals.total).lte(invItem.balance.toString()) ? computed.totals.total : invItem.balance.toFixed(2) : null;
      await recordMovement(tx, {
        tenantId: ctx.tenantId,
        side: 'AR',
        partyId: party.id,
        kind: 'CREDIT_NOTE',
        date: issueDateOnly,
        amount: computed.totals.total,
        reference: number,
        documentId,
        userId: ctx.userId,
        allocations: invItem && toInvoice ? [{ itemId: invItem.id, amount: toInvoice }] : 'none',
      });
    }

    await tx.electronicDocument.create({
      data: {
        documentId,
        tenantId: ctx.tenantId,
        accessKey,
        environment,
        docType,
        xmlVersion: doc.version,
        status: 'SIGNED',
        signedXml: signed,
        emailStatus: buyer.email ? 'PENDING' : 'SKIPPED',
      },
    });
    await tx.electronicDocumentEvent.create({
      data: {
        id: uuidv7(),
        tenantId: ctx.tenantId,
        documentId,
        fromStatus: null,
        toStatus: 'SIGNED',
        note: `Nota de crédito sobre la factura ${invNumber}: generada, validada con el XSD y firmada`,
      },
    });
    return { documentId, accessKey, number, total: computed.totals.total };
  });
}
