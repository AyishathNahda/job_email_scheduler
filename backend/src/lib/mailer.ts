import nodemailer, { type Transporter } from 'nodemailer';
import { decrypt } from './crypto';

/**
 * SMTP sending, wrapped around Nodemailer.
 *
 * The domain uses Ethereal (nodemailer's fake SMTP) as the provider: real SMTP
 * conversation, no mail actually delivered, and every message gets a hosted
 * preview URL. Nothing here is Ethereal-specific though — it is ordinary
 * host/port/user/pass SMTP, so pointing a sender at a real provider needs no
 * code change.
 *
 * Credentials arrive as the encrypted-at-rest ciphertext straight from the
 * Sender row; the password is only ever decrypted here, at the moment a
 * transport is built, and never logged.
 */

/** The subset of a Sender needed to send — decoupled from the Prisma model. */
export interface SenderCredentials {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  /** AES-256-GCM ciphertext (see lib/crypto.ts). Decrypted internally. */
  smtpPass: string;
  fromEmail: string;
  fromName?: string | null;
}

export interface OutgoingEmail {
  to: string;
  toName?: string | null;
  subject: string;
  html: string;
}

export interface SendResult {
  /** SMTP Message-ID assigned to the accepted message. */
  messageId: string;
  /** Ethereal preview URL, or null for a provider that has none. */
  previewUrl: string | null;
}

/**
 * Reuse one transport (and its connection) per distinct set of credentials.
 * Keyed by connection identity, not senderId, so rotating a sender's SMTP
 * credentials transparently yields a fresh transport rather than a stale one.
 */
const transporters = new Map<string, Transporter>();

function transportKey(c: SenderCredentials): string {
  return `${c.smtpHost}:${c.smtpPort}:${c.smtpUser}`;
}

function getTransport(c: SenderCredentials): Transporter {
  const key = transportKey(c);
  const existing = transporters.get(key);
  if (existing) return existing;

  const transport = nodemailer.createTransport({
    host: c.smtpHost,
    port: c.smtpPort,
    // 465 is implicit TLS; 587/25 negotiate STARTTLS. This is the standard rule.
    secure: c.smtpPort === 465,
    auth: { user: c.smtpUser, pass: decrypt(c.smtpPass) },
  });
  transporters.set(key, transport);
  return transport;
}

/**
 * Send one email through the sender's SMTP account.
 *
 * Rejects if the SMTP server does not accept the message; the caller (the
 * worker) is responsible for recording that failure. On success the message is
 * accepted by the SMTP server — which is NOT the same as final delivery, and is
 * the reason this service can offer durable, idempotent processing with strong
 * duplicate-send protection rather than exactly-once external delivery.
 */
export async function sendEmail(
  sender: SenderCredentials,
  email: OutgoingEmail,
): Promise<SendResult> {
  const transport = getTransport(sender);

  const info = await transport.sendMail({
    // Object form lets Nodemailer escape display names safely.
    from: sender.fromName ? { name: sender.fromName, address: sender.fromEmail } : sender.fromEmail,
    to: email.toName ? { name: email.toName, address: email.to } : email.to,
    subject: email.subject,
    html: email.html,
  });

  return {
    messageId: info.messageId,
    previewUrl: nodemailer.getTestMessageUrl(info) || null,
  };
}

/**
 * Open a live SMTP connection and check the credentials/greeting without
 * sending. Used by the seed and by an admin "test connection" path.
 */
export async function verifyTransport(sender: SenderCredentials): Promise<void> {
  await getTransport(sender).verify();
}

/** Close all pooled transports. Called on graceful worker shutdown. */
export function closeTransports(): void {
  for (const transport of transporters.values()) {
    transport.close();
  }
  transporters.clear();
}
