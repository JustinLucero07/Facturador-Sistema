import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { LicenseStatus } from '@vektra/shared-contracts';
import { evaluateLicense, licenseCoversRuc, LicenseState, PlanLimits } from '@vektra/licensing';
import { getEnv } from '../config/env';
import { PrismaService } from '../common/prisma.service';

const CACHE_MS = 30_000;

@Injectable()
export class LicenseService {
  private readonly logger = new Logger(LicenseService.name);
  private cache: { at: number; status: LicenseStatus; state: LicenseState } | null = null;
  private readonly rucs = new Map<string, string>();

  constructor(private readonly prisma: PrismaService) {}

  /** Desarrollo sin llave pública configurada: sin restricciones (nunca en producción). */
  get devMode(): boolean {
    const env = getEnv();
    return env.NODE_ENV !== 'production' && !env.LICENSE_PUBLIC_KEY;
  }

  invalidate(): void {
    this.cache = null;
  }

  /** RUC de la empresa (se cachea: el RUC de una empresa no cambia). */
  private async rucOf(tenantId: string): Promise<string | null> {
    const hit = this.rucs.get(tenantId);
    if (hit) return hit;
    const t = await this.prisma.as({ tenantId, userId: null }, (tx) => tx.tenant.findFirst({ where: { id: tenantId }, select: { ruc: true } }));
    if (t) this.rucs.set(tenantId, t.ruc);
    return t?.ruc ?? null;
  }

  /** Estado de la licencia; con `tenantId`, además verifica que el RUC de esa empresa esté autorizado. */
  async status(tenantId?: string | null): Promise<LicenseStatus> {
    const { status, state } = await this.load();
    if (this.devMode || !tenantId || state.state !== 'valid') return status;
    const ruc = await this.rucOf(tenantId);
    if (!ruc || licenseCoversRuc(state.payload, ruc)) return status;
    return {
      ...status,
      canIssueDocuments: false,
      message: `La licencia de esta instalación no incluye el RUC ${ruc}. Solicite a Vektra Systems un código de activación que lo incluya.`,
    };
  }

  async canWrite(tenantId?: string | null): Promise<boolean> {
    if (this.devMode) return true;
    return (await this.status(tenantId)).canIssueDocuments;
  }

  /** Alta de empresa: el RUC debe estar autorizado en la licencia permanente. */
  async assertRucAllowed(ruc: string): Promise<void> {
    if (this.devMode) return;
    const { state } = await this.load();
    if (state.state === 'valid' && !licenseCoversRuc(state.payload, ruc)) {
      throw new ForbiddenException(`La licencia de esta instalación no incluye el RUC ${ruc}. Solicite a Vektra Systems un código de activación que lo incluya.`);
    }
  }

  /** Límites del plan; `null` = sin límites (modo desarrollo). */
  async limits(): Promise<PlanLimits | null> {
    if (this.devMode) return null;
    const { state } = await this.load();
    return 'payload' in state ? state.payload.limits : null;
  }

  async isModuleAllowed(code: string): Promise<boolean> {
    const limits = await this.limits();
    if (!limits) return true;
    return limits.modules.includes('*') || limits.modules.includes(code);
  }

  /** Lanza 403 si se alcanzó el límite del plan. */
  async assertLimit(kind: 'tenants' | 'establishments' | 'emissionPoints' | 'users'): Promise<void> {
    const limits = await this.limits();
    if (!limits) return;
    const usage = await this.prisma.instanceUsage();
    const map = {
      tenants: [usage.tenants, limits.maxTenants, 'empresa', 'empresas'],
      establishments: [usage.establishments, limits.maxEstablishments, 'establecimiento', 'establecimientos'],
      emissionPoints: [usage.emissionPoints, limits.maxEmissionPoints, 'punto de emisión', 'puntos de emisión'],
      users: [usage.users, limits.maxUsers, 'usuario', 'usuarios'],
    } as const;
    const [used, max, singular, plural] = map[kind];
    if (max > 0 && used >= max) {
      throw new ForbiddenException(`Su plan permite máximo ${max} ${max === 1 ? singular : plural}. Contacte a Vektra para ampliar su plan.`);
    }
  }

  /** Código de activación offline entregado por Vektra. */
  async activate(code: string): Promise<LicenseStatus> {
    const env = getEnv();
    const state = evaluateLicense(code, env.LICENSE_PUBLIC_KEY, new Date(), env.INSTALLATION_ID || undefined);
    if (state.state !== 'valid') {
      const reason = state.state === 'invalid' ? state.reason : this.describe(state).message;
      throw new BadRequestException(`El código de activación no es válido: ${reason}`);
    }
    await this.prisma.client.instanceLicense.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        installationId: state.payload.iid,
        token: code,
        status: 'valid',
        expiresAt: state.payload.exp ? new Date(state.payload.exp * 1000) : null,
        lastValidatedAt: new Date(),
      },
      update: {
        installationId: state.payload.iid,
        token: code,
        status: 'valid',
        expiresAt: state.payload.exp ? new Date(state.payload.exp * 1000) : null,
        lastValidatedAt: new Date(),
        lastError: null,
      },
    });
    this.invalidate();
    return this.status();
  }

  private async load(): Promise<{ status: LicenseStatus; state: LicenseState }> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache;
    const env = getEnv();
    const row = await this.prisma.client.instanceLicense.findUnique({ where: { id: 1 } });
    const state: LicenseState = this.devMode
      ? { state: 'missing' }
      : evaluateLicense(row?.token, env.LICENSE_PUBLIC_KEY, new Date(), env.INSTALLATION_ID || undefined);
    const described = this.describe(state);
    const status: LicenseStatus = {
      state: state.state,
      canIssueDocuments: this.devMode || state.state === 'valid',
      hoursLeft: state.state === 'valid' ? state.hoursLeft : null,
      expiresAt: 'payload' in state && state.payload.exp ? new Date(state.payload.exp * 1000).toISOString() : null,
      lastValidatedAt: row?.lastValidatedAt?.toISOString() ?? null,
      plan: 'payload' in state ? state.payload.plan : null,
      client: 'payload' in state ? state.payload.client : null,
      kind: 'payload' in state ? state.payload.kind : null,
      rucs: 'payload' in state ? (state.payload.rucs ?? null) : null,
      limits: 'payload' in state ? { ...state.payload.limits } : null,
      message: described.message,
    };
    this.cache = { at: Date.now(), status, state };
    if (!status.canIssueDocuments) this.logger.warn(`Licencia no válida: ${status.message}`);
    return this.cache;
  }

  private describe(state: LicenseState): { message: string } {
    if (this.devMode) return { message: 'Modo desarrollo: licencia no requerida' };
    switch (state.state) {
      case 'valid':
        if (state.hoursLeft === null) return { message: 'Licencia permanente activa' };
        return state.hoursLeft < 24
          ? { message: `Sin conexión con Vektra. La emisión se bloqueará en ${state.hoursLeft} h si no se restablece.` }
          : { message: 'Licencia activa' };
      case 'suspended':
        return { message: 'Licencia suspendida. Comuníquese con Vektra Systems.' };
      case 'expired':
        return { message: 'Licencia vencida: más de 48 h sin validar con Vektra. Revise la conexión a internet o ingrese un código de activación.' };
      case 'invalid':
        return { message: `Licencia inválida: ${state.reason}` };
      default:
        return { message: 'Instalación sin licencia. Ingrese el código de activación entregado por Vektra.' };
    }
  }
}
