import { Box, Stack, Typography } from '@mui/material';
import { ChartsAxisHighlight } from '@mui/x-charts/ChartsAxisHighlight';
import { ChartsDataProvider } from '@mui/x-charts/ChartsDataProvider';
import { ChartsGrid } from '@mui/x-charts/ChartsGrid';
import { ChartsSurface } from '@mui/x-charts/ChartsSurface';
import { ChartsLabelMark } from '@mui/x-charts/ChartsLabel';
import {
  ChartsTooltipCell, ChartsTooltipContainer, ChartsTooltipPaper, ChartsTooltipRow, ChartsTooltipTable, useAxesTooltip,
} from '@mui/x-charts/ChartsTooltip';
import { ChartsXAxis } from '@mui/x-charts/ChartsXAxis';
import { ChartsYAxis } from '@mui/x-charts/ChartsYAxis';
import { LinePlot, MarkPlot } from '@mui/x-charts/LineChart';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { fromDay, useFormat } from '#client/hooks/format.ts';

/** Longer ranges are shown by weeks, like the employee page chart. */
const DAILY_UP_TO = 62;

/**
 * A line. `legend` — its name in the legend, if it says more than the
 * tooltip should (a share over the whole range is not the day's).
 * `detail` — counts of the same person's day that are not drawn, told in
 * the tooltip next to the value: the tasks and comments behind the time,
 * the tasks behind the plan. A week tells its total, or its largest with
 * `peak` (the same tasks day after day).
 */
export type Detail = { values: number[]; render: (count: number) => ReactNode; peak?: boolean };
export type Series = {
  id: string; label: string; legend?: string; color: string; values: (number | null)[];
  detail?: Detail[];
};

/** Days grouped into weeks (from Monday) when the range is long; a bucket is the average of its values. */
function buckets(days: string[], series: Series[]): { first: string[]; weekly: boolean; values: (number | null)[][] } {
  const weekly = days.length > DAILY_UP_TO;
  const groups: number[][] = [];
  days.forEach((day, i) => {
    if (!weekly || groups.length === 0 || fromDay(day).getUTCDay() === 1) groups.push([i]);
    else groups[groups.length - 1]!.push(i);
  });
  return {
    first: groups.map((g) => days[g[0]!]!),
    weekly,
    values: series.map((s) => groups.map((g) => {
      const known = g.flatMap((i) => (s.values[i] == null ? [] : [s.values[i]!]));
      return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
    })),
  };
}

/** The details over the same buckets as the values. */
function detailBuckets(days: string[], series: Series[], first: string[]): number[][][] {
  return series.map((s) => (s.detail ?? []).map((d) => {
    const out = first.map(() => 0);
    let bucket = -1;
    days.forEach((day, i) => {
      if (bucket + 1 < first.length && first[bucket + 1] === day) bucket++;
      const v = d.values[i] ?? 0;
      out[bucket] = d.peak ? Math.max(out[bucket]!, v) : out[bucket]! + v;
    });
    return out;
  }));
}

/** The day's value of each line, with its detail. */
function Tip(p: { series: Series[]; details: number[][][] }) {
  const data = useAxesTooltip();
  if (!data) return null;
  return (
    <ChartsTooltipPaper>
      {data.map(({ axisId, axisFormattedValue, dataIndex, seriesItems }) => (
        <ChartsTooltipTable key={axisId}>
          <Typography component="caption">{axisFormattedValue}</Typography>
          <tbody>
            {seriesItems.map((item) => item.formattedValue != null && (
              <ChartsTooltipRow key={item.seriesId}>
                <ChartsTooltipCell component="th">
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <ChartsLabelMark type={item.markType} color={item.color} />
                    <span>{item.formattedLabel}</span>
                  </Stack>
                </ChartsTooltipCell>
                <ChartsTooltipCell component="td">
                  {item.formattedValue}
                  {(() => {
                    const i = p.series.findIndex((s) => s.id === item.seriesId);
                    return (p.series[i]?.detail ?? []).map((d, j) => {
                      const count = p.details[i]![j]![dataIndex] ?? 0;
                      return count > 0 && (
                        <Typography key={j} component="span" variant="caption"
                          sx={{ color: 'text.secondary', ml: 1, display: 'inline-flex', alignItems: 'center', gap: 0.25, verticalAlign: 'middle' }}>
                          {d.render(count)}
                        </Typography>
                      );
                    });
                  })()}
                </ChartsTooltipCell>
              </ChartsTooltipRow>
            ))}
          </tbody>
        </ChartsTooltipTable>
      ))}
    </ChartsTooltipPaper>
  );
}

/** Whether a value is the only one of its series: a line through one point is invisible. */
const alone = (values: (number | null)[]) => values.filter((v) => v !== null).length === 1;

/**
 * A small chart of the details under a row of My team: one or a few lines
 * over the days of the range, with a legend, axes and a tooltip of the
 * day — what a sparkline could only hint at — each value with its
 * detail, if it has one.
 */
export default function (p: {
  days: string[];
  series: Series[];
  format: (value: number) => string;
  /** The scale's labels, when the tooltip's format is too long for them. */
  axisFormat?: (value: number) => string;
  /** The top of the scale; values above stretch it. */
  max?: number;
  /** Dots only: sparse values (scored days), a line between them would invent days. */
  dots?: boolean;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  if (p.series.every((s) => s.values.every((v) => v === null))) {
    return <Typography variant="caption" sx={{ color: 'text.disabled' }}>{t('myDay.team.details.noData')}</Typography>;
  }
  const data = buckets(p.days, p.series);
  const details = detailBuckets(p.days, p.series, data.first);
  const labels = data.first.map((day) =>
    data.weekly ? t('employee.stats.weekOf', { day: format.dayDate(day) }) : format.dayDate(day));
  return (
    <Box>
      {p.series.length > 1 && (
        <Stack direction="row" sx={{ gap: 1.5, flexWrap: 'wrap' }}>
          {p.series.map((s) => (
            <Stack key={s.id} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
              <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: s.color }} />
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>{s.legend ?? s.label}</Typography>
            </Stack>
          ))}
        </Stack>
      )}
      <ChartsDataProvider
        height={130}
        margin={{ left: 0, right: 8, top: 8, bottom: 0 }}
        xAxis={[{ id: 'x', scaleType: 'point', data: labels }]}
        yAxis={[{ id: 'y', min: 0, max: p.max === undefined ? undefined : Math.max(p.max, ...data.values.flat().map((v) => v ?? 0)), width: 40, valueFormatter: p.axisFormat ?? p.format }]}
        series={p.series.map((s, i) => ({
          type: 'line' as const, id: s.id, label: s.label, color: s.color, data: data.values[i]!,
          // A line needs no marks, except for a value standing alone: no line would show it.
          connectNulls: !p.dots,
          curve: 'linear' as const,
          showMark: p.dots ? true : alone(data.values[i]!),
          valueFormatter: (v: number | null) => (v === null ? '—' : p.format(v)),
        }))}
      >
        <ChartsSurface>
          <ChartsGrid horizontal />
          {!p.dots && <LinePlot />}
          <MarkPlot />
          <ChartsAxisHighlight x="line" />
          <ChartsXAxis axisId="x" tickLabelStyle={{ fontSize: 10 }} />
          <ChartsYAxis axisId="y" tickLabelStyle={{ fontSize: 10 }} />
        </ChartsSurface>
        <ChartsTooltipContainer trigger="axis"><Tip series={p.series} details={details} /></ChartsTooltipContainer>
      </ChartsDataProvider>
    </Box>
  );
}
