import { ChevronRight, Close, Download, ExpandMore, ShowChart, WarningAmber } from '@mui/icons-material';
import {
  Box, Button, Checkbox, Chip, Collapse, IconButton, Link as MuiLink, Menu, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableHead,
  TableRow, Tooltip, Typography,
} from '@mui/material';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { Employee } from '#shared/employee.ts';
import type { Member } from '#shared/team.ts';
import { fromDay, today, useFormat } from '#client/hooks/format.ts';
import { useMe } from '#client/hooks/me.ts';
import { useViewAs } from '#client/hooks/viewAs.ts';
import { STATS_POLL_MS, useEmployees, usePronoun } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import { csv, download, xlsx, type Cell } from '#client/hooks/xlsx.ts';
import EmployeeAvatar from '../App/EmployeeAvatar.tsx';
import RangePicker, { useRange } from '../App/RangePicker.tsx';
import RestoreDialog from './RestoreDialog.tsx';
import TeamDetails, { useDuration } from './TeamDetails.tsx';
import { DELAY_LIMIT, DELAYS, metrics, share, type Group, type Metrics } from './teamMetrics.ts';

/** How far a team's people sit from the team line, px. */
const INDENT = 20;

/** A tick: one person, or everyone of a team at once. */
type Pick = { checked: boolean; indeterminate?: boolean; onChange: (on: boolean) => void; label: string };

/**
 * My team — only for someone with reports (docs/product/interface.md, 4):
 * on top the line of my whole team, then me and my direct reports, always
 * shown; a report who manages others is the line of their team, which
 * unfolds into them and their people. Under the table, folded, my
 * dismissed reports, to bring back. Four columns that compare across rows; a click
 * on a row opens its details with charts. Ticks pick people for a line of
 * their own; a team's tick picks the whole team. People and teams are
 * compared by shares, not hours (decision 68); a team's score is its manager's.
 */
