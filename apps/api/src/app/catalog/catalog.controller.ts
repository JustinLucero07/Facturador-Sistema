import { Body, ConflictException, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Tx, uuidv7 } from '@vektra/db';
import { ZodPipe } from '@vektra/nest-common';
import { CatalogLookups, NamedRequest, namedSchema, PriceListRequest, priceListSchema, UnitRequest, unitSchema } from '@vektra/shared-contracts';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { RequirePermissions } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/request-context';

type Kind = 'unit' | 'category' | 'brand' | 'priceList';

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async lookups(): Promise<CatalogLookups> {
    const rates = await this.prisma.client.taxRate.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } });
    return this.prisma.tx(async (tx) => {
      const [units, categories, brands, priceLists, warehouses, counts] = await Promise.all([
        tx.unit.findMany({ orderBy: { name: 'asc' } }),
        tx.category.findMany({ orderBy: { name: 'asc' } }),
        tx.brand.findMany({ orderBy: { name: 'asc' } }),
        tx.priceList.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
        tx.warehouse.findMany({ where: { active: true }, include: { establishment: true }, orderBy: [{ establishment: { code: 'asc' } }, { name: 'asc' }] }),
        tx.product.groupBy({ by: ['categoryId'], _count: true }),
      ]);
      const byCat = new Map(counts.map((c) => [c.categoryId, c._count]));
      return {
        units: units.map(({ id, code, name, allowsDecimal, active }) => ({ id, code, name, allowsDecimal, active })),
        categories: categories.map((c) => ({ id: c.id, name: c.name, active: c.active, productCount: byCat.get(c.id) ?? 0 })),
        brands: brands.map((b) => ({ id: b.id, name: b.name, active: b.active })),
        priceLists: priceLists.map(({ id, code, name, isDefault, sortOrder, active }) => ({ id, code, name, isDefault, sortOrder, active })),
        taxRates: rates.map((r) => ({ id: r.id, label: r.label, name: r.name, rate: r.rate.toFixed(2), percentageCode: r.percentageCode })),
        warehouses: warehouses.map((w) => ({ id: w.id, name: w.name, establishment: `${w.establishment.code} ${w.establishment.name}`, isDefault: w.isDefault })),
      };
    });
  }

  async save(kind: Kind, id: string | null, data: Record<string, unknown>): Promise<{ id: string }> {
    const tenantId = currentContext().tenantId as string;
    const newId = id ?? uuidv7();
    try {
      await this.prisma.tx(async (tx) => {
        const delegate = this.delegate(tx, kind);
        if (kind === 'priceList' && data['isDefault']) await tx.priceList.updateMany({ where: { NOT: { id: newId } }, data: { isDefault: false } });
        if (id) {
          const exists = await delegate.findFirst({ where: { id } });
          if (!exists) throw new NotFoundException('Registro no encontrado');
          await delegate.update({ where: { id }, data });
        } else {
          await delegate.create({ data: { id: newId, tenantId, ...data } });
        }
        await this.audit.record(tx, { action: id ? 'update' : 'create', entity: kind, entityId: newId, after: data });
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException('Ya existe un registro con ese nombre o código');
      throw e;
    }
    return { id: newId };
  }

  // Los delegados de Prisma no comparten un tipo común; se usa una interfaz mínima.
  private delegate(tx: Tx, kind: Kind) {
    const map = { unit: tx.unit, category: tx.category, brand: tx.brand, priceList: tx.priceList } as const;
    return map[kind] as unknown as {
      findFirst(a: object): Promise<unknown>;
      update(a: object): Promise<unknown>;
      create(a: object): Promise<unknown>;
    };
  }
}

@Controller('catalog')
export class CatalogController {
  constructor(private readonly svc: CatalogService) {}

  @Get('lookups')
  @RequirePermissions('catalog.read')
  lookups() {
    return this.svc.lookups();
  }

  @Post('units')
  @RequirePermissions('catalog.manage')
  createUnit(@Body(new ZodPipe(unitSchema)) b: z.output<typeof unitSchema> & UnitRequest) {
    return this.svc.save('unit', null, b);
  }

  @Patch('units/:id')
  @HttpCode(204)
  @RequirePermissions('catalog.manage')
  async updateUnit(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(unitSchema)) b: z.output<typeof unitSchema>) {
    await this.svc.save('unit', id, b);
  }

  @Post('categories')
  @RequirePermissions('catalog.manage')
  createCategory(@Body(new ZodPipe(namedSchema)) b: z.output<typeof namedSchema> & NamedRequest) {
    return this.svc.save('category', null, b);
  }

  @Patch('categories/:id')
  @HttpCode(204)
  @RequirePermissions('catalog.manage')
  async updateCategory(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(namedSchema)) b: z.output<typeof namedSchema>) {
    await this.svc.save('category', id, b);
  }

  @Post('brands')
  @RequirePermissions('catalog.manage')
  createBrand(@Body(new ZodPipe(namedSchema)) b: z.output<typeof namedSchema>) {
    return this.svc.save('brand', null, b);
  }

  @Patch('brands/:id')
  @HttpCode(204)
  @RequirePermissions('catalog.manage')
  async updateBrand(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(namedSchema)) b: z.output<typeof namedSchema>) {
    await this.svc.save('brand', id, b);
  }

  @Post('price-lists')
  @RequirePermissions('catalog.manage')
  createPriceList(@Body(new ZodPipe(priceListSchema)) b: z.output<typeof priceListSchema> & PriceListRequest) {
    return this.svc.save('priceList', null, b);
  }

  @Patch('price-lists/:id')
  @HttpCode(204)
  @RequirePermissions('catalog.manage')
  async updatePriceList(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(priceListSchema)) b: z.output<typeof priceListSchema>) {
    await this.svc.save('priceList', id, b);
  }
}
