import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ZodPipe } from '@vektra/nest-common';
import { pageQuerySchema, ProductParsed, productSchema, quickProductSchema } from '@vektra/shared-contracts';
import type { QuickProduct } from './quick-product';
import { z } from 'zod';
import { RequirePermissions } from '../common/decorators';
import { ProductsService } from './products.service';

const boolParam = z.enum(['true', 'false']).transform((v) => v === 'true').optional();
const listQuery = pageQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  categoryId: z.uuid().optional(),
  lowStock: boolParam,
  active: boolParam,
});
const searchQuery = z.object({
  q: z.string().trim().min(1).max(100),
  priceListId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

@Controller('products')
export class ProductsController {
  constructor(private readonly svc: ProductsService) {}

  @Get()
  @RequirePermissions('catalog.read')
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.svc.list(q);
  }

  /** Buscador rápido para la factura y el POS (código de barras, código o nombre). */
  @Get('search')
  @RequirePermissions('catalog.read')
  search(@Query(new ZodPipe(searchQuery)) q: z.infer<typeof searchQuery>) {
    return this.svc.search(q.q, q);
  }

  @Get(':id')
  @RequirePermissions('catalog.read')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.detail(id);
  }

  /** Alta rápida desde la caja (producto no encontrado al escanear). */
  @Post('quick')
  @RequirePermissions('catalog.manage')
  quick(@Body(new ZodPipe(quickProductSchema)) body: QuickProduct) {
    return this.svc.quick(body);
  }

  @Post()
  @RequirePermissions('catalog.manage')
  create(@Body(new ZodPipe(productSchema)) body: ProductParsed) {
    return this.svc.create(body);
  }

  @Patch(':id')
  @HttpCode(204)
  @RequirePermissions('catalog.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(productSchema)) body: ProductParsed) {
    return this.svc.update(id, body);
  }
}
