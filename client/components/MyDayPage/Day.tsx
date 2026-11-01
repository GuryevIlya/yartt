import { AlarmAdd, ChevronRight, DeleteOutline, Edit, ExpandMore, MoreTime, PlayArrow, Stop } from '@mui/icons-material';
import { Alert, Box, Button, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DayHistory } from '#shared/myDay.ts';
import type { TaskHeader } from '#shared/task.ts';
import { midnightOf, useFormat, useZone } from '#client/hooks/format.ts';
import { useTaskRefresh } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import ScoreDialog from '../EmployeePage/ScoreDialog.tsx';
import { Link } from 'react-router';
import LogTimeDialog from './LogTimeDialog.tsx';
import TaskHint from '../App/TaskHint.tsx';
import { taskTitle } from '../TaskPage/TaskLine.tsx';
import DayRibbon from './DayRibbon.tsx';
import ShiftDialog, { shiftEnd, type ShiftDialogMode } from './ShiftDialog.tsx';

type Dialog = { mode: ShiftDialogMode; from: Date; to: Date; about?: string | null };

/**
 * Where a new shift of a day is put in the dialog: the first free hour of
 * that day from 09:00 (then the small hours), every half hour, inside the
 * day and not past now — never into the next day or into another shift.
 */
function defaultShift(day: string, zone: string, shifts: { startedAt: Date; spentMinutes: number | null }[]): { from: Date; to: Date } {
  const HOUR = 3_600_000;
  const busy = shifts.map((s) => [s.startedAt.getTime(), s.startedAt.getTime() + (s.spentMinutes ?? 24 * 60) * 60_000] as const);
  const midnight = midnightOf(day, zone).getTime();
  const dayEnd = Math.min(midnight + 24 * HOUR, Date.now());
  // From 09:00 to the day's end, then the small hours.
  const starts = Array.from({ length: 48 }, (_, i) => midnight + ((i + 18) % 48) * (HOUR / 2));
  for (const from of starts) {
    if (from + HOUR <= dayEnd && busy.every(([a, b]) => from + HOUR <= a || from >= b)) {
      return { from: new Date(from), to: new Date(from + HOUR) };
    }
  }
  // No free hour: the person corrects the times themselves.
  return { from: new Date(midnight), to: new Date(midnight + HOUR) };
}

/** Visits outside the shifts that span at least this long look like a forgotten shift. */
const GAP_SHIFT_MS = 30 * 60_000;

/**
 * A past day with shifts and activity outside them — before the first,
 * between two, after the last: the longest such stretch of visits (30
 * minutes or more) is offered as the shift that was not written down.
 * Never with an open shift: that day is not over.
 */
function gapShift(shifts: { startedAt: Date; spentMinutes: number | null }[], visits: Date[]): { from: Date; to: Date } | null {
  if (shifts.some((s) => s.spentMinutes === null)) return null;
  const spans = shifts.map((s) => [s.startedAt.getTime(), s.startedAt.getTime() + s.spentMinutes! * 60_000] as const)
    .sort((a, b) => a[0] - b[0]);
  const gaps = new Map<number, number[]>();
  for (const at of visits.map((v) => v.getTime())) {
    if (spans.some(([a, b]) => at >= a && at <= b)) continue;
    const gap = spans.filter(([, b]) => b < at).length; // how many shifts ended before it
    gaps.set(gap, [...(gaps.get(gap) ?? []), at]);
  }
  let best: { from: Date; to: Date } | null = null;
  for (const times of gaps.values()) {
    const from = Math.min(...times);
    const to = Math.max(...times);
    if (to - from >= GAP_SHIFT_MS && (!best || to - from > best.to.getTime() - best.from.getTime())) {
      best = { from: new Date(from), to: new Date(to) };
    }
  }
  return best;
}

/**
 * One day of History (decision 54), compact: its totals, the ribbon of
 * shifts, visits and what was done, its shifts, and every task once — the
 * time logged to it that day, a click to log more. Tasks opened and not
 * logged are folded; the visits one by one are a click away. Today a
 * shift is started and finished now, from here; any day not scored gets a
 * shift by hand, and a past day offers the one its activity suggests.
 * Someone else's day (`employeeId`) is read-only; their direct manager
 * scores it (`canScore`).
 */
