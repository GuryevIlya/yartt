import { AlarmAdd, ChevronRight, DeleteOutline, Edit, ExpandMore, MoreTime, PlayArrow, Stop } from '@mui/icons-material';
import { Box, Button, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DayHistory, Shift } from '#shared/myDay.ts';
import type { TaskHeader } from '#shared/task.ts';
import { dayOf, midnightOf, useFormat, useZone } from '#client/hooks/format.ts';
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
 * shifts, visits and what was done, and its shifts — a shift past midnight
 * in both its days (decision 100) — each with the tasks logged in it, a
 * click to log more, and its score. Tasks opened and not logged are
 * folded; the visits one by one are a click away. Today a shift is started
 * and finished now, from here; a shift is added by hand to any day, and a
 * past day offers the one its activity suggests. A scored shift is frozen.
 * Someone else's day (`employeeId`) is read-only; their direct manager
 * scores its shifts, the day's at once (`canScore`).
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
  const [scoring, setScoring] = useState<Shift[] | null>(null);
  const [logging, setLogging] = useState<{ task: TaskHeader; shiftId: number } | null>(null);
  const [showOpened, setShowOpened] = useState(false);
  const [showVisits, setShowVisits] = useState(false);
  const start = useMutation(trpc.Work.start.mutationOptions({ onSuccess: refresh }));
  const add = useMutation(trpc.Work.add.mutationOptions({ onSuccess: refresh }));
  const removeShift = useMutation(trpc.Work.remove.mutationOptions({ onSuccess: refresh }));
  const setTime = useMutation(trpc.Time.set.mutationOptions({ onSuccess: refresh }));

  const { day } = p;
  const mine = p.employeeId === undefined;
  // A withdrawn score (value NULL) keeps its reason but frees the shift.
  const standing = (s: Shift) => s.score !== null && s.score.value !== null;
  const shifts = [...day.shifts].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const open = shifts.find((s) => s.spentMinutes === null);
  // The manager scores the day's closed shifts not scored yet, at once.
  const unscored = shifts.filter((s) => s.spentMinutes !== null && !standing(s));
  const scorable = p.canScore && p.employeeId !== undefined && unscored.length > 0;
  // Where time can go today: my shifts of the day that are not scored.
  const loggable = mine ? shifts.filter((s) => !standing(s)) : [];
  const choices = loggable.map((s) => ({
    id: s.id, startedAt: s.startedAt, spentMinutes: s.spentMinutes,
    loggedMinutes: day.entries.filter((e) => e.shiftId === s.id).reduce((sum, e) => sum + e.minutes, 0),
  }));

  // Opened and not logged: a hint of time to log, so a task looked up after it closed is not one.
  const opened = [...new Set(day.visits.flatMap((v) => v.taskId === null ? [] : [v.taskId]))]
    .filter((id) => !day.entries.some((e) => e.taskId === id))
    .filter((id) => {
      const deadline = p.tasks.get(id)?.deadline;
      return !deadline || day.visits.some((v) => v.taskId === id && v.at < deadline);
    });
  // The shift a visit falls in, or the day's last one I can log in.
  const shiftFor = (taskId: number) => {
    const at = day.visits.find((v) => v.taskId === taskId)?.at.getTime() ?? 0;
    return loggable.find((s) => at >= s.startedAt.getTime() && (s.spentMinutes === null || at <= s.startedAt.getTime() + s.spentMinutes * 60_000))
      ?? loggable[loggable.length - 1];
  };

  // A past day: what the first and last activity suggest, or the stretch of activity outside its shifts.
  const suggestion = p.isToday ? null
    : day.shifts.length === 0
      ? (day.firstActivity && day.lastActivity && day.lastActivity.getTime() - day.firstActivity.getTime() >= 60_000
        ? { from: day.firstActivity, to: day.lastActivity } : null)
      : gapShift(day.shifts, day.visits.map((v) => v.at));
  const happened = day.shifts.length + day.entries.length + day.visits.length + day.actions.length > 0;
  const task = (id: number) => p.tasks.get(id);
  const minutesSince = (at: Date) => Math.max(0, Math.floor((Date.now() - at.getTime()) / 60_000));
  const closeOpen = (shift: Shift) => setDialog({
    mode: 'close',
    from: shift.startedAt,
    to: p.isToday || !day.lastActivity || day.lastActivity <= shift.startedAt ? shiftEnd() : day.lastActivity,
  });
  // A moment of a shift: the time on this day, the date and time on another.
  const moment = (at: Date) => (dayOf(at, zone) === day.day ? format.time(at) : format.dateTime(at));
  const endOf = (s: Shift) => new Date(s.startedAt.getTime() + (s.spentMinutes ?? 0) * 60_000);

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

  // A task with its entry in a shift: the time, when it was last set on hover. No shift — opened, not logged.
  const taskRow = (taskId: number, shift: Shift | undefined) => {
    const header = task(taskId);
    const entry = shift && day.entries.find((e) => e.taskId === taskId && e.shiftId === shift.id);
    const target = shift ?? shiftFor(taskId);
    const editable = mine && target !== undefined && !standing(target);
    return header && (
      <Stack key={`${taskId}-${shift?.id ?? 'opened'}`} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
        {title(header)}
        <Tooltip title={entry ? t('myDay.history.entryChanged', { at: format.dateTime(entry.updatedAt) }) : ''}>
          <Typography variant="body2" sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
            {format.minutes(entry?.minutes ?? 0)}
          </Typography>
        </Tooltip>
        {editable && (
          <Tooltip title={t('task.myTime.log')}>
            <IconButton size="small" onClick={() => setLogging({ task: header, shiftId: target.id })}><MoreTime fontSize="small" /></IconButton>
          </Tooltip>
        )}
        {editable && entry && (
          <Tooltip title={t('myDay.history.removeEntry')}>
            <IconButton size="small" disabled={setTime.isPending} onClick={() => setTime.mutate({ taskId, shiftId: target.id, minutes: 0 })}>
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
        {scorable && (
          <Button size="small" variant="outlined" onClick={() => setScoring(unscored)}>{t('employee.score.action')}</Button>
        )}
        {/* Today: the shift starts now and finishes now; nothing can follow an open one. */}
        {mine && p.isToday && !p.openShiftFrom && (
          <Button size="small" variant="contained" startIcon={<PlayArrow />} disabled={start.isPending} onClick={() => start.mutate({ startedAt: new Date() })}>
            {t('myDay.shift.start')}
          </Button>
        )}
        {mine && (
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

      {/* The day's totals side by side: worked in closed shifts, and logged in them; a shift past midnight by its share. */}
      {(day.workedMinutes > 0 || day.loggedMinutes > 0) && (
        <Stack direction="row" sx={{ flexWrap: 'wrap', columnGap: 2 }}>
          {day.workedMinutes > 0 && (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('myDay.history.worked', { time: format.minutes(day.workedMinutes) })}</Typography>
          )}
          {day.loggedMinutes > 0 && (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('myDay.history.logged', { time: format.minutes(day.loggedMinutes) })}</Typography>
          )}
        </Stack>
      )}

      {(happened || p.isToday) && (
        <DayRibbon day={day.day} isToday={p.isToday} shifts={shifts} visits={day.visits} actions={day.actions} tasks={p.tasks} />
      )}

      {shifts.map((shift) => {
        const frozen = standing(shift);
        const entries = day.entries.filter((e) => e.shiftId === shift.id);
        return (
          <Stack key={shift.id} spacing={0.5}>
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-start' }}>
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography variant="body2">
                  {shift.spentMinutes === null
                    ? t(mine ? 'myDay.shift.open' : 'myDay.shift.openOther', { from: moment(shift.startedAt), time: format.minutes(minutesSince(shift.startedAt)) })
                    : t('myDay.shift.closed', { from: moment(shift.startedAt), to: moment(endOf(shift)), time: format.minutes(shift.spentMinutes) })}
                </Typography>
                {shift.about && (
                  <Typography variant="body2" sx={{ color: 'text.secondary', whiteSpace: 'pre-wrap' }}>{shift.about}</Typography>
                )}
                {shift.score && !frozen && (
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    {t(mine ? 'myDay.history.withdrawnMine' : 'myDay.history.withdrawn')}
                  </Typography>
                )}
              </Box>
              {shift.score && frozen && (
                <Tooltip title={[shift.score.reason, p.canScore && t('employee.score.edit')].filter(Boolean).join(' · ')} describeChild>
                  <Chip
                    size="small"
                    color="primary"
                    variant="outlined"
                    label={t('myDay.history.score', { value: shift.score.value })}
                    {...(p.canScore && p.employeeId !== undefined && { onClick: () => setScoring([shift]) })}
                  />
                </Tooltip>
              )}
              {mine && shift === open && (
                <Button size="small" variant="contained" startIcon={<Stop />} sx={{ flexShrink: 0 }} onClick={() => closeOpen(shift)}>
                  {t('myDay.shift.close')}
                </Button>
              )}
              {mine && !frozen && shift.spentMinutes !== null && (
                <Tooltip title={t('myDay.shift.edit')}>
                  <IconButton size="small" onClick={() => setDialog({ mode: 'edit', from: shift.startedAt, to: endOf(shift), about: shift.about })}>
                    <Edit fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
              {mine && !frozen && (
                <Tooltip title={t(shift === open ? 'myDay.shift.remove' : 'myDay.shift.delete')}>
                  <IconButton size="small" disabled={removeShift.isPending} onClick={() => {
                    const asked = shift.spentMinutes === null
                      ? t('myDay.shift.removeConfirm', { from: moment(shift.startedAt) })
                      : t('myDay.shift.deleteConfirm', { from: moment(shift.startedAt), to: moment(endOf(shift)) });
                    if (window.confirm(asked)) removeShift.mutate({ startedAt: shift.startedAt });
                  }}>
                    <DeleteOutline fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
            </Stack>
            {entries.length > 0 && (
              <Stack spacing={0.5} sx={{ pl: 1.5, borderLeft: 2, borderColor: 'divider' }}>
                {[...new Set(entries.map((e) => e.taskId))].map((taskId) => taskRow(taskId, shift))}
              </Stack>
            )}
          </Stack>
        );
      })}

      {mine && suggestion && (
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

      {/* Opened and not logged: folded, a reminder to log it — in a shift: without one the time has nowhere to go. */}
      {opened.length > 0 && (
        <Box>
          <Button size="small" color="inherit" sx={{ color: 'text.secondary' }} startIcon={showOpened ? <ExpandMore /> : <ChevronRight />}
            aria-expanded={showOpened} onClick={() => setShowOpened((v) => !v)}>
            {t('myDay.history.opened', { count: opened.length })}
          </Button>
          {showOpened && (
            <Stack spacing={0.5}>
              {mine && loggable.length === 0 && (
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('myDay.history.noShiftToLog')}</Typography>
              )}
              {opened.map((id) => taskRow(id, undefined))}
            </Stack>
          )}
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
              ? [{ startedAt: p.openShiftFrom, spentMinutes: null }] : []),
          ]}
          onClose={() => setDialog(null)}
        />
      )}
      {logging && (
        <LogTimeDialog
          taskId={logging.task.id}
          task={logging.task}
          shifts={choices}
          shiftId={logging.shiftId}
          current={(shiftId) => day.entries.find((e) => e.taskId === logging.task.id && e.shiftId === shiftId)?.minutes ?? 0}
          onClose={() => setLogging(null)}
        />
      )}
      {scoring && p.employeeId !== undefined && (
        <ScoreDialog employeeId={p.employeeId} day={day.day} shifts={scoring} onClose={() => setScoring(null)} />
      )}
    </Stack>
  );
}
