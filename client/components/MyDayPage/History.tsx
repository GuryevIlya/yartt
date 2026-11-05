import { Box, Button, Divider, Pagination, Paper, Stack, Typography } from '@mui/material';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { dayOf as dayAt, useZone } from '#client/hooks/format.ts';
import { useMe } from '#client/hooks/me.ts';
import { openShift, usePending, withPendingShifts } from '#client/hooks/pending.ts';
import { POLL_MS } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import Day from './Day.tsx';
import DayCard from './DayCard.tsx';

/** My day shows today and the last day before it with activity; the rest is History, the employee page. */
const MY_DAY_DAYS = 2;
const DAYS_PER_PAGE = 14;

/**
 * Days from today back (decision 54): shifts, time logged, the ribbon of
 * visits and what was done, scores. Without `employeeId` — my own days in
 * My day, today and the last one before it, where I start and finish
 * shifts, with "History" leading to all of them; with it — someone's days
 * on their page (mine too), with pages, read-only for others, scored by
 * their direct manager — or, not `onEmployeePage`, their two days as their
 * My day shows them (decision 83). On an employee page (`onEmployeePage`) there is no
 * title — the page says whose days — and the days are cards of one size in
 * a grid, each opening whole in a dialog.
 */
export default function (p: { employeeId?: number; canScore?: boolean; onEmployeePage?: boolean }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const me = useMe();
  const [page, setPage] = useState(1);
  const options = { refetchInterval: POLL_MS, placeholderData: keepPreviousData };
  const mine = useQuery(trpc.MyDay.history.queryOptions(
    p.onEmployeePage ? { page, size: DAYS_PER_PAGE } : { page: 1, size: MY_DAY_DAYS },
    { ...options, enabled: p.employeeId === undefined },
  ));
  const theirs = useQuery(trpc.Team.history.queryOptions(
    p.onEmployeePage ? { employeeId: p.employeeId ?? 0, page, size: DAYS_PER_PAGE } : { employeeId: p.employeeId ?? 0, page: 1, size: MY_DAY_DAYS },
    { ...options, enabled: p.employeeId !== undefined },
  ));
  const history = p.employeeId === undefined ? mine : theirs;
  const data = history.data;
  // My own shifts waiting to be sent show as they will be (decision 114).
  const pending = usePending();
  const zone = useZone();
  const own = p.employeeId === undefined;
  const tasks = new Map((data?.tasks ?? []).map((task) => [task.id, task]));
  const pages = p.onEmployeePage ? Math.ceil((data?.total ?? 0) / DAYS_PER_PAGE) : 1;
  const dayOf = (day: NonNullable<typeof data>['days'][number]) => (
    <Day
      key={day.day}
      day={own ? { ...day, shifts: withPendingShifts(day.shifts, pending, (at) => dayAt(at, zone) === day.day) } : day}
      isToday={day.day === data!.today}
      tasks={tasks}
      openShiftFrom={own ? openShift(data!.openShiftFrom, pending) : data!.openShiftFrom}
      employeeId={p.employeeId}
      canScore={p.canScore ?? false}
    />
  );

  return (
    <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
      {!p.onEmployeePage && (
        <Stack direction="row" sx={{ alignItems: 'center' }}>
          <Typography variant="h3" sx={{ fontWeight: 600, flexGrow: 1 }}>{t('myDay.history.title')}</Typography>
          {/* A report's two days sit on their page, over all of them. */}
          {p.employeeId === undefined && (
            <Button size="small" component={Link} to={`/employees/${me.id}`}>{t('myDay.history.stats')}</Button>
          )}
        </Stack>
      )}
      {p.onEmployeePage ? (
        <Box
          sx={{
            display: 'grid', gap: 1.5, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            opacity: history.isPlaceholderData ? 0.6 : 1,
          }}
        >
          {data?.days.map((day) => (
            <DayCard key={day.day} dialog={dayOf(day)}>{dayOf(day)}</DayCard>
          ))}
        </Box>
      ) : (
        <Stack spacing={2} divider={<Divider />} sx={{ opacity: history.isPlaceholderData ? 0.6 : 1 }}>
          {data?.days.map(dayOf)}
        </Stack>
      )}
      {pages > 1 && (
        <Pagination count={pages} page={page} onChange={(_, value) => setPage(value)} sx={{ alignSelf: 'center' }} />
      )}
    </Paper>
  );
}
