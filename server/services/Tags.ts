import type { MyTags, SetTagInput, Suggestions, TagDetail, TagDetailInput, TagGroup, TagPart, TagSort, TagStatsInput } from '#shared/tags.ts';
import { MyTag, TagPerson, TagStats as TagStatsSummary, TagStatsRow } from '#shared/tags.ts';
import { defaultKeyboards, Keyboard, retype } from '#shared/keyboards.ts';
import { Locale } from '#shared/employee.ts';
import { Tag, TagName } from '#shared/task.ts';
import { z } from 'zod';
import { AppError } from '../errors.ts';
import { sql } from '../pg.ts';

export const PAGE_SIZE = 50;

/**
 * The tags of the tasks I see, with how many such tasks carry each and how
 * many are open, and my own color and weight. Tags I gave a color or a
 * weight come first, then by weight, by how often I meet them, by name.
 */
export async function mine(viewerId: number, query: string, page: number): Promise<MyTags> {
  const like = '%' + query.replace(/[\\%_]/g, '\\$&') + '%';
  const tags = sql`
    SELECT t.id, t.name, u.color, COALESCE(u.weight, 0) AS weight,
           count(*)::int AS tasks,
           count(*) FILTER (WHERE f.confirmed_at IS NULL)::int AS open,
           (u.tag_id IS NOT NULL) AS personal
      FROM task k
      CROSS JOIN LATERAL unnest(k.tag_ids) AS kt(id)
      JOIN tag t ON t.id = kt.id
      LEFT JOIN finished_at f ON f.task_id = k.id AND f.expired_at IS NULL
      LEFT JOIN user_tag u ON u.tag_id = t.id AND u.employee_id = ${viewerId}
     WHERE can_see(k.id, ${viewerId}) AND t.name ILIKE ${like}
     GROUP BY t.id, t.name, u.tag_id, u.color, u.weight
  `;
  const items = MyTag.array().parse(await sql`
    SELECT id, name, color, weight, tasks, open FROM (${tags}) x
     ORDER BY personal DESC, weight DESC, tasks DESC, name
     LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}
  `);
  const [count] = z.object({ n: z.number() }).array().parse(await sql`SELECT count(*)::int AS n FROM (${tags}) x`);
  return { items, total: count?.n ?? 0 };
}

/** My color and weight of a tag; the default ones (no color, weight 0) remove my row. */
export async function set(employeeId: number, input: SetTagInput): Promise<void> {
  const [exists] = z.object({ value: z.boolean() }).array().parse(await sql`
    SELECT EXISTS (SELECT 1 FROM tag WHERE id = ${input.tagId}) AS value
  `);
  if (!exists?.value) throw new AppError('not_found');
  if (input.color === null && input.weight === 0) {
    await sql`DELETE FROM user_tag WHERE employee_id = ${employeeId} AND tag_id = ${input.tagId}`;
    return;
  }
  await sql`
    INSERT INTO user_tag (employee_id, tag_id, color, weight)
    VALUES (${employeeId}, ${input.tagId}, ${input.color}, ${input.weight})
    ON CONFLICT (employee_id, tag_id) DO UPDATE SET color = EXCLUDED.color, weight = EXCLUDED.weight
  `;
}

/** How close a tag must be to a phrase to be suggested (0..1). */
const MIN_SCORE = 0.6;
/** Words of the text read as tags; a longer text gets no variants. */
const MAX_WORDS = 8;
/** A tag may span this many words ("3-й этаж"). */
const MAX_SPAN = 3;
const VARIANTS = 5;

const Candidate = z.object({ ord: z.number(), id: z.number(), name: z.string(), color: z.string().nullable(), score: z.number() });
type Candidate = z.infer<typeof Candidate>;

/** How many nearest tags by trigrams each phrase looks at (the KNN index lookup). */
const KNN = 40;

