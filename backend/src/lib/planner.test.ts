import { describe, expect, it } from 'vitest';
import { planSendTime } from './planner';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;

/** Convenience: offset in ms of a planned time relative to T0. */
function offset(seq: number, delayMs: number, hourlyLimit: number): number {
  return planSendTime(T0, seq, delayMs, hourlyLimit).getTime() - T0.getTime();
}

describe('planSendTime', () => {
  it('places the first email exactly at startAt', () => {
    expect(offset(0, 2000, 100)).toBe(0);
  });

  it('spaces consecutive emails by delayMs while under the hourly cap', () => {
    expect(offset(1, 2000, 100)).toBe(2000);
    expect(offset(2, 2000, 100)).toBe(4000);
    expect(offset(99, 2000, 100)).toBe(99 * 2000); // last of window 0
  });

  it('pushes the overflow email into the next hour window when the cap binds', () => {
    // delayMs*hourlyLimit = 2s*100 = 200s < 1h, so the cap binds at seq 100.
    // Spacing alone would put it at 200s, but the hourly window forces +1h.
    expect(offset(100, 2000, 100)).toBe(HOUR);
    expect(offset(101, 2000, 100)).toBe(HOUR + 2000);
    expect(offset(199, 2000, 100)).toBe(HOUR + 99 * 2000);
    expect(offset(200, 2000, 100)).toBe(2 * HOUR);
  });

  it('lets spacing dominate when it is already slower than the cap', () => {
    // delayMs=60s, hourlyLimit=100 -> spacing yields 60/h < 100/h, cap never binds.
    expect(offset(60, 60_000, 100)).toBe(60 * 60_000);
    expect(offset(100, 60_000, 100)).toBe(100 * 60_000);
    // Never earlier than pure spacing.
    for (const seq of [1, 10, 59, 60, 120]) {
      expect(offset(seq, 60_000, 100)).toBe(seq * 60_000);
    }
  });

  it('handles delayMs = 0 as pure hourly batching', () => {
    // No spacing: a whole window fires at the window start.
    expect(offset(0, 0, 50)).toBe(0);
    expect(offset(49, 0, 50)).toBe(0);
    expect(offset(50, 0, 50)).toBe(HOUR);
    expect(offset(99, 0, 50)).toBe(HOUR);
    expect(offset(100, 0, 50)).toBe(2 * HOUR);
  });

  it('is non-decreasing across a long run (never schedules backwards)', () => {
    let prev = -1;
    for (let seq = 0; seq < 500; seq++) {
      const t = offset(seq, 1500, 100);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it('never exceeds hourlyLimit emails in any startAt-anchored hour window', () => {
    const delayMs = 1000;
    const hourlyLimit = 30;
    const counts = new Map<number, number>();
    for (let seq = 0; seq < 300; seq++) {
      const windowIdx = Math.floor(offset(seq, delayMs, hourlyLimit) / HOUR);
      counts.set(windowIdx, (counts.get(windowIdx) ?? 0) + 1);
    }
    for (const count of counts.values()) {
      expect(count).toBeLessThanOrEqual(hourlyLimit);
    }
  });

  it('rejects invalid arguments', () => {
    expect(() => planSendTime(T0, -1, 1000, 100)).toThrow();
    expect(() => planSendTime(T0, 1.5, 1000, 100)).toThrow();
    expect(() => planSendTime(T0, 0, -1, 100)).toThrow();
    expect(() => planSendTime(T0, 0, 1000, 0)).toThrow();
  });
});