export default function (p: { fold?: ReactNode }) {
  const { t } = useTranslation();
  const { as, readOnly } = useViewAs();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const format = useFormat();
  const pronoun = usePronoun();
  const employees = useEmployees();
  const me = useMe();
  const [range, setRange, valid] = useRange();
  const summary = useQuery(trpc.Team.summary.queryOptions({ ...range, as }, {
    refetchInterval: STATS_POLL_MS, placeholderData: keepPreviousData, enabled: valid,
  }));
  const [restoring, setRestoring] = useState<Employee | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [unfolded, setUnfolded] = useState<Set<number>>(new Set());
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [showDismissed, setShowDismissed] = useState(false);
  const [exportMenu, setExportMenu] = useState<HTMLElement | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.Employee.list.queryKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.Team.pathKey() });
  };
  const flip = <T,>(set: (f: (prev: Set<T>) => Set<T>) => void, key: T) => set((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const members = summary.data ?? [];
  const byId = new Map(members.map((m) => [m.employeeId, m]));
  const root = members.find((m) => m.self);
  // The tree comes from the managers: everyone hangs under their manager, who is in the summary too.
  const children = new Map<number, Member[]>();
  for (const m of members) {
    const managerId = employees.get(m.employeeId)?.managerId;
    if (m.self || managerId == null || !byId.has(managerId)) continue;
    children.set(managerId, [...(children.get(managerId) ?? []), m]);
  }
  // The longest unseen first — someone gone without being dismissed, or away, comes up; the dismissed last.
  const seen = (m: Member) => m.lastSeenAt?.getTime() ?? 0;
  for (const list of children.values()) {
    list.sort((a, b) => Number(!!employees.get(a.employeeId)?.dismissedAt) - Number(!!employees.get(b.employeeId)?.dismissedAt)
      || seen(a) - seen(b));
  }
  const descendants = (id: number): Member[] =>
    (children.get(id) ?? []).flatMap((c) => [c, ...descendants(c.employeeId)]);
  // A team is its manager and everyone under them: the manager is part of it.
  const teamOf = (manager: Member): Extract<Group, { kind: 'team' }> => ({
    kind: 'team', manager, people: [manager, ...descendants(manager.employeeId)], direct: children.get(manager.employeeId) ?? [],
  });

  // My dismissed reports, whatever the range: only I can bring them back (a dismissed one always has a manager).
  const dismissed = [...employees.values()].filter((e) => e.kind === 'human' && e.dismissedAt !== null && e.managerId === (as ?? me.id));

  const toggle = (ids: number[], on: boolean) => setSelected((prev) => {
    const next = new Set(prev);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    return next;
  });
  const picked = members.filter((m) => selected.has(m.employeeId));
  const pickAll = (people: Member[], label: string): Pick => {
    const count = people.filter((m) => selected.has(m.employeeId)).length;
    return {
      checked: people.length > 0 && count === people.length,
      indeterminate: count > 0 && count < people.length,
      onChange: (on) => toggle(people.map((m) => m.employeeId), on),
      label,
    };
  };

  // Payroll export: the picked people, or everyone; one row per person and per
  // person-day: people are compared by shares, not by a total of hours (decision 68).
  const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;
  const exported = picked.length ? picked : members;
  const name = (id: number) => employees.get(id)?.fullName ?? `#${id}`;
  const summaryRows = (): Cell[][] => [
    [t('myDay.team.export.person'), t('myDay.team.export.email'), t('myDay.team.export.manager'),
      t('myDay.team.export.workHours'), t('myDay.team.export.workDays'), t('myDay.team.export.spentHours'),
      t('myDay.team.export.share'), t('myDay.team.export.score'), t('myDay.team.export.scoredDays')],
    ...exported.map((m) => {
      const e = employees.get(m.employeeId);
      const s = share(m);
      return [name(m.employeeId), e?.email ?? null, e?.managerId ? name(e.managerId) : null,
        hours(m.stats.workMinutes), m.stats.workDays, hours(m.stats.spentMinutes),
        s === null ? null : Math.round(s), m.stats.weightedScore === null ? null : Math.round(m.stats.weightedScore), m.stats.scoredDays];
    }),
  ];
  const dayRows = (): Cell[][] => [
    [t('myDay.team.export.person'), t('myDay.team.export.day'), t('myDay.team.export.workHours'),
      t('myDay.team.export.spentHours'), t('myDay.team.export.score')],
    ...exported.flatMap((m) => m.days
      .filter((d) => d.workMinutes > 0 || d.spentMinutes > 0 || d.score !== null)
      .map((d): Cell[] => [name(m.employeeId), d.day, hours(d.workMinutes), hours(d.spentMinutes), d.score])),
  ];
  const fileName = `yartt-${range.from}-${range.to}`;
  const exportXlsx = () => {
    setExportMenu(null);
    download(`${fileName}.xlsx`, xlsx([
      { name: t('myDay.team.export.summarySheet'), rows: summaryRows() },
      { name: t('myDay.team.export.daysSheet'), rows: dayRows() },
    ]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  };
  const exportCsv = () => {
    setExportMenu(null);
    download(`${fileName}.csv`, csv(dayRows()), 'text/csv;charset=utf-8');
  };

  const head = [
    { key: 'person', label: t('myDay.team.person') },
    { key: 'share', label: t('myDay.team.spent'), hint: t('myDay.team.spentHint') },
    { key: 'score', label: t('employee.stats.score'), hint: t('myDay.team.scoreHint') },
    { key: 'tasks', label: t('myDay.team.tasks'), hint: t('myDay.team.tasksHint') },
    { key: 'delay', label: t('myDay.team.delay'), hint: t('myDay.team.delayHint') },
  ];

  const row = (key: string, depth: number, group: Group, label: ReactNode, pick: Pick | null, fold?: { open: boolean; onToggle: () => void }, action?: ReactNode) => (
    <Row
      key={key}
      depth={depth}
      group={group}
      label={label}
      pick={pick}
      fold={fold}
      action={action}
      open={opened.has(key)}
      onOpen={() => flip(setOpened, key)}
      onChanged={refresh}
    />
  );

  const personLabel = (m: Member) => {
    const e = employees.get(m.employeeId);
    if (!e) return null;
    const away = e.nextDay !== null && e.nextDay > today();
    return (
      <Stack direction="row" sx={{ alignItems: 'center', flexWrap: 'wrap', columnGap: 0.75, rowGap: 0.25, minWidth: 0 }}>
        <Box sx={{ display: { xs: 'none', sm: 'flex' } }}><EmployeeAvatar employee={e} size={24} /></Box>
        <Typography
          variant="body2"
          component={Link}
          to={`/employees/${e.id}`}
          onClick={(ev) => ev.stopPropagation()}
          sx={{ color: 'text.primary', fontWeight: 500, textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}
        >
          {e.fullName}
        </Typography>
        {m.self && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('myDay.team.me')}</Typography>}
        {!m.self && !e.dismissedAt && (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {m.lastSeenAt
              ? t('myDay.team.seen', { when: format.relative(m.lastSeenAt), ...pronoun(e.id) })
              : t('myDay.team.neverSeen', pronoun(e.id))}
          </Typography>
        )}
        {e.dismissedAt && (
          <Chip size="small" label={t('myDay.team.dismissedOn', { day: format.date(e.dismissedAt), ...pronoun(e.id) })} />
        )}
        {e.idpBlockedAt && !e.dismissedAt && (
          <Tooltip title={t('employee.idpBlockedHint', { day: format.date(e.idpBlockedAt) })}>
            <Chip size="small" color="error" variant="outlined" label={t('employee.idpBlocked')} />
          </Tooltip>
        )}
        {away && (
          <Tooltip title={t('employee.awayUntil', { day: format.dayDate(e.nextDay!) })}>
            <Chip size="small" color="warning" label={t('myDay.team.away', { day: format.dayDate(e.nextDay!) })} />
          </Tooltip>
        )}
      </Stack>
    );
  };

  const personRow = (m: Member, depth: number) => row(`p${m.employeeId}`, depth, { kind: 'person', person: m }, personLabel(m), {
    checked: selected.has(m.employeeId),
    onChange: (on) => toggle([m.employeeId], on),
    label: t('myDay.team.pick', { name: name(m.employeeId) }),
  });

  // A report who manages others is the line of their team, which unfolds into them first, then their people.
  const branch = (m: Member, depth: number): ReactNode => {
    if (!children.has(m.employeeId)) return personRow(m, depth);
    const group = teamOf(m);
    const open = unfolded.has(m.employeeId);
    return (
      <Fragment key={`b${m.employeeId}`}>
        {row(
          `t${m.employeeId}`, depth, group,
          t('myDay.team.teamOf', { name: name(m.employeeId), count: group.people.length }),
          pickAll(group.people, t('myDay.team.pickTeam', { name: name(m.employeeId) })),
          { open, onToggle: () => flip(setUnfolded, m.employeeId) },
        )}
        {open && personRow(m, depth + 1)}
        {open && (children.get(m.employeeId) ?? []).map((k) => branch(k, depth + 1))}
      </Fragment>
    );
  };

  return (
    <Paper component="section" aria-label={t('myDay.team.title')} sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Stack direction="row" sx={{ alignItems: 'center' }}>
        <Typography variant="h3" sx={{ fontWeight: 600, flexGrow: 1 }}>{t('myDay.team.title')}</Typography>
        {p.fold}
      </Stack>
      <Stack direction="row" sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
        <Box sx={{ flexGrow: 1 }}><RangePicker range={range} onChange={setRange} /></Box>
        <Button size="small" startIcon={<Download />} onClick={(e) => setExportMenu(e.currentTarget)} disabled={members.length === 0}>
          {t(picked.length ? 'myDay.team.export.picked' : 'myDay.team.export.all', { count: picked.length })}
        </Button>
        <Menu anchorEl={exportMenu} open={!!exportMenu} onClose={() => setExportMenu(null)}>
          <MenuItem onClick={exportXlsx}>{t('myDay.team.export.xlsx')}</MenuItem>
          <MenuItem onClick={exportCsv}>{t('myDay.team.export.csv')}</MenuItem>
        </Menu>
      </Stack>
      {summary.isSuccess && members.length <= 1 && (
        <Typography sx={{ color: 'text.secondary' }}>{t('team.noReports')}</Typography>
      )}
      {root && members.length > 1 && (
        <Box sx={{ opacity: summary.isPlaceholderData ? 0.6 : 1 }}>
          {/* Narrow on purpose (no horizontal scroll): on a phone the share goes to the details. */}
          <Table
            size="small"
            sx={{
              '& td, & th': { px: { xs: 0.25, sm: 0.75 } },
              '& th': { color: 'text.secondary', fontSize: 12 },
              '& th, & td:not(:first-of-type)': { whiteSpace: 'nowrap' },
              '& td:nth-of-type(2), & th:nth-of-type(2)': { display: { xs: 'none', sm: 'table-cell' } },
              '& td[colspan]': { display: 'table-cell' },
            }}
          >
            <TableHead>
              <TableRow>
                {head.map((h) => (
                  <TableCell key={h.key} align={h.key === 'person' ? 'left' : 'right'}>
                    {h.hint ? <Tooltip title={h.hint} describeChild><span>{h.label}</span></Tooltip> : h.label}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {row('total', 0, teamOf(root), t('myDay.team.mine', { count: teamOf(root).people.length }),
                pickAll(teamOf(root).people, t('myDay.team.pickAll')))}
              {personRow(root, 0)}
              {(children.get(root.employeeId) ?? []).map((m) => branch(m, 0))}
              {picked.length > 0 && row('picked', 0, { kind: 'picked', people: picked }, t('myDay.team.picked', { count: picked.length }), null, undefined, (
                <Tooltip title={t('myDay.team.clear')}>
                  <IconButton size="small" onClick={(e) => { e.stopPropagation(); setSelected(new Set()); }}><Close fontSize="small" /></IconButton>
                </Tooltip>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
      {dismissed.length > 0 && (
        <Box>
          <Button
            size="small"
            color="inherit"
            startIcon={showDismissed ? <ExpandMore /> : <ChevronRight />}
            aria-expanded={showDismissed}
            onClick={() => setShowDismissed((v) => !v)}
            sx={{ color: 'text.secondary' }}
          >
            {t('myDay.team.dismissedList', { count: dismissed.length })}
          </Button>
          <Collapse in={showDismissed}>
            <Stack sx={{ pl: 4, pt: 0.5, gap: 0.5 }}>
              {dismissed.map((e) => (
                <Stack key={e.id} direction="row" sx={{ alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <MuiLink component={Link} to={`/employees/${e.id}`} variant="body2">{e.fullName}</MuiLink>
                  {e.dismissedAt && (
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      {t('myDay.team.dismissedOn', { day: format.date(e.dismissedAt), ...pronoun(e.id) })}
                    </Typography>
                  )}
                  {!readOnly && <Button size="small" sx={{ py: 0 }} onClick={() => setRestoring(e)}>{t('team.restore')}</Button>}
                </Stack>
              ))}
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('myDay.team.dismissedHint')}</Typography>
            </Stack>
          </Collapse>
        </Box>
      )}
      {restoring && <RestoreDialog employee={restoring} onClose={() => setRestoring(null)} onDone={refresh} />}
    </Paper>
  );
}

function MetricCells(p: { group: Group; m: Metrics }) {
  const { t } = useTranslation();
  const format = useFormat();
  const duration = useDuration();
  const { m } = p;
  const percent = (value: number | null) => (value === null ? '—' : `${Math.round(value)}%`);
  const note = (text: ReactNode, warn = false) => (
    <Typography variant="caption" sx={{ color: warn ? 'warning.dark' : 'text.secondary', display: 'block', lineHeight: 1.3 }}>{text}</Typography>
  );
  const late = m.worst !== null && m.worst.minutes >= DELAY_LIMIT[m.worst.kind];
  const mine = p.group.kind === 'person' || (p.group.kind === 'team' && p.group.manager.self);
  return (
    <>
      <TableCell align="right" sx={{ color: (m.share ?? 0) > 100 ? 'warning.dark' : undefined }}>{percent(m.share)}</TableCell>
      <TableCell align="right">
        {percent(m.score)}
        {/* Days waiting for my score only: a team's wait for its manager is in its details. */}
        {mine && m.unscored !== null && m.unscored > 0 && note(t('myDay.team.toScore', { count: m.unscored }), true)}
      </TableCell>
      <TableCell align="right">
        <Stack direction="row" sx={{ justifyContent: 'flex-end', alignItems: 'center', gap: 0.5 }}>
          {m.atRisk > 0 && (
            <Tooltip title={t('myDay.team.atRiskCount', { count: m.atRisk })}>
              <Stack direction="row" sx={{ alignItems: 'center', color: 'warning.dark', fontWeight: 600 }}>
                <WarningAmber sx={{ fontSize: 16 }} />{m.atRisk}
              </Stack>
            </Tooltip>
          )}
          {m.open}
        </Stack>
        {m.backlog && m.backlog.minutes > 0 && note(t('myDay.team.planned', { time: format.minutes(m.backlog.minutes) }))}
      </TableCell>
      <TableCell align="right">
        <Tooltip
          title={DELAYS.map((kind) => `${t(`myDay.team.details.delay.${kind}`)}: ${duration(m.delays[kind])}`).join(' · ')}
          describeChild
        >
          <Box component="span" sx={{ color: late ? 'warning.dark' : undefined, fontWeight: late ? 600 : undefined }}>
            {m.worst ? duration(m.worst.minutes) : '—'}
          </Box>
        </Tooltip>
        {m.worst && note(t(`myDay.team.delayOf.${m.worst.kind}`), late)}
      </TableCell>
    </>
  );
}

/** A line of the table: a person, a team, all of my team or the picked; a click opens its details. */
function Row(p: {
  depth: number;
  group: Group;
  label: ReactNode;
  pick: Pick | null;
  fold?: { open: boolean; onToggle: () => void };
  action?: ReactNode;
  open: boolean;
  onOpen: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const isGroup = p.group.kind !== 'person';
  return (
    <>
      <TableRow
        hover
        selected={p.open}
        onClick={p.onOpen}
        aria-expanded={p.open}
        sx={{ cursor: 'pointer', '& td': isGroup ? { fontWeight: 600, bgcolor: p.open ? undefined : 'action.hover' } : {} }}
      >
        <TableCell sx={{ pl: { xs: `${p.depth * INDENT / 2}px !important`, sm: `${p.depth * INDENT}px !important` } }}>
          <Stack direction="row" sx={{ alignItems: 'center' }}>
            <Box sx={{ width: { xs: 22, sm: 26 }, flexShrink: 0 }}>
              {p.fold && (
                <IconButton
                  size="small"
                  aria-label={t(p.fold.open ? 'myDay.team.collapse' : 'myDay.team.expand')}
                  onClick={(e) => { e.stopPropagation(); p.fold!.onToggle(); }}
                >
                  {p.fold.open ? <ExpandMore fontSize="small" /> : <ChevronRight fontSize="small" />}
                </IconButton>
              )}
            </Box>
            {/* Picking is for the payroll export, done at a desk: no ticks at phone width. */}
            {p.pick ? (
              <Checkbox
                size="small"
                sx={{ p: 0.5, display: { xs: 'none', sm: 'inline-flex' } }}
                checked={p.pick.checked}
                indeterminate={p.pick.indeterminate}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => p.pick!.onChange(e.target.checked)}
                slotProps={{ input: { 'aria-label': p.pick.label } }}
              />
            ) : <Box sx={{ width: 30, flexShrink: 0, display: { xs: 'none', sm: 'block' } }} />}
            <Box sx={{ ml: 0.5, minWidth: 0, flexGrow: 1 }}>{p.label}</Box>
            {/* The details are behind a visible sign, not only a click on the row. */}
            <Tooltip title={t(p.open ? 'myDay.team.hideDetails' : 'myDay.team.showDetails')}>
              <IconButton
                size="small"
                sx={{ p: { xs: 0.25, sm: 0.625 } }}
                color={p.open ? 'primary' : 'default'}
                aria-label={t(p.open ? 'myDay.team.hideDetails' : 'myDay.team.showDetails')}
                aria-expanded={p.open}
                onClick={(e) => { e.stopPropagation(); p.onOpen(); }}
              >
                <ShowChart fontSize="small" />
              </IconButton>
            </Tooltip>
            {p.action}
          </Stack>
        </TableCell>
        <MetricCells group={p.group} m={metrics(p.group)} />
      </TableRow>
      <TableRow>
        <TableCell colSpan={5} sx={{ py: 0, borderBottom: p.open ? undefined : 'none' }}>
          <Collapse in={p.open} unmountOnExit>
            {/* Takes the table's width, never widens it: the charts fit the columns, not the other way round. */}
            <Box sx={{ width: 0, minWidth: '100%' }}>
              <TeamDetails group={p.group} onChanged={p.onChanged} />
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}
