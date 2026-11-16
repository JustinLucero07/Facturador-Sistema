import { Logger } from '@nestjs/common';
import { PrismaClient } from '@vektra/db';
import { evaluateLicense } from '@vektra/licensing';
import type { WorkerEnv } from './env';

const logger = new Logger('LicenseCheck');

/**
 * Valida la licencia con el Vektra Hub y reporta el uso de la instalación.
 * Si el Hub no responde, se conserva el token anterior (válido hasta 48 h desde la última validación).
 */
export async function checkLicenseWithHub(prisma: PrismaClient, env: WorkerEnv): Promise<'ok' | 'skipped' | 'failed'> {
  if (!env.INSTALLATION_ID || !env.INSTALLATION_SECRET || !env.HUB_URL) {
    logger.warn('INSTALLATION_ID / INSTALLATION_SECRET / HUB_URL no configurados: se omite la validación');
    return 'skipped';
  }
  const [usage] = await prisma.$queryRaw<{ tenants: bigint; establishments: bigint; emission_points: bigint; users: bigint }[]>`SELECT * FROM instance_usage()`;
  const report = {
    tenants: Number(usage.tenants),
    establishments: Number(usage.establishments),
    emissionPoints: Number(usage.emission_points),
    users: Number(usage.users),
  };

  try {
    const res = await fetch(`${env.HUB_URL.replace(/\/$/, '')}/api/v1/licenses/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installationId: env.INSTALLATION_ID, secret: env.INSTALLATION_SECRET, appVersion: env.APP_VERSION, report }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string; message?: string };
    if (!res.ok || !body.token) throw new Error(body.message ?? `HTTP ${res.status}`);

    const state = evaluateLicense(body.token, env.LICENSE_PUBLIC_KEY, new Date(), env.INSTALLATION_ID);
    if (state.state === 'invalid' || state.state === 'missing') {
      throw new Error(`El Hub devolvió una licencia no válida (${state.state === 'invalid' ? state.reason : 'vacía'})`);
    }
    const expiresAt = new Date(state.payload.exp * 1000);
    await prisma.instanceLicense.upsert({
      where: { id: 1 },
      create: { id: 1, installationId: env.INSTALLATION_ID, token: body.token, status: state.state, expiresAt, lastValidatedAt: new Date() },
      update: { installationId: env.INSTALLATION_ID, token: body.token, status: state.state, expiresAt, lastValidatedAt: new Date(), lastError: null },
    });
    logger.log(`Licencia renovada (${state.state}) hasta ${expiresAt.toISOString()}`);
    return 'ok';
  } catch (e) {
    const message = (e as Error).message;
    logger.error(`No se pudo validar con el Hub: ${message}`);
    await prisma.instanceLicense.upsert({
      where: { id: 1 },
      create: { id: 1, installationId: env.INSTALLATION_ID, lastError: message },
      update: { lastError: message },
    });
    return 'failed';
  }
}