/**
 * Tags close to each phrase, best first. Exact name — 1, exact in another
 * layout — 0.95; a name or its Latin form starting with the phrase — 0.9
 * (only where `prefix`: the word being typed), containing it — 0.7;
 * otherwise Levenshtein and trigrams on the Latin forms (db.sql, SEARCH).
 * Each phrase comes with `variants`: the same keys read with the viewer's
 * other layouts. A phrase of `words` words is compared only with tags of as
 * many words (0 — any): otherwise a long phrase would pass for a short tag
 * it merely contains. Candidates come from the indexes first: the nearest
 * by trigrams (KNN), the exact name, names starting with the word.
 */
async function candidates(
  viewerId: number,
  phrases: { text: string; variants: string[]; prefix: boolean; words: number }[],
  limit: number,
): Promise<Candidate[]> {
  if (phrases.length === 0) return [];
  const esc = (v: string) => v.replace(/[\\%_]/g, '\\$&');
  const rows = phrases.flatMap((p, i) => [p.text, ...p.variants].map((variant) => ({ ...p, ord: i + 1, variant })));
  return Candidate.array().parse(await sql`
      WITH q AS (
        SELECT ord::int, phrase, variant, prefix::bool AS prefix, words::int AS words, pattern, translit(variant) AS a
          FROM unnest(${rows.map((r) => String(r.ord))}::text[], ${rows.map((r) => r.text)}::text[],
                      ${rows.map((r) => r.variant)}::text[], ${rows.map((r) => (r.prefix ? 't' : 'f'))}::text[],
                      ${rows.map((r) => String(r.words))}::text[], ${rows.map((r) => esc(r.variant))}::text[])
               AS x(ord, phrase, variant, prefix, words, pattern)
      ), scored AS (
        SELECT q.ord, t.id, t.name, max(
                 CASE
                   WHEN t.name = q.phrase THEN 1.0
                   WHEN t.name = q.variant THEN 0.95
                   WHEN q.prefix AND (t.name LIKE q.pattern || '%' OR t.latin LIKE translit(q.pattern) || '%') THEN 0.9
                   WHEN q.prefix AND length(q.variant) >= 3 AND t.name LIKE '%' || q.pattern || '%' THEN 0.7
                   ELSE greatest(
                     1 - levenshtein(left(q.a, 255), left(t.latin, 255))::float8 / greatest(length(q.a), length(t.latin), 1),
                     similarity(q.a, t.latin))
                 END) AS score
          FROM q
          -- Candidates first, by the indexes: the nearest by trigrams (GiST, KNN),
          -- the exact name, and names starting with or containing the word typed.
          JOIN LATERAL (
            (SELECT c.id FROM tag c ORDER BY c.latin <-> q.a LIMIT ${KNN})
            UNION (SELECT c.id FROM tag c WHERE c.name = q.variant)
            UNION (SELECT c.id FROM tag c
                    WHERE q.prefix AND (c.name LIKE q.pattern || '%' OR c.latin LIKE translit(q.pattern) || '%') LIMIT ${KNN})
            UNION (SELECT c.id FROM tag c
                    WHERE q.prefix AND length(q.variant) >= 3 AND c.name LIKE '%' || q.pattern || '%' LIMIT ${KNN})
          ) candidate ON TRUE
          JOIN tag t ON t.id = candidate.id
         WHERE q.words = 0 OR q.words = array_length(string_to_array(t.name, ' '), 1)
         GROUP BY q.ord, t.id, t.name
      ), ranked AS (
        SELECT s.*, row_number() OVER (
                 PARTITION BY s.ord
                 ORDER BY s.score DESC, (SELECT count(*) FROM task k WHERE k.tag_ids @> ARRAY[s.id]) DESC, s.name
               ) AS rn
          FROM scored s
         WHERE s.score >= ${MIN_SCORE}
      )
      SELECT r.ord, r.id, r.name, u.color, r.score::float8 AS score
        FROM ranked r
        LEFT JOIN user_tag u ON u.tag_id = r.id AND u.employee_id = ${viewerId}
       WHERE r.rn <= ${limit}
       ORDER BY r.ord, r.rn
    `);
}

const KeyboardsRow = z.object({ keyboards: Keyboard.array().nullable(), locale: Locale });

type Partial = { parts: TagPart[]; score: number };

