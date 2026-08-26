'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ClockIcon, FilterIcon, RefreshIcon, SearchIcon, StarIcon } from '@/components/Icons';
import { CenteredSpinner, EmptyState } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import type { AllJobsItem } from '@/lib/types';

function formatFigmaDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const day = d.toLocaleDateString('en-US', { weekday: 'short' });
  const time = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  return `${day} ${time}`;
}

export default function DashboardPage() {
  const searchParams = useSearchParams();
  const tab = searchParams.get('tab') || 'scheduled';
  const isSent = tab === 'sent';

  const [items, setItems] = useState<AllJobsItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [starred, setStarred] = useState<Record<string, boolean>>({});

  const loadJobs = useCallback(async (searchQuery = '') => {
    setLoading(true);
    setError(null);
    try {
      const status = isSent ? 'SENT' : 'SCHEDULED';
      const page = await api.listAllJobs({
        status,
        search: searchQuery || undefined,
        limit: 25,
      });
      setItems(page.items);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load emails.');
    } finally {
      setLoading(false);
    }
  }, [isSent]);

  useEffect(() => {
    void loadJobs(search);
  }, [loadJobs, search]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const status = isSent ? 'SENT' : 'SCHEDULED';
      const page = await api.listAllJobs({
        cursor,
        status,
        search: search || undefined,
        limit: 25,
      });
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch {
      // silent
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleStar = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setStarred((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="figma-inbox-wrap">
      {/* ── Top Bar with Search, Filter & Refresh ── */}
      <div className="figma-topbar">
        <div className="figma-search-box">
          <span className="figma-search-icon">
            <SearchIcon />
          </span>
          <input
            type="text"
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="figma-search-input"
          />
        </div>
        <div className="figma-topbar-actions">
          <button
            type="button"
            className="figma-icon-btn"
            title="Filter"
            onClick={() => void loadJobs(search)}
          >
            <FilterIcon />
          </button>
          <button
            type="button"
            className="figma-icon-btn"
            title="Refresh"
            onClick={() => void loadJobs(search)}
          >
            <RefreshIcon />
          </button>
        </div>
      </div>

      {/* ── Email List ── */}
      <div className="figma-list-container">
        {loading ? (
          <CenteredSpinner />
        ) : error ? (
          <div style={{ padding: 24, color: 'var(--danger)' }}>{error}</div>
        ) : items.length === 0 ? (
          <div className="figma-empty-container">
            <div className="figma-empty-title">
              {isSent ? 'No sent emails yet' : 'No scheduled emails'}
            </div>
            <div className="figma-empty-desc">
              {isSent
                ? 'Sent emails will appear here once delivered.'
                : 'Compose and schedule emails to see them in this queue.'}
            </div>
            <Link href="/campaigns/new" className="figma-empty-compose-btn">
              Compose
            </Link>
          </div>
        ) : (

          <div className="figma-email-list">
            {items.map((job) => {
              const recipientDisplay = job.toName || job.toEmail.split('@')[0];
              const dateDisplay = isSent
                ? formatFigmaDate(job.sentAt)
                : formatFigmaDate(job.scheduledAt);
              const isStar = !!starred[job.id];

              return (
                <Link
                  key={job.id}
                  href={`/emails/${job.id}`}
                  className="figma-email-row"
                >
                  {/* Recipient */}
                  <div className="figma-row-recipient">
                    To: {recipientDisplay}
                  </div>

                  {/* Status Pill & Subject / Snippet */}
                  <div className="figma-row-content">
                    {isSent ? (
                      <span className="figma-status-pill figma-status-pill--sent">
                        Sent
                      </span>
                    ) : (
                      <span className="figma-status-pill figma-status-pill--scheduled">
                        <ClockIcon style={{ width: 12, height: 12 }} />
                        <span>{dateDisplay}</span>
                      </span>
                    )}

                    <span className="figma-row-subject">
                      {job.campaignSubject}
                    </span>

                    <span className="figma-row-snippet">
                      {isSent
                        ? ` - Delivered via ${job.senderEmail}`
                        : ` - Scheduled - In queue for recipient ${job.toEmail}`}
                    </span>
                  </div>

                  {/* Star Icon */}
                  <button
                    type="button"
                    onClick={(e) => toggleStar(job.id, e)}
                    className={`figma-star-btn ${isStar ? 'figma-star-btn--active' : ''}`}
                    title="Star message"
                  >
                    <StarIcon active={isStar} />
                  </button>
                </Link>
              );
            })}
          </div>
        )}

        {cursor && (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="btn btn--secondary"
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}


