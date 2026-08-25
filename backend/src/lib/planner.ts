/**
 * Deterministic send-time planning — a pure function, no clock, no I/O.
 *
 * Given a campaign's start time and per-campaign knobs, it returns the intended
 * send time for the email at a given 0-based sequence position. Two constraints
 * are combined and the later one wins:
 *
 *   1. Spacing:  consecutive emails are at least `delayMs` apart, so email N is
 *      no earlier than startAt + N*delayMs.
 *   2. Hourly cap: at most `hourlyLimit` emails may fall in each one-hour window
 *      anchored at startAt. Emails are bucketed into windows of `hourlyLimit`;
 *      window W begins at startAt + W hours, and positions within a window are
 *      still spaced by `delayMs`.
 *
 *   scheduledAt(seq) = startAt + max(
 *       seq * delayMs,                                   // pure spacing
 *       windowIndex * 1h + positionInWindow * delayMs    // hourly-window packing
 *   )
 *
 * The two terms cross over exactly when `hourlyLimit * delayMs` crosses one
 * hour: if spacing alone already keeps the rate under the cap the first term
 * wins and the cap never binds; otherwise the second term pushes the overflow
 * into the next hour window. Taking the max means whichever constraint is
 * tighter for a given position is the one that applies.
 *
 * This is a good-faith schedule. The authority on rate is the runtime limiter
 * in the worker (global BullMQ limiter + per-sender Redis Lua); if reality
 * drifts from this plan a job is simply deferred and rescheduled. Keeping this
 * function pure makes the scheduling policy exhaustively unit-testable.
 */

/** Milliseconds in one hour. A unit definition, not a tunable knob. */
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Intended send time for the email at `sequenceNumber` (0-based).
 *
 * @param startAt      campaign start (send window opens here)
 * @param sequenceNumber 0-based position within the campaign
 * @param delayMs      minimum spacing between consecutive emails (>= 0)
 * @param hourlyLimit  max emails per one-hour window (>= 1)
 */
export function planSendTime(
  startAt: Date,
  sequenceNumber: number,
  delayMs: number,
  hourlyLimit: number,
): Date {
  if (!Number.isInteger(sequenceNumber) || sequenceNumber < 0) {
    throw new Error(`planSendTime: sequenceNumber must be a non-negative integer, got ${sequenceNumber}`);
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(`planSendTime: delayMs must be >= 0, got ${delayMs}`);
  }
  if (!Number.isInteger(hourlyLimit) || hourlyLimit < 1) {
    throw new Error(`planSendTime: hourlyLimit must be a positive integer, got ${hourlyLimit}`);
  }

  const windowIndex = Math.floor(sequenceNumber / hourlyLimit);
  const positionInWindow = sequenceNumber % hourlyLimit;

  const spacingOffset = sequenceNumber * delayMs;
  const windowOffset = windowIndex * MS_PER_HOUR + positionInWindow * delayMs;

  const offsetMs = Math.max(spacingOffset, windowOffset);
  return new Date(startAt.getTime() + offsetMs);
}
