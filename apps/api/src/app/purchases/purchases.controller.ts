import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ZodPipe } from '@vektra/nest-common';
import { pageQuerySchema, purchaseAtsSchema, PurchaseAtsRequest, PurchaseParsed, purchaseSchema, voidPurchaseSchema } from '@vektra/shared-contracts';
import { z } from 'zod';
import { RequirePermissions } from '../common/decorators';
import { PurchasesService } from './purchases.service';

const listQuery = pageQuerySchema.extend({ search: z.string().trim().max(100).optional() });

@Controller('purchases')
export class PurchasesController {
  constructor(private readonly svc: PurchasesService) {}

  @Get()
  @RequirePermissions('purchases.manage')
  list(@Query(new ZodPipe(listQuery)) q: z.output<typeof listQuery>) {
    return this.svc.list(q);
  }

  /** Catálogos del ATS para el formulario de compra: sustento (Tabla 5) y formas de pago (Tabla 13). */
  @Get('ats-catalogs')
  @RequirePermissions('purchases.manage')
  atsCatalogs() {
    return this.svc.atsCatalogs();
  }

  @Get(':id')
  @RequirePermissions('purchases.manage')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.detail(id);
  }

  /** Vista previa del XML autorizado de la factura del proveedor (no guarda). */
  @Post('xml-preview')
  @HttpCode(200)
  @RequirePermissions('purchases.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  xmlPreview(@UploadedFile() file: { buffer: Buffer } | undefined) {
    if (!file) throw new BadRequestException('Seleccione el archivo XML de la factura del proveedor');
    return this.svc.xmlPreview(file.buffer.toString('utf8'));
  }

  @Post()
  @RequirePermissions('purchases.manage')
  create(@Body(new ZodPipe(purchaseSchema)) body: PurchaseParsed) {
    return this.svc.create(body);
  }

  /** Datos del ATS (sustento, forma de pago, parte relacionada). */
  @Post(':id/ats')
  @HttpCode(204)
  @RequirePermissions('purchases.manage')
  updateAts(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(purchaseAtsSchema)) body: PurchaseAtsRequest) {
    return this.svc.updateAts(id, body);
  }

  @Post(':id/void')
  @HttpCode(204)
  @RequirePermissions('purchases.manage')
  void(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(voidPurchaseSchema)) body: { reason: string }) {
    return this.svc.void(id, body.reason);
  }
}
