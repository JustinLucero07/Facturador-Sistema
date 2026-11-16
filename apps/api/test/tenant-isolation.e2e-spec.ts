/**
 * Criterio de aceptación: "Dos empresas distintas en el mismo servidor no pueden ver datos la una de la otra".
 * Se prueba en dos niveles: la base de datos (RLS con el rol real de la app) y la API HTTP.
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient, ProvisionTenantResult, uuidv7, withContext } from '@vektra/db';
import request from 'supertest';
import { appClient, createApp, makeTenant, ownerClient, randomRuc, seedPermissions, tokenFor, uniqueEmail } from './helpers';

describe('Aislamiento entre empresas', () => {
  let owner: PrismaClient;
  let db: PrismaClient;
  let app: INestApplication;
  let A: ProvisionTenantResult;
  let B: ProvisionTenantResult;
  const emailA = uniqueEmail('admin-a');

  beforeAll(async () => {
    owner = ownerClient();
    db = appClient();
    await seedPermissions(owner);
    A = await makeTenant(owner, randomRuc(), emailA);
    B = await makeTenant(owner, randomRuc(), uniqueEmail('admin-b'));
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await owner.$disconnect();
  });

  describe('nivel base de datos (RLS)', () => {
    it('sin contexto de empresa no se ve ninguna fila', async () => {
      // El dueño ve todas las filas; la app sin contexto, ninguna.
      expect(await owner.establishment.count()).toBeGreaterThanOrEqual(2);
      expect(await db.establishment.count()).toBe(0);
      expect(await db.role.count()).toBe(0);
    });

    it('con contexto de A solo se ven datos de A', async () => {
      const rows = await withContext(db, { tenantId: A.tenantId }, (tx) => tx.establishment.findMany());
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe(A.tenantId);
      const foreign = await withContext(db, { tenantId: A.tenantId }, (tx) => tx.establishment.findFirst({ where: { id: B.establishmentId } }));
      expect(foreign).toBeNull();
    });

    it('A no puede modificar ni borrar datos de B', async () => {
      const updated = await withContext(db, { tenantId: A.tenantId }, (tx) =>
        tx.establishment.updateMany({ where: { id: B.establishmentId }, data: { name: 'HACKEADO' } }),
      );
      expect(updated.count).toBe(0);
      const deleted = await withContext(db, { tenantId: A.tenantId }, (tx) => tx.warehouse.deleteMany({ where: { id: B.warehouseId } }));
      expect(deleted.count).toBe(0);
      const b = await owner.establishment.findUnique({ where: { id: B.establishmentId } });
      expect(b?.name).not.toBe('HACKEADO');
    });

    it('A no puede insertar filas a nombre de B', async () => {
      await expect(
        withContext(db, { tenantId: A.tenantId }, (tx) =>
          tx.establishment.create({ data: { id: uuidv7(), tenantId: B.tenantId, code: '009', name: 'Intruso', address: 'x' } }),
        ),
      ).rejects.toThrow();
    });

    it('la bitácora de auditoría es de solo inserción para la app', async () => {
      await expect(db.$executeRaw`DELETE FROM audit_log`).rejects.toThrow(/permission denied/);
    });
  });

  describe('nivel API', () => {
    let tokenA: string;

    beforeAll(async () => {
      tokenA = await tokenFor(app, emailA);
    });

    it('lista solo los establecimientos de su empresa', async () => {
      const res = await request(app.getHttpServer()).get('/api/establishments').set('authorization', `Bearer ${tokenA}`).expect(200);
      expect(res.body.map((e: { id: string }) => e.id)).toEqual([A.establishmentId]);
    });

    it('no puede editar un establecimiento de otra empresa (404)', async () => {
      await request(app.getHttpServer())
        .patch(`/api/establishments/${B.establishmentId}`)
        .set('authorization', `Bearer ${tokenA}`)
        .send({ code: '001', name: 'Robado', address: 'x', active: true })
        .expect(404);
    });

    it('lista solo los usuarios de su empresa', async () => {
      const res = await request(app.getHttpServer()).get('/api/users').set('authorization', `Bearer ${tokenA}`).expect(200);
      expect(res.body.map((u: { email: string }) => u.email)).toEqual([emailA]);
    });

    it('no puede asignar roles de otra empresa', async () => {
      const bRole = await owner.role.findFirstOrThrow({ where: { tenantId: B.tenantId, systemCode: 'CASHIER' } });
      const res = await request(app.getHttpServer())
        .post('/api/users')
        .set('authorization', `Bearer ${tokenA}`)
        .send({ email: uniqueEmail('cajero'), fullName: 'Cajero', password: 'Cajero.2026', roleIds: [bRole.id] })
        .expect(400);
      expect(res.body.fields.roleIds).toBeDefined();
    });

    it('no puede cambiarse a una empresa de la que no es miembro', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/switch-tenant')
        .set('authorization', `Bearer ${tokenA}`)
        .send({ tenantId: B.tenantId })
        .expect(403);
    });

    it('un administrador de empresa no accede a funciones de Soporte Vektra', async () => {
      await request(app.getHttpServer()).get('/api/admin/tenants').set('authorization', `Bearer ${tokenA}`).expect(403);
    });
  });
});
