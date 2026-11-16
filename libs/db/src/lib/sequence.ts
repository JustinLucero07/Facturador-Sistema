import { Tx } from './client';

export const SRI_DOC_TYPES = ['01', '03', '04', '05', '06', '07'] as const;
export type SriDocType = (typeof SRI_DOC_TYPES)[number];

/**
 * Reserva el siguiente secuencial para (punto de emisión, tipo de comprobante) de forma atómica.
 * El UPDATE bloquea la fila hasta el fin de la transacción: dos cajas concurrentes nunca obtienen
 * el mismo número, y si la transacción falla el número no se consume (sin saltos).
 * Debe llamarse dentro de `withContext` (RLS).
 */
export async function nextSequential(tx: Tx, emissionPointId: string, docType: SriDocType): Promise<bigint> {
  const rows = await tx.$queryRaw<{ value: bigint }[]>`
    INSERT INTO sequence_counter (tenant_id, emission_point_id, doc_type, next_value, updated_at)
    VALUES (app_current_tenant(), ${emissionPointId}::uuid, ${docType}, 2, now())
    ON CONFLICT (emission_point_id, doc_type)
    DO UPDATE SET next_value = sequence_counter.next_value + 1, updated_at = now()
    RETURNING next_value - 1 AS value`;
  return rows[0].value;
}

/** Formato de 9 dígitos usado en la clave de acceso y el número de comprobante. */
export function formatSequential(value: bigint | number): string {
  return value.toString().padStart(9, '0');
}
