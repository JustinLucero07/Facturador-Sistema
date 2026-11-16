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

  /**
   * Firma una licencia. Periódica: expira en `graceHours` (48 h por defecto).
   * Offline: expira en N días (código de activación manual).
   */
  async issue(
    installation: Installation & { plan: Plan; client: { legalName: string; tradeName: string | null } },
    kind: 'periodic' | 'offline',
    opts: { days?: number; issuedBy?: string } = {},
  ): Promise<{ token: string; expiresAt: Date }> {
    const now = Math.floor(Date.now() / 1000);
    const ttl = kind === 'offline' ? (opts.days ?? 7) * 86_400 : installation.graceHours * 3600;
    const status = installation.status === 'ACTIVE' ? 'active' : 'suspended';
    const payload: LicensePayload = {
      iid: installation.publicId,
      client: installation.client.tradeName ?? installation.client.legalName,
      plan: installation.plan.code,
      status,
      kind,
      limits: this.limitsFor(installation),
      iat: now,
      exp: now + ttl,
    };
    const token = signLicense(payload, hubEnv().LICENSE_PRIVATE_KEY);
    const expiresAt = new Date(payload.exp * 1000);
    await this.prisma.db.licenseIssue.create({
      data: { id: randomUUID(), installationId: installation.id, kind, status, expiresAt, issuedBy: opts.issuedBy ?? null },
    });
    return { token, expiresAt };
  }
}
