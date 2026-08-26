import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * HTTP integration tests — real Docker MySQL + Redis, the Express app mounted
 * via supertest. Covers the whole request surface: the auth gate, the Google
 * login → cookie-session flow, sender CRUD (and that the SMTP password is
 * encrypted and never echoed), the campaign lifecycle, and cross-user isolation.
 *
 * Only ONE thing is mocked: Google's ID-token verification. We are not testing
 * Google's servers, and there is no way to mint a real signed token in CI — so
 * verifyGoogleIdToken is replaced with a deterministic identity derived from the
 * token string (distinct tokens → distinct users, which is what the isolation
 * test needs). Everything else is the real code path.
 */
vi.mock('../lib/googleAuth', () => ({
  verifyGoogleIdToken: vi.fn(async (idToken: string) => ({
    googleId: `google-${idToken}`,
    email: `${idToken}@example.test`,
    name: `User ${idToken}`,
    avatarUrl: null,
  })),
}));

import { decrypt } from '../lib/crypto';
import { prisma } from '../lib/prisma';
import { closeQueue, emailJobKey, emailQueue } from '../queue/emailQueue';
import { buildApp } from './app';

const app = buildApp();

// Login token strings; the mock maps `<name>` → `<name>@example.test`.
const ALICE = 'alice';
const BOB = 'bob';
const TEST_EMAILS = [`${ALICE}@example.test`, `${BOB}@example.test`];

const SMTP_PASSWORD = 'sup3r-secret-smtp-pass';

type Agent = ReturnType<typeof request.agent>;

async function cleanup(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { email: { in: TEST_EMAILS } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  // EmailJob.senderId is ON DELETE RESTRICT → jobs, then campaigns, then senders.
  await prisma.emailJob.deleteMany({ where: { campaign: { userId: { in: ids } } } });
  await prisma.campaign.deleteMany({ where: { userId: { in: ids } } });
  await prisma.sender.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

/** Log in through the real cookie flow and return a cookie-persisting agent. */
async function loginAs(token: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/google').send({ idToken: token });
  expect(res.status).toBe(200);
  return agent;
}

let alice: Agent;

beforeAll(async () => {
  await cleanup();
  await emailQueue.obliterate({ force: true });
  alice = await loginAs(ALICE);
});

afterAll(async () => {
  await cleanup();
  await emailQueue.obliterate({ force: true });
  await closeQueue();
  await prisma.$disconnect();
});

describe('health + auth gate', () => {
  it('reports healthy with a working database', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.checks.db).toBe(true);
  });

  it('rejects an unauthenticated request to a protected route with 401', async () => {
    const res = await request(app).get('/api/senders');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns the current user from /me after login', async () => {
    const res = await alice.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(`${ALICE}@example.test`);
    expect(res.body.user.id).toBeTruthy();
  });
});

