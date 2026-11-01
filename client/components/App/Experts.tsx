import { PersonAdd } from '@mui/icons-material';
import { Chip, Stack, Typography } from '@mui/material';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useEmployees } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import EmployeeAvatar from './EmployeeAvatar.tsx';
import HelpTip from './HelpTip.tsx';

const SHOWN = 3;

/**
 * Who knows the subject of these tags (Task.experts): those who worked most
 * on tasks sharing them, a click invites one. The answer to "I do not know
 * who should take it" (decision 97). Nothing is shown when nobody did.
 */
export default function (p: { tags: string[]; exclude: number[]; onPick: (employeeId: number) => void }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const employees = useEmployees();
  const experts = useQuery(trpc.Task.experts.queryOptions({ tags: p.tags }, { enabled: p.tags.length > 0, placeholderData: keepPreviousData }));
  const shown = (experts.data ?? []).filter((x) => !p.exclude.includes(x.employeeId) && employees.has(x.employeeId)).slice(0, SHOWN);
  if (p.tags.length === 0 || shown.length === 0) return null;
  return (
    <Stack direction="row" sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {t('experts.title')} <HelpTip title={t('experts.hint')} />
      </Typography>
      {shown.map((x) => {
        const employee = employees.get(x.employeeId)!;
        return (
          <Chip
            key={x.employeeId}
            size="small"
            variant="outlined"
            avatar={<EmployeeAvatar employee={employee} size={20} />}
            label={t('experts.item', { name: employee.fullName, count: x.tasks })}
            deleteIcon={<PersonAdd />}
            onDelete={() => p.onPick(x.employeeId)}
            onClick={() => p.onPick(x.employeeId)}
          />
        );
      })}
    </Stack>
  );
}
