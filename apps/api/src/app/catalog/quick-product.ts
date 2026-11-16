import { ConflictException } from '@nestjs/common';
import { Tx, uuidv7 } from '@vektra/db';
import type { z } from 'zod';
import type { quickProductSchema } from '@vektra/shared-contracts';

export type QuickProduct = z.output<typeof quickProductSchema>;

/**
 * Alta rápida desde la caja (web o escritorio): código, nombre, unidad, IVA, código de barras y
 * precio sin IVA en la lista por defecto. Los ids los fija quien lo crea (la caja de escritorio
 * ya pudo venderlo sin conexión). Devuelve false si ya existía con ese id (reintento).
 */
export async function createQuickProduct(tx: Tx, tenantId: string, p: QuickProduct): Promise<boolean> {
  if (await tx.product.findFirst({ where: { id: p.id }, select: { id: true } })) return false;
  if (await tx.product.findFirst({ where: { code: p.code }, select: { id: true } })) throw new ConflictException(`Ya existe otro producto con el código ${p.code}`);
  const list = await tx.priceList.findFirst({ where: { isDefault: true } });
  await tx.product.create({ data: { id: p.id, tenantId, code: p.code, name: p.name, unitId: p.unitId, taxRateId: p.taxRateId, isService: p.isService } });
  await tx.productUnit.create({ data: { id: p.productUnitId, tenantId, productId: p.id, unitId: p.unitId, factor: 1, isBase: true } });
  if (p.barcode && !(await tx.productBarcode.findFirst({ where: { barcode: p.barcode } }))) {
    await tx.productBarcode.create({ data: { id: uuidv7(), tenantId, productId: p.id, productUnitId: null, barcode: p.barcode } });
  }
  if (list) await tx.productPrice.create({ data: { id: uuidv7(), tenantId, productId: p.id, priceListId: list.id, productUnitId: p.productUnitId, price: p.price } });
  return true;
}
