import { agingBucket, daysOverdue } from './ledger';

describe('antigüedad de saldos', () => {
  const today = new Date('2026-11-17T15:00:00Z');
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  it('días de vencido', () => {
    expect(daysOverdue(d('2026-11-17'), today)).toBe(0);
    expect(daysOverdue(d('2026-11-30'), today)).toBe(0);
    expect(daysOverdue(d('2026-11-16'), today)).toBe(1);
    expect(daysOverdue(d('2026-08-01'), today)).toBe(108);
  });
  it('tramos 1-30, 31-60, 61-90, más de 90', () => {
    expect(agingBucket(d('2026-11-20'), today)).toBe('current');
    expect(agingBucket(d('2026-10-18'), today)).toBe('d30');
    expect(agingBucket(d('2026-10-17'), today)).toBe('d60');
    expect(agingBucket(d('2026-08-19'), today)).toBe('d90');
    expect(agingBucket(d('2026-08-18'), today)).toBe('over90');
  });
});
