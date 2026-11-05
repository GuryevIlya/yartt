import { useMemo } from 'react';
import superjson from 'superjson';
import type { Shift, TodoItem } from '#shared/myDay.ts';
import { useOutbox } from './offline.ts';

// What waits in the outbox, shown on screen as done (decision 114). It is
// read from the outbox itself, not copied into the loaded data: a change
// the server refuses on arrival leaves the outbox and so comes back on
// screen, with its reason in a snackbar.

/** A change waiting to be sent: its procedure and its input. */
export type Pending = { id: string; path: string; input: Record<string, unknown> };

/** The outbox, in order, with inputs read back. */
export function usePending(): Pending[] {
  const items = useOutbox();
  return useMemo(() => items.flatMap((item) => {
    try {
      const input: unknown = superjson.parse(item.input);
      return input && typeof input === 'object' ? [{ id: item.id, path: item.path, input: input as Record<string, unknown> }] : [];
    } catch {
      return [];
    }
  }), [items]);
}

const dateOf = (value: unknown): Date | null => (value instanceof Date ? value : null);
const same = (a: Date | null, b: Date | null) => a !== null && b !== null && a.getTime() === b.getTime();
const minutesBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / 60_000);

/** The open shift once what waits is sent: started offline, or ended. */
export function openShift(loaded: Date | null, pending: Pending[]): Date | null {
  let open = loaded;
  for (const { path, input } of pending) {
    const startedAt = dateOf(input.startedAt);
    if (path === 'Work.start') open = startedAt;
    // Closing closes the open shift, whatever start it gives (it may correct it), as the server does.
    else if (path === 'Work.close' || (path === 'Work.remove' && same(open, startedAt))) open = null;
  }
  return open;
}

/** A shift that waits to be sent: it has no id of its own yet. */
export const waiting = (shift: Shift) => shift.id < 0;

/**
 * A day's shifts once what waits is sent. Shifts started or added offline
 * get negative ids (`waiting`); `inDay` says whether one belongs to the day.
 */
export function withPendingShifts(shifts: Shift[], pending: Pending[], inDay: (startedAt: Date) => boolean): Shift[] {
  let result = [...shifts];
  pending.forEach(({ path, input }, index) => {
    const startedAt = dateOf(input.startedAt);
    const endedAt = dateOf(input.endedAt);
    const about = typeof input.about === 'string' ? input.about : null;
    if (!startedAt) return;
    const id = -(index + 1);
    if (path === 'Work.start' && inDay(startedAt)) {
      result.push({ id, startedAt, spentMinutes: null, about: null, score: null });
    } else if (path === 'Work.add' && endedAt && inDay(startedAt)) {
      result.push({ id, startedAt, spentMinutes: minutesBetween(startedAt, endedAt), about, score: null });
    } else if (path === 'Work.close' && endedAt) {
      result = result.map((s) => (s.spentMinutes === null
        ? { ...s, id: Math.min(s.id, id), startedAt, spentMinutes: minutesBetween(startedAt, endedAt), about } : s));
    } else if (path === 'Work.update' && endedAt) {
      const moved = dateOf(input.newStartedAt) ?? startedAt;
      result = result.map((s) => (same(s.startedAt, startedAt)
        ? { ...s, id: Math.min(s.id, id), startedAt: moved, spentMinutes: minutesBetween(moved, endedAt), about } : s));
    } else if (path === 'Work.remove') {
      result = result.filter((s) => !same(s.startedAt, startedAt));
    }
  });
  return result;
}

/** Whether an item of "Waiting for me" is answered by a change that waits to be sent. */
export function answered(item: TodoItem, pending: Pending[]): boolean {
  return pending.some(({ path, input }) => {
    if ((input.taskId ?? input.id) !== item.task.id) return false;
    switch (path) {
      case 'Comment.closeMention': return item.kind === 'mention' && input.commentId === item.commentId;
      case 'Task.markReviewed':
      case 'Task.close': return item.kind === 'review';
      case 'Observer.approve':
      case 'Observer.reject': return item.kind === 'request' && input.employeeId === item.employeeId;
      case 'Remind.remove':
      case 'Remind.move': return item.kind === 'remind' && same(dateOf(input.at), item.at);
      case 'Time.setLeft': return item.kind === 'plan_left';
      default: return false;
    }
  });
}

/** "Waiting for me" once what waits is sent. */
export function usePendingTodo<T extends TodoItem>(items: T[] | undefined): T[] | undefined {
  const pending = usePending();
  return useMemo(() => items?.filter((item) => !answered(item, pending)), [items, pending]);
}
