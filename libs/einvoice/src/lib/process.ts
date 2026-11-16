import { EDocStatus, PrismaClient, Tx, uuidv7, withContext } from '@vektra/db';
import { hasCode, queryAuthorization, sendToReception, SRI_ERROR_CODES, SriConnectionError, SriMessage } from '@vektra/sri-core';
import { RetryLaterError } from './errors';
import { loadSriSettings, wsFor } from './settings';

/**
 * Ciclo de vida en el SRI (Ficha v2.34, numerales 5.10–5.12 y 7.4):
 *   SIGNED/CONTINGENCY → (recepción) → RECEIVED | RETURNED | CONTINGENCY
 *   RECEIVED → (autorización, tras una espera configurable) → AUTHORIZED | NOT_AUTHORIZED | sigue RECEIVED (en proceso)
 * Los comprobantes DEVUELTOS se corrigen y reenvían con la MISMA clave y secuencial (numeral 5.10).
 */

export interface ProcessDeps {
  prisma: PrismaClient;
  fetchImpl?: typeof fetch;
}

export type NextStep = { kind: 'authorize'; delayMs: number } | { kind: 'email' } | { kind: 'none' };

async function transition(
  tx: Tx,
  tenantId: string,
  documentId: string,
  from: EDocStatus,
  to: EDocStatus,
  data: { messages?: SriMessage[]; note?: string; extra?: Record<string, unknown> } = {},
): Promise<void> {
  await tx.electronicDocument.update({
    where: { documentId },
    data: { status: to, ...(data.messages ? { lastMessages: data.messages as object[] } : {}), ...(data.extra ?? {}) },
  });
  await tx.electronicDocumentEvent.create({
    data: { id: uuidv7(), tenantId, documentId, fromStatus: from, toStatus: to, messages: (data.messages ?? []) as object[], note: data.note ?? null },
  });
}

const RETRYABLE_RECEPTION = Object.entries(SRI_ERROR_CODES)
  .filter(([, v]) => v.retryable)
  .map(([k]) => k);

/** Envía el comprobante firmado al WS de recepción. */
export async function sendStep(deps: ProcessDeps, tenantId: string, documentId: string): Promise<NextStep> {
  const { prisma } = deps;
  const settings = await loadSriSettings(prisma);
  const edoc = await withContext(prisma, { tenantId }, (tx) => tx.electronicDocument.findUnique({ where: { documentId } }));
  if (!edoc) return { kind: 'none' };
  if (!['SIGNED', 'CONTINGENCY', 'SENT'].includes(edoc.status) || !edoc.signedXml) return { kind: 'none' };

  const ws = wsFor(settings, edoc.environment);
  await withContext(prisma, { tenantId }, (tx) =>
    tx.electronicDocument.update({ where: { documentId }, data: { attempts: { increment: 1 }, lastAttemptAt: new Date() } }),
  );

  let result;
  try {
    result = await sendToReception(edoc.signedXml, ws.reception, { timeoutMs: settings.timeoutMs, fetchImpl: deps.fetchImpl });
  } catch (e) {
    if (e instanceof SriConnectionError) {
      await withContext(prisma, { tenantId }, async (tx) => {
        if (edoc.status === 'CONTINGENCY') {
          await tx.electronicDocument.update({
            where: { documentId },
            data: { lastMessages: [{ identifier: 'RED', message: e.message, additionalInfo: null, type: 'ERROR' }] },
          });
        } else {
          await transition(tx, tenantId, documentId, edoc.status, 'CONTINGENCY', { note: e.message });
        }
      });
      throw new RetryLaterError(e.message);
    }
    throw e;
  }

  return withContext(prisma, { tenantId }, async (tx): Promise<NextStep> => {
    if (result.status === 'RECIBIDA') {
      await transition(tx, tenantId, documentId, edoc.status, 'RECEIVED', { messages: result.messages, note: 'Recibido por el SRI' });
      return { kind: 'authorize', delayMs: settings.authWaitSeconds * 1000 };
    }
    // DEVUELTA
    if (hasCode(result.messages, '43') || hasCode(result.messages, '70')) {
      // Ya registrado o en procesamiento: no reenviar, consultar autorización (numeral 11, nota 2).
      await transition(tx, tenantId, documentId, edoc.status, 'RECEIVED', { messages: result.messages, note: 'El SRI ya tenía el comprobante; se consultará la autorización' });
      return { kind: 'authorize', delayMs: settings.authWaitSeconds * 1000 };
    }
    if (result.messages.length > 0 && result.messages.every((m) => RETRYABLE_RECEPTION.includes(m.identifier))) {
      await transition(tx, tenantId, documentId, edoc.status, 'CONTINGENCY', { messages: result.messages, note: 'Error temporal del SRI' });
      throw new RetryLaterError('Error temporal del SRI en recepción');
    }
    await transition(tx, tenantId, documentId, edoc.status, 'RETURNED', { messages: result.messages, note: 'Devuelto por el SRI en la recepción' });
    return { kind: 'none' };
  });
}

