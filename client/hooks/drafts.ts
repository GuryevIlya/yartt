import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { storageKey } from './base.ts';
import { useMe } from './me.ts';

// What is typed but not saved yet — a comment, a new task, a context being
// edited — outlives leaving the page: a task page unmounts when another
// opens. Kept in sessionStorage (this tab, survives a reload), under the
// employee's id, so a sign-in link for someone else in the same tab never
// shows them my drafts; logging out clears them.

type Drafts = { drafts: Record<string, unknown> };

const useDrafts = create<Drafts>()(persist(() => ({ drafts: {} }), {
  name: storageKey('yartt-drafts'),
  // Without sessionStorage (blocked site data) drafts live in memory only.
  storage: createJSONStorage(() => sessionStorage),
}));

/**
 * A draft under `key`, or `initial` when there is none. Setting `initial`
 * back is the same as `clear`: an untouched form leaves nothing behind.
 */
export function useDraft<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void, () => void] {
  const me = useMe();
  const full = `${me.id}:${key}`;
  // The selector returns the stored reference itself: a fresh `initial` from
  // it on every call would re-render forever.
  const stored = useDrafts((s) => s.drafts[full]) as T | undefined;
  const value = stored === undefined ? initial : stored;
  const clear = () => useDrafts.setState((s) => {
    const { [full]: _, ...rest } = s.drafts;
    return { drafts: rest };
  });
  const set = (next: T | ((prev: T) => T)) => useDrafts.setState((s) => {
    const prev = full in s.drafts ? (s.drafts[full] as T) : initial;
    const resolved = typeof next === 'function' ? (next as (prev: T) => T)(prev) : next;
    if (JSON.stringify(resolved) === JSON.stringify(initial)) {
      const { [full]: _, ...rest } = s.drafts;
      return { drafts: rest };
    }
    return { drafts: { ...s.drafts, [full]: resolved } };
  });
  return [value, set, clear];
}

/** Forgets every draft: on logging out. */
export const clearDrafts = () => useDrafts.setState({ drafts: {} });