const key = (parts: TagPart[]) => parts.map((p) => ('tag' in p ? `#${p.tag.id}` : p.name)).join('|');

/**
 * Tags for what is typed: the closest to the whole text, and ways to read it
 * as several tags — a beam search over the words where a run of up to
 * MAX_SPAN words is an existing tag or the words between such runs make one
 * new tag. A variant scores the closeness of its tags times the words they
 * cover, so the reading that explains more of the text with existing tags
 * comes first.
 */
export async function suggest(viewerId: number, text: string): Promise<Suggestions> {
  const parsed = TagName.safeParse(text);
  if (!parsed.success) return { tags: [], variants: [], exact: false };
  const whole = parsed.data;
  // Only spaces part words: "," and ";" are letters typed in another layout ("б", "ж").
  const words = whole.split(' ');
  const [row] = KeyboardsRow.array().parse(await sql`SELECT h.keyboards::text[] AS keyboards, e.locale FROM employee e LEFT JOIN human h ON h.employee_id = e.id WHERE e.id = ${viewerId}`);
  const keyboards = row?.keyboards ?? defaultKeyboards(row?.locale ?? 'en');
  const retyped = (phrase: string) => retype(phrase, keyboards);
  // The last word is still being typed unless a space follows it.
  const typing = !/\s$/.test(text);

  const spans: { from: number; to: number; text: string; variants: string[]; prefix: boolean; words: number }[] = [];
  if (words.length > 1 && words.length <= MAX_WORDS) {
    for (let from = 0; from < words.length; from++) {
      for (let to = from + 1; to <= Math.min(words.length, from + MAX_SPAN); to++) {
        const phrase = words.slice(from, to).join(' ');
        spans.push({ from, to, text: phrase, variants: retyped(phrase), prefix: typing && to === words.length, words: to - from });
      }
    }
  }
  const phrases = [{ text: whole, variants: retyped(whole), prefix: true, words: 0 }, ...spans];
  const found = await candidates(viewerId, phrases, 10);
  const byPhrase = (ord: number) => found.filter((c) => c.ord === ord).map(({ id, name, color, score }) => ({ tag: Tag.parse({ id, name, color }), score }));
  const tags = byPhrase(1).map((c) => c.tag);

  let beam: Partial[][] = [[{ parts: [], score: 0 }], ...words.map(() => [])];
  for (let i = 0; i < words.length; i++) {
    for (const partial of beam[i]!) {
      const last = partial.parts.at(-1);
      const asNew: TagPart[] = last && 'name' in last
        ? [...partial.parts.slice(0, -1), { name: `${last.name} ${words[i]}` }]
        : [...partial.parts, { name: words[i]! }];
      beam[i + 1]!.push({ parts: asNew, score: partial.score });
      spans.forEach((span, n) => {
        if (span.from !== i) return;
        for (const c of byPhrase(n + 2).slice(0, 2)) {
          if (partial.parts.some((p) => 'tag' in p && p.tag.id === c.tag.id)) continue;
          beam[span.to]!.push({ parts: [...partial.parts, { tag: c.tag }], score: partial.score + c.score * (span.to - span.from) });
        }
      });
    }
    for (let j = i + 1; j <= words.length; j++) {
      const seen = new Set<string>();
      beam[j] = beam[j]!.sort((a, b) => b.score - a.score).filter((p) => !seen.has(key(p.parts)) && !!seen.add(key(p.parts))).slice(0, VARIANTS * 2);
    }
  }
  const variants = words.length > 1
    ? beam[words.length]!.filter((p) => p.score > 0).slice(0, VARIANTS).map((p) => p.parts)
    : [];

  return { tags, variants, exact: tags.some((t) => t.name === whole) };
}

const RELATED = 6;
/** The rubrics offered in an empty title field. */
const MINE = 10;

/**
 * A rubric is a tag on more than one task; a phrase of one task is not a
 * group (decision 56). Two rows read at most, whatever the tag's size.
 */
const rubric = () => sql`(SELECT count(*) FROM (SELECT 1 FROM task c WHERE c.tag_ids @> ARRAY[t.id] LIMIT 2) two) > 1`;

