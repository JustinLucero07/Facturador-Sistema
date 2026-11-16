import { z } from 'zod';

export const uuidSchema = z.uuid({ message: 'Identificador inválido' });

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Correo electrónico inválido' }));

/** Mínimo 8 caracteres con al menos una letra y un número. */
export const passwordSchema = z
  .string()
  .min(8, 'La contraseña debe tener al menos 8 caracteres')
  .max(128, 'La contraseña es demasiado larga')
  .regex(/[A-Za-z]/, 'La contraseña debe contener al menos una letra')
  .regex(/\d/, 'La contraseña debe contener al menos un número');

export const code3Schema = z.string().regex(/^\d{3}$/, 'Debe ser un código de 3 dígitos (ej. 001)').refine((v) => v !== '000', 'El código 000 no es válido');

export const nonEmpty = (label: string, max = 300) =>
  z.string().trim().min(1, `${label} es obligatorio`).max(max, `${label} es demasiado largo`);

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Formato de error de la API (siempre en español). */
export interface ApiError {
  statusCode: number;
  message: string;
  /** Errores por campo (validación). */
  fields?: Record<string, string>;
}
