import type { CampaignStatus, EmailStatus } from './types';

/** Format an ISO timestamp as e.g. "Aug 24, 2026, 3:45 PM". Empty on invalid. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/** Compact date without the time, e.g. "Aug 24, 2026". */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

/** Human-readable relative time, e.g. "in 2 hours", "5 minutes ago". */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const diffMs = date.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
    ['second', 1000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'second') {
      return rtf.format(Math.round(diffMs / ms), unit);
    }
  }
  return '';
}

/** Title-case a status enum for display, e.g. "PARTIALLY_FAILED" → "Partially failed". */
export function humanizeStatus(status: EmailStatus | CampaignStatus | string): string {
  const lower = status.toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Compute overall send progress (sent + failed + cancelled) / total. Returns a
 * 0–100 integer; 0 when the campaign has no recipients.
 */
export function progressPercent(counts: {
  sent: number;
  failed: number;
  cancelled: number;
}, total: number): number {
  if (total <= 0) return 0;
  const done = counts.sent + counts.failed + counts.cancelled;
  return Math.round((done / total) * 100);
}
