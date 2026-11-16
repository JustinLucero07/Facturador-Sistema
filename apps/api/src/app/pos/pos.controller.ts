import { Body, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query, Res, StreamableFile, UnprocessableEntityException } from '@nestjs/common';
import { formatSequential, nextSequential, Prisma, uuidv7, withContext } from '@vektra/db';
import { loadSriSettings, renderRide } from '@vektra/einvoice';
import { ZodPipe } from '@vektra/nest-common';
import {
  CashMovementRequest,
  cashMovementSchema,
  CloseCashRequest,
  closeCashSchema,
  OpenCashRequest,
  openCashSchema,
  pageQuerySchema,
  QuoteLine,
  quoteSchema,
  QuoteView,
  TicketData,
} from '@vektra/shared-contracts';
import { computeInvoice, parseInvoiceXml } from '@vektra/sri-core';
import Decimal from 'decimal.js';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { Public, RequirePermissions } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/request-context';
import { CashService } from './cash.service';
import { publicBaseUrl, publicToken, verifyPublicToken } from './public-link';

@Injectable()
export class PosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────── Ticket ─────────

  async ticket(documentId: string): Promise<TicketData> {
    const ctx = currentContext();
    const tenantId = ctx.tenantId as string;
    const data = await this.prisma.tx(async (tx) => ({
      doc: await tx.document.findFirst({ where: { id: documentId }, include: { payments: true, electronic: true } }),
      tenant: await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    }));
    if (!data.doc || !data.doc.electronic?.signedXml) throw new NotFoundException('Comprobante no encontrado');
    const { doc, tenant } = data;
    const electronic = data.doc.electronic;
    const inv = parseInvoiceXml(electronic.authorizedXml ?? electronic.signedXml ?? '');
    const [rates, settings] = await Promise.all([this.prisma.client.taxRate.findMany({ where: { taxCode: '2' } }), loadSriSettings(this.prisma.client)]);
    const label = (code: string) => rates.find((r) => r.percentageCode === code)?.label ?? code;
    const methodLabel = (m: string) => settings.paymentMethods.find((x) => x.method === m)?.label ?? m;
    const cashier = doc.createdBy ? (await this.prisma.client.user.findUnique({ where: { id: doc.createdBy }, select: { fullName: true } }))?.fullName ?? null : null;
    const branding = (tenant.branding ?? {}) as { logoBase64?: string };
    return {
      documentId,
      company: {
        legalName: inv.issuer.legalName,
        tradeName: inv.issuer.tradeName ?? null,
        ruc: inv.issuer.ruc,
        mainAddress: inv.issuer.mainAddress,
        establishmentAddress: inv.issuer.establishmentAddress ?? null,
        keepsAccounting: inv.issuer.keepsAccounting,
        specialTaxpayerNumber: inv.issuer.specialTaxpayerNumber ?? null,
        withholdingAgentNumber: inv.issuer.withholdingAgentNumber ?? null,
        rimpeLegend: inv.issuer.rimpeLegend ?? null,
        logoBase64: branding.logoBase64 ?? null,
      },
      number: `${inv.establishment}-${inv.emissionPoint}-${inv.sequential}`,
      accessKey: inv.accessKey,
      environment: inv.environment,
      status: electronic.status,
      issuedAt: doc.createdAt.toISOString(),
      buyer: { idType: inv.buyer.idType, id: inv.buyer.id, name: inv.buyer.name, address: inv.buyer.address ?? null, email: doc.buyerEmail },
      lines: inv.lines.map((l) => ({
        description: l.description,
        quantity: new Decimal(l.quantity).toString(),
        unitPrice: new Decimal(l.unitPrice).toDecimalPlaces(4).toString(),
        discount: l.discount,
        subtotal: l.subtotal,
        taxLabel: l.taxes.map((t) => label(t.percentageCode)).join(' '),
      })),
      taxSummary: inv.totals.taxGroups.map((g) => ({ label: label(g.percentageCode), base: g.base, amount: g.amount })),
      subtotal: inv.totals.subtotal,
      totalDiscount: inv.totals.totalDiscount,
      totalTax: inv.totals.totalTax,
      total: inv.totals.total,
      payments: doc.payments.map((p) => {
        const received = p.cashReceived ? new Decimal(p.cashReceived.toString()) : null;
        return {
          label: methodLabel(p.method),
          amount: p.amount.toFixed(2),
          cashReceived: received ? received.toFixed(2) : null,
          change: received ? Decimal.max(0, received.minus(p.amount.toString())).toFixed(2) : null,
        };
      }),
      cashier,
      publicRideUrl: `${publicBaseUrl()}/api/public/documents/${publicToken(tenantId, documentId)}/ride`,
      buyerPhone: doc.buyerPhone,
    };
  }

  // ───────── Proformas ─────────

  async createQuote(input: z.output<typeof quoteSchema>): Promise<QuoteView> {
    const ctx = currentContext();
    const tenantId = ctx.tenantId as string;
    const rates = await this.prisma.client.taxRate.findMany({ where: { id: { in: input.lines.map((l) => l.taxRateId) } } });
    let total: string;
    try {
      total = computeInvoice(
        input.lines.map((l) => {
          const r = rates.find((x) => x.id === l.taxRateId);
          if (!r) throw new Error('Tarifa no encontrada');
          return { description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, taxes: [{ taxCode: r.taxCode, percentageCode: r.percentageCode, rate: r.rate.toString() }] };
        }),
      ).totals.total;
    } catch (e) {
      throw new UnprocessableEntityException((e as Error).message);
    }
    const id = uuidv7();
    await this.prisma.tx(async (tx) => {
      const ep = await tx.emissionPoint.findFirst({ where: { id: input.emissionPointId } });
      if (!ep) throw new NotFoundException('Punto de emisión no encontrado');
      // Numeración propia de proformas por punto de emisión (no es serie del SRI)
      const number = await nextSequential(tx, ep.id, 'PF');
      const validUntil = new Date();
      validUntil.setUTCDate(validUntil.getUTCDate() + input.validDays);
      await tx.quote.create({
        data: {
          id,
          tenantId,
          emissionPointId: ep.id,
          number,
          buyerIdType: input.buyer.idType,
          buyerId: input.buyer.id,
          buyerName: input.buyer.name,
          buyerEmail: input.buyer.email ?? null,
          priceListId: input.priceListId ?? null,
          lines: input.lines as unknown as Prisma.InputJsonValue,
          total,
          validUntil,
          notes: input.notes ?? null,
          createdBy: ctx.userId ?? null,
        },
      });
      await this.audit.record(tx, { action: 'create', entity: 'quote', entityId: id, after: { number: number.toString(), total } });
    });
    return this.quote(id);
  }

  async quote(id: string): Promise<QuoteView> {
    const q = await this.prisma.tx((tx) => tx.quote.findFirst({ where: { id } }));
    if (!q) throw new NotFoundException('Proforma no encontrada');
    return this.toQuote(q);
  }

  private toQuote(q: Prisma.QuoteGetPayload<object>): QuoteView {
    return {
      id: q.id,
      number: formatSequential(q.number),
      emissionPointId: q.emissionPointId,
      buyerIdType: q.buyerIdType,
      buyerId: q.buyerId,
      buyerName: q.buyerName,
      buyerEmail: q.buyerEmail,
      priceListId: q.priceListId,
      lines: q.lines as unknown as QuoteLine[],
      total: q.total.toFixed(2),
      validUntil: q.validUntil.toISOString().slice(0, 10),
      notes: q.notes,
      documentId: q.documentId,
      createdAt: q.createdAt.toISOString(),
      expired: q.validUntil < new Date(new Date().toISOString().slice(0, 10)),
    };
  }

  async quotes(q: { page: number; pageSize: number; search?: string; pending?: boolean }) {
    const where: Prisma.QuoteWhereInput = {
      ...(q.pending ? { documentId: null } : {}),
      ...(q.search ? { OR: [{ buyerName: { contains: q.search, mode: 'insensitive' } }, { buyerId: { startsWith: q.search } }] } : {}),
    };
    const [total, rows] = await this.prisma.tx((tx) =>
      Promise.all([tx.quote.count({ where }), tx.quote.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize })]),
    );
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map((r) => this.toQuote(r)) };
  }
}

