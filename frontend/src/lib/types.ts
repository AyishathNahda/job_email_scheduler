/**
 * Response shapes returned by the ReachInbox API. These mirror the backend's
 * serialised DTOs (see backend/src/services/*). Dates cross the wire as ISO
 * strings, so every timestamp is typed `string` here.
 */

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface Sender {
  id: string;
  fromEmail: string;
  fromName: string | null;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  maxPerHour: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type EmailStatus = 'SCHEDULED' | 'PROCESSING' | 'SENT' | 'FAILED' | 'CANCELLED';

export type CampaignStatus =
  | 'SCHEDULED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'PARTIALLY_FAILED'
  | 'CANCELLED';

export interface StatusCounts {
  scheduled: number;
  processing: number;
  sent: number;
  failed: number;
  cancelled: number;
}

export interface CampaignListItem {
  id: string;
  subject: string;
  status: CampaignStatus;
  totalCount: number;
  startAt: string;
  createdAt: string;
  counts: StatusCounts;
}

export interface CampaignDetail extends CampaignListItem {
  bodyHtml: string;
  delayMs: number;
  hourlyLimit: number;
  updatedAt: string;
}

export interface JobItem {
  id: string;
  senderId: string;
  toEmail: string;
  toName: string | null;
  sequenceNumber: number;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  messageId: string | null;
  previewUrl: string | null;
  error: string | null;
  attempts: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Result of POST /api/campaigns — includes the idempotency `deduplicated` flag. */
export interface CreateCampaignResult {
  id: string;
  status: CampaignStatus;
  totalCount: number;
  startAt: string;
  delayMs: number;
  hourlyLimit: number;
  firstScheduledAt: string | null;
  lastScheduledAt: string | null;
  deduplicated: boolean;
}

export interface RecipientInput {
  email: string;
  name?: string;
}

export interface AllJobsItem {
  id: string;
  campaignId: string;
  campaignSubject: string;
  senderId: string;
  senderEmail: string;
  senderName: string | null;
  toEmail: string;
  toName: string | null;
  sequenceNumber: number;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  messageId: string | null;
  previewUrl: string | null;
  error: string | null;
  attempts: number;
}

export interface AllJobsPage extends Page<AllJobsItem> {
  counts: StatusCounts & { total: number };
}

export interface JobDetail extends AllJobsItem {
  campaignBodyHtml: string;
  campaignCreatedAt: string;
}

