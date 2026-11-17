import { Body, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { uuidv7 } from '@vektra/db';
import { invalidateSriSettings } from '@vektra/einvoice';
import { ZodPipe } from '@vektra/nest-common';
import { TaxRateItem, TaxRateRequest, taxRateSchema, WithholdingCodeItem, withholdingCodeSchema } from '@vektra/shared-contracts';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { RequirePermissions } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/request-context';

/** Parámetros que solo Soporte Vektra puede cambiar (afectan la conexión con el SRI o la ley). */
const SUPPORT_ONLY_SETTINGS = new Set(['ws.test', 'ws.production', 'ws.timeout_ms', 'xml_versions', 'provider_ruc', 'rimpe_legends']);

const toDate = (v?: string | null) => (v ? new Date(`${v}T00:00:00.000Z`) : null);

@Injectable()
export class TaxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async rates(): Promise<TaxRateItem[]> {
    const rows = await this.prisma.client.taxRate.findMany({ orderBy: [{ taxCode: 'asc' }, { sortOrder: 'asc' }] });
    return rows.map((r) => ({
      id: r.id,
      taxCode: r.taxCode,
      percentageCode: r.percentageCode,
      name: r.name,
      label: r.label,
      rate: r.rate.toFixed(2),
      validFrom: r.validFrom?.toISOString().slice(0, 10) ?? null,
      validTo: r.validTo?.toISOString().slice(0, 10) ?? null,
      active: r.active,
      sortOrder: r.sortOrder,
    }));
  }

  async create(input: z.output<typeof taxRateSchema>) {
    const id = uuidv7();
    const data = { ...input, validFrom: toDate(input.validFrom), validTo: toDate(input.validTo) };
    await this.prisma.client.taxRate.create({ data: { id, ...data } });
    await this.log('create', id, null, data);
    return { id };
  }

  async update(id: string, input: z.output<typeof taxRateSchema>) {
    const before = await this.prisma.client.taxRate.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Tarifa no encontrada');
    const data = { ...input, validFrom: toDate(input.validFrom), validTo: toDate(input.validTo) };
    await this.prisma.client.taxRate.update({ where: { id }, data });
    await this.log('update', id, before, data);
  }

  async settings() {
    const rows = await this.prisma.client.sriSetting.findMany({ orderBy: { key: 'asc' } });
    return rows.map((r) => ({ key: r.key, value: r.value, note: r.note, supportOnly: SUPPORT_ONLY_SETTINGS.has(r.key) }));
  }

  async updateSetting(key: string, value: unknown) {
    const ctx = currentContext();
    if (SUPPORT_ONLY_SETTINGS.has(key) && !ctx.isSupport) throw new ForbiddenException('Solo Soporte Vektra puede cambiar este parámetro');
    const before = await this.prisma.client.sriSetting.findUnique({ where: { key } });
    if (!before) throw new NotFoundException('Parámetro no encontrado');
    await this.prisma.client.sriSetting.update({ where: { key }, data: { value: value as object } });
    invalidateSriSettings();
    await this.log('setting.update', key, before.value, value);
  }

  // ───────── Códigos de retención (Catálogo ATS / Tabla 20) ─────────

  async withholdingCodes(): Promise<WithholdingCodeItem[]> {
    const rows = await this.prisma.client.withholdingCode.findMany({ orderBy: [{ tax: 'asc' }, { sortOrder: 'asc' }, { code: 'asc' }] });
    return rows.map((r) => ({
      id: r.id,
      tax: r.tax,
      code: r.code,
      description: r.description,
      percentage: r.percentage === null ? null : r.percentage.toString(),
      percentageNote: r.percentageNote,
      residence: r.residence,
      validFrom: r.validFrom?.toISOString().slice(0, 10) ?? null,
      validTo: r.validTo?.toISOString().slice(0, 10) ?? null,
      active: r.active,
    }));
  }

  async saveWithholdingCode(id: string | null, input: z.output<typeof withholdingCodeSchema>) {
    const data = { ...input, percentage: input.percentage ?? null, percentageNote: input.percentageNote ?? null, validFrom: toDate(input.validFrom), validTo: toDate(input.validTo) };
    if (id) {
      const before = await this.prisma.client.withholdingCode.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Código no encontrado');
      await this.prisma.client.withholdingCode.update({ where: { id }, data });
      await this.log('withholding_code.update', id, before, data);
      return { id };
    }
    const newId = uuidv7();
    await this.prisma.client.withholdingCode.create({ data: { id: newId, ...data, sortOrder: 999 } });
    await this.log('withholding_code.create', newId, null, data);
    return { id: newId };
  }

  private log(action: string, entityId: string, before: unknown, after: unknown) {
    const ctx = currentContext();
    return this.audit.recordStandalone(ctx.tenantId ?? null, ctx.userId ?? null, { action, entity: 'tax_config', entityId, before, after });
  }
}

/** Tarifas y parámetros tributarios (globales en la instalación). */
@Controller('tax')
export class TaxController {
  constructor(private readonly svc: TaxService) {}

  @Get('rates')
  @RequirePermissions('catalog.read')
  rates() {
    return this.svc.rates();
  }

  @Post('rates')
  @RequirePermissions('tax.manage')
  create(@Body(new ZodPipe(taxRateSchema)) body: z.output<typeof taxRateSchema> & TaxRateRequest) {
    return this.svc.create(body);
  }

  @Patch('rates/:id')
  @HttpCode(204)
  @RequirePermissions('tax.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(taxRateSchema)) body: z.output<typeof taxRateSchema>) {
    return this.svc.update(id, body);
  }

  @Get('withholding-codes')
  @RequirePermissions('purchases.manage')
  withholdingCodes() {
    return this.svc.withholdingCodes();
  }

  @Post('withholding-codes')
  @RequirePermissions('tax.manage')
  createWithholdingCode(@Body(new ZodPipe(withholdingCodeSchema)) b: z.output<typeof withholdingCodeSchema>) {
    return this.svc.saveWithholdingCode(null, b);
  }

  @Patch('withholding-codes/:id')
  @HttpCode(204)
  @RequirePermissions('tax.manage')
  async updateWithholdingCode(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(withholdingCodeSchema)) b: z.output<typeof withholdingCodeSchema>) {
    await this.svc.saveWithholdingCode(id, b);
  }

  @Get('settings')
  @RequirePermissions('tax.manage')
  settings() {
    return this.svc.settings();
  }

  @Put('settings/:key')
  @HttpCode(204)
  @RequirePermissions('tax.manage')
  updateSetting(@Param('key') key: string, @Body(new ZodPipe(z.object({ value: z.unknown() }))) body: { value: unknown }) {
    return this.svc.updateSetting(key, body.value);
  }
}
