import { claimSequential, formatSequential, nextSequential, PrismaClient, uuidv7, withContext } from '@vektra/db';
import type { IssueInvoiceParsed } from '@vektra/shared-contracts';
import { validateCedula, validateRuc } from '@vektra/shared-domain';
import {
  assertPaymentsMatch,
  buildAccessKey,
  buildInvoiceXml,
  CalculationError,
  computeInvoice,
  dec,
  InvoiceDocument,
  MAX_SINGLE_DOCUMENT_BYTES,
  signXades,
  validateAgainstXsd,
} from '@vektra/sri-core';
import { allowsNegativeStock, applyMovement, defaultWarehouseId, InventoryError, toBaseUnits } from '@vektra/inventory';
import { loadSigningIdentity } from './certificates';
import { EInvoiceError } from './errors';
import { loadSriSettings } from './settings';

export interface IssueContext {
  tenantId: string;
  userId: string | null;
  masterKey: string;
  now?: Date;
  /** La caja de escritorio emite desde su propio punto DESKTOP (Fase 4). */
  allowDesktopPoint?: boolean;
  /**
   * Factura hecha SIN CONEXIÓN en una caja de escritorio y recibida al sincronizar. La venta ya
   * ocurrió y el cliente tiene su ticket: se respetan el id, el secuencial, la fecha de emisión y la
   * clave de acceso de la caja, y no se rechaza por stock insuficiente ni por productos desactivados
   * después de la venta. Se firma aquí (el .p12 nunca sale del servidor).
   */
  offline?: { documentId: string; deviceId: string; sequential: number; issuedAt: Date; accessKey: string };
}

export interface IssueResult {
  documentId: string;
  accessKey: string;
  number: string;
  total: string;
}

/** Fecha calendario en Ecuador continental. */
export function ecuadorDate(now = new Date()): { day: number; month: number; year: number } {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now)
    .split('-')
    .map(Number);
  return { day, month, year };
}

function validateBuyer(b: IssueInvoiceParsed['buyer'], finalConsumerId: string): void {
  if (b.idType === '07') {
    if (b.id !== finalConsumerId) throw new EInvoiceError(`Para consumidor final la identificación es ${finalConsumerId}`);
    return;
  }
  if (b.id === finalConsumerId) throw new EInvoiceError('La identificación 9999999999999 solo se usa con el tipo "Consumidor final"');
  if (b.idType === '04') {
    const r = validateRuc(b.id);
    if (!r.valid) throw new EInvoiceError(`RUC del cliente inválido: ${r.error}`);
  }
  if (b.idType === '05') {
    const r = validateCedula(b.id);
    if (!r.valid) throw new EInvoiceError(`Cédula del cliente inválida: ${r.error}`);
  }
}

/**
 * Emite una factura electrónica: calcula, reserva el secuencial, genera el XML, lo valida contra el XSD,
 * lo firma (XAdES-BES) y lo guarda en estado FIRMADO. Todo en una transacción: si algo falla, el
 * secuencial no se consume. El envío al SRI lo hace el worker.
 */
