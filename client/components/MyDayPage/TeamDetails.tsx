import { PersonRemove } from '@mui/icons-material';
import { Box, Button, Stack, Typography, useTheme } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { useViewAs } from '#client/hooks/viewAs.ts';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { Employee } from '#shared/employee.ts';
import { useFormat } from '#client/hooks/format.ts';
import { useEmployees } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import TeamChart from './TeamChart.tsx';
import { daily, DELAY_LIMIT, DELAYS, metrics, peopleOf, type Group } from './teamMetrics.ts';

/** Coarse on purpose: "3 дн." reads faster than "72ч". */
export function useDuration() {
  const { t } = useTranslation();
  const format = useFormat();
  return (minutes: number | null) => (minutes === null ? '—'
    : minutes >= 2 * 1440 ? t('myDay.team.inDays', { count: Math.round(minutes / 1440) }) : format.minutes(Math.round(minutes)));
}

function Section(p: { title: string; children: ReactNode }) {
  return (
    <Stack spacing={0.5} sx={{ minWidth: 0 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{p.title}</Typography>
      {p.children}
    </Stack>
  );
}

function Line(p: { children: ReactNode; warn?: boolean }) {
  return <Typography variant="body2" sx={{ color: p.warn ? 'warning.dark' : 'text.secondary' }}>{p.children}</Typography>;
}

/**
 * What a row of My team does not fit: every number behind the four columns
 * and how it went over the range, as charts. A person's actions — dismiss
 * (the direct manager) — is here too.
 */
export default function (p: { group: Group; onChanged: () => void }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const theme = useTheme();
  const format = useFormat();
  const duration = useDuration();
  const employees = useEmployees();
  const { readOnly } = useViewAs();
  const dismiss = useMutation(trpc.Employee.dismiss.mutationOptions({ onSuccess: p.onChanged }));
  const { group } = p;
  const m = metrics(group);
  const people = peopleOf(group);
  const scorer = group.kind === 'person' ? group.person : group.kind === 'team' ? group.manager : null;
  const days = (people[0] ?? scorer)?.days.map((d) => d.day) ?? [];
  const person = group.kind === 'person' ? group.person : null;
  const employee = person ? employees.get(person.employeeId) : undefined;
  const palette = (theme.vars ?? theme).palette;
  const colors = { record: palette.primary.main, reply: palette.success.main };
  const percent = (v: number) => `${Math.round(v)}%`;

  // Dismissal cannot be undone by the person dismissed and hurts them: confirm it.
  const confirmDismiss = (e: Employee) => {
    if (window.confirm(t('team.dismissConfirm', { name: e.fullName }))) dismiss.mutate({ id: e.id });
  };

  return (
    <Stack spacing={2} sx={{ py: 1.5 }}>
      <Box sx={{ display: 'grid', gap: 2.5, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
        <Section title={t('myDay.team.details.time')}>
          {person ? (
            <>
              <Line>{t('myDay.team.details.work', { time: format.minutes(person.stats.workMinutes), count: person.stats.workDays })}</Line>
              <Line>
                {t('myDay.team.spentTime', { spent: format.minutes(person.stats.spentMinutes), work: format.minutes(person.stats.workMinutes) })}
                {m.share !== null && ` · ${percent(m.share)}`}
              </Line>
            </>
          ) : (
            <Line>{t('myDay.team.details.shareAverage', { value: m.share === null ? '—' : percent(m.share), count: people.length })}</Line>
          )}
          <TeamChart
            days={days}
            max={100}
            format={percent}
            series={[{
              id: 'share', label: t('myDay.team.spent'), color: palette.primary.main,
              values: daily(people, (d) => (d.workMinutes > 0 ? (d.spentMinutes / d.workMinutes) * 100 : null)),
            }]}
          />
        </Section>

        <Section title={t(group.kind === 'team' ? 'myDay.team.details.managerScore' : 'employee.stats.score')}>
          <Line>
            {m.score === null ? '—' : percent(m.score)}
            {m.scoredDays !== null && ` · ${t('employee.stats.scoredDays', { count: m.scoredDays })}`}
          </Line>
          {m.unscored !== null && m.unscored > 0 && (
            <Line>{t(group.kind === 'team' ? 'myDay.team.details.unscoredByManager' : 'myDay.team.details.unscored', { count: m.unscored })}</Line>
          )}
          {scorer ? (
            <TeamChart
              days={days}
              max={100}
              dots
              format={percent}
              series={[{ id: 'score', label: t('employee.stats.score'), color: palette.warning.main, values: scorer.days.map((d) => d.score) }]}
            />
          ) : <Line>{t('myDay.team.details.scoreAverage')}</Line>}
        </Section>

        <Section title={t('myDay.team.tasks')}>
          <Line>
            {t('myDay.team.details.open', { count: m.open })}
            {m.atRisk > 0 && <Box component="span" sx={{ color: 'warning.dark' }}> · {t('myDay.team.atRiskCount', { count: m.atRisk })}</Box>}
          </Line>
          <Line>{t('myDay.team.details.closed', { finished: m.finished, late: m.late })}</Line>
          {m.backlog ? (
            <>
              <Line>
                {t('myDay.team.details.backlog', {
                  time: format.minutes(m.backlog.minutes),
                  growth: m.backlog.growth === 0 ? '±0' : `${m.backlog.growth > 0 ? '+' : '−'}${format.minutes(Math.abs(m.backlog.growth))}`,
                })}
              </Line>
              <TeamChart
                days={days}
                max={1}
                format={(v) => format.minutes(Math.round(v * 60))}
                series={[{ id: 'backlog', label: t('myDay.team.backlog'), color: palette.primary.main, values: person!.days.map((d) => d.backlogMinutes / 60) }]}
              />
            </>
          ) : <Line>{t('myDay.team.details.noBacklog')}</Line>}
        </Section>

        <Section title={t('myDay.team.delay')}>
          {DELAYS.map((kind) => (
            <Line key={kind} warn={(m.delays[kind] ?? 0) >= DELAY_LIMIT[kind]}>
              {t(`myDay.team.details.delay.${kind}`)}: {duration(m.delays[kind])}
              {kind === 'reply' && m.unanswered > 0 && ` · ${t('myDay.team.unanswered', { count: m.unanswered })}`}
            </Line>
          ))}
          <TeamChart
            days={days}
            format={(v) => duration(v * 60)}
            series={DELAYS.map((kind) => ({
              id: kind, label: t(`myDay.team.delayOf.${kind}`), color: colors[kind],
              values: daily(people, (d) => {
                const v = kind === 'record' ? d.recordDelayMinutes : d.replyMinutes;
                return v === null ? null : v / 60;
              }),
            }))}
          />
        </Section>
      </Box>

      {employee && (
        <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
          <Button size="small" component={Link} to={`/employees/${employee.id}`}>{t('myDay.team.details.page')}</Button>
          {/* My active direct report; a dismissed one comes back from the list under the table. */}
          {person!.direct && employee.dismissedAt === null && !readOnly && (
            <Button size="small" color="error" startIcon={<PersonRemove />} disabled={dismiss.isPending} onClick={() => confirmDismiss(employee)}>
              {t('team.dismiss')}
            </Button>
          )}
        </Stack>
      )}
    </Stack>
  );
}
