import { WarningAmber } from '@mui/icons-material';
import { Chip, Tooltip } from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { TaskHeader } from '#shared/task.ts';
import { useFormat } from '#client/hooks/format.ts';
import { useEmployees } from '#client/hooks/task.ts';
import { OWN_HINT } from '../App/TaskHint.tsx';

/**
 * "At risk": the deadline will not be met by a person's plan, or a latest
 * deadline around the task is broken — it waits for a task due too late,
 * or it is due too late for a task waiting for it (decision 66). Status
 * colour with an icon and a word, never colour alone; the hint says each
 * reason with the names and numbers.
 */
export default function (p: { task: TaskHeader }) {
  const { t } = useTranslation();
  const format = useFormat();
  const employees = useEmployees();
  const { risk, deadline, late, delays } = p.task;
  const reasons: string[] = [];
  if (risk && deadline) {
    reasons.push(t('task.risk.hint', {
      days: Math.max(0, Math.round((deadline.getTime() - Date.now()) / 86_400_000)),
      name: employees.get(risk.employeeId)?.fullName ?? `#${risk.employeeId}`,
      planned: format.minutes(risk.plannedMinutes),
      capacity: format.minutes(risk.capacityMinutes),
    }));
  }
  for (const id of late) reasons.push(t('task.risk.late', { id }));
  for (const id of delays) reasons.push(t('task.risk.delays', { id }));
  if (reasons.length === 0) return null;
  return (
    <Tooltip describeChild title={<span style={{ whiteSpace: 'pre-line' }}>{reasons.join('\n')}</span>}>
      <Chip size="small" color="warning" variant="outlined" icon={<WarningAmber />} label={t('task.risk.label')} {...OWN_HINT} />
    </Tooltip>
  );
}
