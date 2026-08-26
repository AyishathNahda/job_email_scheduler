'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@/components/auth/AuthProvider';
import { ChevronDownIcon, ClockIcon, SendIcon } from '@/components/Icons';
import { api } from '@/lib/api';

/** Sidebar + top bar chrome matching Figma design with dynamic data. */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, logout } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [counts, setCounts] = useState<{ scheduled: number; sent: number }>({
    scheduled: 0,
    sent: 0,
  });
  const [menuOpen, setMenuOpen] = useState(false);

  const currentTab = searchParams.get('tab') || 'scheduled';

  // Load real dynamic counts for sidebar badges
  useEffect(() => {
    let mounted = true;
    const fetchCounts = async () => {
      try {
        const page = await api.listAllJobs({ limit: 1 });
        if (mounted && page.counts) {
          setCounts({
            scheduled: page.counts.scheduled + page.counts.processing,
            sent: page.counts.sent,
          });
        }
      } catch {
        // silent fallback
      }
    };
    void fetchCounts();
    const interval = setInterval(fetchCounts, 5000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const onLogout = async () => {
    setSigningOut(true);
    await logout();
    router.replace('/login');
  };

  const initial =
    user?.name?.trim().charAt(0).toUpperCase() ||
    user?.email?.trim().charAt(0).toUpperCase() ||
    'U';

  const isCompose = pathname === '/campaigns/new';
  const isScheduledActive = !isCompose && (currentTab === 'scheduled' || pathname === '/campaigns' && !searchParams.get('tab'));
  const isSentActive = !isCompose && currentTab === 'sent';

  return (
    <div className="figma-shell">
      {/* ── Left Sidebar ── */}
      <aside className="figma-sidebar">
        {/* ONB Logo */}
        <div className="figma-logo">
          <Link href="/campaigns" className="figma-logo-text">
            ONB
          </Link>
        </div>

        {/* User Profile Card */}
        <div className="figma-user-card" onClick={() => setMenuOpen(!menuOpen)}>
          <div className="figma-avatar">
            {user?.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.avatarUrl} alt={user.name || ''} className="figma-avatar-img" />
            ) : (
              <span>{initial}</span>
            )}
          </div>
          <div className="figma-user-info">
            <div className="figma-user-name">{user?.name || 'Oliver Brown'}</div>
            <div className="figma-user-email">{user?.email || 'oliver.brown@domain.io'}</div>
          </div>
          <div className="figma-user-chevron">
            <ChevronDownIcon />
          </div>

          {menuOpen && (
            <div className="figma-user-dropdown" onClick={(e) => e.stopPropagation()}>
              <button onClick={onLogout} disabled={signingOut} className="figma-dropdown-item">
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          )}
        </div>

        {/* Compose Button */}
        <Link href="/campaigns/new" className="figma-compose-btn">
          Compose
        </Link>

        {/* Core Navigation */}
        <div className="figma-core-section">
          <div className="figma-core-label">CORE</div>

          <Link
            href="/campaigns?tab=scheduled"
            className={`figma-nav-item ${isScheduledActive ? 'figma-nav-item--active' : ''}`}
          >
            <div className="figma-nav-left">
              <span className="figma-nav-icon">
                <ClockIcon />
              </span>
              <span className="figma-nav-text">Scheduled</span>
            </div>
            <span className="figma-nav-badge">{counts.scheduled}</span>
          </Link>

          <Link
            href="/campaigns?tab=sent"
            className={`figma-nav-item ${isSentActive ? 'figma-nav-item--active' : ''}`}
          >
            <div className="figma-nav-left">
              <span className="figma-nav-icon">
                <SendIcon />
              </span>
              <span className="figma-nav-text">Sent</span>
            </div>
            <span className="figma-nav-badge">{counts.sent}</span>
          </Link>
        </div>
      </aside>

      {/* ── Main Content Area ── */}
      <main className="figma-main">
        {children}
      </main>
    </div>
  );
}


