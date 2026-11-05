import { CloudOff, NotificationsNone, PlayCircleOutline, StopCircleOutlined } from '@mui/icons-material';
import { Badge, Button, Chip, IconButton, Popover, Stack, Tooltip, Typography } from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useFormat } from '#client/hooks/format.ts';
import { openShift, usePending, usePendingTodo } from '#client/hooks/pending.ts';
import PendingList from './PendingList.tsx';
import { POLL_MS, useTaskRefresh } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import { focusTodo } from '#client/hooks/store.ts';
import ShiftDialog, { shiftEnd } from '../MyDayPage/ShiftDialog.tsx';

/**
 * What the top line shows on every page, a task page included: whether
 * there is a connection and how many changes wait to be sent; how much
 * waits for me in TODO (a click brings My day and shows the TODO block, even
 * when My day is already open), and the shift: started now with one click,
 * then its running time — finished from here at the end of the day
 * (decision 54).
 */
export default function () {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const format = useFormat();
  const navigate = useNavigate();
  // The same query as the TODO block: one request, one cache.
  const todo = useQuery(trpc.MyDay.todo.queryOptions(undefined, { refetchInterval: POLL_MS }));
  const shift = useQuery(trpc.Work.open.queryOptions(undefined, { refetchInterval: POLL_MS }));
  const [closing, setClosing] = useState(false);
  const refresh = useTaskRefresh();
  const start = useMutation(trpc.Work.start.mutationOptions({
    onSuccess: refresh,
  }));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Tasks, not items: Waiting for me is tasks, each with its groups (decision 94).
  // What waits to be sent counts as done (decision 114).
  const pending = usePending();
  const items = usePendingTodo(todo.data);
  const count = new Set(items?.map((item) => item.task.id)).size;
  const [listed, setListed] = useState<HTMLElement | null>(null);
  const online = useSyncExternalStore(
    (notify) => {
      window.addEventListener('online', notify);
      window.addEventListener('offline', notify);
      return () => { window.removeEventListener('online', notify); window.removeEventListener('offline', notify); };
    },
    () => navigator.onLine,
  );
  const startedAt = shift.isSuccess ? openShift(shift.data?.startedAt ?? null, pending) : null;
  const startWaits = startedAt !== null && startedAt.getTime() !== shift.data?.startedAt.getTime();

  return (
    <>
      {(!online || pending.length > 0) && (
        <Tooltip title={t('offline.hint')}>
          <Chip
            size="small"
            color="warning"
            variant="outlined"
            icon={<CloudOff />}
            label={pending.length ? t('offline.pending', { count: pending.length }) : t('offline.offline')}
            {...(pending.length > 0 && { onClick: (e: React.MouseEvent<HTMLDivElement>) => setListed(e.currentTarget) })}
          />
        </Tooltip>
      )}
      {listed && pending.length > 0 && (
        <Popover open anchorEl={listed} onClose={() => setListed(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}>
          <Stack spacing={0.5} sx={{ p: 2, maxWidth: 360 }}>
            <Typography variant="subtitle2">{t('offline.listTitle')}</Typography>
            <PendingList pending={pending} />
          </Stack>
        </Popover>
      )}
      {shift.isSuccess && !startedAt && (
        <Tooltip title={t('myDay.shift.start')}>
          <IconButton aria-label={t('myDay.shift.start')} disabled={start.isPending} onClick={() => start.mutate({ startedAt: new Date() })}>
            <PlayCircleOutline />
          </IconButton>
        </Tooltip>
      )}
      {startedAt && (
        <Tooltip title={[t('nav.closeShift', { from: format.time(startedAt) }), startWaits && t('offline.waits')].filter(Boolean).join(' · ')}>
          <Button
            size="small"
            color="inherit"
            variant="outlined"
            startIcon={<StopCircleOutlined />}
            onClick={() => setClosing(true)}
            sx={{ borderColor: 'divider', whiteSpace: 'nowrap' }}
          >
            {t('nav.shift', { time: format.minutes(Math.max(0, Math.floor((now - startedAt.getTime()) / 60_000))) })}
          </Button>
        </Tooltip>
      )}
      <Tooltip title={t('nav.todo', { count })}>
        <IconButton onClick={() => { void navigate('/'); focusTodo(); }} aria-label={t('nav.todo', { count })}>
          <Badge badgeContent={count} color="error" max={99}>
            <NotificationsNone />
          </Badge>
        </IconButton>
      </Tooltip>
      {closing && startedAt && (
        <ShiftDialog mode="close" from={startedAt} to={shiftEnd()} onClose={() => setClosing(false)} />
      )}
    </>
  );
}
