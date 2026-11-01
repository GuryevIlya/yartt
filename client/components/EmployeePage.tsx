import { Box, Chip, CircularProgress, Paper, Stack, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { fromDay, today, useFormat } from '#client/hooks/format.ts';
import { useMe } from '#client/hooks/me.ts';
import { useEmployees } from '#client/hooks/task.ts';
import EmployeeAvatar from './App/EmployeeAvatar.tsx';
import { ViewAs } from '#client/hooks/viewAs.ts';
import Fold from './App/Fold.tsx';
import Stats from './EmployeePage/Stats.tsx';
import { DayColumns } from './MyDayPage.tsx';
import History from './MyDayPage/History.tsx';

// An employee's page (docs/product/interface.md, 4a): the metrics of a
// period and all their days; for a manager above, their My day as they see
// it — every block, read-only (decision 83). Seen by the employee and every
// manager above; only the direct manager scores (the server checks both).
// A bot has no days or metrics: its page is who it is and who runs it; its
// settings are in Bots under My team.
export default function (p: { id: number }) {
  const { t } = useTranslation();
  const format = useFormat();
  const me = useMe();
  const employees = useEmployees();
  const employee = employees.get(p.id);
  if (!employee) return employees.size === 0 ? <CircularProgress sx={{ m: 'auto' }} /> : null;
  const manager = employee.managerId === null ? undefined : employees.get(employee.managerId);
  const away = employee.nextDay !== null && employee.nextDay > today();

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 2, width: '100%', maxWidth: 1280, mx: 'auto' }}>
      {/* The person and the metrics with the chart on top; their days below, full width. */}
      <Paper sx={{ p: 2, display: 'flex', gap: 2, alignItems: 'flex-start', flex: '1 1 300px', minWidth: 0 }}>
        <EmployeeAvatar employee={employee} size={56} />
        <Stack spacing={0.5} sx={{ minWidth: 0 }}>
          <Typography variant="h2" sx={{ fontWeight: 600 }}>{employee.fullName}</Typography>
          <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
            {employee.kind === 'bot' && <Chip size="small" label={t('bots.chip')} />}
            {employee.dismissedAt !== null && <Chip size="small" label={t('team.dismissed')} />}
            {employee.idpBlockedAt !== null && employee.dismissedAt === null && (
              <Chip size="small" color="error" variant="outlined" label={t('employee.idpBlocked')} />
            )}
            {away && <Chip size="small" color="warning" label={t('employee.awayUntil', { day: format.dayDate(employee.nextDay!) })} />}
          </Stack>
          {employee.about && <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{employee.about}</Typography>}
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {manager ? t('employee.manager', { name: manager.fullName }) : t('employee.noManager')}
          </Typography>
        </Stack>
      </Paper>
      {employee.kind === 'human' && (
        <>
          <Box sx={{ flex: '3 1 640px', minWidth: 0 }}>
            <Stats employeeId={p.id} />
          </Box>
          {p.id === me.id ? (
            <Box sx={{ flex: '1 1 100%', minWidth: 0 }}>
              <History onEmployeePage />
            </Box>
          ) : (
            <>
              <Box sx={{ flex: '1 1 100%', minWidth: 0 }}>
                <ViewAs.Provider value={{ as: p.id }}>
                  <DayColumns canScore={employee.managerId === me.id} />
                </ViewAs.Provider>
              </Box>
              <Box sx={{ flex: '1 1 100%', minWidth: 0 }}>
                <Fold id="employee.days" title={t('employee.allDays')} summary={t('employee.allDaysHint')}>
                  {(fold) => (
                    <Stack spacing={1}>
                      <Box sx={{ alignSelf: 'flex-end' }}>{fold}</Box>
                      <History employeeId={p.id} canScore={employee.managerId === me.id} onEmployeePage />
                    </Stack>
                  )}
                </Fold>
              </Box>
            </>
          )}
        </>
      )}
    </Box>
  );
}
