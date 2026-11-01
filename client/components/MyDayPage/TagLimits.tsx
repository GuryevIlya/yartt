import { Add, ChevronRight, Close, Edit, ExpandMore, History } from '@mui/icons-material';
import {
  Box, Button, Collapse, IconButton, LinearProgress, Paper, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TagPart } from '#shared/tags.ts';
import type { TagLimit, TagLimitVersion } from '#shared/tagLimit.ts';
import type { Tag } from '#shared/task.ts';
import { fromDay, today, useFormat } from '#client/hooks/format.ts';
import { useDraft } from '#client/hooks/drafts.ts';
import { useMe } from '#client/hooks/me.ts';
import { POLL_MS, useEmployees, useTaskRefresh } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import { useViewAs } from '#client/hooks/viewAs.ts';
import HelpTip from '../App/HelpTip.tsx';
import TagChip from '../App/TagChip.tsx';
import TagInput from '../App/TagInput.tsx';
import { minusDays } from '../App/RangePicker.tsx';
import TeamChart from './TeamChart.tsx';

/** How a limit stands: over — spent past it; risk — the forecast is past it. */
export const standing = (l: { minutes: number; spentMinutes: number; forecastMinutes: number }) =>
  l.spentMinutes > l.minutes ? 'over' : l.forecastMinutes > l.minutes ? 'risk' : 'ok';

const COLOR = { over: 'error.main', risk: 'warning.dark', ok: 'text.secondary' } as const;

/** "70h of 100h · 70% · forecast 89h (−11% vs the budget)" — the figures of a limit in one line, coloured by how it stands. */
export function LimitFigures(p: { limit: TagLimit; forecast?: number }) {
  const { t } = useTranslation();
  const format = useFormat();
  const l = p.limit;
  const forecast = p.forecast ?? l.forecastMinutes;
  const state = standing({ ...l, forecastMinutes: forecast });
  const delta = Math.round(((forecast - l.minutes) / l.minutes) * 100);
  return (
    <Typography variant="body2" sx={{ color: COLOR[state], fontWeight: state === 'ok' ? undefined : 600 }}>
      {t('tagLimits.figures', {
        spent: format.minutes(l.spentMinutes),
        limit: format.minutes(l.minutes),
        percent: Math.round((l.spentMinutes / l.minutes) * 100),
        forecast: format.minutes(forecast),
        delta: delta > 0 ? `+${delta}%` : delta < 0 ? `−${-delta}%` : '0%',
      })}
    </Typography>
  );
}

type Draft = { replaces: number | null; tags: Tag[]; input: string; startsOn: string; endsOn: string; hours: string };

/**
 * Limits of hours on tag combinations (decision 69): anyone sets them for
 * a fixed period, for themselves and everyone under them; they are seen
 * by who set them, their managers and their people. A line: the tags, the
 * period, spent of the limit, the forecast — spent and of the plans what
 * fits in the time left at the pace of the last 28 days (decision 91) —
 * and, unfolded, the spending day by day against the limit and every
 * version. A change is a new version, the old one kept; nothing is
 * forbidden and nothing is sent: it is a line to keep to.
 */
