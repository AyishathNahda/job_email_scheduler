'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';
import { useAuth } from '@/components/auth/AuthProvider';
import { CenteredSpinner } from '@/components/ui';

/**
 * Client-side guard for every authenticated page. While the session check is in
 * flight we show a spinner; an unauthenticated result redirects to /login.
 * Server components can't read the httpOnly cookie's validity without a round
 * trip, so the gate lives here where the AuthProvider has already made it.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login');
  }, [status, router]);

  if (status !== 'authenticated') {
    return <CenteredSpinner />;
  }

  return <AppShell>{children}</AppShell>;
}
