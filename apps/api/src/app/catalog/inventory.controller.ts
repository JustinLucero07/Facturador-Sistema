import { Body, Controller, Get, Injectable, Param, ParseUUIDPipe, Post, Query, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, uuidv7 } from '@vektra/db';
import { allowsNegativeStock, applyMovement, InventoryError, transferStock } from '@vektra/inventory';
import { ZodPipe } from '@vektra/nest-common';
import { AdjustmentRequest, adjustmentSchema, KardexItem, MOVEMENT_LABELS, pageQuerySchema, Paginated, StockItem, TransferRequest, transferSchema } from '@vektra/shared-contracts';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { RequirePermissions } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/request-context';

const stockQuery = pageQuerySchema.extend({
  warehouseId: z.uuid().optional(),
  search: z.string().trim().max(100).optional(),
  lowOnly: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
const kardexQuery = pageQuerySchema.extend({ warehouseId: z.uuid().optional() });

const n = (v: unknown) => new Decimal(String(v ?? 0)).toDecimalPlaces(6).toString();

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private costs() {
    return currentContext().permissions?.has('catalog.costs') ?? false;
  }

  /** Existencias por producto (de una bodega o de todas). */
  async stock(q: z.infer<typeof stockQuery>): Promise<Paginated<StockItem>> {
    const like = q.search ? `%${q.search.toLowerCase()}%` : null;
    const stockJoin = q.warehouseId
      ? Prisma.sql`LEFT JOIN stock s ON s.product_id = p.id AND s.warehouse_id = ${q.warehouseId}::uuid`
      : Prisma.sql`LEFT JOIN (SELECT product_id, SUM(quantity) AS quantity FROM stock GROUP BY product_id) s ON s.product_id = p.id`;
    const where = Prisma.sql`WHERE p.active AND NOT p.is_service
      ${like ? Prisma.sql`AND (lower(p.name) LIKE ${like} OR lower(p.code) LIKE ${like})` : Prisma.empty}
      ${q.lowOnly ? Prisma.sql`AND p.min_stock > 0 AND COALESCE(s.quantity, 0) <= p.min_stock` : Prisma.empty}`;
    const { total, rows } = await this.prisma.tx(async (tx) => {
      const [{ count }] = await tx.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM product p ${stockJoin} ${where}`;
      const rows = await tx.$queryRaw<{ id: string; code: string; name: string; unit: string; qty: string; min: string; avg: string }[]>`
        SELECT p.id, p.code, p.name, u.code AS unit, COALESCE(s.quantity, 0)::text AS qty, p.min_stock::text AS min, p.avg_cost::text AS avg
        FROM product p JOIN unit u ON u.id = p.unit_id ${stockJoin} ${where}
        ORDER BY p.name COLLATE es_natural, p.code LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
      return { total: Number(count), rows };
    });
    const costs = this.costs();
    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      items: rows.map((r) => ({
        productId: r.id,
        code: r.code,
        name: r.name,
        unit: r.unit,
        quantity: n(r.qty),
        minStock: n(r.min),
        avgCost: costs ? new Decimal(r.avg).toFixed(4) : null,
        value: costs ? new Decimal(r.qty).mul(r.avg).toFixed(2) : null,
        lowStock: new Decimal(r.min).gt(0) && new Decimal(r.qty).lte(r.min),
      })),
    };
  }

  async kardex(productId: string, q: z.infer<typeof kardexQuery>): Promise<Paginated<KardexItem>> {
    const where: Prisma.InventoryMovementWhereInput = { productId, ...(q.warehouseId ? { warehouseId: q.warehouseId } : {}) };
    const [total, rows] = await this.prisma.tx((tx) =>
      Promise.all([
        tx.inventoryMovement.count({ where }),
        tx.inventoryMovement.findMany({ where, include: { warehouse: true }, orderBy: { at: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      ]),
    );
    const users = await this.prisma.client.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => !!x))] } },
      select: { id: true, fullName: true },
    });
    const names = new Map(users.map((u) => [u.id, u.fullName]));
    const costs = this.costs();
    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      items: rows.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        type: r.type,
        typeLabel: MOVEMENT_LABELS[r.type] ?? r.type,
        warehouse: r.warehouse.name,
        quantity: n(r.quantity),
        unitCost: costs ? r.unitCost.toFixed(4) : null,
        totalCost: costs ? r.totalCost.toFixed(2) : null,
        balanceAfter: n(r.balanceAfter),
        avgCostAfter: costs ? r.avgCostAfter.toFixed(4) : null,
        reason: r.reason,
        documentId: r.documentId,
        userName: r.createdBy ? (names.get(r.createdBy) ?? null) : null,
      })),
    };
  }

  async adjust(input: z.output<typeof adjustmentSchema>): Promise<{ batchId: string }> {
    const ctx = currentContext();
    const tenantId = ctx.tenantId as string;
    const batchId = uuidv7();
    await this.prisma
      .tx(async (tx) => {
        const allowNegative = await allowsNegativeStock(tx, tenantId);
        for (const item of input.items) {
          await applyMovement(tx, {
            tenantId,
            productId: item.productId,
            warehouseId: input.warehouseId,
            type: input.direction === 'IN' ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
            quantity: item.quantity,
            unitCost: input.direction === 'IN' ? (item.unitCost ?? null) : null,
            allowNegative,
            batchId,
            reason: input.reason,
            userId: ctx.userId,
          });
        }
        await this.audit.record(tx, { action: 'inventory.adjustment', entity: 'inventory', entityId: batchId, after: input });
      })
      .catch(this.asUnprocessable);
    return { batchId };
  }

  async transfer(input: z.output<typeof transferSchema>): Promise<{ batchId: string }> {
    const ctx = currentContext();
    const tenantId = ctx.tenantId as string;
    const batchId = await this.prisma
      .tx(async (tx) => {
        const id = await transferStock(tx, { tenantId, fromWarehouseId: input.fromWarehouseId, toWarehouseId: input.toWarehouseId, items: input.items, reason: input.reason, userId: ctx.userId });
        await this.audit.record(tx, { action: 'inventory.transfer', entity: 'inventory', entityId: id, after: input });
        return id;
      })
      .catch(this.asUnprocessable);
    return { batchId };
  }

  private asUnprocessable(e: unknown): never {
    if (e instanceof InventoryError) throw new UnprocessableEntityException(e.message);
    throw e;
  }
}

@Controller('inventory')
export class InventoryController {
  constructor(private readonly svc: InventoryService) {}

  @Get('stock')
  @RequirePermissions('inventory.read')
  stock(@Query(new ZodPipe(stockQuery)) q: z.infer<typeof stockQuery>) {
    return this.svc.stock(q);
  }

  @Get('kardex/:productId')
  @RequirePermissions('inventory.read')
  kardex(@Param('productId', ParseUUIDPipe) productId: string, @Query(new ZodPipe(kardexQuery)) q: z.infer<typeof kardexQuery>) {
    return this.svc.kardex(productId, q);
  }

  @Post('adjustments')
  @RequirePermissions('inventory.adjust')
  adjust(@Body(new ZodPipe(adjustmentSchema)) body: z.output<typeof adjustmentSchema> & AdjustmentRequest) {
    return this.svc.adjust(body);
  }

  @Post('transfers')
  @RequirePermissions('inventory.adjust')
  transfer(@Body(new ZodPipe(transferSchema)) body: z.output<typeof transferSchema> & TransferRequest) {
    return this.svc.transfer(body);
  }
}
