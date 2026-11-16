import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { uuidv7 } from '@vektra/db';
import { createHash, randomBytes } from 'node:crypto';
import { getEnv } from '../config/env';
import { PrismaService } from '../common/prisma.service';

export interface AccessTokenPayload {
  typ: 'access';
  sub: string;
  tid: string;
  ver: number;
}

export interface ChallengePayload {
  typ: '2fa' | 'tenant';
  sub: string;
}

export interface IssuedTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async issue(
    user: { id: string; tokenVersion: number },
    tenantId: string,
    meta: { ip: string | null; userAgent: string | null },
    familyId: string = uuidv7(),
  ): Promise<IssuedTokens & { refreshId: string }> {
    const env = getEnv();
    const payload: AccessTokenPayload = { typ: 'access', sub: user.id, tid: tenantId, ver: user.tokenVersion };
    const accessToken = await this.jwt.signAsync(payload, { expiresIn: env.JWT_ACCESS_TTL_SECONDS });
    const refreshToken = randomBytes(32).toString('base64url');
    const refreshExpiresAt = new Date(Date.now() + env.REFRESH_TTL_DAYS * 86_400_000);
    const refreshId = uuidv7();
    await this.prisma.client.refreshToken.create({
      data: {
        id: refreshId,
        userId: user.id,
        tenantId,
        familyId,
        tokenHash: sha256(refreshToken),
        expiresAt: refreshExpiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
      },
    });
    return { accessToken, expiresIn: env.JWT_ACCESS_TTL_SECONDS, refreshToken, refreshExpiresAt, refreshId };
  }

  /**
   * Rotación: cada refresh se usa una sola vez. Si llega uno ya usado (robado/reutilizado),
   * se revoca toda la familia (todas las sesiones derivadas de ese login).
   */
  async rotate(rawRefresh: string, meta: { ip: string | null; userAgent: string | null }) {
    const record = await this.prisma.client.refreshToken.findUnique({
      where: { tokenHash: sha256(rawRefresh) },
      include: { user: true },
    });
    if (!record) throw new UnauthorizedException();
    if (record.revokedAt) {
      await this.revokeFamily(record.familyId);
      return { reused: true as const, userId: record.userId, tenantId: record.tenantId };
    }
    if (record.expiresAt <= new Date() || !record.user.active) throw new UnauthorizedException();

    const issued = await this.issue(record.user, record.tenantId, meta, record.familyId);
    // Revocación condicional: si otro request rotó el mismo token en paralelo, solo uno gana.
    const { count } = await this.prisma.client.refreshToken.updateMany({
      where: { id: record.id, revokedAt: null },
      data: { revokedAt: new Date(), replacedBy: issued.refreshId },
    });
    if (count === 0) {
      await this.revokeFamily(record.familyId);
      return { reused: true as const, userId: record.userId, tenantId: record.tenantId };
    }
    return { reused: false as const, issued, user: record.user, tenantId: record.tenantId };
  }

  async revokeByRaw(rawRefresh: string): Promise<void> {
    const record = await this.prisma.client.refreshToken.findUnique({ where: { tokenHash: sha256(rawRefresh) } });
    if (record) await this.revokeFamily(record.familyId);
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.client.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.client.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  signChallenge(payload: ChallengePayload): Promise<string> {
    return this.jwt.signAsync(payload, { expiresIn: 300 });
  }

  async verifyChallenge(token: string, typ: ChallengePayload['typ']): Promise<ChallengePayload> {
    try {
      const payload = await this.jwt.verifyAsync<ChallengePayload>(token);
      if (payload.typ !== typ) throw new Error('tipo');
      return payload;
    } catch {
      throw new UnauthorizedException('El paso de verificación expiró. Inicie sesión nuevamente.');
    }
  }
}
