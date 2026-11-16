import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import { createPrismaClient, PrismaClient, provisionTenant } from '@vektra/db';
import { PERMISSIONS } from '@vektra/shared-domain';
import request from 'supertest';
import { AppModule } from '../src/app/app.module';
import { configureApp } from '../src/app/bootstrap';
import { resetEnvCache } from '../src/app/config/env';
import { applyTestEnv, testUrls } from './test-env';

export const PASSWORD = 'Prueba.2026!';

/** RUC de persona natural válido y aleatorio (cédula módulo 10 + 001). */
export function randomRuc(): string {
  const province = String(1 + Math.floor(Math.random() * 24)).padStart(2, '0');
  const base = province + String(Math.floor(Math.random() * 6)) + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  const coefficients = [2, 1, 2, 1, 2, 1, 2, 1, 2];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let p = Number(base[i]) * coefficients[i];
    if (p > 9) p -= 9;
    sum += p;
  }
  return `${base}${(10 - (sum % 10)) % 10}001`;
}

/** Correo único por ejecución de pruebas. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@test.local`;
}

/** Cliente con el usuario DUEÑO (se salta RLS): solo para preparar datos. */
export function ownerClient(): PrismaClient {
  return createPrismaClient(testUrls().ownerUrl);
}

/** Cliente con `vektra_app` (RLS aplica), igual que la app en producción. */
export function appClient(): PrismaClient {
  return createPrismaClient(testUrls().appUrl);
}

export async function seedPermissions(owner: PrismaClient): Promise<void> {
  for (const p of PERMISSIONS) {
    await owner.permission.upsert({ where: { code: p.code }, create: { ...p }, update: {} });
  }
}

let passwordHash: Promise<string> | null = null;

export async function makeTenant(owner: PrismaClient, ruc: string, adminEmail: string, template = 'general') {
  passwordHash ??= hash(PASSWORD);
  return provisionTenant(owner, {
    ruc,
    legalName: `EMPRESA ${ruc}`,
    mainAddress: 'Cuenca',
    businessTemplate: template,
    admin: { email: adminEmail, fullName: `Admin ${ruc}`, passwordHash: await passwordHash },
  });
}

export async function createApp(envOverrides: Record<string, string> = {}): Promise<INestApplication> {
  applyTestEnv(envOverrides);
  resetEnvCache();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();
  return app;
}

export async function login(app: INestApplication, email: string, password = PASSWORD) {
  const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password });
  return res;
}

export async function tokenFor(app: INestApplication, email: string): Promise<string> {
  const res = await login(app, email);
  if (res.body.step !== 'done') throw new Error(`Login incompleto para ${email}: ${JSON.stringify(res.body)}`);
  return res.body.accessToken as string;
}
