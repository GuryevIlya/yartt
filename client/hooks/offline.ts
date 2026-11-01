import { dehydrate, hydrate, type QueryClient } from '@tanstack/react-query';
import { TRPCClientError, type TRPCLink, type TRPCUntypedClient } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import superjson from 'superjson';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { AppRouter } from '#shared/types.ts';
import i18n from '#client/i18n/index.ts';
import { showError, showInfo } from './store.ts';

// Working without a connection (decision 43). A change made offline is
// accepted at once and waits in the outbox — kept in this browser — to be
// sent, in order, at the first chance; what was last loaded is saved too, so
// the screens open offline. The server stays the judge: a change it refuses
// when it finally arrives is dropped with its reason shown.
//
// Every change carries an id (X-Yartt-Change, decision 103): one whose
// answer was lost on the way is queued, and when it is sent again the server
// knows it applied it already. A change belongs to whoever made it: it waits
// while they are signed out and goes only for them.

/** `employeeId` — who made it; missing in changes queued before it was kept. */
type Item = { id: string; path: string; input: string; at: number; employeeId?: number | null };

const useOutboxStore = create<{ items: Item[] }>()(persist(() => ({ items: [] as Item[] }), {
  name: 'yartt-outbox',
  storage: createJSONStorage(() => localStorage),
}));

/** Changes waiting to be sent. */
export const useOutbox = () => useOutboxStore((s) => s.items);

/**
 * Not queued: signing in and out, a token shown once, and visits — a visit
 * sent later would be logged at the wrong time.
 */
const queueable = (path: string) => !/^(Auth|Visit)\./.test(path) && path !== 'Bot.create' && path !== 'Bot.resetKey';

/** The error's code from our server, if it answered. */
const appCode = (error: unknown) => (error instanceof TRPCClientError ? (error.data as { appCode?: string } | undefined)?.appCode : undefined);

/** Who is signed in here, as last loaded (Auth.me); NULL — nobody, or not known yet. */
let signedIn: () => number | null = () => null;

/**
 * The server did not answer (as opposed to saying no). Only an answer of our
 * own server carries an error code (server/trpc.ts); anything else — no
 * network, a proxy page, a timeout — is tried again later, never dropped.
 */
export function unreachable(error: unknown): boolean {
  const data = error instanceof TRPCClientError ? (error.data as { appCode?: unknown } | undefined) : undefined;
  return !data?.appCode;
}

function enqueue(id: string, path: string, input: unknown): void {
  const item = { id, path, input: superjson.stringify(input), at: Date.now(), employeeId: signedIn() };
  useOutboxStore.setState((s) => ({ items: [...s.items, item] }));
  showInfo(i18n.t('offline.queued'));
}

/**
 * The first link: a mutation without a connection goes to the outbox and
 * succeeds at once (with no result), so the screen moves on as if it was
 * sent. Queries pass through untouched.
 */
export function offlineLink(): TRPCLink<AppRouter> {
  return () => ({ next, op: given }) => observable((observer) => {
    const op = given.type === 'mutation' ? { ...given, context: { ...given.context, changeId: crypto.randomUUID() } } : given;
    const queue = () => {
      enqueue(op.context.changeId as string, op.path, op.input);
      observer.next({ result: { type: 'data', data: undefined } });
      observer.complete();
    };
    if (op.type === 'mutation' && queueable(op.path) && !navigator.onLine) {
      queue();
      return () => {};
    }
    const subscription = next(op).subscribe({
      next: (value) => observer.next(value),
      error: (error) => (op.type === 'mutation' && queueable(op.path) && unreachable(error) ? queue() : observer.error(error)),
      complete: () => observer.complete(),
    });
    return () => subscription.unsubscribe();
  });
}

let flushing = false;

/**
 * Sends the outbox in order; stops at the first change the network does not
 * take. One tab at a time (a lock across tabs), reading the outbox afresh:
 * two open tabs must not send the same change twice.
 */
async function flush(client: TRPCUntypedClient<AppRouter>, queryClient: QueryClient): Promise<void> {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    if (navigator.locks) await navigator.locks.request('yartt-outbox', () => send(client, queryClient));
    else await send(client, queryClient);
  } finally {
    flushing = false;
  }
}