/**
 * The tags that most often go with these ones (decision 56): on the tasks
 * carrying all of them, the other tags by how many such tasks carry them —
 * rubrics only, not a phrase of one task. Offered under a title being typed,
 * so the same things keep the same names. Without tags — the rubrics of the
 * tasks the viewer takes part in, offered in an empty title field: the whole
 * list a click away, with nothing typed.
 */
export async function related(viewerId: number, tagIds: number[]): Promise<Tag[]> {
  if (tagIds.length === 0) {
    return Tag.array().parse(await sql`
      SELECT t.id, t.name, u.color
        FROM observer o
        JOIN task k ON k.id = o.task_id
        CROSS JOIN LATERAL unnest(k.tag_ids) AS kt(id)
        JOIN tag t ON t.id = kt.id
        LEFT JOIN user_tag u ON u.tag_id = t.id AND u.employee_id = ${viewerId}
       WHERE o.value = ${viewerId} AND o.added_at IS NOT NULL AND o.deleted_at IS NULL
         AND ${rubric()}
       GROUP BY t.id, t.name, u.color
       ORDER BY count(*) DESC, t.name
       LIMIT ${MINE}
    `);
  }
  return Tag.array().parse(await sql`
    SELECT t.id, t.name, u.color
      FROM task k
      CROSS JOIN LATERAL unnest(k.tag_ids) AS kt(id)
      JOIN tag t ON t.id = kt.id
      LEFT JOIN user_tag u ON u.tag_id = t.id AND u.employee_id = ${viewerId}
     WHERE k.tag_ids @> ${tagIds}::int[] AND NOT t.id = ANY(${tagIds}::int[])
       AND ${rubric()}
     GROUP BY t.id, t.name, u.color
     ORDER BY count(*) DESC, t.name
     LIMIT ${RELATED}
  `);
}

const SUMMARY_PAGE = 20;
/** How far back a range may start: two years. */
const FURTHEST = 730;
const Count = z.object({ n: z.number() });
const SummaryRow = TagStatsRow.omit({ group: true, tags: true }).extend({ tagId: z.number().nullable() });
const Range = z.object({ from: z.string(), to: z.string() });

/** From `since` to today in the viewer's time zone; a day in the future is today, one too far back is two years ago. */
export async function untilToday(viewerId: number, since: string): Promise<{ from: string; to: string }> {
  const [range] = Range.array().parse(await sql`
    SELECT LEAST(GREATEST(${since}::date, local_today(${viewerId}) - ${FURTHEST}::int), local_today(${viewerId}))::text AS from,
           local_today(${viewerId})::text AS to
  `);
  return range!;
}

/**
 * The tasks the viewer sees and what people did on them over a range of
 * their days (decision 58): `v` — the tasks, `cm` — their comments in the
 * range, `tp` — who commented on or logged time to each, `m` — each task's
 * figures. Bots are not people here: their comments are automation, not
 * work under a tag.
 */
