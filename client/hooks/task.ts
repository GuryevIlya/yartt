import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Employee } from '#shared/employee.ts';
import { useTRPC } from './trpc.ts';

/** Employees by id, dismissed included (names in feeds and lists). */
export function useEmployees(): Map<number, Employee> {
  const trpc = useTRPC();
  const { data } = useQuery(trpc.Employee.list.queryOptions());
  return new Map((data ?? []).map((e) => [e.id, e]));
}

/** Refetches everything a task page, My day and an employee page show after a change. */
export function useTaskRefresh(): () => void {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return () => {
    for (const key of [trpc.Task.pathKey(), trpc.Comment.pathKey(), trpc.Observer.pathKey(), trpc.Time.pathKey(), trpc.MyDay.pathKey(), trpc.Remind.pathKey(), trpc.Team.pathKey(), trpc.Work.pathKey(), trpc.TagLimit.pathKey(), trpc.Attachment.pathKey()]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

/** UI updates are polling (AGENTS.md): what others do shows up within this time. */
export const POLL_MS = 30_000;

/**
 * Figures over a range of days — the team, tags, bots: they move slowly,
 * and counting them for many people is heavy, so they are polled rarely.
 */
export const STATS_POLL_MS = 300_000;

/**
 * How often a report over these days is asked again by itself: never over
 * a quarter, which takes seconds at the top of a big company.
 */
export const statsPoll = (from: string, to: string) =>
  (Date.parse(to) - Date.parse(from) > 92 * 86_400_000 ? false : STATS_POLL_MS);

/**
 * The i18next context for verb forms about an employee ("упомянул" /
 * "упомянула"): their pronoun, or none — then the neutral form with both
 * endings ("упомянул(а)") is used.
 */
export function usePronoun(): (employeeId: number | null | undefined) => { context?: 'he' | 'she' } {
  const employees = useEmployees();
  return (employeeId) => {
    const pronoun = employeeId == null ? null : employees.get(employeeId)?.pronoun;
    return pronoun ? { context: pronoun } : {};
  };
}