export default function (p: { fold?: ReactNode }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const me = useMe();
  const { as, readOnly } = useViewAs();
  const limits = useQuery(trpc.TagLimit.list.queryOptions({ as }, { refetchInterval: POLL_MS, placeholderData: keepPreviousData }));
  const [draft, setDraft, clearDraft] = useDraft<Draft | null>('tag-limit', null);
  const [showRemoved, setShowRemoved] = useState(false);
  const set = useMutation(trpc.TagLimit.set.mutationOptions({ onSuccess: () => { clearDraft(); void limits.refetch(); } }));
  const current = limits.data?.current ?? [];
  const removed = limits.data?.removed ?? [];

  const start = (limit?: TagLimit) => setDraft(limit
    ? {
        replaces: limit.id, tags: limit.tags, input: '', startsOn: limit.startsOn, endsOn: limit.endsOn,
        hours: String(Math.round((limit.minutes / 60) * 10) / 10),
      }
    : { replaces: null, tags: [], input: '', startsOn: today(), endsOn: minusDays(today(), -182), hours: '' });
  const hours = draft ? Number(draft.hours.replace(',', '.')) : NaN;
  const valid = !!draft && draft.tags.length > 0 && draft.startsOn !== '' && draft.endsOn >= draft.startsOn
    && Number.isFinite(hours) && hours > 0;
  const save = () => valid && set.mutate({
    replaces: draft!.replaces, tagIds: draft!.tags.map((tag) => tag.id), startsOn: draft!.startsOn, endsOn: draft!.endsOn,
    minutes: Math.round(hours * 60),
  });

  return (
    <Paper component="section" aria-label={t('tagLimits.title')} sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexGrow: 1 }}>
          <Typography variant="h3" sx={{ fontWeight: 600 }}>{t('tagLimits.title')}</Typography>
          <HelpTip title={t('tagLimits.hint')} />
        </Stack>
        {!draft && !readOnly && <Button size="small" startIcon={<Add />} onClick={() => start()}>{t('tagLimits.create')}</Button>}
        {p.fold}
      </Stack>

      {draft && (
        <Stack spacing={1.5} sx={{ p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1 }}>
          <TagInput
            value={draft.tags.map((tag) => ({ tag }))}
            onChange={(next: TagPart[]) => setDraft((prev) => prev && { ...prev, tags: next.flatMap((part) => ('tag' in part ? [part.tag] : [])) })}
            input={draft.input}
            onInputChange={(input) => setDraft((prev) => prev && { ...prev, input })}
            label={t('tagLimits.tags')}
            helperText={t('tagLimits.tagsHint')}
            autoFocus
          />
          <Stack direction="row" sx={{ gap: 1.5, flexWrap: 'wrap' }}>
            <TextField
              type="date" size="small" label={t('tagLimits.startsOn')} value={draft.startsOn}
              onChange={(e) => setDraft({ ...draft, startsOn: e.target.value })}
              slotProps={{ inputLabel: { shrink: true } }} sx={{ width: 170 }}
            />
            <TextField
              type="date" size="small" label={t('tagLimits.endsOn')} value={draft.endsOn}
              onChange={(e) => setDraft({ ...draft, endsOn: e.target.value })} error={draft.endsOn < draft.startsOn}
              slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: draft.startsOn } }} sx={{ width: 170 }}
            />
            <TextField
              size="small" label={t('tagLimits.hours')} value={draft.hours}
              onChange={(e) => setDraft({ ...draft, hours: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
              error={draft.hours !== '' && !(hours > 0)} sx={{ width: 140 }}
            />
          </Stack>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {draft.replaces === null ? t('tagLimits.newHelp') : t('tagLimits.changeHelp')}
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button variant="contained" disabled={!valid || set.isPending} onClick={save}>{t('common.save')}</Button>
            <Button color="inherit" onClick={clearDraft}>{t('common.cancel')}</Button>
          </Stack>
        </Stack>
      )}

      {limits.isSuccess && current.length === 0 && !draft && (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('tagLimits.empty')}</Typography>
      )}
      {current.map((limit) => <Line key={limit.id} limit={limit} mine={limit.employeeId === (as ?? me.id)} onEdit={readOnly ? undefined : () => start(limit)} />)}

      {removed.length > 0 && (
        <Box>
          <Button size="small" color="inherit" startIcon={showRemoved ? <ExpandMore /> : <ChevronRight />} onClick={() => setShowRemoved((v) => !v)}>
            {t('tagLimits.removed', { count: removed.length })}
          </Button>
          <Collapse in={showRemoved} unmountOnExit>
            <Stack spacing={0.5} sx={{ pl: 1 }}>{removed.map((v) => <Version key={v.id} version={v} />)}</Stack>
          </Collapse>
        </Box>
      )}
    </Paper>
  );
}