function scope(viewerId: number, from: string, to: string) {
  return sql`
    WITH r AS (
      SELECT (${from}::date)::timestamp AT TIME ZONE e.time_zone AS since,
             (${to}::date + 1)::timestamp AT TIME ZONE e.time_zone AS until,
             e.time_zone
        FROM employee e WHERE e.id = ${viewerId}
    ),
    v AS (
      SELECT k.id, k.tag_ids, f.value AS deadline, f.confirmed_at AS closed_at
        FROM task k
        LEFT JOIN finished_at f ON f.task_id = k.id AND f.expired_at IS NULL
       WHERE can_see(k.id, ${viewerId})
    ),
    cm AS (
      SELECT c.task_id, c.created_by, (c.created_at AT TIME ZONE r.time_zone)::date AS day
        FROM comment c JOIN human h ON h.employee_id = c.created_by, r
       WHERE c.created_at >= r.since AND c.created_at < r.until AND c.task_id IN (SELECT id FROM v)
    ),
    sp AS (
      -- A shift past midnight puts its share of an entry in each day (decision 100).
      SELECT s.task_id, s."by", s.day, s.minutes AS value FROM spent_day s
       WHERE s.day BETWEEN ${from}::date AND ${to}::date AND s.task_id IN (SELECT id FROM v)
    ),
    tp AS (
      SELECT DISTINCT task_id, person, day FROM (
        SELECT task_id, created_by AS person, day FROM cm
        UNION ALL
        SELECT task_id, "by", day FROM sp
      ) x
    ),
    m AS (
      SELECT v.id, v.tag_ids,
             v.closed_at IS NULL AS open,
             at_risk(v.id) AS at_risk,
             COALESCE(v.closed_at >= r.since AND v.closed_at < r.until, FALSE) AS closed_in,
             (v.closed_at AT TIME ZONE r.time_zone)::date AS closed_day,
             COALESCE(v.closed_at > v.deadline, FALSE) AS late,
             (SELECT count(*) FROM cm WHERE cm.task_id = v.id)::int AS comments,
             EXISTS (SELECT 1 FROM tp WHERE tp.task_id = v.id) AS touched,
             GREATEST(
               (SELECT max((c.created_at AT TIME ZONE r.time_zone)::date) FROM comment c
                  JOIN human h ON h.employee_id = c.created_by WHERE c.task_id = v.id),
               (SELECT max(s.day) FROM spent_day s WHERE s.task_id = v.id),
               (v.closed_at AT TIME ZONE r.time_zone)::date
             ) AS last_day
        FROM v CROSS JOIN r
    )
  `;
}

const figures = () => sql`
  count(*) FILTER (WHERE m.open)::int AS open,
  count(*) FILTER (WHERE m.at_risk)::int AS at_risk,
  count(*) FILTER (WHERE m.open AND NOT m.touched)::int AS stale,
  count(*) FILTER (WHERE m.closed_in AND NOT m.late)::int AS finished,
  count(*) FILTER (WHERE m.closed_in AND m.late)::int AS late,
  count(*) FILTER (WHERE m.closed_in OR m.touched)::int AS active,
  COALESCE(sum(m.comments), 0)::int AS comments,
  count(*) FILTER (WHERE m.comments > 0)::int AS discussed,
  (SELECT COALESCE(sum(sp.value), 0) FROM sp WHERE sp.task_id = ANY(array_agg(m.id)))::int AS minutes,
  (SELECT COALESCE(sum(e.value), 0) FROM estimate_minutes e
    WHERE e.expired_at IS NULL AND e.task_id = ANY(array_agg(m.id) FILTER (WHERE m.open)))::int AS left_minutes,
  (SELECT count(DISTINCT tp.person) FROM tp WHERE tp.task_id = ANY(array_agg(m.id)))::int AS people,
  (SELECT count(DISTINCT e."by") FROM estimate_minutes e
    WHERE e.expired_at IS NULL AND e.task_id = ANY(array_agg(m.id) FILTER (WHERE m.open)))::int AS planners,
  max(m.last_day)::text AS last_day
`;

/** The order of the lines: the column picked, largest (latest) first, then the tasks in work. */
function order(sort: TagSort) {
  switch (sort) {
    case 'active': return sql`active DESC, open DESC`;
    case 'open': return sql`open DESC, active DESC`;
    case 'closed': return sql`finished + late DESC, active DESC`;
    case 'comments': return sql`comments DESC, active DESC`;
    case 'hours': return sql`minutes DESC, left_minutes DESC, active DESC`;
    case 'last': return sql`last_day DESC NULLS LAST, active DESC`;
  }
}

/** The tasks of a line: carrying the tag, all the picked ones, or any of them. */
function carrying(group: TagGroup, column = sql`tag_ids`) {
  return group.kind === 'tag' ? sql`${column} @> ARRAY[${group.tagId}::int]`
    : group.kind === 'all' ? sql`${column} @> ${group.tagIds}::int[]`
    : sql`${column} && ${group.tagIds}::int[]`;
}


async function tagsByIds(viewerId: number, ids: number[]): Promise<Map<number, Tag>> {
  if (ids.length === 0) return new Map();
  const rows = Tag.array().parse(await sql`
    SELECT t.id, t.name, u.color FROM tag t
      LEFT JOIN user_tag u ON u.tag_id = t.id AND u.employee_id = ${viewerId}
     WHERE t.id = ANY(${ids})
  `);
  return new Map(rows.map((t) => [t.id, t]));
}