export async function issueInvoice(prisma: PrismaClient, ctx: IssueContext, input: IssueInvoiceParsed): Promise<IssueResult> {
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

    // Tarifas vigentes (desde la BD: cambiar una tarifa no requiere tocar código)
    const rateIds = [...new Set(input.lines.map((l) => l.taxRateId))];
    const rates = await tx.taxRate.findMany({ where: { id: { in: rateIds } } });
    const rateById = new Map(rates.map((r) => [r.id, r]));
    for (const id of rateIds) {
      const r = rateById.get(id);
      const valid = r && r.active && (!r.validFrom || r.validFrom <= issueDateOnly) && (!r.validTo || r.validTo >= issueDateOnly);
      if (!valid) throw new EInvoiceError('Una de las tarifas de impuesto seleccionadas no está vigente');
    }

    validateBuyer(input.buyer, settings.finalConsumer.id);

    // Venta de caja (POS): la sesión debe estar abierta y ser de este punto de emisión.
    if (input.cashSessionId) {
      const session = await tx.cashSession.findFirst({ where: { id: input.cashSessionId } });
      if (!session) throw new EInvoiceError('La caja de esta venta no existe');
      // Sin conexión la caja pudo cerrarse antes de sincronizar: basta con que la sesión exista.
      if (session.status !== 'OPEN' && !offline) throw new EInvoiceError('La caja está cerrada. Abra la caja para seguir vendiendo.');
      if (session.emissionPointId !== point.id) throw new EInvoiceError('La caja abierta no corresponde a este punto de emisión');
    }
    // Medios de pago: el código SRI sale del parámetro payment_methods (no lo decide el cliente).
    const methodDefs = new Map(settings.paymentMethods.map((m) => [m.method, m]));
    const payments = input.payments.map((p) => {
      const def = methodDefs.get(p.method);
      if (def?.credit && input.buyer.idType === '07') throw new EInvoiceError('Las ventas a crédito requieren un cliente identificado');
      return { ...p, sriCode: def?.sriCode ?? p.sriCode };
    });
    let quoteId = input.quoteId ?? null;
    if (quoteId) {
      const quote = await tx.quote.findFirst({ where: { id: quoteId } });
      if (offline) {
        // La venta ya se hizo: si la proforma no existe o ya se facturó, solo no se enlaza.
        if (!quote || quote.documentId) quoteId = null;
      } else {
        if (!quote) throw new EInvoiceError('Proforma no encontrada');
        if (quote.documentId) throw new EInvoiceError('Esta proforma ya fue facturada');
      }
    }

    // Productos del catálogo: deben existir en la empresa (RLS) y estar activos; factor de la presentación.
    const productIds = [...new Set(input.lines.map((l) => l.productId).filter((x): x is string => !!x))];
    const products = productIds.length
      ? await tx.product.findMany({ where: { id: { in: productIds } }, include: { units: true } })
      : [];
    const productById = new Map(products.map((p) => [p.id, p]));
    const lineFactors = input.lines.map((l, i) => {
      if (!l.productId) return '1';
      const p = productById.get(l.productId);
      if (!p || (!p.active && !offline)) throw new EInvoiceError(`Línea ${i + 1}: el producto no existe o está inactivo`);
      if (!l.productUnitId) return '1';
      const pu = p.units.find((u) => u.id === l.productUnitId);
      if (!pu) throw new EInvoiceError(`Línea ${i + 1}: la presentación no corresponde al producto`);
      return pu.factor.toString();
    });

    let computed;
    try {
      computed = computeInvoice(
        input.lines.map((l) => {
          const r = rateById.get(l.taxRateId)!;
          return {
            mainCode: l.mainCode,
            auxCode: l.auxCode,
            description: l.description,
            unit: l.unit,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discount: l.discount ?? '0',
            taxes: [{ taxCode: r.taxCode, percentageCode: r.percentageCode, rate: r.rate.toString() }],
            additional: l.additional,
          };
        }),
        { tip: input.tip ?? '0' },
      );
      assertPaymentsMatch(payments, computed.totals.total);
    } catch (e) {
      if (e instanceof CalculationError) throw new EInvoiceError(e.message);
      throw e;
    }

    if (input.buyer.idType === '07' && dec(computed.totals.total).gt(settings.finalConsumer.maxAmount)) {
      throw new EInvoiceError(
        `Las facturas a consumidor final no pueden superar $${settings.finalConsumer.maxAmount}. Identifique al cliente con cédula o RUC.`,
      );
    }

    const identity = await loadSigningIdentity(tx, ctx.masterKey, now);
    const docType = '01';
    let sequential: bigint;
    if (offline) {
      sequential = BigInt(offline.sequential);
      const taken = await tx.document.findFirst({ where: { emissionPointId: point.id, docType, sequential }, select: { id: true } });
      if (taken) throw new EInvoiceError(`El secuencial ${formatSequential(sequential)} ya está usado en este punto de emisión`);
      await claimSequential(tx, point.id, docType, sequential);
    } else {
      sequential = await nextSequential(tx, point.id, docType);
    }
    const accessKey = buildAccessKey({
      issueDate,
      docType,
      ruc: tenant.ruc,
      environment: tenant.environment === 2 ? 2 : 1,
      establishment: point.establishment.code,
      emissionPoint: point.code,
      sequential,
      // Sin conexión: el código numérico (8 dígitos, posiciones 40-47) lo generó la caja.
      ...(offline ? { numericCode: offline.accessKey.slice(39, 47) } : {}),
    });

    if (offline && offline.accessKey !== accessKey) {
      throw new EInvoiceError('La clave de acceso de la caja no coincide con la del servidor (¿cambió el RUC, el ambiente o el punto de emisión?)');
    }

    const additionalInfo = [...(input.additionalInfo ?? [])];
    if (input.buyer.email) additionalInfo.push({ name: 'Email', value: input.buyer.email });
    if (input.buyer.phone) additionalInfo.push({ name: 'Teléfono', value: input.buyer.phone });
    if (settings.providerRuc) additionalInfo.push({ name: 'RUC Proveedor', value: settings.providerRuc });
    if (additionalInfo.length > 15) throw new EInvoiceError('Máximo 15 campos de información adicional');

    const buyerName = input.buyer.idType === '07' ? settings.finalConsumer.name : input.buyer.name;
    const doc: InvoiceDocument = {
      version: settings.xmlVersions[docType] ?? '1.1.0',
      environment: tenant.environment === 2 ? 2 : 1,
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
      buyer: { ...input.buyer, name: buyerName },
      lines: computed.lines,
      totals: computed.totals,
      payments: payments.map((p) => ({ code: p.sriCode, amount: dec(p.amount).toFixed(2), term: p.term != null ? String(p.term) : null, timeUnit: p.timeUnit })),
      additionalInfo,
      currency: settings.currency,
    };

    const xml = buildInvoiceXml(doc);
    const xsd = await validateAgainstXsd(xml, 'factura', doc.version);
    if (!xsd.valid) throw new EInvoiceError('El comprobante no cumple el esquema XSD del SRI', xsd.errors);
    const signed = signXades(xml, identity, { signingTime: now });
    if (Buffer.byteLength(signed, 'utf8') > MAX_SINGLE_DOCUMENT_BYTES) {
      throw new EInvoiceError('El comprobante supera el tamaño máximo de 320 KB del SRI. Divida la venta en varias facturas.');
    }

    const documentId = offline?.documentId ?? uuidv7();
    await tx.document.create({
      data: {
        id: documentId,
        tenantId: ctx.tenantId,
        docType,
        establishmentId: point.establishmentId,
        emissionPointId: point.id,
        sequential,
        issueDate: issueDateOnly,
        buyerIdType: input.buyer.idType,
        buyerId: input.buyer.id,
        buyerName,
        buyerAddress: input.buyer.address ?? null,
        buyerEmail: input.buyer.email ?? null,
        buyerPhone: input.buyer.phone ?? null,
        subtotal: computed.totals.subtotal,
        totalDiscount: computed.totals.totalDiscount,
        totalTax: computed.totals.totalTax,
        tip: computed.totals.tip,
        total: computed.totals.total,
        taxSummary: computed.totals.taxGroups as object[],
        additionalInfo,
        cashSessionId: input.cashSessionId ?? null,
        deviceId: offline?.deviceId ?? null,
        createdBy: ctx.userId,
        ...(offline ? { createdAt: offline.issuedAt } : {}),
      },
    });
    for (const [k, line] of computed.lines.entries()) {
      const lineId = uuidv7();
      await tx.documentLine.create({
        data: {
          id: lineId,
          tenantId: ctx.tenantId,
          documentId,
          lineNo: k + 1,
          productId: input.lines[k].productId ?? null,
          productUnitId: input.lines[k].productUnitId ?? null,
          unitFactor: lineFactors[k],
          mainCode: line.mainCode,
          auxCode: line.auxCode,
          description: line.description,
          unit: line.unit,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discount: line.discount,
          subtotal: line.subtotal,
          additional: line.additional,
          taxes: {
            create: line.taxes.map((t) => ({
              id: uuidv7(),
              tenantId: ctx.tenantId,
              taxRateId: input.lines[k].taxRateId,
              taxCode: t.taxCode,
              percentageCode: t.percentageCode,
              rate: t.rate,
              base: t.base,
              amount: t.amount,
            })),
          },
        },
      });
    }
    // Descargo de inventario (bodega principal del establecimiento)
    if (productIds.length) {
      const warehouseId = await defaultWarehouseId(tx, point.establishmentId).catch((e: Error) => {
        throw new EInvoiceError(e.message);
      });
      // Una venta hecha sin conexión ya ocurrió: se registra aunque deje el stock negativo.
      const allowNegative = offline ? true : await allowsNegativeStock(tx, ctx.tenantId);
      for (const [k, l] of input.lines.entries()) {
        if (!l.productId) continue;
        try {
          await applyMovement(tx, {
            tenantId: ctx.tenantId,
            productId: l.productId,
            warehouseId,
            type: 'SALE',
            quantity: toBaseUnits(computed.lines[k].quantity, lineFactors[k]),
            allowNegative,
            documentId,
            reason: `Factura ${point.establishment.code}-${point.code}-${formatSequential(sequential)}${offline ? ' (caja sin conexión)' : ''}`,
            userId: ctx.userId,
          });
        } catch (e) {
          if (e instanceof InventoryError) throw new EInvoiceError(e.message);
          throw e;
        }
      }
    }

    await tx.documentPayment.createMany({
      data: payments.map((p) => ({
        id: uuidv7(),
        tenantId: ctx.tenantId,
        documentId,
        sriCode: p.sriCode,
        method: p.method,
        amount: dec(p.amount).toFixed(2),
        term: p.term ?? null,
        timeUnit: p.timeUnit ?? null,
        reference: p.reference ?? null,
        cashReceived: p.cashReceived ?? null,
      })),
    });
    if (quoteId) await tx.quote.update({ where: { id: quoteId }, data: { documentId } });
    await tx.electronicDocument.create({
      data: {
        documentId,
        tenantId: ctx.tenantId,
        accessKey,
        environment: doc.environment,
        docType,
        xmlVersion: doc.version,
        status: 'SIGNED',
        signedXml: signed,
        emailStatus: input.buyer.email && input.buyer.idType !== '07' ? 'PENDING' : 'SKIPPED',
      },
    });
    await tx.electronicDocumentEvent.create({
      data: { id: uuidv7(), tenantId: ctx.tenantId, documentId, fromStatus: null, toStatus: 'SIGNED', note: offline ? 'Venta de caja sin conexión recibida al sincronizar; XML generado, validado con el XSD y firmado' : 'Comprobante generado, validado con el XSD y firmado' },
    });

    return {
      documentId,
      accessKey,
      number: `${point.establishment.code}-${point.code}-${formatSequential(sequential)}`,
      total: computed.totals.total,
    };
  });
}
