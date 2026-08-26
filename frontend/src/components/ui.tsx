import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { humanizeStatus } from '@/lib/format';

/**
 * Presentational primitives built on the global design-system classes in
 * globals.css. No client-only hooks here, so these compose freely inside either
 * server or client trees (when imported by a client component they are bundled
 * client-side and can receive event handlers).
 */

type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'subtle';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const classes = ['btn', `btn--${variant}`, size === 'sm' ? 'btn--sm' : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button className={classes} disabled={disabled ?? loading} {...rest}>
      {loading && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}

export function Spinner({ large = false }: { large?: boolean }) {
  return <span className={large ? 'spinner spinner--lg' : 'spinner'} role="status" aria-label="Loading" />;
}

export function CenteredSpinner() {
  return (
    <div className="spinner-center">
      <Spinner large />
    </div>
  );
}

export function Alert({
  kind = 'error',
  children,
}: {
  kind?: 'error' | 'success' | 'info';
  children: ReactNode;
}) {
  return (
    <div className={`alert alert--${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label?: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      {label && (
        <label className="field__label" htmlFor={htmlFor}>
          {label}
        </label>
      )}
      {children}
      {hint && !error && <span className="field__hint">{hint}</span>}
      {error && <span className="field__error">{error}</span>}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty__title">{title}</div>
      {description && <div className="small">{description}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

/** Status pill. Maps an email/campaign status enum to its themed badge class. */
export function StatusBadge({ status }: { status: string }) {
  const variant = status.toLowerCase();
  return <span className={`badge badge--${variant}`}>{humanizeStatus(status)}</span>;
}
