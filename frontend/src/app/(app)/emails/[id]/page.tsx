'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArchiveIcon, ArrowLeftIcon, ChevronDownIcon, StarIcon, TrashIcon } from '@/components/Icons';
import { CenteredSpinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import type { JobDetail } from '@/lib/types';

function formatDetailDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export default function EmailDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;

  const [job, setJob] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isStarred, setIsStarred] = useState(false);

  useEffect(() => {
    if (!id) return;
    let active = true;
    const fetchEmail = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await api.getJob(id);
        if (active) setJob(data);
      } catch (err) {
        if (active) {
          setError(err instanceof ApiError ? err.message : 'Failed to load email details.');
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    void fetchEmail();
    return () => {
      active = false;
    };
  }, [id]);

  if (loading) return <CenteredSpinner />;
  if (error || !job) {
    return (
      <div style={{ padding: 32 }}>
        <p style={{ color: 'var(--danger)', marginBottom: 16 }}>{error || 'Email not found.'}</p>
        <Link href="/campaigns" className="btn btn--secondary">
          ← Back to Inbox
        </Link>
      </div>
    );
  }

  const senderInitial = (job.senderName || job.senderEmail || 'S').trim().charAt(0).toUpperCase();
  const dateFormatted = formatDetailDate(job.sentAt || job.scheduledAt);

  return (
    <div className="figma-email-detail-wrap">
      {/* ── Detail Top Bar ── */}
      <div className="figma-detail-topbar">
        <div className="figma-detail-title-group">
          <button
            type="button"
            onClick={() => router.back()}
            className="figma-back-btn"
            title="Back"
          >
            <ArrowLeftIcon />
          </button>
          <h1 className="figma-detail-subject">
            {job.campaignSubject}{' '}
            <span className="figma-detail-tag">| {job.id.slice(-8).toUpperCase()}</span>
          </h1>
        </div>

        <div className="figma-detail-actions">
          <button
            type="button"
            onClick={() => setIsStarred(!isStarred)}
            className="figma-icon-action"
            title="Star"
          >
            <StarIcon active={isStarred} />
          </button>
          <button type="button" className="figma-icon-action" title="Archive">
            <ArchiveIcon />
          </button>
          <button type="button" className="figma-icon-action" title="Delete">
            <TrashIcon />
          </button>
        </div>
      </div>

      {/* ── Detail Content Area ── */}
      <div className="figma-detail-body-container">
        {/* Sender Info Row */}
        <div className="figma-sender-row">
          <div className="figma-sender-avatar-letter">
            {senderInitial}
          </div>
          <div className="figma-sender-info">
            <div className="figma-sender-headline">
              <span className="figma-sender-name">
                {job.senderName || job.senderEmail.split('@')[0]}
              </span>{' '}
              <span className="figma-sender-address">&lt;{job.senderEmail}&gt;</span>
            </div>
            <div className="figma-recipient-meta">
              to {job.toName ? `${job.toName} <${job.toEmail}>` : job.toEmail} <ChevronDownIcon style={{ display: 'inline-block', verticalAlign: 'middle' }} />
            </div>
          </div>
          <div className="figma-detail-date">{dateFormatted}</div>
        </div>

        {/* Rendered Email Body */}
        <div className="figma-email-body-content">
          {job.campaignBodyHtml ? (
            <div
              dangerouslySetInnerHTML={{ __html: job.campaignBodyHtml }}
              className="figma-rendered-html"
            />
          ) : (
            <p className="muted">No content.</p>
          )}

          {/* Callout Notice */}
          <div className="figma-callout-box">
            <div className="figma-callout-item">
              <strong>Scheduled &amp; Idempotent Delivery</strong> — Engine Verified
            </div>
            <div className="figma-callout-item">
              Sequence #{job.sequenceNumber} · Status: <strong>{job.status}</strong> · Attempts: {job.attempts}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