async function send(client: TRPCUntypedClient<AppRouter>, queryClient: QueryClient): Promise<void> {
  await useOutboxStore.persist.rehydrate(); // what another tab sent or added
  if (useOutboxStore.getState().items.length === 0) return;
  // Signed out (the session ended): the changes wait for their person to sign in.
  const me = await client.query('Auth.me').catch(() => undefined) as { id: number } | null | undefined;
  if (!me) return;
  const drop = (id: string) => useOutboxStore.setState((s) => ({ items: s.items.filter((i) => i.id !== id) }));
  let sent = 0;
  for (const item of useOutboxStore.getState().items) {
    // Someone else signed in in this browser since: not theirs to send.
    if (item.employeeId != null && item.employeeId !== me.id) {
      drop(item.id);
      continue;
    }
    try {
      await client.mutation(item.path, superjson.parse(item.input), { context: { changeId: item.id } });
      sent++;
    } catch (error) {
      if (appCode(error) === 'change_applied') {
        sent++; // it went the first time, only the answer was lost
      } else if (appCode(error) === 'unauthorized') {
        break; // signed out meanwhile: it waits
      } else if (unreachable(error)) {
        // Not the network but a bug would wait here forever: say so in the console.
        if (!(error instanceof TRPCClientError)) console.error('outbox:', error);
        break;
      } else {
        showError(error); // refused now: the reason, and the change is dropped
      }
    }
    drop(item.id);
  }
  if (sent > 0) {
    showInfo(i18n.t('offline.sent', { count: sent }));
    void queryClient.invalidateQueries();
  }
}

const CACHE_KEY = 'yartt-cache';
/** Beyond this the saved cache is skipped: localStorage is small and shared with drafts. */
const CACHE_LIMIT = 2_000_000;

/**
 * What was last loaded comes back on a start without a connection, so the
 * screens open offline. Online it is not used: fresh data comes at once,
 * and a saved state must not stand in for it — on a shared computer it
 * might be someone else's.
 */
export function restoreCache(queryClient: QueryClient): void {
  if (navigator.onLine) return;
  try {
    const saved = localStorage.getItem(CACHE_KEY);
    if (saved) hydrate(queryClient, superjson.parse(saved));
  } catch {
    // A broken or unreadable cache is just not restored.
  }
}

let saving = true;

/**
 * Forgets the saved screens: on signing in, possibly as someone else. The
 * outbox stays: its changes go only if their person is the one signed in.
 */
export function clearOfflineCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // Nothing saved, nothing to clear.
  }
}

/**
 * Forgets everything: on logging out (`reloading` — the page starts
 * afresh, so nothing more is saved) or, in the demo, switching person.
 */
export function clearOfflineData(reloading = false): void {
  if (reloading) saving = false;
  clearOfflineCache();
  useOutboxStore.setState({ items: [] });
}

/** Saves the cache as it changes and sends the outbox whenever there is a chance. */
export function startOffline(client: TRPCUntypedClient<AppRouter>, queryClient: QueryClient): void {
  signedIn = () => {
    const [, me] = queryClient.getQueriesData<{ id: number } | null>({ queryKey: [['Auth', 'me']] })[0] ?? [];
    return me?.id ?? null;
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  queryClient.getQueryCache().subscribe(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!saving) return;
      try {
        const text = superjson.stringify(dehydrate(queryClient));
        if (text.length < CACHE_LIMIT) localStorage.setItem(CACHE_KEY, text);
      } catch {
        // No room or no storage: offline the screens just start empty.
      }
    }, 1000);
  });
  const tryFlush = () => void flush(client, queryClient);
  // Signed in again: what waited for them goes now.
  queryClient.getQueryCache().subscribe((event) => {
    const [path] = event.query.queryKey as [string[]?];
    if (event.type === 'updated' && path?.join('.') === 'Auth.me' && signedIn() !== null && useOutboxStore.getState().items.length) tryFlush();
  });
  // "online" comes a moment before the network really answers.
  window.addEventListener('online', () => setTimeout(tryFlush, 1500));
  setInterval(() => { if (useOutboxStore.getState().items.length) tryFlush(); }, 30_000);
  tryFlush();
}
