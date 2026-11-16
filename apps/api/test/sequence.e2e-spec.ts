/**
 * Secuenciales sin saltos ni duplicados con concurrencia (varias cajas emitiendo a la vez).
 */
import { formatSequential, nextSequential, PrismaClient, ProvisionTenantResult, withContext } from '@vektra/db';
import { appClient, makeTenant, ownerClient, randomRuc, seedPermissions, uniqueEmail } from './helpers';

describe('Secuenciales por punto de emisión', () => {
  let owner: PrismaClient;
  let db: PrismaClient;
  let T: ProvisionTenantResult;
  let other: ProvisionTenantResult;

  beforeAll(async () => {
    owner = ownerClient();
    db = appClient();
    await seedPermissions(owner);
    T = await makeTenant(owner, randomRuc(), uniqueEmail('secuencial'));
    other = await makeTenant(owner, randomRuc(), uniqueEmail('otra'));
  });

  afterAll(async () => {
    await db.$disconnect();
    await owner.$disconnect();
  });

  const take = (tenantId: string, ep: string, docType: '01' | '04' = '01') =>
    withContext(db, { tenantId }, (tx) => nextSequential(tx, ep, docType));

  it('50 emisiones concurrentes obtienen 1..50 sin duplicados', async () => {
    const values = await Promise.all(Array.from({ length: 50 }, () => take(T.tenantId, T.emissionPointId)));
    const sorted = values.map(Number).sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('una transacción fallida no consume el número (sin saltos)', async () => {
    await expect(
      withContext(db, { tenantId: T.tenantId }, async (tx) => {
        await nextSequential(tx, T.emissionPointId, '01');
        throw new Error('fallo al guardar la factura');
      }),
    ).rejects.toThrow('fallo');
    expect(Number(await take(T.tenantId, T.emissionPointId))).toBe(51);
  });

  it('cada tipo de comprobante y punto de emisión tiene su propia serie', async () => {
    expect(Number(await take(T.tenantId, T.emissionPointId, '04'))).toBe(1);
    expect(Number(await take(other.tenantId, other.emissionPointId, '01'))).toBe(1);
  });

  it('una empresa no puede usar el punto de emisión de otra', async () => {
    await expect(take(T.tenantId, other.emissionPointId)).rejects.toThrow();
  });

  it('formatea a 9 dígitos', () => {
    expect(formatSequential(51n)).toBe('000000051');
  });
});
