import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Prisma, uuidv7 } from '@vektra/db';
import { ZodPipe } from '@vektra/nest-common';
import { pageQuerySchema, Paginated, PartyItem, PartyParsed, partySchema } from '@vektra/shared-contracts';
import { validateCedula, validateRuc } from '@vektra/shared-domain';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { RequirePermissions } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/request-context';

/** Valida cédula/RUC según el tipo. Devuelve el mensaje de error o null. */
export function identificationError(idType: string, id: string): string | null {
  if (id === '9999999999999') return 'La identificación de consumidor final no se registra como cliente';
  if (idType === '04') {
    const r = validateRuc(id);
    return r.valid ? null : (r.error ?? 'RUC inválido');
  }
  if (idType === '05') {
    const r = validateCedula(id);
    return r.valid ? null : (r.error ?? 'Cédula inválida');
  }
  return null;
}

const listQuery = pageQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  role: z.enum(['customer', 'supplier']).optional(),
});

@Injectable()
export class PartiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: z.infer<typeof listQuery>): Promise<Paginated<PartyItem>> {
    const s = q.search?.trim();
    const where: Prisma.PartyWhereInput = {
      ...(q.role === 'customer' ? { isCustomer: true } : q.role === 'supplier' ? { isSupplier: true } : {}),
      ...(s
        ? { OR: [{ name: { contains: s, mode: 'insensitive' } }, { tradeName: { contains: s, mode: 'insensitive' } }, { identification: { startsWith: s } }] }
        : {}),
    };
    const [total, rows, lists] = await this.prisma.tx((tx) =>
      Promise.all([
        tx.party.count({ where }),
        tx.party.findMany({ where, orderBy: { name: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
        tx.priceList.findMany(),
      ]),
    );
    const listName = new Map(lists.map((l) => [l.id, l.name]));
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map((r) => this.toItem(r, listName)) };
  }

  private toItem(r: Prisma.PartyGetPayload<object>, listName: Map<string, string>): PartyItem {
    return {
      id: r.id,
      idType: r.idType as PartyItem['idType'],
      identification: r.identification,
      name: r.name,
      tradeName: r.tradeName,
      email: r.email,
      phone: r.phone,
      address: r.address,
      isCustomer: r.isCustomer,
      isSupplier: r.isSupplier,
      priceListId: r.priceListId,
      priceListName: r.priceListId ? (listName.get(r.priceListId) ?? null) : null,
      creditLimit: r.creditLimit.toFixed(2),
      creditDays: r.creditDays,
      personType: (r.personType as PartyItem['personType']) ?? null,
      relatedParty: r.relatedParty,
      notes: r.notes,
      active: r.active,
      customFields: r.customFields as PartyItem['customFields'],
      createdAt: r.createdAt.toISOString(),
    };
  }

  async byIdentification(identification: string): Promise<PartyItem | null> {
    const [row, lists] = await this.prisma.tx((tx) => Promise.all([tx.party.findFirst({ where: { identification } }), tx.priceList.findMany()]));
    return row ? this.toItem(row, new Map(lists.map((l) => [l.id, l.name]))) : null;
  }

  async save(id: string | null, input: PartyParsed): Promise<{ id: string }> {
    const err = identificationError(input.idType, input.identification);
    if (err) throw new BadRequestException({ message: 'Revise los datos', fields: { identification: err } });
    if (!input.isCustomer && !input.isSupplier) throw new BadRequestException({ message: 'Revise los datos', fields: { isCustomer: 'Marque si es cliente, proveedor o ambos' } });
    // Tipo de persona (ATS Tabla 14): solo aplica con pasaporte / identificación del exterior
    if (input.idType !== '06' && input.idType !== '08') input = { ...input, personType: null };
    const tenantId = currentContext().tenantId as string;
    const newId = id ?? uuidv7();
    await this.prisma.tx(async (tx) => {
      const dup = await tx.party.findFirst({ where: { identification: input.identification, ...(id ? { NOT: { id } } : {}) }, select: { name: true } });
      if (dup) throw new ConflictException(`Ya existe "${dup.name}" con esa identificación`);
      if (input.priceListId && !(await tx.priceList.findFirst({ where: { id: input.priceListId } }))) throw new NotFoundException('Lista de precios no encontrada');
      if (id) {
        const before = await tx.party.findFirst({ where: { id } });
        if (!before) throw new NotFoundException('Registro no encontrado');
        await tx.party.update({ where: { id }, data: input });
        await this.audit.record(tx, { action: 'update', entity: 'party', entityId: id, before, after: input });
      } else {
        await tx.party.create({ data: { id: newId, tenantId, ...input } });
        await this.audit.record(tx, { action: 'create', entity: 'party', entityId: newId, after: input });
      }
    });
    return { id: newId };
  }
}

@Controller('parties')
export class PartiesController {
  constructor(private readonly svc: PartiesService) {}

  @Get()
  @RequirePermissions('customers.read')
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.svc.list(q);
  }

  /** Para autocompletar el cliente al facturar. 200 con null si no existe. */
  @Get('by-identification/:identification')
  @RequirePermissions('customers.read')
  byIdentification(@Param('identification') identification: string) {
    return this.svc.byIdentification(identification.trim());
  }

  @Post()
  @RequirePermissions('customers.manage')
  create(@Body(new ZodPipe(partySchema)) body: PartyParsed) {
    return this.svc.save(null, body);
  }

  @Patch(':id')
  @HttpCode(204)
  @RequirePermissions('customers.manage')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(partySchema)) body: PartyParsed) {
    await this.svc.save(id, body);
  }
}
