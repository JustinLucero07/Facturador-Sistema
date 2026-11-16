import type { INestApplication } from '@nestjs/common';
import { PrismaClient, ProvisionTenantResult } from '@vektra/db';
import { generate } from 'otplib';
import request from 'supertest';
import { createApp, login, makeTenant, ownerClient, PASSWORD, randomRuc, seedPermissions, tokenFor, uniqueEmail } from './helpers';

describe('Autenticación', () => {
  let owner: PrismaClient;
  let app: INestApplication;
  let T: ProvisionTenantResult;
  let T2: ProvisionTenantResult;
  const uno = uniqueEmail('auth-uno');
  const dos = uniqueEmail('auth-dos');

  beforeAll(async () => {
    owner = ownerClient();
    await seedPermissions(owner);
    T = await makeTenant(owner, randomRuc(), uno);
    T2 = await makeTenant(owner, randomRuc(), dos);
    app = await createApp({ AUTH_MAX_FAILED_ATTEMPTS: '3' });
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  const http = () => request(app.getHttpServer());

  it('bloquea la cuenta tras N intentos fallidos', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await login(app, uno, 'incorrecta1');
      expect(r.status).toBe(401);
    }
    const locked = await login(app, uno);
    expect(locked.status).toBe(423);
    expect(locked.body.message).toMatch(/bloqueada/);
    // El administrador (soporte) desbloquea → vuelve a funcionar.
    await owner.user.update({ where: { id: T.adminUserId }, data: { lockedUntil: null, failedAttempts: 0 } });
    expect((await login(app, uno)).body.step).toBe('done');
  });

  it('el mismo mensaje para usuario inexistente y contraseña errada', async () => {
    const a = await login(app, 'noexiste@x.test', 'algo12345');
    const b = await login(app, dos, 'algo12345');
    expect(a.status).toBe(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it('rota el refresh token y detecta reutilización', async () => {
    const res = await login(app, dos);
    const cookie = res.headers['set-cookie'] as unknown as string[];
    const first = await http().post('/api/auth/refresh').set('cookie', cookie).expect(200);
    const rotated = first.headers['set-cookie'] as unknown as string[];
    // Reusar el original revoca toda la familia.
    await http().post('/api/auth/refresh').set('cookie', cookie).expect(401);
    await http().post('/api/auth/refresh').set('cookie', rotated).expect(401);
  });

  it('cambiar la contraseña invalida los accesos emitidos', async () => {
    const token = await tokenFor(app, dos);
    await http()
      .post('/api/auth/change-password')
      .set('authorization', `Bearer ${token}`)
      .send({ currentPassword: PASSWORD, newPassword: 'Nueva.2026x' })
      .expect(204);
    await http().get('/api/auth/me').set('authorization', `Bearer ${token}`).expect(401);
    expect((await login(app, dos, 'Nueva.2026x')).body.step).toBe('done');
  });

  it('2FA: configurar, activar y exigir el código en el login', async () => {
    const token = await tokenFor(app, uno);
    const setup = await http().post('/api/auth/2fa/setup').set('authorization', `Bearer ${token}`).expect(200);
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    await http().post('/api/auth/2fa/enable').set('authorization', `Bearer ${token}`).send({ code: '000000' }).expect(400);
    await http()
      .post('/api/auth/2fa/enable')
      .set('authorization', `Bearer ${token}`)
      .send({ code: await generate({ secret: setup.body.secret }) })
      .expect(204);

    const step1 = await login(app, uno);
    expect(step1.body.step).toBe('2fa');
    await http().post('/api/auth/login/2fa').send({ challenge: step1.body.challenge, code: '123456' }).expect(401);
    const step2 = await http()
      .post('/api/auth/login/2fa')
      .send({ challenge: step1.body.challenge, code: await generate({ secret: setup.body.secret }) })
      .expect(200);
    expect(step2.body.step).toBe('done');
  });

  it('usuario con varias empresas elige empresa al ingresar', async () => {
    // Preparar: el usuario "dos" también es cajero en la empresa T.
    const roles = await owner.role.findFirstOrThrow({ where: { tenantId: T.tenantId, systemCode: 'CASHIER' } });
    const user = await owner.user.findUniqueOrThrow({ where: { email: dos } });
    const membershipId = crypto.randomUUID();
    await owner.membership.create({ data: { id: membershipId, tenantId: T.tenantId, userId: user.id } });
    await owner.membershipRole.create({ data: { tenantId: T.tenantId, membershipId, roleId: roles.id } });

    const step1 = await login(app, dos, 'Nueva.2026x');
    expect(step1.body.step).toBe('tenant');
    expect(step1.body.tenants.map((t: { id: string }) => t.id).sort()).toEqual([T.tenantId, T2.tenantId].sort());
    const done = await http().post('/api/auth/login/tenant').send({ challenge: step1.body.challenge, tenantId: T.tenantId }).expect(200);
    expect(done.body.session.tenant.id).toBe(T.tenantId);
    // Como cajero en T no puede gestionar usuarios.
    await http().get('/api/users').set('authorization', `Bearer ${done.body.accessToken}`).expect(403);
  });
});
