import {
  Box, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Slider, Stack, TextField, Tooltip,
  Typography,
} from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Shift } from '#shared/myDay.ts';
import { useFormat } from '#client/hooks/format.ts';
import { useTaskRefresh } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';

const QUICK = [100, 90, 80, 70, 60, 50, 30, 0];
/** Below this a reason is asked for: a bad score must say what went wrong. */
const REASON_BELOW = 60;

/**
 * The direct manager scores shifts (decision 100): the day's unscored
 * ones at once, each can be left out — or one shift, to correct its score.
 * Every version is mailed to the employee with its time and the previous
 * value, so a score is given with an explicit step, not undone. A standing
 * score can be withdrawn so the employee may correct the shift and the
 * time logged in it; its reason stays and is here again when it is scored
 * anew.
 */
export default function (p: {
  employeeId: number;
  day: string;
  shifts: Shift[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const format = useFormat();
  const refresh = useTaskRefresh();
  // One shift: its score, standing or withdrawn; several: a withdrawn reason, if any, to start from.
  const current = p.shifts.length === 1 ? p.shifts[0]!.score : p.shifts.find((s) => s.score?.reason)?.score ?? null;
  const [value, setValue] = useState<number | null>(current?.value ?? null);
  const [reason, setReason] = useState(current?.reason ?? '');
  const [picked, setPicked] = useState(p.shifts.map((s) => s.id));
  const standing = p.shifts.length === 1 && current?.value != null;
  const unchanged = standing && value === current!.value && reason.trim() === (current!.reason ?? '');
  const span = (s: Shift) => t('employee.score.shift', {
    from: format.time(s.startedAt), to: format.time(new Date(s.startedAt.getTime() + (s.spentMinutes ?? 0) * 60_000)),
    time: format.minutes(s.spentMinutes ?? 0),
  });
  const done = { onSuccess: () => { refresh(); p.onClose(); } };
  const score = useMutation(trpc.Team.score.mutationOptions(done));
  const unscore = useMutation(trpc.Team.unscore.mutationOptions(done));
  const needsReason = value !== null && value < REASON_BELOW && reason.trim() === '';

  return (
    <Dialog open onClose={p.onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{t(standing ? 'employee.score.editTitle' : 'employee.score.title', { day: format.day(p.day) })}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('employee.score.hint')}</Typography>
        {p.shifts.length === 1 ? (
          <Typography variant="body2">{span(p.shifts[0]!)}</Typography>
        ) : (
          <Stack>
            {p.shifts.map((s) => (
              <FormControlLabel
                key={s.id}
                label={span(s)}
                control={<Checkbox checked={picked.includes(s.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, s.id] : picked.filter((id) => id !== s.id))} />}
              />
            ))}
          </Stack>
        )}
        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75 }}>
          {QUICK.map((v) => (
            <Chip key={v} label={`${v}%`} color={value === v ? 'primary' : 'default'} onClick={() => setValue(v)} />
          ))}
        </Stack>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center', px: 1 }}>
          <Slider value={value ?? 0} min={0} max={100} step={5} onChange={(_, v) => setValue(v as number)} />
          <Typography sx={{ minWidth: 48, fontWeight: 600 }}>{value === null ? '—' : `${value}%`}</Typography>
        </Stack>
        <TextField
          multiline
          minRows={2}
          label={t('employee.score.reason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={needsReason}
          helperText={needsReason ? t('employee.score.reasonNeeded') : t(standing ? 'employee.score.mailEdit' : 'employee.score.mail')}
        />
      </DialogContent>
      <DialogActions>
        {standing && (
          <Tooltip title={t('employee.score.withdrawHint')} describeChild>
            <Button
              color="warning"
              disabled={unscore.isPending}
              onClick={() => unscore.mutate({ employeeId: p.employeeId, shiftId: p.shifts[0]!.id })}
            >
              {t('employee.score.withdraw')}
            </Button>
          </Tooltip>
        )}
        <Box sx={{ flexGrow: 1 }} />
        <Button onClick={p.onClose}>{t('common.cancel')}</Button>
        <Button
          variant="contained"
          disabled={value === null || needsReason || unchanged || picked.length === 0 || score.isPending}
          onClick={() => value !== null && score.mutate({ employeeId: p.employeeId, shiftIds: picked, value, reason: reason.trim() || null })}
        >
          {t('employee.score.submit')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
