import { redirect } from 'next/navigation';

// The authenticated area lives under /campaigns; the (app) route-group guard
// bounces unauthenticated visitors on to /login.
export default function Home() {
  redirect('/campaigns');
}
