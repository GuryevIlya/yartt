import {
  Button, Dialog, DialogActions, DialogContent, DialogTitle, Paper, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { forecast } from '#shared/tagLimit.ts';
import { useDraft } from '#client/hooks/drafts.ts';
import { parseMinutes, today, useFormat } from '#client/hooks/format.ts';
import { useTaskRefresh } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import TagChip from '../App/TagChip.tsx';
import LogTimeDialog from '../MyDayPage/LogTimeDialog.tsx';
import { LimitFigures } from '../MyDayPage/TagLimits.tsx';

/**
 * My own time on the task, above the observer list (decision 17): all I
 * logged, today's entry — the same one the timesheet shows, set and
 * replaced, never added up (decision 60) — and my plan of time left. Under
 * them, the hour budgets the task falls under (decision 69): seen while
 * planning, and in the plan dialog with the forecast my new plan makes.
 */
export default function (p: { taskId: number }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const format = useFormat();
  const refresh = useTaskRefresh();
  const mine = useQuery(trpc.Time.mine.queryOptions({ taskId: p.taskId }));
  const limits = useQuery(trpc.TagLimit.forTask.queryOptions({ taskId: p.taskId }));
  const [dialog, setDialog] = useState<'log' | 'plan' | null>(null);
  const [text, setText] = useState('');
  // What the plan is for is words typed: kept as a draft until saved or cancelled.
  const [about, setAbout, clearAbout] = useDraft(`plan-about:${p.taskId}`, '');
  const setLeft = useMutation(trpc.Time.setLeft.mutationOptions({ onSuccess: () => { refresh(); clearAbout(); setDialog(null); } }));
  const minutes = parseMinutes(text);
  const ofDay = (day: string) => mine.data?.days.find((d) => d.day === day)?.minutes ?? 0;
  const todayEntry = mine.data?.days.find((d) => d.day === today());

  const openPlan = () => {
    setText(mine.data?.leftMinutes ? format.minutes(mine.data.leftMinutes) : '');
    if (about === '' && mine.data?.leftAbout) setAbout(mine.data.leftAbout);
    setDialog('plan');
  };
  const cancelPlan = () => {
    clearAbout();
    setDialog(null);
  };

  return (
    <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Typography variant="h3" sx={{ fontWeight: 600 }}>{t('task.myTime.title')}</Typography>
      {mine.data && (
        <Stack direction="row" spacing={2} sx={{ color: 'text.secondary', flexWrap: 'wrap' }}>
          <Typography variant="body2">{t('task.myTime.spent', { time: format.minutes(mine.data.spentMinutes) })}</Typography>
          <Tooltip title={todayEntry ? t('myDay.history.entryChanged', { at: format.dateTime(todayEntry.updatedAt) }) : ''}>
            <Typography variant="body2">{t('task.myTime.today', { time: format.minutes(todayEntry?.minutes ?? 0) })}</Typography>
          </Tooltip>
          <Typography variant="body2">
            {mine.data.leftMinutes === null ? t('task.myTime.noPlan') : t('task.myTime.plan', { time: format.minutes(mine.data.leftMinutes) })}
          </Typography>
        </Stack>
      )}
      {mine.data?.leftAbout && (
        <Typography variant="body2" sx={{ color: 'text.secondary', whiteSpace: 'pre-wrap' }}>{t('common.quote', { text: mine.data.leftAbout })}</Typography>
      )}
      <Stack direction="row" spacing={1}>
        <Button variant="outlined" onClick={() => setDialog('log')}>{t('task.myTime.log')}</Button>
        <Button color="inherit" variant="outlined" onClick={openPlan}>{t('task.myTime.setPlan')}</Button>
      </Stack>
      {(limits.data?.length ?? 0) > 0 && (
        <Stack spacing={0.75} sx={{ mt: 0.5 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>{t('tagLimits.inTask')}</Typography>
          {limits.data!.map((limit) => (
            <Stack key={limit.id} spacing={0.25}>
              <Stack direction="row" sx={{ gap: 0.5, flexWrap: 'wrap' }}>
                {limit.tags.map((tag) => <TagChip key={tag.id} size="small" tag={tag} />)}
              </Stack>
              <LimitFigures limit={limit} />
            </Stack>
          ))}
        </Stack>
      )}

      {dialog === 'log' && (
        <LogTimeDialog taskId={p.taskId} day={today()} pickDay current={ofDay} onClose={() => setDialog(null)} />
      )}
      <Dialog open={dialog === 'plan'} onClose={() => setDialog(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('task.myTime.setPlan')}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          <TextField
            autoFocus
            label={t('task.myTime.planMinutes')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            error={text !== '' && minutes === null}
            helperText={minutes !== null ? format.minutes(minutes) : t('task.myTime.timeHint')}
          />
          <TextField
            label={t('task.myTime.planAbout')}
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            multiline
            minRows={2}
            slotProps={{ htmlInput: { maxLength: 1000 } }}
            helperText={t('task.myTime.planAboutHint')}
          />
          {/* Where my hours count: the forecast my new plan makes, before it is saved. */}
          {limits.data?.filter((limit) => limit.includesMe && limit.endsOn >= today()).map((limit) => (
            <Stack key={limit.id} spacing={0.25}>
              <Stack direction="row" sx={{ gap: 0.5, flexWrap: 'wrap' }}>
                {limit.tags.map((tag) => <TagChip key={tag.id} size="small" tag={tag} />)}
              </Stack>
              <LimitFigures limit={limit} forecast={forecast(limit, limit.leftMinutes - (mine.data?.leftMinutes ?? 0) + (minutes ?? 0))} />
            </Stack>
          ))}
        </DialogContent>
        <DialogActions>
          {mine.data?.leftMinutes !== null && (
            <Button color="inherit" onClick={() => setLeft.mutate({ taskId: p.taskId, minutes: null })}>{t('task.myTime.clearPlan')}</Button>
          )}
          <Button onClick={cancelPlan}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            disabled={minutes === null || setLeft.isPending}
            onClick={() => minutes !== null && setLeft.mutate({ taskId: p.taskId, minutes, about })}
          >
            {t('common.save')}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
