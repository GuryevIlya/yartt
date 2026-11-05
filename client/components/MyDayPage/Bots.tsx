import { Add, SmartToy, WarningAmber } from '@mui/icons-material';
import {
  Box, Button, Chip, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Tooltip, Typography,
} from '@mui/material';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Bot, BotStats } from '#shared/bot.ts';
import { useFormat } from '#client/hooks/format.ts';
import { useMe } from '#client/hooks/me.ts';
import { POLL_MS, STATS_POLL_MS, useEmployees } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import { useViewAs } from '#client/hooks/viewAs.ts';
import HelpLink from '../App/HelpLink.tsx';
import HelpTip from '../App/HelpTip.tsx';
import SincePicker, { lastDays } from '../App/SincePicker.tsx';
import BotDialog from './BotDialog.tsx';

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const share = (part: number, whole: number) => `${Math.round((part / Math.max(whole, 1)) * 100)}%`;

/** Calls day by day as tiny bars: a bot that went quiet shows at once. */
function Sparkline(p: { values: number[] }) {
  const max = Math.max(1, ...p.values);
  const width = 64;
  const step = width / Math.max(p.values.length, 1);
  return (
    <Box component="svg" width={width} height={18} viewBox={`0 0 ${width} 18`} aria-hidden sx={{ color: 'primary.main', flexShrink: 0 }}>
      {p.values.map((v, i) => (
        <rect key={i} x={i * step} y={18 - (v / max) * 18} width={Math.max(step - 0.5, 0.5)} height={(v / max) * 18} fill="currentColor" opacity={v ? 0.7 : 0} />
      ))}
    </Box>
  );
}

/**
 * Bots under My team (decision 49): mine and those of everyone under me,
 * and what each did from a day to today — its tasks, comments and mentions, API
 * calls and refusals, webhook deliveries — the quiet ones first, so a bot
 * that stopped is seen. A click opens its settings, "New bot" creates one
 * under me. What a figure means is under a "?". `bare` — without the
 * card, in the profile.
 */
