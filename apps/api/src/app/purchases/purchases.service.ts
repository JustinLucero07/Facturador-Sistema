import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, Tx, uuidv7 } from '@vektra/db';
import { AccountsError, addDays, createItem, recordMovement } from '@vektra/accounts';
import { loadSriSettings } from '@vektra/einvoice';
import { allowsNegativeStock, applyMovement, InventoryError, toBaseUnits } from '@vektra/inventory';
import type { Paginated, PurchaseAtsCatalogs, PurchaseAtsRequest, PurchaseDetail, PurchaseListItem, PurchaseParsed, PurchaseXmlPreview } from '@vektra/shared-contracts';
import { validateCedula, validateRuc } from '@vektra/shared-domain';
import { CalculationError, computeInvoice, dec, parseInvoiceXml } from '@vektra/sri-core';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/request-context';

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Compras a proveedores: suman stock y actualizan el costo promedio (kárdex PURCHASE).
 * El costo que entra al kárdex es el neto sin IVA (subtotal de la línea ÷ unidades base).
 */
@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private ctx() {
    const c = currentContext();
    return { tenantId: c.tenantId as string, userId: c.userId as string };
  }

  async list(q: { search?: string; page: number; pageSize: number }): Promise<Paginated<PurchaseListItem>> {
    const s = q.search?.trim();
    const where: Prisma.PurchaseWhereInput = s ? { OR: [{ number: { contains: s } }, { authorization: { contains: s } }] } : {};
    const [total, rows] = await this.prisma.tx((tx) =>
      Promise.all([
        tx.purchase.count({ where }),
        tx.purchase.findMany({ where, orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { _count: { select: { lines: true } } } }),
      ]),
    );
    const parties = await this.suppliers(rows.map((r) => r.supplierId));
    let items = rows.map((r) => this.listItem(r, parties.get(r.supplierId), r._count.lines));
    if (s && !items.length) {
      // Búsqueda por proveedor
      const sup = await this.prisma.tx((tx) => tx.party.findMany({ where: { OR: [{ name: { contains: s, mode: 'insensitive' } }, { identification: { contains: s } }] }, select: { id: true } }));
      if (sup.length) {
        const more = await this.prisma.tx((tx) =>
          tx.purchase.findMany({ where: { supplierId: { in: sup.map((x) => x.id) } }, orderBy: { issueDate: 'desc' }, take: q.pageSize, include: { _count: { select: { lines: true } } } }),
        );
        const p2 = await this.suppliers(more.map((r) => r.supplierId));
        items = more.map((r) => this.listItem(r, p2.get(r.supplierId), r._count.lines));
        return { total: items.length, page: 1, pageSize: q.pageSize, items };
      }
    }
    return { total, page: q.page, pageSize: q.pageSize, items };
  }

  private async suppliers(ids: string[]) {
    const rows = await this.prisma.tx((tx) => tx.party.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true, identification: true } }));
    return new Map(rows.map((r) => [r.id, r]));
  }

  private listItem(
    r: { id: string; supplierId: string; docType: string; number: string; issueDate: Date; total: Prisma.Decimal; status: string; fromXml: boolean; createdAt: Date },
    sup: { name: string; identification: string } | undefined,
    lines: number,
  ): PurchaseListItem {
    return {
      id: r.id,
      supplierId: r.supplierId,
      supplierName: sup?.name ?? '—',
      supplierIdentification: sup?.identification ?? '',
      docType: r.docType,
      number: r.number,
      issueDate: fmtDate(r.issueDate),
      total: r.total.toFixed(2),
      status: r.status as PurchaseListItem['status'],
      lines,
      fromXml: r.fromXml,
      createdAt: r.createdAt.toISOString(),
    };
  }

  async detail(id: string): Promise<PurchaseDetail> {
    const r = await this.prisma.tx((tx) => tx.purchase.findFirst({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } } } }));
    if (!r) throw new NotFoundException('Compra no encontrada');
    const [sup, wh, products, rates] = await Promise.all([
      this.suppliers([r.supplierId]),
      this.prisma.tx((tx) => tx.warehouse.findFirst({ where: { id: r.warehouseId }, select: { name: true } })),
      this.prisma.tx((tx) => tx.product.findMany({ where: { id: { in: r.lines.map((l) => l.productId).filter((x): x is string => !!x) } }, select: { id: true, code: true, name: true } })),
      this.prisma.client.taxRate.findMany({ where: { taxCode: '2' } }),
    ]);
    const label = (code: string) => rates.find((x) => x.percentageCode === code)?.label ?? code;
    const summary = (r.taxSummary as { percentageCode: string; base: string; amount: string }[]) ?? [];
    const payable = await this.prisma.tx((tx) => tx.accountItem.findFirst({ where: { side: 'AP', sourceType: 'PURCHASE', sourceId: r.id } }));
    return {
      ...this.listItem(r, sup.get(r.supplierId), r.lines.length),
      payable: payable ? { dueDate: payable.dueDate.toISOString().slice(0, 10), balance: payable.balance.toFixed(2), status: payable.status as 'OPEN' | 'PAID' | 'VOID' } : null,
      authorization: r.authorization,
      sustentoCode: r.sustentoCode,
      paymentCode: r.paymentCode,
      relatedParty: r.relatedParty,
      warehouse: wh?.name ?? '',
      subtotal: r.subtotal.toFixed(2),
      totalDiscount: r.totalDiscount.toFixed(2),
      totalTax: r.totalTax.toFixed(2),
      taxSummary: summary.map((g) => ({ label: label(g.percentageCode), base: g.base, amount: g.amount })),
      notes: r.notes,
      voidReason: r.voidReason,
      items: r.lines.map((l) => {
        const p = products.find((x) => x.id === l.productId);
        return {
          description: l.description,
          supplierCode: l.supplierCode,
          product: p ? { id: p.id, code: p.code, name: p.name } : null,
          quantity: dec(l.quantity.toString()).toString(),
          unitCost: dec(l.unitCost.toString()).toString(),
          discount: l.discount.toFixed(2),
          subtotal: l.subtotal.toFixed(2),
          taxLabel: label(l.percentageCode),
        };
      }),
    };
  }

  /** Lee el XML autorizado de la factura del proveedor y propone las líneas (no guarda nada). */
  async xmlPreview(xml: string): Promise<PurchaseXmlPreview> {
    const { tenantId } = this.ctx();
    let inv;
    try {
      inv = parseInvoiceXml(xml);
    } catch {
      throw new UnprocessableEntityException('El archivo no es una factura electrónica XML del SRI');
    }
    const tenant = await this.prisma.client.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const rates = await this.prisma.client.taxRate.findMany({ where: { taxCode: '2', active: true } });
    const number = `${inv.establishment}-${inv.emissionPoint}-${inv.sequential.padStart(9, '0')}`;
    const pad = (n: number) => String(n).padStart(2, '0');
    const issueDate = `${inv.issueDate.year}-${pad(inv.issueDate.month)}-${pad(inv.issueDate.day)}`;

    return this.prisma.tx(async (tx) => {
      const supplier = await tx.party.findFirst({ where: { identification: inv.issuer.ruc } });
      const duplicate = supplier ? !!(await tx.purchase.findFirst({ where: { supplierId: supplier.id, docType: '01', number }, select: { id: true } })) : false;
      const codes = inv.lines.map((l) => l.mainCode).filter((x): x is string => !!x);
      const [remembered, byCode, byBarcode] = await Promise.all([
        supplier ? tx.supplierProductCode.findMany({ where: { supplierId: supplier.id, supplierCode: { in: codes } } }) : Promise.resolve([]),
        tx.product.findMany({ where: { code: { in: codes }, active: true }, select: { id: true, code: true, name: true } }),
        tx.productBarcode.findMany({ where: { barcode: { in: codes } }, include: { product: { select: { id: true, code: true, name: true } } } }),
      ]);
      const rememberedProducts = await tx.product.findMany({ where: { id: { in: remembered.map((r) => r.productId) } }, select: { id: true, code: true, name: true } });

      const lines = inv.lines.map((l) => {
        const iva = l.taxes.find((t) => t.taxCode === '2') ?? l.taxes[0];
        const rate = iva ? rates.find((r) => r.percentageCode === iva.percentageCode) : undefined;
        const code = l.mainCode;
        let match: PurchaseXmlPreview['lines'][number]['match'] = null;
        const rem = code ? remembered.find((r) => r.supplierCode === code) : undefined;
        const remP = rem ? rememberedProducts.find((p) => p.id === rem.productId) : undefined;
        if (rem && remP) match = { productId: remP.id, productUnitId: rem.productUnitId, code: remP.code, name: remP.name, by: 'remembered' };
        else if (code) {
          const c = byCode.find((p) => p.code.toLowerCase() === code.toLowerCase());
          const b = byBarcode.find((x) => x.barcode === code);
          if (c) match = { productId: c.id, productUnitId: null, code: c.code, name: c.name, by: 'code' };
          else if (b) match = { productId: b.product.id, productUnitId: b.productUnitId, code: b.product.code, name: b.product.name, by: 'barcode' };
        }
        return {
          supplierCode: code,
          description: l.description,
          quantity: dec(l.quantity).toString(),
          unitCost: dec(l.unitPrice).toString(),
          discount: l.discount,
          subtotal: l.subtotal,
          percentageCode: iva?.percentageCode ?? '',
          taxRateId: rate?.id ?? null,
          taxLabel: rate?.label ?? (iva ? `${Number(iva.rate)}%` : ''),
          match,
        };
      });
      return {
        supplier: { idType: '04', identification: inv.issuer.ruc, name: inv.issuer.legalName, address: inv.issuer.mainAddress, id: supplier?.id ?? null },
        buyerMismatch: inv.buyer.id !== tenant.ruc ? `La factura está emitida a ${inv.buyer.name} (${inv.buyer.id}), no a esta empresa (${tenant.ruc}).` : null,
        docType: '01',
        number,
        authorization: inv.accessKey,
        issueDate,
        duplicate,
        paymentCode: inv.payments[0]?.code ?? null,
        lines,
        totals: { subtotal: inv.totals.subtotal, tax: inv.totals.totalTax, total: inv.totals.total },
      };
    });
  }

  async create(input: PurchaseParsed): Promise<{ id: string }> {
    const { tenantId, userId } = this.ctx();
    const rates = await this.prisma.client.taxRate.findMany({ where: { id: { in: [...new Set(input.lines.map((l) => l.taxRateId))] } } });
    const rateById = new Map(rates.map((r) => [r.id, r]));
    let computed;
    try {
      computed = computeInvoice(
        input.lines.map((l) => {
          const r = rateById.get(l.taxRateId);
          if (!r) throw new CalculationError('Tarifa de IVA inválida');
          return { description: l.description, quantity: l.quantity, unitPrice: l.unitCost, discount: l.discount, taxes: [{ taxCode: r.taxCode, percentageCode: r.percentageCode, rate: r.rate.toString() }] };
        }),
      );
    } catch (e) {
      throw new UnprocessableEntityException((e as Error).message);
    }
    if (input.newSupplier && (input.newSupplier.idType === '04' || input.newSupplier.idType === '05')) {
      const v = input.newSupplier.idType === '04' ? validateRuc(input.newSupplier.identification) : validateCedula(input.newSupplier.identification);
      if (!v.valid) throw new UnprocessableEntityException(`Identificación del proveedor inválida: ${v.error}`);
    }

    const id = uuidv7();
    await this.prisma
      .tx(async (tx) => {
        const supplierId = await this.resolveSupplier(tx, tenantId, input);
        if (await tx.purchase.findFirst({ where: { supplierId, docType: input.docType, number: input.number }, select: { id: true } })) {
          throw new ConflictException(`La factura ${input.number} de este proveedor ya fue registrada`);
        }
        const wh = await tx.warehouse.findFirst({ where: { id: input.warehouseId, active: true } });
        if (!wh) throw new NotFoundException('Bodega no encontrada');

        // Presentaciones: factor para convertir a unidades base
        const productIds = [...new Set(input.lines.map((l) => l.productId).filter((x): x is string => !!x))];
        const products = await tx.product.findMany({ where: { id: { in: productIds } }, include: { units: true } });
        const factors = input.lines.map((l, i) => {
          if (!l.productId) return '1';
          const p = products.find((x) => x.id === l.productId);
          if (!p) throw new UnprocessableEntityException(`Línea ${i + 1}: producto no encontrado`);
          if (!l.productUnitId) return '1';
          const u = p.units.find((x) => x.id === l.productUnitId);
          if (!u) throw new UnprocessableEntityException(`Línea ${i + 1}: la presentación no corresponde al producto`);
          return u.factor.toString();
        });

        await tx.purchase.create({
          data: {
            id,
            tenantId,
            supplierId,
            docType: input.docType,
            number: input.number,
            authorization: input.authorization ?? null,
            issueDate: new Date(`${input.issueDate}T00:00:00Z`),
            warehouseId: wh.id,
            subtotal: computed.totals.subtotal,
            totalDiscount: computed.totals.totalDiscount,
            totalTax: computed.totals.totalTax,
            total: computed.totals.total,
            taxSummary: computed.totals.taxGroups as object[],
            notes: input.notes ?? null,
            fromXml: input.fromXml,
            sustentoCode: input.sustentoCode ?? null,
            paymentCode: input.paymentCode ?? (input.payment.mode === 'CASH' ? await this.sriPaymentCode(input.payment.method ?? 'efectivo') : null),
            relatedParty: input.relatedParty ?? (await tx.party.findFirst({ where: { id: supplierId }, select: { relatedParty: true } }))?.relatedParty ?? false,
            createdBy: userId,
          },
        });
        for (const [k, l] of computed.lines.entries()) {
          const src = input.lines[k];
          const t = l.taxes[0];
          await tx.purchaseLine.create({
            data: {
              id: uuidv7(),
              tenantId,
              purchaseId: id,
              lineNo: k + 1,
              productId: src.productId ?? null,
              productUnitId: src.productUnitId ?? null,
              unitFactor: factors[k],
              supplierCode: src.supplierCode ?? null,
              description: l.description,
              quantity: l.quantity,
              unitCost: l.unitPrice,
              discount: l.discount,
              subtotal: l.subtotal,
              taxCode: t.taxCode,
              percentageCode: t.percentageCode,
              taxRate: t.rate,
              taxAmount: t.amount,
            },
          });
          if (src.productId) {
            const baseQty = toBaseUnits(l.quantity, factors[k]);
            // Costo neto (con descuento, sin IVA) por unidad base
            const unitCost = dec(l.subtotal).div(baseQty).toDecimalPlaces(6).toString();
            try {
              await applyMovement(tx, {
                tenantId,
                productId: src.productId,
                warehouseId: wh.id,
                type: 'PURCHASE',
                quantity: baseQty,
                unitCost,
                allowNegative: true,
                documentId: id,
                reason: `Compra ${input.number}`,
                userId,
              });
            } catch (e) {
              if (e instanceof InventoryError) throw new UnprocessableEntityException(e.message);
              throw e;
            }
            if (input.rememberCodes && src.supplierCode) {
              await tx.supplierProductCode.upsert({
                where: { supplierId_supplierCode: { supplierId, supplierCode: src.supplierCode } },
                create: { tenantId, supplierId, supplierCode: src.supplierCode, productId: src.productId, productUnitId: src.productUnitId ?? null },
                update: { productId: src.productId, productUnitId: src.productUnitId ?? null },
              });
            }
          }
        }
        // Cuenta por pagar (Fase 7): a crédito queda hasta su vencimiento; al contado se paga en el acto.
        const supplier = await tx.party.findFirstOrThrow({ where: { id: supplierId } });
        const issueDay = new Date(`${input.issueDate}T00:00:00Z`);
        const dueDate = input.payment.mode === 'CREDIT' && input.payment.dueDate ? new Date(`${input.payment.dueDate}T00:00:00Z`) : addDays(issueDay, input.payment.mode === 'CREDIT' ? supplier.creditDays : 0);
        const itemId = await createItem(tx, {
          tenantId,
          side: 'AP',
          partyId: supplierId,
          sourceType: 'PURCHASE',
          sourceId: id,
          number: input.number,
          issueDate: issueDay,
          dueDate,
          amount: computed.totals.total,
          userId,
        }).catch((e) => {
          if (e instanceof AccountsError) throw new UnprocessableEntityException(e.message);
          throw e;
        });
        if (input.payment.mode === 'CASH') {
          await this.payNow(tx, tenantId, userId, supplierId, itemId, computed.totals.total, input.payment.method ?? 'efectivo', input.payment.cashSessionId ?? null, `Pago compra ${input.number}`);
        }
        await this.audit.record(tx, { action: 'create', entity: 'purchase', entityId: id, after: { number: input.number, total: computed.totals.total, supplierId, fromXml: input.fromXml, payment: input.payment.mode } });
      })
      .catch((e) => {
        if ((e as { code?: string }).code === 'P2002') throw new ConflictException(`La factura ${input.number} de este proveedor ya fue registrada`);
        throw e;
      });
    return { id };
  }

  /** Pago inmediato de una compra al contado; en efectivo con caja abierta sale de esa caja. */
  /** Forma de pago del SRI (Tabla 24 = ATS Tabla 13) del medio de pago interno (parámetro payment_methods). */
  private async sriPaymentCode(method: string): Promise<string | null> {
    const settings = await loadSriSettings(this.prisma.client);
    return settings.paymentMethods.find((m) => m.method === method)?.sriCode ?? null;
  }

  async atsCatalogs(): Promise<PurchaseAtsCatalogs> {
    const rows = await this.prisma.client.sriCatalog.findMany({ where: { catalog: { in: ['ats_sustento', 'payment_method'] }, active: true }, orderBy: { sortOrder: 'asc' } });
    const pick = (c: string) => rows.filter((r) => r.catalog === c).map((r) => ({ code: r.code, description: r.description }));
    return { sustento: pick('ats_sustento'), paymentForms: pick('payment_method') };
  }

  /** Corrige sustento, forma de pago y parte relacionada (datos del ATS) de una compra registrada. */
  async updateAts(id: string, input: PurchaseAtsRequest): Promise<void> {
    const sustento = await this.prisma.client.sriCatalog.findFirst({ where: { catalog: 'ats_sustento', code: input.sustentoCode, active: true } });
    if (!sustento) throw new UnprocessableEntityException('Sustento tributario inválido');
    if (input.paymentCode) {
      const pay = await this.prisma.client.sriCatalog.findFirst({ where: { catalog: 'payment_method', code: input.paymentCode, active: true } });
      if (!pay) throw new UnprocessableEntityException('Forma de pago inválida');
    }
    await this.prisma.tx(async (tx) => {
      const before = await tx.purchase.findFirst({ where: { id }, select: { sustentoCode: true, paymentCode: true, relatedParty: true, status: true } });
      if (!before) throw new NotFoundException('Compra no encontrada');
      const data = { sustentoCode: input.sustentoCode, paymentCode: input.paymentCode ?? null, relatedParty: input.relatedParty };
      await tx.purchase.update({ where: { id }, data });
      await this.audit.record(tx, { action: 'update', entity: 'purchase', entityId: id, before, after: data });
    });
  }

  private async payNow(tx: Tx, tenantId: string, userId: string, supplierId: string, itemId: string, amount: string, method: string, cashSessionId: string | null, reason: string) {
    const methods = (await loadSriSettings(this.prisma.client)).paymentMethods;
    const def = methods.find((m) => m.method === method);
    if (!def || def.credit) throw new UnprocessableEntityException('Medio de pago inválido para una compra al contado');
    let cashMovementId: string | null = null;
    if (def.cash && cashSessionId) {
      const s = await tx.cashSession.findFirst({ where: { id: cashSessionId } });
      if (!s || s.status !== 'OPEN') throw new UnprocessableEntityException('La caja está cerrada');
      cashMovementId = uuidv7();
      await tx.cashMovement.create({ data: { id: cashMovementId, tenantId, sessionId: s.id, type: 'OUT', amount, reason, createdBy: userId } });
    }
    await recordMovement(tx, {
      tenantId,
      side: 'AP',
      partyId: supplierId,
      kind: 'PAYMENT',
      date: new Date(),
      amount,
      method,
      cashMovementId,
      userId,
      allocations: [{ itemId, amount }],
    });
  }

  private async resolveSupplier(tx: Tx, tenantId: string, input: PurchaseParsed): Promise<string> {
    if (input.supplierId) {
      const p = await tx.party.findFirst({ where: { id: input.supplierId } });
      if (!p) throw new NotFoundException('Proveedor no encontrado');
      if (!p.isSupplier) await tx.party.update({ where: { id: p.id }, data: { isSupplier: true } });
      return p.id;
    }
    const n = input.newSupplier!;
    const existing = await tx.party.findFirst({ where: { identification: n.identification } });
    if (existing) {
      if (!existing.isSupplier) await tx.party.update({ where: { id: existing.id }, data: { isSupplier: true } });
      return existing.id;
    }
    const id = uuidv7();
    await tx.party.create({
      data: { id, tenantId, idType: n.idType, identification: n.identification, name: n.name, email: n.email ?? null, address: n.address ?? null, isCustomer: false, isSupplier: true },
    });
    await this.audit.record(tx, { action: 'create', entity: 'party', entityId: id, after: { identification: n.identification, name: n.name, supplier: true } });
    return id;
  }

  /** Anula una compra: devuelve al proveedor lo que entró (kárdex PURCHASE_RETURN). */
  async void(id: string, reason: string): Promise<void> {
    const { tenantId, userId } = this.ctx();
    await this.prisma.tx(async (tx) => {
      const p = await tx.purchase.findFirst({ where: { id }, include: { lines: true } });
      if (!p) throw new NotFoundException('Compra no encontrada');
      if (p.status === 'VOID') throw new UnprocessableEntityException('La compra ya está anulada');
      const item = await tx.accountItem.findFirst({ where: { side: 'AP', sourceType: 'PURCHASE', sourceId: p.id }, include: { allocations: true } });
      if (item?.allocations.length) {
        throw new UnprocessableEntityException('Esta compra ya tiene pagos o retención aplicados: anule primero los pagos en Cuentas por pagar');
      }
      if (item) await tx.accountItem.update({ where: { id: item.id }, data: { status: 'VOID', balance: '0' } });
      const allowNegative = await allowsNegativeStock(tx, tenantId);
      for (const l of p.lines) {
        if (!l.productId) continue;
        try {
          await applyMovement(tx, {
            tenantId,
            productId: l.productId,
            warehouseId: p.warehouseId,
            type: 'PURCHASE_RETURN',
            quantity: toBaseUnits(l.quantity.toString(), l.unitFactor.toString()),
            allowNegative,
            documentId: p.id,
            reason: `Anulación de compra ${p.number}: ${reason}`,
            userId,
          });
        } catch (e) {
          if (e instanceof InventoryError) throw new UnprocessableEntityException(`${e.message}. Parte de esta compra ya se vendió.`);
          throw e;
        }
      }
      await tx.purchase.update({ where: { id }, data: { status: 'VOID', voidedAt: new Date(), voidedBy: userId, voidReason: reason } });
      await this.audit.record(tx, { action: 'void', entity: 'purchase', entityId: id, before: { status: 'REGISTERED' }, after: { status: 'VOID', reason } });
    });
  }
}
