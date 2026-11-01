import { Close, NotificationsActive, NotificationsNone } from '@mui/icons-material';
import {
  Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Menu, MenuItem, Paper, Stack, TextField, Tooltip,
  Typography,
} from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clockOf, fromDay, fromLocalInput, today, toLocalInput, useFormat, zoned } from '#client/hooks/format.ts';
import { useTaskRefresh } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';

/** Today or a later day at 09:00 in the profile's time zone. */
function morning(daysAhead: number): Date {
  const c = clockOf(new Date());
  return zoned(c.year, c.month, c.day + daysAhead, 9, 0);
}

/** The moments a reminder is offered for, a click away: in an hour, tomorrow, on Monday, before the deadline. */
function useQuick(deadline: Date | null): { label: string; at: Date }[] {
  const { t } = useTranslation();
  const nextMonday = morning(((8 - fromDay(today()).getUTCDay()) % 7) || 7);
  const dayBefore = deadline && deadline.getTime() - 86_400_000 > Date.now() + 60_000
    ? new Date(deadline.getTime() - 86_400_000) : null;
  return [
    { label: t('task.remind.inHour'), at: new Date(Date.now() + 3_600_000) },
    { label: t('task.remind.tomorrow'), at: morning(1) },
    { label: t('task.remind.monday'), at: nextMonday },
    ...(dayBefore ? [{ label: t('task.remind.dayBefore'), at: dayBefore }] : []),
  ];
}

/**
 * "Put off": a due reminder moved to a later moment, from the quick ones or
 * any picked — it comes again then and leaves "Waiting for me" till then.
 */
export function PutOff(p: { taskId: number; at: Date; deadline: Date | null }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const refresh = useTaskRefresh();
  const quick = useQuick(p.deadline);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [picking, setPicking] = useState(false);
  const [to, setTo] = useState('');
  const move = useMutation(trpc.Remind.move.mutationOptions({ onSuccess: () => { refresh(); setPicking(false); } }));
  const picked = fromLocalInput(to);
  const put = (at: Date) => { setAnchor(null); move.mutate({ taskId: p.taskId, at: p.at, to: at }); };

  return (
    <>
      <Button size="small" disabled={move.isPending} onClick={(e) => setAnchor(e.currentTarget)}>{t('task.remind.putOff')}</Button>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        {quick.map((q) => <MenuItem key={q.label} onClick={() => put(q.at)}>{q.label}</MenuItem>)}
        <MenuItem onClick={() => { setAnchor(null); setTo(toLocalInput(morning(1))); setPicking(true); }}>{t('task.remind.other')}</MenuItem>
      </Menu>
      <Dialog open={picking} onClose={() => setPicking(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('task.remind.putOff')}</DialogTitle>
        <DialogContent sx={{ pt: '8px !important' }}>
          <TextField
            fullWidth
            type="datetime-local"
            label={t('task.remind.at')}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: toLocalInput(new Date()) } }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPicking(false)}>{t('common.cancel')}</Button>
          <Button variant="contained" disabled={!picked || move.isPending} onClick={() => picked && put(picked)}>{t('common.save')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

/**
 * My reminders on the task. A reminder is not a note: it brings the task
 * back to me from a moment — from then on it is in "Waiting for me" until
 * I mark it done or put it off (decision 73).
 */
export default function (p: { taskId: number; deadline: Date | null }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const format = useFormat();
  const refresh = useTaskRefresh();
  const reminds = useQuery(trpc.Remind.list.queryOptions({ taskId: p.taskId }));
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState('');
  const [text, setText] = useState('');
  const add = useMutation(trpc.Remind.add.mutationOptions({ onSuccess: () => { void reminds.refetch(); refresh(); setOpen(false); } }));
  const remove = useMutation(trpc.Remind.remove.mutationOptions({ onSuccess: () => { void reminds.refetch(); refresh(); } }));
  const quick = useQuick(p.deadline);
  const picked = fromLocalInput(at);

  const start = () => {
    setAt(toLocalInput(morning(1)));
    setText('');
    setOpen(true);
  };

  return (
    <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Stack direction="row" sx={{ alignItems: 'center' }}>
        <Typography variant="h3" sx={{ fontWeight: 600, flexGrow: 1 }}>{t('task.remind.title')}</Typography>
        <Button size="small" startIcon={<NotificationsNone />} onClick={start}>{t('task.remind.add')}</Button>
      </Stack>
      {reminds.data?.length === 0 && (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('task.remind.none')}</Typography>
      )}
      {reminds.data?.map((r) => (
        <Stack key={r.at.getTime()} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          {r.due && <NotificationsActive fontSize="small" color="primary" />}
          <Stack sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="body2">
              {format.dateTime(r.at)} · {r.due ? t('task.remind.due') : format.relative(r.at)}
            </Typography>
            {r.text && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{r.text}</Typography>}
          </Stack>
          {r.due && <PutOff taskId={p.taskId} at={r.at} deadline={p.deadline} />}
          <Tooltip title={t('task.remind.remove')}>
            <IconButton size="small" onClick={() => remove.mutate({ taskId: p.taskId, at: r.at })}><Close fontSize="small" /></IconButton>
          </Tooltip>
        </Stack>
      ))}

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('task.remind.add')}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          <Stack direction="row" sx={{ gap: 0.75, flexWrap: 'wrap' }}>
            {quick.map((q) => (
              <Chip
                key={q.label}
                label={q.label}
                color={at === toLocalInput(q.at) ? 'primary' : 'default'}
                onClick={() => setAt(toLocalInput(q.at))}
              />
            ))}
          </Stack>
          <TextField
            type="datetime-local"
            label={t('task.remind.at')}
            value={at}
            onChange={(e) => setAt(e.target.value)}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: toLocalInput(new Date()) } }}
          />
          <TextField
            autoFocus
            label={t('task.remind.text')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            helperText={t('task.remind.hint')}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            disabled={!picked || add.isPending}
            onClick={() => picked && add.mutate({ taskId: p.taskId, at: picked, text: text.trim() || null })}
          >
            {t('common.save')}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
