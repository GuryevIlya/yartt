import { EventBusy } from '@mui/icons-material';
import { Button, Chip, IconButton, Popover, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LAST_DAY, typedDay } from '#shared/employee.ts';
import { fromDay, today, useFormat } from '#client/hooks/format.ts';
import { useMe } from '#client/hooks/me.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import { fieldErrors } from '#client/i18n/errors.ts';

/** A day `n` days after `d` (a date from fromDay()), YYYY-MM-DD. */
const plus = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n)).toISOString().slice(0, 10);

/**
 * "I'm away" from the top line: vacation, sick leave, a day off — the day
 * I'm back, in one click. Until then my notifications are copied to my
 * manager (employee.next_day), so it is worth setting, and seeing, from
 * every page; the profile keeps the same field.
 */
export default function () {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const format = useFormat();
  const me = useMe();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const settings = useMutation(trpc.Employee.updateSettings.mutationOptions({
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      setAnchor(null);
    },
  }));
  const errors = fieldErrors(settings.error);
  const away = me.nextDay !== null && me.nextDay > today();
  const now = fromDay(today());
  const set = (nextDay: string | null) => settings.mutate({ nextDay });
  // An absence starts now and ends the day before the return: said in days, so the
  // chips and the field read as the day I'm back, not the day I leave.
  const lastDay = away ? plus(fromDay(me.nextDay!), -1) : null;
  const quick = [
    { label: t('away.tomorrow'), day: plus(now, 1) },
    { label: t('away.monday'), day: plus(now, (8 - now.getUTCDay()) % 7 || 7) },
    { label: t('away.week'), day: plus(now, 7) },
  ];

  return (
    <>
      {away ? (
        <Tooltip title={`${t('away.until', { day: format.dayDate(me.nextDay!) })}. ${t('away.hint')}`} describeChild>
          <Chip
            color="warning"
            size="small"
            icon={<EventBusy />}
            label={t('away.until', { day: format.dayDate(me.nextDay!) })}
            onClick={(e) => setAnchor(e.currentTarget)}
            // At phone width the line is full: the sign alone, the date in the hint.
            sx={{ '& .MuiChip-label': { display: { xs: 'none', sm: 'block' } }, '& .MuiChip-icon': { mx: { xs: 0.5, sm: undefined } } }}
          />
        </Tooltip>
      ) : (
        <Tooltip title={t('away.set')}>
          <IconButton aria-label={t('away.set')} onClick={(e) => setAnchor(e.currentTarget)}>
            <EventBusy />
          </IconButton>
        </Tooltip>
      )}
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Stack spacing={1.5} sx={{ p: 2, width: 300 }}>
          <Typography variant="subtitle2">{t('away.title')}</Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: '0 !important' }}>{t('away.starts')}</Typography>
          <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
            {quick.map((q) => (
              <Chip key={q.label} label={q.label} variant={me.nextDay === q.day ? 'filled' : 'outlined'} onClick={() => set(q.day)} disabled={settings.isPending} />
            ))}
          </Stack>
          <TextField
            size="small"
            type="date"
            label={t('away.other')}
            value={me.nextDay ?? ''}
            // Applied as it changes, so a year typed digit by digit (0002, 0020) is skipped.
            onChange={(e) => typedDay(e.target.value) && set(e.target.value)}
            error={!!errors.nextDay}
            helperText={errors.nextDay ?? t('profile.nextDayHint')}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: plus(now, 1), max: LAST_DAY } }}
          />
          {away && (
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              {lastDay === today()
                ? t('away.spanToday', { day: format.dayDate(me.nextDay!) })
                : t('away.span', { last: format.dayDate(lastDay!), day: format.dayDate(me.nextDay!) })}
            </Typography>
          )}
          {away && (
            <Button variant="outlined" onClick={() => set(null)} disabled={settings.isPending}>{t('away.back')}</Button>
          )}
        </Stack>
      </Popover>
    </>
  );
}