const sessionsQuery = pageQuerySchema;
const quotesQuery = pageQuerySchema.extend({ search: z.string().trim().max(100).optional(), pending: z.enum(['true', 'false']).transform((v) => v === 'true').optional() });

@Controller()
export class PosController {
  constructor(
    private readonly cash: CashService,
    private readonly pos: PosService,
    private readonly prisma: PrismaService,
  ) {}

  // Caja
  @Get('cash/current')
  @RequirePermissions('cash.operate')
  current(@Query('emissionPointId', ParseUUIDPipe) emissionPointId: string) {
    return this.cash.current(emissionPointId);
  }

  @Post('cash/sessions')
  @RequirePermissions('cash.operate')
  open(@Body(new ZodPipe(openCashSchema)) b: z.output<typeof openCashSchema> & OpenCashRequest) {
    return this.cash.open(b.emissionPointId, b.openingAmount);
  }

  @Get('cash/sessions')
  @RequirePermissions('cash.operate')
  sessions(@Query(new ZodPipe(sessionsQuery)) q: z.infer<typeof sessionsQuery>) {
    return this.cash.list(q.page, q.pageSize);
  }

  @Get('cash/sessions/:id')
  @RequirePermissions('cash.operate')
  summary(@Param('id', ParseUUIDPipe) id: string) {
    return this.cash.summary(id);
  }

