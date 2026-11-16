import {
  CanActivate,
  ExecutionContext,
  Injectable,
  OnModuleDestroy,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { createHubPrismaClient, PrismaClient } from '@vektra/hub-db';
import type { Request } from 'express';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HUB_DATABASE_URL: z.string().min(1),
  HUB_PORT: z.coerce.number().default(3400),
  HUB_WEB_ORIGIN: z.string().default('http://localhost:4400'),
  HUB_JWT_SECRET: z.string().min(32, 'HUB_JWT_SECRET debe tener al menos 32 caracteres'),
  LICENSE_PRIVATE_KEY: z.string().min(1, 'Falta LICENSE_PRIVATE_KEY'),
  HUB_PUBLIC_URL: z.string().default('http://localhost:3400'),
});
export type HubEnv = z.infer<typeof envSchema>;

let cached: HubEnv | null = null;
export function hubEnv(): HubEnv {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Configuración inválida del Hub:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  cached = parsed.data;
  return cached;
}

@Injectable()
export class HubPrisma implements OnModuleDestroy {
  readonly db: PrismaClient = createHubPrismaClient(hubEnv().HUB_DATABASE_URL);
  async onModuleDestroy() {
    await this.db.$disconnect();
  }
}

export const HUB_PUBLIC = 'hub:public';
export const HubPublic = () => SetMetadata(HUB_PUBLIC, true);

export interface HubRequest extends Request {
  hubUserId?: string;
}

@Injectable()
export class HubAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(HUB_PUBLIC, [context.getHandler(), context.getClass()])) return true;
    const req = context.switchToHttp().getRequest<HubRequest>();
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) throw new UnauthorizedException();
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; typ: string }>(header.slice(7));
      if (payload.typ !== 'hub') throw new Error();
      req.hubUserId = payload.sub;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