/**
 * The tag summary from a day to today, on the tasks the viewer sees
 * (decision 58). No tags picked: every rubric — a tag on more than one
 * task; a phrase of one task is not a group — the most active first, with
 * pages. Tags picked: each of them, then, for two or more, their tasks all
 * together and any of them.
 */
export async function stats(viewerId: number, input: TagStatsInput): Promise<z.infer<typeof TagStatsSummary>> {
  const { from, to } = await untilToday(viewerId, input.since);
  const picked = input.tagIds.length > 0;
  const base = scope(viewerId, from, to);
  const which = picked ? sql`t.id = ANY(${input.tagIds}::int[])` : rubric();
  const rows = SummaryRow.array().parse(await sql`
    ${base}
    SELECT * FROM (
      SELECT t.id AS tag_id, t.name, ${figures()}
        FROM m
        CROSS JOIN LATERAL unnest(m.tag_ids) AS mt(id)
        JOIN tag t ON t.id = mt.id
       WHERE ${which}
       GROUP BY t.id, t.name
    ) x
     ORDER BY ${order(input.sort)}, x.name
     ${picked ? sql`` : sql`LIMIT ${SUMMARY_PAGE} OFFSET ${(input.page - 1) * SUMMARY_PAGE}`}
  `);
  const [count] = Count.array().parse(await sql`
    ${base}
    SELECT count(DISTINCT t.id)::int AS n
      FROM m CROSS JOIN LATERAL unnest(m.tag_ids) AS mt(id) JOIN tag t ON t.id = mt.id
     WHERE ${which}
  `);
  const groups: { group: TagGroup; tagIds: number[]; figures: z.infer<typeof SummaryRow> }[] = rows.map((r) => ({
    group: { kind: 'tag', tagId: r.tagId! }, tagIds: [r.tagId!], figures: r,
  }));
  if (input.tagIds.length > 1) {
    for (const kind of ['all', 'any'] as const) {
      const group: TagGroup = { kind, tagIds: input.tagIds };
      const [row] = SummaryRow.array().parse(await sql`
        ${base}
        SELECT NULL::int AS tag_id, ${figures()} FROM m WHERE ${carrying(group, sql`m.tag_ids`)}
      `);
      groups.push({ group, tagIds: input.tagIds, figures: row! });
    }
  }
  const tags = await tagsByIds(viewerId, [...new Set(groups.flatMap((g) => g.tagIds))]);
  return {
    rows: groups.map(({ group, tagIds, figures: { tagId: _, ...rest } }) => ({
      group, tags: tagIds.flatMap((id) => tags.get(id) ?? []), ...rest,
    })),
    total: count?.n ?? 0,
  };
}

const Days = z.object({ day: z.string() });
const PersonRow = TagPerson.omit({ daily: true, dailyTasks: true, dailyComments: true, planned: true, plannedTasks: true });
const PersonDay = z.object({ employeeId: z.number(), day: z.string(), n: z.number() });

/**
 * A line of the summary unfolded, from a day to today on the tasks the
 * viewer sees: each person's own time and own plan of time left, day by
 * day, and with them the tasks they logged time to and the comments they
 * left, and the tasks their plan covered that day; the share of all they logged and their plan now —
 * most time first; the client adds their hours up into the line's total
 * (decision 68).
 */
