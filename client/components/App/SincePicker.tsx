import { Chip, Stack, TextField } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { today } from '#client/hooks/format.ts';
import { minusDays } from './RangePicker.tsx';

/** The quick starts the summaries of Tags and Bots offer: the last N days, today included. */
export const LAST_DAYS = [7, 30, 90, 365] as const;

/** The first day of the last `days` days. */
export const lastDays = (days: number) => minusDays(today(), days - 1);

/**
 * The first day of a range that always ends today, so the plans of now
 * belong next to it (Tags and Bots; My team keeps any dates): the last N
 * days in one click, or any day since.
 */
export default function (p: { since: string; onChange: (since: string) => void }) {
  const { t } = useTranslation();
  return (
    <Stack direction="row" sx={{ alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      {LAST_DAYS.map((days) => {
        const on = p.since === lastDays(days);
        return (
          <Chip
            key={days}
            size="small"
            label={t('employee.stats.days', { count: days })}
            color={on ? 'primary' : 'default'}
            variant={on ? 'filled' : 'outlined'}
            onClick={() => p.onChange(lastDays(days))}
          />
        );
      })}
      <TextField
        type="date"
        size="small"
        label={t('employee.stats.since')}
        value={p.since}
        onChange={(e) => e.target.value && e.target.value <= today() && p.onChange(e.target.value)}
        slotProps={{ inputLabel: { shrink: true }, htmlInput: { max: today() } }}
        // Apart from the quick starts, so it does not read as one more of them.
        sx={{ width: 150, ml: 1 }}
      />
    </Stack>
  );
}
