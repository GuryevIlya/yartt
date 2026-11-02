import type { Member } from '#shared/team.ts';

// The numbers of a row of My team: one person, a manager's team or the
// picked people. People and teams are compared by shares, not hours
// (decision 68): counts add up, shares and delays are averaged over people, and a
// team's score is its manager's.

export const DELAYS = ['record', 'reply'] as const;
export type DelayKind = (typeof DELAYS)[number];

/**
 * Where a delay starts to matter, minutes: a timesheet written a day later
 * is a reconstruction; a mention left for a working day.
 */
export const DELAY_LIMIT: Record<DelayKind, number> = { record: 1440, reply: 480 };

export type Group =
  | { kind: 'person'; person: Member }
  /** A manager's team: everyone under them; `direct` — the people they score themselves. */
  | { kind: 'team'; manager: Member; people: Member[]; direct: Member[] }
  | { kind: 'picked'; people: Member[] };

export type Metrics = {
  /** Time in tasks, % of the person's own timesheet; a group — the average of people. */
  share: number | null;
  /** A person's score weighted by their own hours; a team — its manager's; picked — the average of people. */
  score: number | null;
  scoredDays: number | null;
  /** Past days not scored: a person — by me; a team — by its manager. */
  unscored: number | null;
  finished: number;
  late: number;
  open: number;
  atRisk: number;
  /** A person's planned work and its change over the range; a group has none (hours are not combined). */
  backlog: { minutes: number; growth: number } | null;
  delays: Record<DelayKind, number | null>;
  unanswered: number;
  /** The delay furthest past its limit — what the Delay column shows. */
  worst: { kind: DelayKind; minutes: number } | null;
};

export const average = (values: (number | null)[]) => {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
};
const sum = (people: Member[], value: (m: Member) => number) => people.reduce((n, m) => n + value(m), 0);

/** Time logged to tasks as a share of the person's own timesheet; NULL — no timesheet. */
export const share = (m: Member) => (m.stats.workMinutes > 0 ? (m.stats.spentMinutes / m.stats.workMinutes) * 100 : null);

const delaysOf = (m: Member): Record<DelayKind, number | null> =>
  ({ record: m.recordDelayMinutes, reply: m.replyMinutes });

/** The people whose numbers a row combines. */
export const peopleOf = (g: Group) => (g.kind === 'person' ? [g.person] : g.people);

export function metrics(g: Group): Metrics {
  const people = peopleOf(g);
  const delays = Object.fromEntries(DELAYS.map((k) => [k, average(people.map((m) => delaysOf(m)[k]))])) as Metrics['delays'];
  const worst = DELAYS.reduce<Metrics['worst']>((w, kind) => {
    const minutes = delays[kind];
    if (minutes === null) return w;
    return !w || minutes / DELAY_LIMIT[kind] > w.minutes / DELAY_LIMIT[w.kind] ? { kind, minutes } : w;
  }, null);
  const scorer = g.kind === 'person' ? g.person : g.kind === 'team' ? g.manager : null;
  return {
    share: average(people.map(share)),
    score: scorer ? scorer.stats.weightedScore : average(people.map((m) => m.stats.weightedScore)),
    scoredDays: scorer ? scorer.stats.scoredDays : null,
    unscored: g.kind === 'person' ? (g.person.direct ? g.person.unscoredDays : null)
      : g.kind === 'team' ? sum(g.direct, (m) => m.unscoredDays) : null,
    finished: sum(people, (m) => m.finished),
    late: sum(people, (m) => m.late),
    open: sum(people, (m) => m.openTasks),
    atRisk: sum(people, (m) => m.atRisk),
    backlog: g.kind === 'person' ? { minutes: g.person.backlogMinutes, growth: g.person.backlogGrowthMinutes } : null,
    delays,
    unanswered: sum(people, (m) => m.unanswered),
    worst,
  };
}

/** Day by day, for the charts: a person's values, or the average of the people. */
export function daily(people: Member[], value: (day: Member['days'][number]) => number | null): (number | null)[] {
  const length = people[0]?.days.length ?? 0;
  return Array.from({ length }, (_, i) => average(people.map((m) => {
    const day = m.days[i];
    return day ? value(day) : null;
  })));
}
