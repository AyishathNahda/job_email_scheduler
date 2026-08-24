import { redirect } from 'next/navigation';

// The real UI (login → dashboard) is built in Phase 7.
export default function Home() {
  redirect('/login');
}