  @Post('cash/sessions/:id/movements')
  @RequirePermissions('cash.operate')
  movement(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(cashMovementSchema)) b: z.output<typeof cashMovementSchema> & CashMovementRequest) {
    return this.cash.movement(id, b);
  }

  @Post('cash/sessions/:id/close')
  @HttpCode(200)
  @RequirePermissions('cash.operate')
  close(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(closeCashSchema)) b: z.output<typeof closeCashSchema> & CloseCashRequest) {
    return this.cash.close(id, b);
  }

  // Ticket
  @Get('pos/tickets/:documentId')
  @RequirePermissions('einvoice.read')
  ticket(@Param('documentId', ParseUUIDPipe) id: string) {
    return this.pos.ticket(id);
  }

  // Proformas
  @Post('quotes')
  @RequirePermissions('sales.quote')
  createQuote(@Body(new ZodPipe(quoteSchema)) b: z.output<typeof quoteSchema>) {
    return this.pos.createQuote(b);
  }

  @Get('quotes')
  @RequirePermissions('sales.quote')
  quotes(@Query(new ZodPipe(quotesQuery)) q: z.infer<typeof quotesQuery>) {
    return this.pos.quotes(q);
  }

  @Get('quotes/:id')
  @RequirePermissions('sales.quote')
  quote(@Param('id', ParseUUIDPipe) id: string) {
    return this.pos.quote(id);
  }

  // Links públicos (sin sesión): RIDE y XML para el cliente
  @Public()
  @Get('public/documents/:token/:kind')
  async publicFile(@Param('token') token: string, @Param('kind') kind: string, @Res({ passthrough: true }) res: Response) {
    const ref = verifyPublicToken(token);
    if (!ref || !['ride', 'xml'].includes(kind)) throw new NotFoundException('Enlace inválido');
    if (kind === 'ride') {
      const { pdf, fileName } = await renderRide(this.prisma.client, ref.tenantId, ref.documentId).catch(() => {
        // Venta de una caja de escritorio que aún no sincroniza: el enlace es válido, falta que llegue.
        throw new NotFoundException('Su factura aún se está procesando. Intente nuevamente en unos minutos.');
      });
      res.set({ 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${fileName}"`, 'cache-control': 'private, max-age=300' });
      return new StreamableFile(pdf);
    }
    const edoc = await withContext(this.prisma.client, { tenantId: ref.tenantId }, (tx) => tx.electronicDocument.findUnique({ where: { documentId: ref.documentId } }));
    const xml = edoc?.authorizedXml ?? edoc?.signedXml;
    if (!xml) throw new NotFoundException('Comprobante no encontrado');
    res.set({ 'content-type': 'application/xml; charset=utf-8', 'content-disposition': `attachment; filename="${edoc!.accessKey}.xml"` });
    return new StreamableFile(Buffer.from(xml, 'utf8'));
  }
}
