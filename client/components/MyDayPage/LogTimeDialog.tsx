import { Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MyTime } from '#shared/observer.ts';
import type { TaskHeader } from '#shared/task.ts';
import { parseMinutes, useFormat } from '#client/hooks/format.ts';
import { useTaskRefresh } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import TaskLine from '../TaskPage/TaskLine.tsx';

const PRESETS = [15, 30, 60, 120];

export type ShiftChoice = MyTime['shifts'][number];

/** How long a shift lasts: closed — its minutes, open — since it began. */
export const lengthOf = (s: Pick<ShiftChoice, 'startedAt' | 'spentMinutes'>) =>
  s.spentMinutes ?? Math.max(0, Math.ceil((Date.now() - s.startedAt.getTime()) / 60_000));

/**
 * My time on a task in a shift — the shift's whole time on it, one entry:
 * what is there is shown and replaced, the usual amounts are one click, 0
 * removes it (decision 60). Time is logged only in a shift and fits in it
 * (decision 100): the dialog says how much is left there. `shifts` — where
 * it may go, `shiftId` — the one picked first; `current` — the time already
 * set for the task in a shift.
 */
export default function (p: {
  taskId: number;
  task?: TaskHeader;
  shifts: ShiftChoice[];
  shiftId?: number;
  current: (shiftId: number) => number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const format = useFormat();
  const refresh = useTaskRefresh();
  const set = useMutation(trpc.Time.set.mutationOptions({ onSuccess: () => { refresh(); p.onClose(); } }));
  const [shiftId, setShiftId] = useState(p.shiftId ?? p.shifts[0]?.id);
  const shift = p.shifts.find((s) => s.id === shiftId);
  const shown = (id: number | undefined) => (id !== undefined && p.current(id) ? format.minutes(p.current(id)) : '');
  const [text, setText] = useState(shown(shiftId));
  const minutes = text.trim() === '' ? null : parseMinutes(text, true);
  const had = shiftId !== undefined && p.current(shiftId) > 0;
  // What the other tasks of the shift leave to this one.
  const left = shift ? lengthOf(shift) - (shift.loggedMinutes - p.current(shift.id)) : 0;
  const save = () => shiftId !== undefined && minutes !== null && set.mutate({ taskId: p.taskId, shiftId, minutes });
  const label = (s: ShiftChoice) => s.spentMinutes === null
    ? t('task.myTime.shiftOpen', { from: format.dateTime(s.startedAt) })
    : t('task.myTime.shiftClosed', {
      from: format.dateTime(s.startedAt), to: format.time(new Date(s.startedAt.getTime() + s.spentMinutes * 60_000)),
      time: format.minutes(s.spentMinutes),
    });

  return (
    <Dialog open onClose={p.onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{t('task.myTime.log')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        {p.task && <TaskLine dense task={p.task} />}
        {p.shifts.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('task.myTime.noShift')}</Typography>
        ) : (
          <>
            <TextField
              select
              label={t('task.myTime.shift')}
              value={shiftId ?? ''}
              onChange={(e) => { const id = Number(e.target.value); setShiftId(id); setText(shown(id)); }}
              helperText={shift && t('task.myTime.shiftLeft', { time: format.minutes(Math.max(0, left)) })}
            >
              {p.shifts.map((s) => <MenuItem key={s.id} value={s.id}>{label(s)}</MenuItem>)}
            </TextField>
            <Stack direction="row" spacing={1}>
              {PRESETS.map((value) => (
                <Chip key={value} label={format.minutes(value)} onClick={() => setText(format.minutes(value))} variant="outlined" />
              ))}
            </Stack>
            <TextField
              autoFocus
              label={t('task.myTime.shiftMinutes')}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
              error={(text.trim() !== '' && minutes === null) || (minutes !== null && minutes > left)}
              helperText={minutes !== null && minutes > 0 ? format.minutes(minutes) : t('task.myTime.shiftHint')}
            />
          </>
        )}
      </DialogContent>
      <DialogActions>
        {had && (
          <Button color="error" sx={{ mr: 'auto' }} disabled={set.isPending} onClick={() => shiftId !== undefined && set.mutate({ taskId: p.taskId, shiftId, minutes: 0 })}>
            {t('task.myTime.remove')}
          </Button>
        )}
        <Button onClick={p.onClose}>{t('common.cancel')}</Button>
        <Button variant="contained" disabled={shiftId === undefined || minutes === null || (minutes === 0 && !had) || set.isPending} onClick={save}>
          {t('common.save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
