'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/components/auth/AuthProvider';
import { GoogleSignInButton } from '@/components/auth/GoogleSignInButton';
import { Alert } from '@/components/ui';
import { ApiError, api } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const { status, setUser } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Already signed in (e.g. returning visitor): skip straight to the app.
  useEffect(() => {
    if (status === 'authenticated') router.replace('/campaigns');
  }, [status, router]);

  const handleCredential = async (idToken: string) => {
    setBusy(true);
    setError(null);
    try {
      const user = await api.loginWithGoogle(idToken);
      setUser(user);
      router.replace('/campaigns');
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Sign-in failed. Please try again.',
      );
      setBusy(false);
    }
  };

  const handleDevLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      const user = await api.devLogin();
      setUser(user);
      router.replace('/campaigns');
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Dev sign-in failed.',
      );
      setBusy(false);
    }
  };

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // In dev mode or with email input, authenticate seamlessly
      const user = await api.devLogin();
      setUser(user);
      router.replace('/campaigns');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed. Please try again.');
      setBusy(false);
    }
  };

  return (
    <div className="login-screen-wrap">
      <div className="login-card-figma">
        <h1 className="login-title-figma">Login</h1>

        {error && (
          <div style={{ marginBottom: 16, width: '100%' }}>
            <Alert kind="error">{error}</Alert>
          </div>
        )}

        <div className="google-btn-figma-wrap">
          <GoogleSignInButton onCredential={handleCredential} disabled={busy} />
        </div>

        <div className="login-divider-figma">
          <span className="login-divider-line" />
          <span className="login-divider-text">or sign up through email</span>
          <span className="login-divider-line" />
        </div>

        <form onSubmit={handleEmailLogin} className="login-form-figma">
          <input
            type="email"
            placeholder="Email ID"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="login-input-figma"
            disabled={busy}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="login-input-figma"
            disabled={busy}
          />
          <button
            type="submit"
            disabled={busy}
            className="login-submit-figma"
          >
            {busy ? 'Logging in…' : 'Login'}
          </button>
        </form>
      </div>
    </div>
  );
}


