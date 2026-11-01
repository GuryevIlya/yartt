import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material';
import type { Shift } from '#shared/myDay.ts';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clockOf, dayOf, useFormat, useZone, zoned } from '#client/hooks/format.ts';
import { useTaskRefresh } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';

/**
 * 'close' — close the open one (its start may be corrected); 'add' — a
 * closed shift at once, to any day not scored; 'edit' — correct a closed
 * shift (`from` finds it). A shift is opened from a visit, without a dialog.
 */
export type ShiftDialogMode = 'close' | 'add' | 'edit';

/**
 * The latest end a shift may have: now rounded up to the minute (the
 * timesheet is kept in minutes), so a shift just started closes as one minute.
 */
export function shiftEnd(): Date {
  return new Date(Math.floor(Date.now() / 60_000) * 60_000 + 60_000);
}

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (value: Date, zone: string) => {
  const c = clockOf(value, zone);
  return `${pad(c.hour)}:${pad(c.minute)}`;
};

/** HH:mm of the day YYYY-MM-DD in a time zone, or of the day after it. */
function moment(day: string, zone: string, value: string, nextDay = false): Date | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [y, m, d] = day.split('-').map(Number);
  return zoned(y!, m!, d! + (nextDay ? 1 : 0), Number(match[1]), Number(match[2]), zone);
}

/**
 * `others` — the shifts already there that this one must not overlap (the
 * day's, and an open one): a conflict is named and saving waits until the
 * times are moved (decision 81).
 */
export default function (p: {
  mode: ShiftDialogMode; from: Date; to: Date; about?: string | null; others?: Pick<Shift, 'startedAt' | 'spentMinutes'>[]; onClose: () => void;
}) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const format = useFormat();
  const refresh = useTaskRefresh();
  const done = { onSuccess: () => { refresh(); p.onClose(); } };
  const close = useMutation(trpc.Work.close.mutationOptions(done));
  const add = useMutation(trpc.Work.add.mutationOptions(done));
  const update = useMutation(trpc.Work.update.mutationOptions(done));

  // Only the times are picked, on the day the shift starts; an end not after the start is
  // the next day's: a shift may run past midnight, and is never longer than a day (decision 100).
  const zone = useZone();
  const day = dayOf(p.from, zone);
  const [from, setFrom] = useState(clock(p.from, zone));
  const [to, setTo] = useState(clock(p.to, zone));
  const [about, setAbout] = useState(p.about ?? '');
  const startedAt = moment(day, zone, from);
  const sameDay = moment(day, zone, to);
  const nextDay = startedAt !== null && sameDay !== null && sameDay <= startedAt && to !== from;
  const endedAt = nextDay ? moment(day, zone, to, true) : sameDay;
  const minutes = startedAt && endedAt ? Math.floor((endedAt.getTime() - startedAt.getTime()) / 60_000) : 0;
  const future = endedAt !== null && endedAt > shiftEnd();
  // The first shift in the way: an open one lasts until now and on.
  const conflict = startedAt && endedAt && minutes > 0 ? (p.others ?? []).find((s) => {
    const end = s.spentMinutes === null ? Infinity : s.startedAt.getTime() + s.spentMinutes * 60_000;
    return s.startedAt.getTime() < endedAt.getTime() && startedAt.getTime() < end;
  }) : undefined;
  const valid = startedAt !== null && minutes > 0 && !future && !conflict;
  const pending = close.isPending || add.isPending || update.isPending;

  const save = () => {
    if (!startedAt || !endedAt) return;
    if (p.mode === 'edit') update.mutate({ startedAt: p.from, newStartedAt: startedAt, endedAt, about: about.trim() || null });
    else (p.mode === 'close' ? close : add).mutate({ startedAt, endedAt, about: about.trim() || null });
  };

  return (
    <Dialog open onClose={p.onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{t(`myDay.shift.${p.mode}Title`)}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        <Typography variant="body2" sx={{ color: 'text.secondary', '&::first-letter': { textTransform: 'uppercase' } }}>
          {format.day(day)}
        </Typography>
        <Stack direction="row" spacing={2}>
          <TextField
            type="time"
            label={t('myDay.shift.from')}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ flex: 1 }}
          />
          <TextField
            type="time"
            label={t('myDay.shift.to')}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            error={!valid}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ flex: 1 }}
          />
        </Stack>
        <Typography variant="caption" sx={{ color: valid ? 'text.secondary' : 'error.main', mt: -1 }}>
          {future ? t('errors.shift_in_future') : minutes > 0 ? format.minutes(minutes) : t('myDay.shift.endAfterStart')}
          {nextDay && ` · ${t('myDay.shift.nextDay')}`}
        </Typography>
        <TextField
          autoFocus
          multiline
          minRows={2}
          label={t('myDay.shift.about')}
          value={about}
          onChange={(e) => setAbout(e.target.value)}
        />
        {conflict && (
          <Alert severity="warning">
            {conflict.spentMinutes === null
              ? t('errors.shift_overlap_open', { from: format.time(conflict.startedAt) })
              : t('errors.shift_overlap_with', {
                from: format.time(conflict.startedAt),
                to: format.time(new Date(conflict.startedAt.getTime() + conflict.spentMinutes * 60_000)),
              })}
          </Alert>
        )}
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('myDay.shift.untilScored')}</Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={p.onClose}>{t('common.cancel')}</Button>
        <Button variant="contained" disabled={!valid || pending} onClick={save}>{t(`myDay.shift.${p.mode === 'edit' ? 'add' : p.mode}`)}</Button>
      </DialogActions>
    </Dialog>
  );
}