/** Consulta la autorización. Si el SRI aún procesa, lanza RetryLaterError para reintentar más tarde. */
export async function authorizeStep(deps: ProcessDeps, tenantId: string, documentId: string): Promise<NextStep> {
  const { prisma } = deps;
  const settings = await loadSriSettings(prisma);
  const edoc = await withContext(prisma, { tenantId }, (tx) => tx.electronicDocument.findUnique({ where: { documentId } }));
  if (!edoc || edoc.status !== 'RECEIVED') return { kind: 'none' };

  let result;
  try {
    result = await queryAuthorization(edoc.accessKey, wsFor(settings, edoc.environment).authorization, { timeoutMs: settings.timeoutMs, fetchImpl: deps.fetchImpl });
  } catch (e) {
    if (e instanceof SriConnectionError) throw new RetryLaterError(e.message);
    throw e;
  }

  if (result.status === 'EN PROCESO') throw new RetryLaterError('El SRI aún está procesando el comprobante');

  return withContext(prisma, { tenantId }, async (tx): Promise<NextStep> => {
    if (result.status === 'AUTORIZADO') {
      await transition(tx, tenantId, documentId, 'RECEIVED', 'AUTHORIZED', {
        messages: result.messages,
        note: `Autorizado (${result.environment ?? ''})`,
        extra: {
          authorizedXml: result.authorizedXml,
          authorizationNumber: result.authorizationNumber,
          authorizedAt: result.authorizationDate ? new Date(result.authorizationDate) : new Date(),
        },
      });
      return edoc.emailStatus === 'PENDING' ? { kind: 'email' } : { kind: 'none' };
    }
    await transition(tx, tenantId, documentId, 'RECEIVED', 'NOT_AUTHORIZED', { messages: result.messages, note: 'No autorizado por el SRI' });
    return { kind: 'none' };
  });
}

/** Reintento manual desde el panel: reencola según el estado. */
export async function retryTarget(prisma: PrismaClient, tenantId: string, documentId: string): Promise<'send' | 'authorize' | null> {
  const edoc = await withContext(prisma, { tenantId }, (tx) => tx.electronicDocument.findUnique({ where: { documentId } }));
  if (!edoc) return null;
  if (['SIGNED', 'CONTINGENCY', 'SENT'].includes(edoc.status)) return 'send';
  if (edoc.status === 'RECEIVED') return 'authorize';
  if (edoc.status === 'RETURNED' || edoc.status === 'NOT_AUTHORIZED') {
    // Reenvío con la misma clave y secuencial (numeral 5.10).
    await withContext(prisma, { tenantId }, (tx) => transition(tx, tenantId, documentId, edoc.status, 'SIGNED', { note: 'Reenvío solicitado por el usuario' }));
    return 'send';
  }
  return null;
}

/** Comprobantes pendientes de una empresa (para el barrido periódico del worker). */
export async function pendingDocuments(prisma: PrismaClient, tenantId: string, olderThan: Date) {
  return withContext(prisma, { tenantId }, (tx) =>
    tx.electronicDocument.findMany({
      where: { status: { in: ['SIGNED', 'SENT', 'CONTINGENCY', 'RECEIVED'] as EDocStatus[] }, updatedAt: { lt: olderThan } },
      select: { documentId: true, status: true },
      take: 200,
      orderBy: { createdAt: 'asc' },
    }),
  );
}
