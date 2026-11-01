import { Box, Stack, Tooltip, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { Action, Shift, Visit } from '#shared/myDay.ts';
import type { TaskHeader } from '#shared/task.ts';
import { clockOf, midnightOf, useFormat, useZone } from '#client/hooks/format.ts';
import { taskTitle } from '../TaskPage/TaskLine.tsx';

const HOUR = 3_600_000;

/**
 * A day in one line (decision 54): the shifts as bars, every visit as a
 * thin tick — faint inside a shift, marked outside one — and what was done
 * (a comment, time logged) as a dot. When someone was here, when they
 * worked, and whether the two agree, at a glance; a hover tells the time
 * and the task. The span is the working hours, 09–18, widened to whatever
 * happened outside them.
 */
export default function (p: {
  day: string;
  isToday: boolean;
  shifts: Shift[];
  visits: Visit[];
  actions: Action[];
  tasks: Map<number, TaskHeader>;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const zone = useZone();
  const midnight = midnightOf(p.day, zone).getTime();
  const now = Date.now();
  const lastSeen = Math.max(midnight, ...p.visits.map((v) => v.at.getTime()), ...p.actions.map((a) => a.at.getTime()));
  // An open shift runs to now today; on a past day, to the last thing seen.
  const spans = p.shifts.map((s) => {
    const from = s.startedAt.getTime();
    const to = s.spentMinutes !== null ? from + s.spentMinutes * 60_000 : p.isToday ? now : Math.max(lastSeen, from);
    return { from, to, open: s.spentMinutes === null };
  });
  const points = [
    ...spans.flatMap((s) => [s.from, s.to]),
    ...p.visits.map((v) => v.at.getTime()),
    ...p.actions.map((a) => a.at.getTime()),
  ].filter((x) => x >= midnight && x <= midnight + 24 * HOUR);
  const from = Math.max(midnight, Math.floor(Math.min(midnight + 9 * HOUR, ...points) / HOUR) * HOUR);
  const to = Math.min(midnight + 24 * HOUR, Math.ceil(Math.max(midnight + 18 * HOUR, ...points) / HOUR) * HOUR);
  const left = (at: number) => `${(Math.min(Math.max(at, from), to) - from) / (to - from) * 100}%`;
  const width = (a: number, b: number) => `${(Math.min(b, to) - Math.max(a, from)) / (to - from) * 100}%`;
  const inShift = (at: number) => spans.some((s) => at >= s.from && at <= s.to);
  const title = (taskId: number | null) => {
    if (taskId === null) return t('nav.myDay');
    const task = p.tasks.get(taskId);
    return task ? `#${taskId} ${taskTitle(task.tags)}` : `#${taskId}`;
  };
  const hour = (at: number) => String(clockOf(new Date(at), zone).hour).padStart(2, '0');

  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }} aria-label={t('myDay.ribbon.label')}>
      <Typography variant="caption" sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>{hour(from)}</Typography>
      <Box sx={{ position: 'relative', flexGrow: 1, height: 22, bgcolor: 'action.hover', borderRadius: 1 }}>
        {spans.map((s) => (
          <Tooltip
            key={`s${s.from}`}
            title={s.open
              ? t('myDay.ribbon.openShift', { from: format.time(new Date(s.from)) })
              : t('myDay.ribbon.shift', { from: format.time(new Date(s.from)), to: format.time(new Date(s.to)) })}
          >
            <Box
              sx={{
                position: 'absolute', top: 5, height: 12, left: left(s.from), width: width(s.from, s.to),
                bgcolor: 'primary.main', opacity: s.open ? 0.25 : 0.35, borderRadius: 0.5,
              }}
            />
          </Tooltip>
        ))}
        {p.visits.map((v) => {
          const at = v.at.getTime();
          const outside = !inShift(at);
          return (
            <Tooltip key={`v${at}`} title={`${format.time(v.at)} · ${title(v.taskId)}${outside ? ` · ${t('myDay.ribbon.outside')}` : ''}`}>
              <Box
                sx={{
                  position: 'absolute', top: 2, bottom: 2, width: 2, ml: '-1px', left: left(at),
                  bgcolor: outside ? 'warning.main' : 'text.disabled',
                }}
              />
            </Tooltip>
          );
        })}
        {p.actions.map((a) => (
          <Tooltip key={`a${a.kind}${a.at.getTime()}`} title={`${format.time(a.at)} · ${t(`myDay.ribbon.${a.kind}`)} · ${title(a.taskId)}`}>
            {/* What was done is in a task: the dot opens it. */}
            <Box
              component={Link}
              to={`/tasks/${a.taskId}`}
              sx={{
                position: 'absolute', top: 7, width: 8, height: 8, ml: '-4px', left: left(a.at.getTime()), borderRadius: '50%',
                bgcolor: a.kind === 'comment' ? 'primary.dark' : 'success.main', border: 1, borderColor: 'background.paper',
              }}
            />
          </Tooltip>
        ))}
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>{to === midnight + 24 * HOUR ? '24' : hour(to)}</Typography>
    </Stack>
  );
}
