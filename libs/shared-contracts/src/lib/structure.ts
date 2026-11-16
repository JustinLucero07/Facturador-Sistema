import { z } from 'zod';
import { code3Schema, nonEmpty, uuidSchema } from './common';

export const establishmentSchema = z.object({
  code: code3Schema,
  name: nonEmpty('El nombre', 200),
  address: nonEmpty('La dirección', 300),
  active: z.boolean().default(true),
});
export type EstablishmentRequest = z.infer<typeof establishmentSchema>;

export const emissionPointSchema = z.object({
  establishmentId: uuidSchema,
  code: code3Schema,
  name: nonEmpty('El nombre', 120),
  kind: z.enum(['WEB', 'DESKTOP']).default('WEB'),
  active: z.boolean().default(true),
});
export type EmissionPointRequest = z.infer<typeof emissionPointSchema>;

export const warehouseSchema = z.object({
  establishmentId: uuidSchema,
  name: nonEmpty('El nombre', 120),
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
});
export type WarehouseRequest = z.infer<typeof warehouseSchema>;

export interface EmissionPointItem {
  id: string;
  code: string;
  name: string;
  kind: 'WEB' | 'DESKTOP';
  active: boolean;
  deviceName: string | null;
}

export interface WarehouseItem {
  id: string;
  name: string;
  isDefault: boolean;
  active: boolean;
}

export interface EstablishmentItem {
  id: string;
  code: string;
  name: string;
  address: string;
  active: boolean;
  emissionPoints: EmissionPointItem[];
  warehouses: WarehouseItem[];
}