export async function detail(viewerId: number, input: TagDetailInput): Promise<TagDetail> {
  const { from, to } = await untilToday(viewerId, input.since);
  // `pl` — each plan of time left in force at the end of each day (now, for today) on a task still open then.
  const base = sql`${scope(viewerId, from, to)},
    lt AS (SELECT id FROM v WHERE ${carrying(input.group, sql`v.tag_ids`)}),
    dd AS (
      SELECT d::date AS day, LEAST((d::date + 1)::timestamp AT TIME ZONE r.time_zone, NOW()) AS at
        FROM generate_series(${from}::date, ${to}::date, INTERVAL '1 day') d, r
    ),
    pl AS (
      SELECT dd.day, e."by", e.task_id, e.value
        FROM dd JOIN estimate_minutes e ON e.entered_at <= dd.at AND (e.expired_at IS NULL OR e.expired_at > dd.at)
       WHERE e.task_id IN (SELECT id FROM lt)
         AND NOT EXISTS (
           SELECT 1 FROM finished_at f
            WHERE f.task_id = e.task_id AND f.entered_at <= dd.at AND (f.expired_at IS NULL OR f.expired_at > dd.at)
              AND f.confirmed_at <= dd.at)
    )`;
  const days = Days.array().parse(await sql`${base} SELECT dd.day::text AS day FROM dd ORDER BY dd.day`).map((d) => d.day);
  const persons = PersonRow.array().parse(await sql`
    ${base},
    total AS (
      SELECT s."by", sum(s.minutes) AS minutes FROM spent_day s
       WHERE s.day BETWEEN ${from}::date AND ${to}::date GROUP BY s."by"
    ),
    mine AS (
      SELECT p.person,
             COALESCE((SELECT sum(sp.value) FROM sp WHERE sp."by" = p.person AND sp.task_id IN (SELECT id FROM lt)), 0)::int AS minutes
        FROM (SELECT person FROM tp WHERE task_id IN (SELECT id FROM lt) UNION SELECT "by" FROM pl) p
    )
    SELECT mine.person AS employee_id, mine.minutes,
           (mine.minutes::float8 / NULLIF((SELECT minutes FROM total WHERE total."by" = mine.person), 0))::float8 AS share,
           (SELECT sum(e.value) FROM estimate_minutes e JOIN m ON m.id = e.task_id
             WHERE e."by" = mine.person AND e.expired_at IS NULL AND m.open AND e.task_id IN (SELECT id FROM lt))::int AS left_minutes,
           (SELECT count(*) FROM cm WHERE cm.created_by = mine.person AND cm.task_id IN (SELECT id FROM lt))::int AS comments
      FROM mine
     ORDER BY minutes DESC, left_minutes DESC NULLS LAST, comments DESC, mine.person
  `);
  const perDay = (query: ReturnType<typeof sql>) => query.then((rows) => PersonDay.array().parse(rows));
  const [daily, spentTasks, comments, planned, tasks] = await Promise.all([
    perDay(sql`${base} SELECT sp."by" AS employee_id, sp.day::text AS day, sum(sp.value)::int AS n
                 FROM sp WHERE sp.task_id IN (SELECT id FROM lt) GROUP BY sp."by", sp.day`),
    perDay(sql`${base} SELECT sp."by" AS employee_id, sp.day::text AS day, count(DISTINCT sp.task_id)::int AS n
                 FROM sp WHERE sp.task_id IN (SELECT id FROM lt) GROUP BY sp."by", sp.day`),
    perDay(sql`${base} SELECT cm.created_by AS employee_id, cm.day::text AS day, count(*)::int AS n
                 FROM cm WHERE cm.task_id IN (SELECT id FROM lt) GROUP BY cm.created_by, cm.day`),
    perDay(sql`${base} SELECT pl."by" AS employee_id, pl.day::text AS day, sum(pl.value)::int AS n FROM pl GROUP BY pl."by", pl.day`),
    perDay(sql`${base} SELECT pl."by" AS employee_id, pl.day::text AS day, count(DISTINCT pl.task_id)::int AS n
                 FROM pl GROUP BY pl."by", pl.day`),
  ]);
  const byDay = (rows: z.infer<typeof PersonDay>[], id: number) =>
    days.map((day) => rows.find((d) => d.employeeId === id && d.day === day)?.n ?? 0);
  return {
    days,
    persons: persons.map((person) => ({
      ...person,
      daily: byDay(daily, person.employeeId),
      dailyTasks: byDay(spentTasks, person.employeeId),
      dailyComments: byDay(comments, person.employeeId),
      planned: byDay(planned, person.employeeId),
      plannedTasks: byDay(tasks, person.employeeId),
    })),
  };
}
