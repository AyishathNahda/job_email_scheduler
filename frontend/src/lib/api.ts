import type {
  CampaignDetail,
  CampaignListItem,
  CreateCampaignResult,
  JobItem,
  Page,
  RecipientInput,
  Sender,
  User,
} from './types';

/**
 * The API origin, inlined at build time from the (root) `.env` via
 * next.config.mjs. Falls back to the local dev port so a bare `next dev`
 * still points somewhere sensible.
 */
const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

/** Error envelope codes returned by the backend (`{ error: { code, message } }`). */
export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'NETWORK_ERROR';

/** A typed error carrying the backend's code so callers can branch on it. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: unknown };
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Extra headers, e.g. an Idempotency-Key. */
  headers?: Record<string, string>;
}

/**
 * Single fetch wrapper. Always sends the session cookie (`credentials:
 * 'include'`), parses the shared JSON envelope, and throws a typed `ApiError`
 * on any non-2xx — including a synthetic NETWORK_ERROR when the request never
 * reaches the server.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {} } = options;

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      credentials: 'include',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Could not reach the server.', 0);
  }

  // 204 No Content (e.g. logout) has an empty body.
  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  const data: unknown = text ? safeParse(text) : null;

  if (!res.ok) {
    const envelope = (data ?? {}) as ErrorEnvelope;
    const code = (envelope.error?.code as ApiErrorCode | undefined) ?? 'INTERNAL_ERROR';
    const message = envelope.error?.message ?? `Request failed (${res.status})`;
    throw new ApiError(code, message, res.status, envelope.error?.details);
  }

  return data as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Endpoint methods ────────────────────────────────────────────────────────

export const api = {
  // Auth
  async me(): Promise<User> {
    const res = await request<{ user: User }>('/api/auth/me');
    return res.user;
  },
  async loginWithGoogle(idToken: string): Promise<User> {
    const res = await request<{ user: User }>('/api/auth/google', {
      method: 'POST',
      body: { idToken },
    });
    return res.user;
  },
  async devLogin(): Promise<User> {
    const res = await request<{ user: User }>('/api/auth/dev-login', {
      method: 'POST',
    });
    return res.user;
  },
  async logout(): Promise<void> {
    await request<void>('/api/auth/logout', { method: 'POST' });
  },

  // Senders
  async listSenders(): Promise<Sender[]> {
    const res = await request<{ senders: Sender[] }>('/api/senders');
    return res.senders;
  },
  async createSender(input: CreateSenderInput): Promise<Sender> {
    const res = await request<{ sender: Sender }>('/api/senders', {
      method: 'POST',
      body: input,
    });
    return res.sender;
  },
  async updateSender(id: string, input: UpdateSenderInput): Promise<Sender> {
    const res = await request<{ sender: Sender }>(`/api/senders/${id}`, {
      method: 'PATCH',
      body: input,
    });
    return res.sender;
  },
  async deactivateSender(id: string): Promise<void> {
    await request<void>(`/api/senders/${id}`, { method: 'DELETE' });
  },
  async verifySender(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/senders/${id}/verify`, { method: 'POST' });
  },

  // Campaigns
  async listCampaigns(cursor?: string): Promise<Page<CampaignListItem>> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return request<Page<CampaignListItem>>(`/api/campaigns${query}`);
  },
  async createCampaign(
    input: CreateCampaignInput,
    idempotencyKey?: string,
  ): Promise<CreateCampaignResult> {
    const res = await request<{ campaign: CreateCampaignResult }>('/api/campaigns', {
      method: 'POST',
      body: input,
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
    });
    return res.campaign;
  },
  async getCampaign(id: string): Promise<CampaignDetail> {
    const res = await request<{ campaign: CampaignDetail }>(`/api/campaigns/${id}`);
    return res.campaign;
  },
  async listCampaignJobs(
    id: string,
    opts: { cursor?: string; status?: string; limit?: number } = {},
  ): Promise<Page<JobItem>> {
    const params = new URLSearchParams();
    if (opts.cursor) params.set('cursor', opts.cursor);
    if (opts.status) params.set('status', opts.status);
    if (opts.limit) params.set('limit', String(opts.limit));
    const query = params.toString() ? `?${params.toString()}` : '';
    return request<Page<JobItem>>(`/api/campaigns/${id}/jobs${query}`);
  },
  async cancelCampaign(
    id: string,
  ): Promise<{ id: string; status: string; cancelledCount: number }> {
    const res = await request<{
      campaign: { id: string; status: string; cancelledCount: number };
    }>(`/api/campaigns/${id}/cancel`, { method: 'POST' });
    return res.campaign;
  },
  async listAllJobs(opts: {
    cursor?: string;
    status?: string;
    limit?: number;
    search?: string;
  } = {}): Promise<import('./types').AllJobsPage> {
    const params = new URLSearchParams();
    if (opts.cursor) params.set('cursor', opts.cursor);
    if (opts.status) params.set('status', opts.status);
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.search) params.set('search', opts.search);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request<import('./types').AllJobsPage>(`/api/campaigns/jobs${query}`);
  },
  async getJob(id: string): Promise<import('./types').JobDetail> {
    const res = await request<{ job: import('./types').JobDetail }>(`/api/campaigns/jobs/${id}`);
    return res.job;
  },
};

export interface CreateSenderInput {
  fromEmail: string;
  fromName?: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  maxPerHour?: number;
}

export interface UpdateSenderInput {
  fromEmail?: string;
  fromName?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  maxPerHour?: number | null;
  isActive?: boolean;
}

export interface CreateCampaignInput {
  subject: string;
  bodyHtml: string;
  startAt: string;
  delayMs: number;
  hourlyLimit: number;
  recipients: RecipientInput[];
  senderIds: string[];
}
