'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeftIcon, ClockIcon, PaperclipIcon, UploadIcon } from '@/components/Icons';
import { Alert } from '@/components/ui';
import { api, ApiError, type CreateCampaignInput } from '@/lib/api';
import type { RecipientInput, Sender } from '@/lib/types';

function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export default function ComposeEmailPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);

  // Dynamic Senders from backend
  const [senders, setSenders] = useState<Sender[]>([]);
  const [selectedSenderId, setSelectedSenderId] = useState<string>('');
  const [loadingSenders, setLoadingSenders] = useState(true);

  // Form Fields — Empty by default (no hardcoded values)
  const [recipients, setRecipients] = useState<RecipientInput[]>([]);
  const [toInput, setToInput] = useState('');
  const [subject, setSubject] = useState('');
  const [delaySeconds, setDelaySeconds] = useState<number>(0);
  const [hourlyLimit, setHourlyLimit] = useState<number>(0);
  const [bodyText, setBodyText] = useState('');

  
  // Attachments
  const [attachments, setAttachments] = useState<{ name: string; size: string; url: string }[]>([]);

  // Send Later Popover Modal State
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [scheduledDate, setScheduledDate] = useState<string>(() =>
    toDatetimeLocalValue(new Date(Date.now() + 10 * 60_000)),
  );
  const [isScheduled, setIsScheduled] = useState(false);

  // Submitting state
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listSenders()
      .then((all) => {
        const active = all.filter((s) => s.isActive);
        setSenders(active);
        if (active.length > 0) {
          setSelectedSenderId(active[0]!.id);
        }
      })
      .catch(() => {
        // silent
      })
      .finally(() => setLoadingSenders(false));
  }, []);

  const handleAddRecipient = () => {
    const raw = toInput.trim();
    if (!raw) return;
    const parts = raw.split(/[\s,]+/);
    const newItems: RecipientInput[] = [];
    for (const p of parts) {
      const email = p.toLowerCase();
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        if (!recipients.some((r) => r.email === email)) {
          newItems.push({ email });
        }
      }
    }
    if (newItems.length > 0) {
      setRecipients((prev) => [...prev, ...newItems]);
      setToInput('');
    }
  };

  const removeRecipient = (email: string) => {
    setRecipients((prev) => prev.filter((r) => r.email !== email));
  };

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (!text) return;
      const lines = text.split(/\r?\n/);
      const parsed: RecipientInput[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const comma = trimmed.indexOf(',');
        const email = (comma >= 0 ? trimmed.slice(0, comma) : trimmed).trim().toLowerCase();
        const name = comma >= 0 ? trimmed.slice(comma + 1).trim() : undefined;
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          if (!parsed.some((r) => r.email === email) && !recipients.some((r) => r.email === email)) {
            parsed.push({ email, name });
          }
        }
      }
      if (parsed.length > 0) {
        setRecipients((prev) => [...prev, ...parsed]);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleAttachmentUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const newAttachments = Array.from(files).map((file) => ({
      name: file.name,
      size: `${(file.size / (1024 * 1024)).toFixed(1)} MB`,
      url: URL.createObjectURL(file),
    }));
    setAttachments((prev) => [...prev, ...newAttachments]);
    e.target.value = '';
  };

  // Schedule Presets
  const setPresetTomorrow = (hour?: number) => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    if (hour !== undefined) {
      d.setHours(hour, 0, 0, 0);
    } else {
      d.setHours(9, 0, 0, 0);
    }
    setScheduledDate(toDatetimeLocalValue(d));
    setIsScheduled(true);
    setShowScheduleModal(false);
  };

  const handleSubmit = async () => {
    setFormError(null);
    if (recipients.length === 0) {
      setFormError('Please add at least one recipient.');
      return;
    }
    if (!subject.trim()) {
      setFormError('Please enter a subject.');
      return;
    }
    if (!selectedSenderId) {
      setFormError('Please select or configure a sender account.');
      return;
    }

    const startAt = isScheduled ? new Date(scheduledDate).toISOString() : new Date().toISOString();

    const input: CreateCampaignInput = {
      subject: subject.trim(),
      bodyHtml: `<p>${bodyText.replace(/\n/g, '<br/>') || 'Hello,'}</p>`,
      startAt,
      delayMs: Math.max(0, Math.round((delaySeconds || 2) * 1000)),
      hourlyLimit: hourlyLimit || 100,
      recipients,
      senderIds: [selectedSenderId],
    };

    setSubmitting(true);
    try {
      await api.createCampaign(input);
      router.push('/campaigns?tab=scheduled');
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to schedule email campaign.');
      setSubmitting(false);
    }
  };

  const visibleRecipients = recipients.slice(0, 3);
  const extraCount = recipients.length - 3;

  return (
    <div className="figma-compose-wrap">
      {/* ── Top Header ── */}
      <div className="figma-compose-header">
        <div className="figma-compose-header-left">
          <button
            type="button"
            onClick={() => router.back()}
            className="figma-back-btn"
            title="Back"
          >
            <ArrowLeftIcon />
          </button>
          <h1 className="figma-compose-title">Compose New Email</h1>
        </div>

        <div className="figma-compose-header-right">
          {/* Attachment Icon */}
          <button
            type="button"
            className="figma-compose-action-icon"
            onClick={() => attachmentInputRef.current?.click()}
            title="Attach file"
          >
            <PaperclipIcon />
            {attachments.length > 0 && (
              <span className="figma-action-badge">{attachments.length}</span>
            )}
          </button>
          <input
            type="file"
            ref={attachmentInputRef}
            onChange={handleAttachmentUpload}
            style={{ display: 'none' }}
            multiple
          />

          {/* Schedule Clock Icon */}
          <button
            type="button"
            className={`figma-compose-action-icon ${isScheduled ? 'figma-compose-action-icon--active' : ''}`}
            onClick={() => setShowScheduleModal(!showScheduleModal)}
            title="Schedule send"
          >
            <ClockIcon />
          </button>

          {/* Send / Send Later Primary Button */}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="figma-send-btn"
          >
            {submitting ? 'Sending…' : isScheduled ? 'Send Later' : 'Send'}
          </button>
        </div>
      </div>

      {formError && (
        <div style={{ padding: '0 24px 16px' }}>
          <Alert kind="error">{formError}</Alert>
        </div>
      )}

      {/* ── Form Rows ── */}
      <div className="figma-compose-form">
        {/* From Row */}
        <div className="figma-form-row">
          <label className="figma-form-label">From</label>
          <div className="figma-form-control">
            {loadingSenders ? (
              <span className="muted small">Loading senders…</span>
            ) : senders.length === 0 ? (
              <span className="muted small">No active senders found.</span>
            ) : (
              <select
                value={selectedSenderId}
                onChange={(e) => setSelectedSenderId(e.target.value)}
                className="figma-select-input"
              >
                {senders.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fromEmail}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* To Row */}
        <div className="figma-form-row">
          <label className="figma-form-label">To</label>
          <div className="figma-form-control figma-to-control">
            <div className="figma-recipient-pills">
              {visibleRecipients.map((r) => (
                <span key={r.email} className="figma-recipient-pill">
                  {r.email}
                  <button
                    type="button"
                    onClick={() => removeRecipient(r.email)}
                    className="figma-pill-remove"
                  >
                    ×
                  </button>
                </span>
              ))}
              {extraCount > 0 && (
                <span className="figma-recipient-pill figma-recipient-pill--more">
                  +{extraCount}
                </span>
              )}

              <input
                type="text"
                placeholder={recipients.length === 0 ? 'recipient@example.com' : ''}
                value={toInput}
                onChange={(e) => setToInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    handleAddRecipient();
                  }
                }}
                onBlur={handleAddRecipient}
                className="figma-to-text-input"
              />
            </div>

            {/* Upload List Action */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="figma-upload-link"
            >
              <UploadIcon style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 4 }} />
              Upload List
            </button>
            <input
              type="file"
              ref={fileInputRef}
              accept=".csv,.txt"
              onChange={handleCsvUpload}
              style={{ display: 'none' }}
            />
          </div>
        </div>


        {/* Subject Row */}
        <div className="figma-form-row">
          <label className="figma-form-label">Subject</label>
          <div className="figma-form-control">
            <input
              type="text"
              placeholder="Subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="figma-plain-input"
            />
          </div>
        </div>

        {/* Delay & Hourly Limit Row */}
        <div className="figma-form-row figma-pacing-row">
          <div className="figma-pacing-item">
            <span className="figma-pacing-label">Delay between 2 emails</span>
            <input
              type="number"
              min={0}
              value={delaySeconds}
              onChange={(e) => setDelaySeconds(Number(e.target.value))}
              className="figma-number-input"
            />
          </div>

          <div className="figma-pacing-item">
            <span className="figma-pacing-label">Hourly Limit</span>
            <input
              type="number"
              min={1}
              value={hourlyLimit}
              onChange={(e) => setHourlyLimit(Number(e.target.value))}
              className="figma-number-input"
            />
          </div>
        </div>

        {/* ── Rich Text Editor Area ── */}
        <div className="figma-editor-container">
          <textarea
            placeholder="Type Your Reply..."
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            className="figma-editor-textarea"
          />

          {/* Formatting Toolbar */}
          <div className="figma-editor-toolbar">
            <button type="button" className="figma-tool-btn" title="Undo">↶</button>
            <button type="button" className="figma-tool-btn" title="Redo">↷</button>
            <div className="figma-tool-sep" />
            <button type="button" className="figma-tool-btn" title="Typography">Tᴛ ⌄</button>
            <div className="figma-tool-sep" />
            <button type="button" className="figma-tool-btn" title="Bold"><strong>B</strong></button>
            <button type="button" className="figma-tool-btn" title="Italic"><em>I</em></button>
            <button type="button" className="figma-tool-btn" title="Underline"><u>U</u></button>
            <button type="button" className="figma-tool-btn" title="Align">☰ ⌄</button>
            <div className="figma-tool-sep" />
            <button type="button" className="figma-tool-btn" title="Numbered List">1. 2.</button>
            <button type="button" className="figma-tool-btn" title="Bulleted List">• •</button>
            <button type="button" className="figma-tool-btn" title="Outdent">⇤</button>
            <button type="button" className="figma-tool-btn" title="Indent">⇥</button>
            <button type="button" className="figma-tool-btn" title="Quote">“</button>
            <button type="button" className="figma-tool-btn" title="Link">🔗</button>
            <button type="button" className="figma-tool-btn" title="Strikethrough"><s>S</s></button>
          </div>
        </div>

        {/* Attachments Preview Row */}
        {attachments.length > 0 && (
          <div className="figma-attachments-row">
            {attachments.map((att, i) => (
              <div key={i} className="figma-attachment-card">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={att.url} alt={att.name} className="figma-attachment-thumb" />
                <div className="figma-attachment-info">
                  <div className="figma-attachment-name">{att.name}</div>
                  <div className="figma-attachment-size">{att.size}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Send Later Popover Modal (Figma Screen 5) ── */}
      {showScheduleModal && (
        <div className="figma-schedule-modal-overlay" onClick={() => setShowScheduleModal(false)}>
          <div className="figma-schedule-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="figma-schedule-title">Send Later</h3>

            <div className="figma-schedule-input-wrap">
              <input
                type="datetime-local"
                value={scheduledDate}
                onChange={(e) => {
                  setScheduledDate(e.target.value);
                  setIsScheduled(true);
                }}
                className="figma-schedule-datetime-input"
              />
            </div>

            <div className="figma-schedule-presets">
              <button
                type="button"
                onClick={() => setPresetTomorrow()}
                className="figma-preset-btn"
              >
                Tomorrow
              </button>
              <button
                type="button"
                onClick={() => setPresetTomorrow(10)}
                className="figma-preset-btn"
              >
                Tomorrow, 10:00 AM
              </button>
              <button
                type="button"
                onClick={() => setPresetTomorrow(11)}
                className="figma-preset-btn"
              >
                Tomorrow, 11:00 AM
              </button>
              <button
                type="button"
                onClick={() => setPresetTomorrow(15)}
                className="figma-preset-btn"
              >
                Tomorrow, 3:00 PM
              </button>
            </div>

            <div className="figma-schedule-actions">
              <button
                type="button"
                onClick={() => {
                  setIsScheduled(false);
                  setShowScheduleModal(false);
                }}
                className="figma-schedule-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsScheduled(true);
                  setShowScheduleModal(false);
                }}
                className="figma-schedule-done"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