export default function (p: {
  day: DayHistory;
  isToday: boolean;
  tasks: Map<number, TaskHeader>;
  openShiftFrom: Date | null;
  employeeId?: number;
  canScore: boolean;
}) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const format = useFormat();
  const zone = useZone();
  const refresh = useTaskRefresh();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [scoring, setScoring] = useState(false);
  const [logging, setLogging] = useState<TaskHeader | null>(null);
  const [showOpened, setShowOpened] = useState(false);
  const [showVisits, setShowVisits] = useState(false);
  const start = useMutation(trpc.Work.start.mutationOptions({ onSuccess: refresh }));
  const add = useMutation(trpc.Work.add.mutationOptions({ onSuccess: refresh }));
  const removeShift = useMutation(trpc.Work.remove.mutationOptions({ onSuccess: refresh }));
  const setTime = useMutation(trpc.Time.set.mutationOptions({ onSuccess: refresh }));

  const { day } = p;
  const mine = p.employeeId === undefined;
  // A withdrawn score (value NULL) keeps its reason but frees the day.
  const scored = day.score !== null && day.score.value !== null;
  const editable = mine && !scored;
  // The database requires a past day with closed shifts and no open one.
  const scorable = p.canScore && !scored && !p.isToday
    && day.shifts.some((s) => s.spentMinutes !== null) && !day.shifts.some((s) => s.spentMinutes === null);
  const shifts = [...day.shifts].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const open = shifts.find((s) => s.spentMinutes === null);
  const closedMinutes = shifts.reduce((sum, s) => sum + (s.spentMinutes ?? 0), 0);
  const loggedMinutes = day.entries.reduce((sum, e) => sum + e.minutes, 0);

  // Every task once: the time logged to it that day, in the order it was first logged.
  const logged = [...new Set(day.entries.map((e) => e.taskId))].map((taskId) => {
    const entries = day.entries.filter((e) => e.taskId === taskId);
    return { taskId, entries, minutes: entries.reduce((sum, e) => sum + e.minutes, 0) };
  });
  // Opened and not logged: a hint of time to log, so a task looked up after it closed is not one.
  const opened = [...new Set(day.visits.flatMap((v) => v.taskId === null ? [] : [v.taskId]))]
    .filter((id) => !day.entries.some((e) => e.taskId === id))
    .filter((id) => {
      const deadline = p.tasks.get(id)?.deadline;
      return !deadline || day.visits.some((v) => v.taskId === id && v.at < deadline);
    });

  // A past day: what the first and last activity suggest, or the stretch of activity outside its shifts.
  const suggestion = p.isToday ? null
    : day.shifts.length === 0
      ? (day.firstActivity && day.lastActivity && day.lastActivity.getTime() - day.firstActivity.getTime() >= 60_000
        ? { from: day.firstActivity, to: day.lastActivity } : null)
      : gapShift(day.shifts, day.visits.map((v) => v.at));
  const happened = day.shifts.length + day.entries.length + day.visits.length + day.actions.length > 0;
  const task = (id: number) => p.tasks.get(id);
  const minutesSince = (at: Date) => Math.max(0, Math.floor((Date.now() - at.getTime()) / 60_000));
  const closeOpen = (shift: (typeof shifts)[number]) => setDialog({
    mode: 'close',
    from: shift.startedAt,
    to: p.isToday || !day.lastActivity || day.lastActivity <= shift.startedAt ? shiftEnd() : day.lastActivity,
  });

  // A task as its whole title in text, a link to it; hovered, its context and everyone's time.
  const title = (header: TaskHeader) => (
    <TaskHint taskId={header.id}>
      <Typography
        variant="body2"
        component={Link}
        to={`/tasks/${header.id}`}
        sx={{
          flexGrow: 1, minWidth: 0, color: 'text.primary', textDecoration: 'none', overflowWrap: 'anywhere',
          '&:hover': { textDecoration: 'underline' },
          ...(header.closed && { color: 'text.secondary' }),
        }}
      >
        <Box component="span" sx={{ fontFamily: 'monospace', color: 'primary.main', mr: 0.75 }}>#{header.id}</Box>
        {taskTitle(header.tags)}
      </Typography>
    </TaskHint>
  );

  // A task of the day with its one entry: the time, when it was last set on hover.
  const taskRow = (taskId: number) => {
    const header = task(taskId);
    const entry = day.entries.find((e) => e.taskId === taskId);
    return header && (
      <Stack key={taskId} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
        {title(header)}
        <Tooltip title={entry ? t('myDay.history.entryChanged', { at: format.dateTime(entry.updatedAt) }) : ''}>
          <Typography variant="body2" sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
            {format.minutes(entry?.minutes ?? 0)}
          </Typography>
        </Tooltip>
        {editable && (
          <Tooltip title={t('task.myTime.log')}>
            <IconButton size="small" onClick={() => setLogging(header)}><MoreTime fontSize="small" /></IconButton>
          </Tooltip>
        )}
        {editable && entry && (
          <Tooltip title={t('myDay.history.removeEntry')}>
            <IconButton size="small" disabled={setTime.isPending} onClick={() => setTime.mutate({ taskId, day: day.day, minutes: 0 })}>
              <DeleteOutline fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
    );
  };

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
        <Typography sx={{ fontWeight: 600, flexGrow: 1, '&::first-letter': { textTransform: 'uppercase' } }}>
          {p.isToday ? t('myDay.history.today') : format.day(day.day)}
        </Typography>
        {scorable && p.employeeId !== undefined && (
          <Button size="small" variant="outlined" onClick={() => setScoring(true)}>{t('employee.score.action')}</Button>
        )}
        {day.score && scored && (
          <Tooltip title={[day.score.reason, p.canScore && t('employee.score.edit')].filter(Boolean).join(' · ')} describeChild>
            <Chip
              size="small"
              color="primary"
              variant="outlined"
              label={t('myDay.history.score', { value: day.score.value })}
              {...(p.canScore && p.employeeId !== undefined && { onClick: () => setScoring(true) })}
            />
          </Tooltip>
        )}
        {/* Today: the shift starts now and finishes now; nothing can follow an open one. */}
        {mine && p.isToday && !p.openShiftFrom && (
          <Button size="small" variant="contained" startIcon={<PlayArrow />} disabled={start.isPending} onClick={() => start.mutate({ startedAt: new Date() })}>
            {t('myDay.shift.start')}
          </Button>
        )}
        {editable && (
          <Tooltip title={t('myDay.shift.addHint')} describeChild>
            <IconButton
              size="small"
              aria-label={t('myDay.shift.addTitle')}
              onClick={() => setDialog({ mode: 'add', ...(suggestion ?? defaultShift(day.day, zone, day.shifts)) })}
            >
              <AlarmAdd fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      {day.score && !scored && (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t(mine ? 'myDay.history.withdrawnMine' : 'myDay.history.withdrawn')}
        </Typography>
      )}

      {/* The day's totals side by side: worked in closed shifts, and logged to tasks. */}
      {(closedMinutes > 0 || loggedMinutes > 0) && (
        <Stack direction="row" sx={{ flexWrap: 'wrap', columnGap: 2 }}>
          {closedMinutes > 0 && (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('myDay.history.worked', { time: format.minutes(closedMinutes) })}</Typography>
          )}
          {loggedMinutes > 0 && (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('myDay.history.logged', { time: format.minutes(loggedMinutes) })}</Typography>
          )}
        </Stack>
      )}
      {closedMinutes > 0 && loggedMinutes > closedMinutes && (
        <Alert severity="warning" sx={{ py: 0 }}>
          {t('myDay.history.overLogged', { logged: format.minutes(loggedMinutes), worked: format.minutes(closedMinutes) })}
        </Alert>
      )}

      {(happened || p.isToday) && (
        <DayRibbon day={day.day} isToday={p.isToday} shifts={shifts} visits={day.visits} actions={day.actions} tasks={p.tasks} />
      )}

      {shifts.map((shift) => (
        <Stack key={shift.startedAt.getTime()} direction="row" spacing={0.5} sx={{ alignItems: 'flex-start' }}>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="body2">
              {shift.spentMinutes === null
                ? t(mine ? 'myDay.shift.open' : 'myDay.shift.openOther', { from: format.time(shift.startedAt), time: format.minutes(minutesSince(shift.startedAt)) })
                : t('myDay.shift.closed', {
                    from: format.time(shift.startedAt),
                    to: format.time(new Date(shift.startedAt.getTime() + shift.spentMinutes * 60_000)),
                    time: format.minutes(shift.spentMinutes),
                  })}
            </Typography>
            {shift.about && (
              <Typography variant="body2" sx={{ color: 'text.secondary', whiteSpace: 'pre-wrap' }}>{shift.about}</Typography>
            )}
          </Box>
          {mine && shift === open && (
            <Button size="small" variant="contained" startIcon={<Stop />} sx={{ flexShrink: 0 }} onClick={() => closeOpen(shift)}>
              {t('myDay.shift.close')}
            </Button>
          )}
          {editable && shift.spentMinutes !== null && (
            <Tooltip title={t('myDay.shift.edit')}>
              <IconButton size="small" onClick={() => setDialog({
                mode: 'edit',
                from: shift.startedAt,
                to: new Date(shift.startedAt.getTime() + shift.spentMinutes! * 60_000),
                about: shift.about,
              })}>
                <Edit fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          {editable && (
            <Tooltip title={t(shift === open ? 'myDay.shift.remove' : 'myDay.shift.delete')}>
              <IconButton size="small" disabled={removeShift.isPending} onClick={() => {
                const asked = shift.spentMinutes === null
                  ? t('myDay.shift.removeConfirm', { from: format.time(shift.startedAt) })
                  : t('myDay.shift.deleteConfirm', {
                      from: format.time(shift.startedAt),
                      to: format.time(new Date(shift.startedAt.getTime() + shift.spentMinutes * 60_000)),
                    });
                if (window.confirm(asked)) removeShift.mutate({ startedAt: shift.startedAt });
              }}>
                <DeleteOutline fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Stack>
      ))}

      {mine && suggestion && !scored && (
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ color: 'text.secondary', flexGrow: 1 }}>
            {t('myDay.shift.suggested', { from: format.time(suggestion.from), to: format.time(suggestion.to) })}
          </Typography>
          <Button
            size="small"
            variant="outlined"
            disabled={add.isPending}
            onClick={() => add.mutate({ startedAt: suggestion.from, endedAt: suggestion.to, about: null })}
          >
            {t('myDay.shift.confirm')}
          </Button>
          <Tooltip title={t('myDay.shift.otherTime')}>
            <IconButton size="small" onClick={() => setDialog({ mode: 'add', ...suggestion })}>
              <Edit fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      )}

      {logged.length > 0 && (
        <Stack spacing={0.5}>{logged.map((l) => taskRow(l.taskId))}</Stack>
      )}

      {/* Opened and not logged: folded, a reminder to log it. */}
      {opened.length > 0 && (
        <Box>
          <Button size="small" color="inherit" sx={{ color: 'text.secondary' }} startIcon={showOpened ? <ExpandMore /> : <ChevronRight />}
            aria-expanded={showOpened} onClick={() => setShowOpened((v) => !v)}>
            {t('myDay.history.opened', { count: opened.length })}
          </Button>
          {showOpened && <Stack spacing={0.5}>{opened.map((id) => taskRow(id))}</Stack>}
        </Box>
      )}

      {/* The visits one by one, for whoever wants the detail behind the ribbon. */}
      {day.visits.length > 0 && (
        <Box>
          <Button size="small" color="inherit" sx={{ color: 'text.secondary' }} startIcon={showVisits ? <ExpandMore /> : <ChevronRight />}
            aria-expanded={showVisits} onClick={() => setShowVisits((v) => !v)}>
            {t('myDay.history.visits', { count: day.visits.length })}
          </Button>
          {showVisits && (
            <Stack spacing={0.5} sx={{ pl: 1, borderLeft: 2, borderColor: 'divider' }}>
              {day.visits.map((visit) => {
                const header = visit.taskId === null ? undefined : task(visit.taskId);
                return (
                  <Stack key={visit.at.getTime()} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', width: 44, flexShrink: 0 }}>{format.time(visit.at)}</Typography>
                    {header ? title(header) : (
                      <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('nav.myDay')}</Typography>
                    )}
                  </Stack>
                );
              })}
            </Stack>
          )}
        </Box>
      )}

      {!happened && !(mine && p.isToday) && (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('myDay.history.quiet')}</Typography>
      )}

      {dialog && (
        <ShiftDialog
          {...dialog}
          // Not the shift being closed or corrected; an open one from another day is in the way too.
          others={[
            ...day.shifts.filter((s) => dialog.mode === 'add' || s.startedAt.getTime() !== dialog.from.getTime()),
            ...(p.openShiftFrom && !day.shifts.some((s) => s.startedAt.getTime() === p.openShiftFrom!.getTime())
              && dialog.from.getTime() !== p.openShiftFrom.getTime()
              ? [{ startedAt: p.openShiftFrom, spentMinutes: null, about: null }] : []),
          ]}
          onClose={() => setDialog(null)}
        />
      )}
      {logging && (
        <LogTimeDialog
          taskId={logging.id}
          task={logging}
          day={day.day}
          current={() => day.entries.find((e) => e.taskId === logging.id)?.minutes ?? 0}
          onClose={() => setLogging(null)}
        />
      )}
      {scoring && p.employeeId !== undefined && (
        <ScoreDialog employeeId={p.employeeId} day={day.day} current={day.score} onClose={() => setScoring(false)} />
      )}
    </Stack>
  );
}
