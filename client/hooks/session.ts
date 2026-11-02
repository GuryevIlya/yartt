import { url } from './base.ts';
import { clearDrafts } from './drafts.ts';
import { clearOfflineData } from './offline.ts';

/**
 * After logging out nothing of the person stays in this browser — data,
 * drafts, the outbox — and the page starts afresh on the sign-in page. A
 * full reload rather than resetting the cache: a query restored from the
 * saved cache would reset to that state, the person still signed in, and
 * screens would briefly render half signed out.
 */
export function useSignedOut(): () => void {
  return () => {
    clearDrafts();
    clearOfflineData(true);
    window.location.replace(url('/login'));
  };
}

/**
 * The demo: after signing in as someone else nothing of the previous person
 * stays either — the same clean start, on My day.
 */
export function useSwitchedPerson(): () => void {
  return () => {
    clearDrafts();
    clearOfflineData(true);
    window.location.replace(url('/'));
  };
}