/** `onEdit` left out — read-only, on a report's page. */
function Line(p: { limit: TagLimit; mine: boolean; onEdit?: () => void }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const format = useFormat();
  const theme = useTheme();
  const palette = (theme.vars ?? theme).palette;
  const employees = useEmployees();
  const [open, setOpen] = useState(false);
  const refresh = useTaskRefresh();
  const remove = useMutation(trpc.TagLimit.remove.mutationOptions({ onSuccess: refresh }));
  const { as } = useViewAs();
  const history = useQuery(trpc.TagLimit.history.queryOptions({ id: p.limit.id, as }, { enabled: open && p.limit.changed }));
  const l = p.limit;
  const state = standing(l);

  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
      <Stack
        direction="row"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        sx={{ alignItems: 'center', gap: 1, px: 1, py: 0.75, cursor: 'pointer', flexWrap: 'wrap', '&:hover': { bgcolor: 'action.hover' } }}
      >
        <IconButton size="small" aria-label={t(open ? 'tagLimits.fold' : 'tagLimits.unfold')}>
          {open ? <ExpandMore fontSize="small" /> : <ChevronRight fontSize="small" />}
        </IconButton>
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', flex: '1 1 200px', minWidth: 0 }}>
          {l.tags.map((tag) => <TagChip key={tag.id} size="small" tag={tag} />)}
        </Box>
        <Box sx={{ flex: '1 1 260px', minWidth: 0 }}>
          <LimitFigures limit={l} />
          <LinearProgress
            variant="determinate"
            value={Math.min(100, (l.spentMinutes / l.minutes) * 100)}
            color={state === 'over' ? 'error' : state === 'risk' ? 'warning' : 'primary'}
            sx={{ mt: 0.5, height: 6, borderRadius: 3 }}
          />
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('tagLimits.period', { from: format.dayDate(l.startsOn), to: format.dayDate(l.endsOn) })}
            {!p.mine && ` · ${t('tagLimits.of', { name: employees.get(l.employeeId)?.fullName ?? `#${l.employeeId}` })}`}
          </Typography>
        </Box>
        {p.mine && p.onEdit && (
          <Stack direction="row" onClick={(e) => e.stopPropagation()}>
            <Tooltip title={t('tagLimits.change')}><IconButton size="small" onClick={p.onEdit}><Edit fontSize="small" /></IconButton></Tooltip>
            <Tooltip title={t('tagLimits.remove')}>
              <IconButton size="small" disabled={remove.isPending} onClick={() => remove.mutate({ id: l.id })}><Close fontSize="small" /></IconButton>
            </Tooltip>
          </Stack>
        )}
      </Stack>
      <Collapse in={open} unmountOnExit>
        <Stack spacing={1.5} sx={{ px: 2, pb: 1.5 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('tagLimits.planned', { left: format.minutes(l.leftMinutes) })}
            {l.aheadMinutes !== null && l.endsOn >= today() && ` · ${t('tagLimits.ahead', { ahead: format.minutes(l.aheadMinutes) })}`}
          </Typography>
          <TeamChart
            days={l.days}
            format={(v) => format.minutes(Math.round(v))}
            axisFormat={(v) => format.minutes(v >= 60 ? Math.round(v / 60) * 60 : Math.round(v))}
            max={l.minutes}
            series={[
              { id: 'spent', label: t('tagLimits.spentLine'), color: palette.primary.main, values: l.cumulative },
              { id: 'limit', label: t('tagLimits.limitLine'), color: palette.error.main, values: l.days.map(() => l.minutes) },
            ]}
          />
          {l.changed && (
            <Box>
              <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', color: 'text.secondary' }}>
                <History fontSize="small" />
                <Typography variant="caption" sx={{ fontWeight: 600 }}>{t('tagLimits.history')}</Typography>
              </Stack>
              <Stack spacing={0.5} sx={{ pl: 1 }}>{history.data?.map((v) => <Version key={v.id} version={v} />)}</Stack>
            </Box>
          )}
        </Stack>
      </Collapse>
    </Box>
  );
}

/** One version: the tags, the period, the limit, and from when to when it stood. */
function Version(p: { version: TagLimitVersion }) {
  const { t } = useTranslation();
  const format = useFormat();
  const v = p.version;
  return (
    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
      {v.tags.map((tag) => tag.name).join(' · ')} — {format.minutes(v.minutes)},{' '}
      {t('tagLimits.period', { from: format.dayDate(v.startsOn), to: format.dayDate(v.endsOn) })}
      {' · '}
      {v.expiredAt
        ? t('tagLimits.stood', { from: format.dateTime(v.createdAt), to: format.dateTime(v.expiredAt) })
        : t('tagLimits.since', { from: format.dateTime(v.createdAt) })}
    </Typography>
  );
}
