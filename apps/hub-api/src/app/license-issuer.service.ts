import { Injectable } from '@nestjs/common';
import { Installation, Plan } from '@vektra/hub-db';
import { LicensePayload, PlanLimits, signLicense } from '@vektra/licensing';
import { randomUUID } from 'node:crypto';
import { hubEnv, HubPrisma } from './core';

@Injectable()
export class LicenseIssuer {
  constructor(private readonly prisma: HubPrisma) {}

  limitsFor(installation: Installation & { plan: Plan }): PlanLimits {
    return { ...(installation.plan.limits as unknown as PlanLimits), ...((installation.limitOverrides as Partial<PlanLimits> | null) ?? {}) };
  }

  /** RUC autorizados: los de la instalación o, si no tiene, el del cliente. */
  rucsFor(installation: Installation & { client: { ruc: string } }): string[] {
    return installation.rucs.length ? installation.rucs : [installation.client.ruc];
  }

  /**
   * Firma la licencia PERMANENTE (pago único): no vence y está atada a la instalación y a sus RUC.
   * Es el código de activación que se ingresa al instalar (o al autorizar un RUC nuevo).
   */
  async issue(
    installation: Installation & { plan: Plan; client: { ruc: string; legalName: string; tradeName: string | null } },
    opts: { issuedBy?: string; record?: boolean } = {},
  ): Promise<{ token: string; rucs: string[] }> {
    const rucs = this.rucsFor(installation);
    const payload: LicensePayload = {
      iid: installation.publicId,
      client: installation.client.tradeName ?? installation.client.legalName,
      plan: installation.plan.code,
      status: 'active',
      kind: 'perpetual',
      rucs,
      limits: this.limitsFor(installation),
      iat: Math.floor(Date.now() / 1000),
      exp: null,
    };
    const token = signLicense(payload, hubEnv().LICENSE_PRIVATE_KEY);
    if (opts.record !== false) await this.prisma.db.licenseIssue.create({
      data: { id: randomUUID(), installationId: installation.id, kind: 'perpetual', status: 'active', expiresAt: null, issuedBy: opts.issuedBy ?? null },
    });
    return { token, rucs };
  }
}
