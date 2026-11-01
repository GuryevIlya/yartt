import { Box, Stack, Typography, useTheme } from '@mui/material';
import { BarPlot } from '@mui/x-charts/BarChart';
import { ChartsAxisHighlight } from '@mui/x-charts/ChartsAxisHighlight';
import { ChartsDataProvider } from '@mui/x-charts/ChartsDataProvider';
import { ChartsGrid } from '@mui/x-charts/ChartsGrid';
import { ChartsSurface } from '@mui/x-charts/ChartsSurface';
import { ChartsTooltip } from '@mui/x-charts/ChartsTooltip';
import { ChartsXAxis } from '@mui/x-charts/ChartsXAxis';
import { ChartsYAxis } from '@mui/x-charts/ChartsYAxis';
import { LinePlot, MarkPlot } from '@mui/x-charts/LineChart';
import { useTranslation } from 'react-i18next';
import type { DayStats } from '#shared/team.ts';
import { fromDay, useFormat } from '#client/hooks/format.ts';

/** Longer ranges are shown by weeks: a bar per day would be a comb. */
const DAILY_UP_TO = 62;

type Bucket = { label: string; work: number; spent: number; score: number | null };

/**
 * Hours in the timesheet and logged to tasks as bars, the score as a line
 * on its own axis: workload and quality side by side, never mixed. A week
 * score is weighted by the hours of its scored days, like the total.
 */
function buckets(days: DayStats[], label: (day: string, weekly: boolean) => string): Bucket[] {
  const weekly = days.length > DAILY_UP_TO;
  const groups: DayStats[][] = [];
  for (const day of days) {
    const startsWeek = fromDay(day.day).getUTCDay() === 1;
    if (!weekly || groups.length === 0 || startsWeek) groups.push([day]);
    else groups[groups.length - 1]!.push(day);
  }
  return groups.map((group) => {
    const scored = group.filter((d) => d.score !== null && d.workMinutes > 0);
    const weight = scored.reduce((sum, d) => sum + d.workMinutes, 0);
    return {
      label: label(group[0]!.day, weekly),
      work: group.reduce((sum, d) => sum + d.workMinutes, 0) / 60,
      spent: group.reduce((sum, d) => sum + d.spentMinutes, 0) / 60,
      score: weight > 0 ? scored.reduce((sum, d) => sum + d.score! * d.workMinutes, 0) / weight : null,
    };
  });
}

export default function (p: { days: DayStats[] }) {
  const { t } = useTranslation();
  const format = useFormat();
  const theme = useTheme();
  const data = buckets(p.days, (day, weekly) =>
    weekly ? t('employee.stats.weekOf', { day: format.dayDate(day) }) : format.dayDate(day));
  const colors = { work: theme.palette.primary.main, spent: theme.palette.primary.light, score: theme.palette.warning.main };
  const hours = (v: number | null) => (v === null ? '—' : format.minutes(Math.round(v * 60)));

  return (
    <Box>
      <Stack direction="row" sx={{ gap: 2, flexWrap: 'wrap', mb: 0.5 }}>
        {(['work', 'spent', 'score'] as const).map((key) => (
          <Stack key={key} direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
            <Box sx={{ width: 10, height: 10, borderRadius: key === 'score' ? '50%' : 0.5, bgcolor: colors[key] }} />
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t(`employee.stats.legend.${key}`)}</Typography>
          </Stack>
        ))}
      </Stack>
      <ChartsDataProvider
        height={240}
        margin={{ left: 4, right: 4, top: 8, bottom: 4 }}
        xAxis={[{ id: 'x', scaleType: 'band', data: data.map((b) => b.label), categoryGapRatio: 0.3, barGapRatio: 0.1 }]}
        yAxis={[
          { id: 'hours', min: 0, width: 36, valueFormatter: (v: number) => `${Math.round(v)}` },
          { id: 'score', min: 0, max: 100, position: 'right', width: 36 },
        ]}
        series={[
          { type: 'bar', id: 'work', yAxisId: 'hours', data: data.map((b) => b.work), color: colors.work, label: t('employee.stats.legend.work'), valueFormatter: hours },
          { type: 'bar', id: 'spent', yAxisId: 'hours', data: data.map((b) => b.spent), color: colors.spent, label: t('employee.stats.legend.spent'), valueFormatter: hours },
          {
            type: 'line', id: 'score', yAxisId: 'score', data: data.map((b) => b.score), color: colors.score,
            label: t('employee.stats.legend.score'), connectNulls: true,
            valueFormatter: (v: number | null) => (v === null ? '—' : `${Math.round(v)}%`),
          },
        ]}
      >
        <ChartsSurface>
          <ChartsGrid horizontal />
          <BarPlot />
          <LinePlot />
          <MarkPlot />
          <ChartsAxisHighlight x="band" />
          <ChartsXAxis axisId="x" tickLabelStyle={{ fontSize: 11 }} />
          <ChartsYAxis axisId="hours" />
          <ChartsYAxis axisId="score" />
        </ChartsSurface>
        <ChartsTooltip trigger="axis" />
      </ChartsDataProvider>
    </Box>
  );
}