export default function (p: { bare?: boolean; fold?: ReactNode }) {
  const { t } = useTranslation();
  const { as, readOnly } = useViewAs();
  const trpc = useTRPC();
  const me = useMe();
  const format = useFormat();
  const employees = useEmployees();
  const [since, setSince] = useState(() => lastDays(30));
  const bots = useQuery(trpc.Bot.list.queryOptions({ as }, { refetchInterval: POLL_MS }));
  const stats = useQuery(trpc.Bot.stats.queryOptions({ since, as }, {
    refetchInterval: STATS_POLL_MS, placeholderData: keepPreviousData,
  }));
  const [opened, setOpened] = useState<Bot | 'new' | null>(null);
  const byId = new Map((stats.data ?? []).map((s) => [s.id, s]));
  const last = (bot: Bot) => byId.get(bot.id)?.lastRequestAt?.getTime() ?? 0;
  // Working ones first, the quietest on top; the dismissed at the end.
  const list = [...(bots.data ?? [])].sort((a, b) =>
    Number(!!a.dismissedAt) - Number(!!b.dismissedAt) || last(a) - last(b) || a.fullName.localeCompare(b.fullName));
  const note = (text: ReactNode, warn = false) => (
    <Typography variant="caption" sx={{ display: 'block', lineHeight: 1.3, color: warn ? 'warning.dark' : 'text.secondary' }}>{text}</Typography>
  );

  const head = (label: string, hint: string, narrow = false) => (
    <TableCell align="right" sx={narrow ? { display: { xs: 'none', sm: 'table-cell' } } : undefined}>
      <Stack direction="row" spacing={0.25} sx={{ justifyContent: 'flex-end', alignItems: 'center' }}>
        <span>{label}</span><HelpTip title={hint} />
      </Stack>
    </TableCell>
  );

  const cells = (bot: Bot, s: BotStats | undefined) => (
    <>
      <TableCell align="right">
        {s?.openTasks ?? '—'}
        {s && s.observedTasks > 0 && note(t('bots.observed', { count: s.observedTasks }))}
      </TableCell>
      <TableCell align="right" sx={{ display: { xs: 'none', sm: 'table-cell' } }}>
        {s ? t('bots.activityLine', { comments: s.comments, mentions: s.mentions }) : '—'}
        {s && s.closedTasks > 0 && note(t('bots.closed', { count: s.closedTasks }))}
      </TableCell>
      <TableCell align="right">
        <Stack direction="row" sx={{ justifyContent: 'flex-end', alignItems: 'center', gap: 0.75 }}>
          {s && <Sparkline values={s.daily.map((d) => d.requests)} />}
          {s?.requests ?? '—'}
        </Stack>
        {s && s.refused > 0 && note(t('bots.refusedShare', { share: share(s.refused, s.requests) }), true)}
        {s && s.deliveries > 0 && note(
          t('bots.deliveredShare', { share: share(s.deliveries - s.failedDeliveries, s.deliveries) }),
          s.failedDeliveries > 0,
        )}
      </TableCell>
      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
        {s?.lastRequestAt ? format.relative(s.lastRequestAt) : t('bots.never')}
      </TableCell>
    </>
  );

  const content = (
    <Stack spacing={1.5}>
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
        {!p.bare && (
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexGrow: 1 }}>
            <Typography variant="h3" sx={{ fontWeight: 600 }}>{t('bots.title')}</Typography>
            <HelpTip title={t('bots.blockHint')} />
            <Typography variant="body2"><HelpLink to="api-bots">{t('bots.howTo')}</HelpLink></Typography>
          </Stack>
        )}
        {p.bare && <Typography variant="body2" sx={{ color: 'text.secondary', flexGrow: 1 }}>{t('bots.hint')} <HelpLink to="api-bots">{t('bots.howTo')}</HelpLink></Typography>}
        {!readOnly && <Button size="small" startIcon={<Add />} onClick={() => setOpened('new')}>{t('bots.create')}</Button>}
        {p.fold}
      </Stack>
      {!p.bare && list.length === 0 && bots.isSuccess && (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('bots.hint')}</Typography>
      )}
      {list.length > 0 && (
        <>
          <SincePicker since={since} onChange={setSince} />
          <Box sx={{ opacity: stats.isPlaceholderData ? 0.6 : 1 }}>
            <Table
              size="small"
              sx={{
                '& td, & th': { px: { xs: 0.25, sm: 0.75 } },
                '& th': { color: 'text.secondary', fontSize: 12, whiteSpace: 'nowrap' },
              }}
            >
              <TableHead>
                <TableRow>
                  <TableCell>{t('bots.bot')}</TableCell>
                  {head(t('bots.tasks'), t('bots.tasksHint'))}
                  {head(t('bots.activity'), t('bots.activityHint'), true)}
                  {head(t('bots.requests'), t('bots.requestsHint'))}
                  {head(t('bots.lastRequest'), t('bots.lastRequestHint'))}
                </TableRow>
              </TableHead>
              <TableBody>
                {list.map((bot) => {
                  const oldKey = !bot.dismissedAt && Date.now() - bot.keyIssuedAt.getTime() >= YEAR_MS;
                  return (
                    <TableRow
                      key={bot.id}
                      hover={!readOnly}
                      onClick={readOnly ? undefined : () => setOpened(bot)}
                      sx={{ cursor: readOnly ? 'default' : 'pointer', opacity: bot.dismissedAt ? 0.6 : 1 }}
                    >
                      <TableCell>
                        <Stack direction="row" sx={{ alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                          <SmartToy fontSize="small" sx={{ color: 'text.secondary' }} />
                          <Typography variant="body2" sx={{ fontWeight: 500 }}>{bot.fullName}</Typography>
                          {bot.dismissedAt && <Chip size="small" label={t('team.dismissed')} />}
                          {bot.stopped && !bot.dismissedAt && (
                            <Tooltip title={t('bots.stoppedHint')}>
                              <Chip size="small" color="error" variant="outlined" label={t('bots.stopped')} />
                            </Tooltip>
                          )}
                          {oldKey && (
                            <Tooltip title={t('bots.oldKeyHint', { day: format.date(bot.keyIssuedAt) })}>
                              <WarningAmber fontSize="small" sx={{ color: 'warning.dark' }} aria-label={t('bots.oldKey')} />
                            </Tooltip>
                          )}
                        </Stack>
                        {bot.managerId !== me.id && note(t('bots.of', { name: employees.get(bot.managerId)?.fullName ?? `#${bot.managerId}` }))}
                        {note(bot.permissions.length
                          ? bot.permissions.map((perm) => t(`bots.permission.${perm}`)).join(', ')
                          : t('bots.readOnly'))}
                      </TableCell>
                      {cells(bot, byId.get(bot.id))}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        </>
      )}
      {opened && (
        <BotDialog
          bot={opened === 'new' ? null : opened}
          stats={opened === 'new' ? undefined : byId.get(opened.id)}
          onClose={() => setOpened(null)}
        />
      )}
    </Stack>
  );

  return p.bare ? <Box>{content}</Box> : <Paper component="section" aria-label={t('bots.title')} sx={{ p: 2 }}>{content}</Paper>;
}