describe('senders', () => {
  let senderId: string;

  it('creates a sender, encrypts the password at rest, and never echoes it', async () => {
    const res = await alice.post('/api/senders').send({
      fromEmail: 'Campaigns@Acme.test',
      fromName: 'Acme Campaigns',
      smtpHost: 'smtp.ethereal.email',
      smtpPort: 587,
      smtpUser: 'acme-smtp-user',
      smtpPass: SMTP_PASSWORD,
    });
    expect(res.status).toBe(201);
    expect(res.body.sender.id).toBeTruthy();
    // The from-address is normalised to lower-case…
    expect(res.body.sender.fromEmail).toBe('campaigns@acme.test');
    // …and the password is nowhere in the response.
    expect(res.body.sender.smtpPass).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(SMTP_PASSWORD);
    senderId = res.body.sender.id;

    // Stored as AES-256-GCM ciphertext (iv:tag:data), not plaintext.
    const row = await prisma.sender.findUniqueOrThrow({
      where: { id: senderId },
      select: { smtpPass: true },
    });
    expect(row.smtpPass).not.toBe(SMTP_PASSWORD);
    expect(row.smtpPass.split(':')).toHaveLength(3);
    expect(decrypt(row.smtpPass)).toBe(SMTP_PASSWORD);
  });

  it('lists the created sender', async () => {
    const res = await alice.get('/api/senders');
    expect(res.status).toBe(200);
    expect(res.body.senders.some((s: { id: string }) => s.id === senderId)).toBe(true);
  });

  it('rejects an invalid sender payload with 400 VALIDATION_ERROR', async () => {
    const res = await alice.post('/api/senders').send({
      fromEmail: 'not-an-email',
      smtpHost: '',
      smtpPort: 70000, // out of range
      smtpUser: 'x',
      smtpPass: '',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('campaign lifecycle', () => {
  let senderId: string;
  let campaignId: string;

  beforeAll(async () => {
    // Reuse Alice's sender (created above) or make one if run in isolation.
    const existing = await alice.get('/api/senders');
    senderId = existing.body.senders[0].id;
  });

  it('creates a campaign with one job per recipient', async () => {
    const res = await alice.post('/api/campaigns').send({
      subject: 'Launch announcement',
      bodyHtml: '<p>Hello!</p>',
      startAt: new Date(Date.now() + 3_600_000).toISOString(),
      delayMs: 2000,
      hourlyLimit: 100,
      recipients: [{ email: 'r1@example.test' }, { email: 'r2@example.test', name: 'R Two' }],
      senderIds: [senderId],
    });
    expect(res.status).toBe(201);
    expect(res.body.campaign.totalCount).toBe(2);
    expect(res.body.campaign.status).toBe('SCHEDULED');
    expect(res.body.campaign.deduplicated).toBe(false);
    campaignId = res.body.campaign.id;
  });

  it('lists the campaign with per-status counts', async () => {
    const res = await alice.get('/api/campaigns');
    expect(res.status).toBe(200);
    const found = res.body.items.find((c: { id: string }) => c.id === campaignId);
    expect(found).toBeTruthy();
    expect(found.counts.scheduled).toBe(2);
  });

  it('returns campaign detail with body and counts', async () => {
    const res = await alice.get(`/api/campaigns/${campaignId}`);
    expect(res.status).toBe(200);
    expect(res.body.campaign.bodyHtml).toBe('<p>Hello!</p>');
    expect(res.body.campaign.counts.scheduled).toBe(2);
  });

  it('lists all user jobs with counts across campaigns via /jobs', async () => {
    const res = await alice.get('/api/campaigns/jobs?status=SCHEDULED');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.counts.scheduled).toBe(2);
    expect(res.body.items[0].campaignSubject).toBe('Launch announcement');
  });

  it('rejects invalid campaign payload with 400 VALIDATION_ERROR', async () => {
    const res = await alice.post('/api/campaigns').send({
      subject: '',
      bodyHtml: '',
      startAt: 'invalid-date',
      delayMs: -1,
      hourlyLimit: 0,
      recipients: [],
      senderIds: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('lists the campaign jobs in send order', async () => {
    const res = await alice.get(`/api/campaigns/${campaignId}/jobs`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.map((j: { toEmail: string }) => j.toEmail)).toEqual([
      'r1@example.test',
      'r2@example.test',
    ]);
    expect(res.body.items.every((j: { status: string }) => j.status === 'SCHEDULED')).toBe(true);
  });

  it('cancels the campaign, flips scheduled jobs, and removes their queue jobs', async () => {
    // Grab a job id first so we can prove its delayed BullMQ job is gone after.
    const before = await alice.get(`/api/campaigns/${campaignId}/jobs`);
    const someJobId: string = before.body.items[0].id;
    expect(await emailQueue.getJob(emailJobKey(someJobId))).toBeTruthy();

    const res = await alice.post(`/api/campaigns/${campaignId}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.campaign.status).toBe('CANCELLED');
    expect(res.body.campaign.cancelledCount).toBe(2);

    const detail = await alice.get(`/api/campaigns/${campaignId}`);
    expect(detail.body.campaign.status).toBe('CANCELLED');
    expect(detail.body.campaign.counts.cancelled).toBe(2);
    expect(detail.body.campaign.counts.scheduled).toBe(0);

    // The delayed job was pulled from Redis (best-effort cleanup succeeded here).
    expect(await emailQueue.getJob(emailJobKey(someJobId))).toBeFalsy();
  });

  it('enforces cross-user isolation: another user cannot see the campaign', async () => {
    const bob = await loginAs(BOB);

    // Bob has no senders of his own.
    const senders = await bob.get('/api/senders');
    expect(senders.body.senders).toHaveLength(0);

    // Alice's campaign is a 404 for Bob (indistinguishable from "does not exist").
    const detail = await bob.get(`/api/campaigns/${campaignId}`);
    expect(detail.status).toBe(404);
    expect(detail.body.error.code).toBe('NOT_FOUND');

    // And he cannot cancel it either.
    const cancel = await bob.post(`/api/campaigns/${campaignId}/cancel`);
    expect(cancel.status).toBe(404);
  });
});
