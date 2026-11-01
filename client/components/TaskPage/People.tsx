import { HourglassBottom, Lock, Public, TaskAlt } from '@mui/icons-material';
import {
  Alert, Autocomplete, Box, Button, IconButton, Pagination, Paper, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Person } from '#shared/observer.ts';
import type { TaskPage } from '#shared/task.ts';
import { useFormat } from '#client/hooks/format.ts';
import { useEmployees, usePronoun, useTaskRefresh, POLL_MS } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import EmployeeAvatar from '../App/EmployeeAvatar.tsx';
import { employeeFilter, employeeOption } from '../App/employeeOption.tsx';
import Experts from '../App/Experts.tsx';

const PAGE_SIZE = 10;

/**
 * Observers of a private task, or everyone who opened a public one: one list
 * by last visit, with icons for time spent and planned, and the observation
 * periods on hover. Any participant brings someone in, like a copy in an
 * email; the rest of access is the owner's (decisions 15, 82).
 */
export default function (p: { task: TaskPage }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const format = useFormat();
  const employees = useEmployees();
  const refresh = useTaskRefresh();
  const pronoun = usePronoun();
  const [page, setPage] = useState(1);
  const [leftOut, setLeftOut] = useState<number[]>([]);
  const [addInput, setAddInput] = useState('');
  const taskId = p.task.id;
  const isOwner = p.task.access === 'owner';
  const inside = isOwner || p.task.access === 'observer';
  const people = useQuery(trpc.Observer.list.queryOptions({ taskId, page }, { refetchInterval: POLL_MS }));

  const done = { onSuccess: refresh };
  const add = useMutation(trpc.Observer.add.mutationOptions(done));
  const remove = useMutation(trpc.Observer.remove.mutationOptions(done));
  const approve = useMutation(trpc.Observer.approve.mutationOptions(done));
  const reject = useMutation(trpc.Observer.reject.mutationOptions(done));
  const leave = useMutation(trpc.Observer.leave.mutationOptions(done));
  const makePublic = useMutation(trpc.Task.makePublic.mutationOptions(done));
  const makePrivate = useMutation(trpc.Task.makePrivate.mutationOptions({ onSuccess: (ids) => { setLeftOut((ids as number[] | undefined) ?? []); refresh(); } }));

  const name = (id: number | null) => (id === null ? '' : (employees.get(id)?.fullName ?? `#${id}`));
  const total = people.data?.total ?? 0;
  const activeIds = new Set((people.data?.items ?? []).filter((x) => x.active).map((x) => x.employeeId));
  const candidates = [...employees.values()].filter((e) => e.dismissedAt === null && !activeIds.has(e.id));

  // Why someone observes without having been added by hand: they own the
  // task, manage someone who observes it, or were mentioned.
  const reason = (person: Person): string | null =>
    !person.active ? null
    : person.lockedBy === 'owner' ? t('task.people.lockOwner')
    : person.lockedBy !== null ? t('task.people.lockManager', { name: name(person.lockedBy) })
    : person.openMention && !p.task.isPublic ? t('task.people.mentioned', pronoun(person.employeeId))
    : null;

  // One line per person; every period they observed is in the tooltip.
  const periods = (person: Person) => (
    <Stack spacing={0.25}>
      {reason(person) && <b>{reason(person)}</b>}
      {person.periods.map((period) => (
        <span key={period.from.getTime()}>
          {t('task.people.period', { from: format.date(period.from), to: period.to ? format.date(period.to) : t('task.people.now') })}
          {' · '}
          {period.addedBy === null ? t('task.people.addedBySystem') : t('task.people.addedBy', { name: name(period.addedBy), ...pronoun(period.addedBy) })}
          {period.to && ` · ${period.removedBy === null ? t('task.people.leftSelf', pronoun(person.employeeId)) : t('task.people.removedBy', { name: name(period.removedBy), ...pronoun(period.removedBy) })}`}
        </span>
      ))}
    </Stack>
  );

  return (
    <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      <Typography variant="h3" sx={{ fontWeight: 600 }}>
        {p.task.isPublic ? t('task.people.visitors', { count: total }) : t('task.people.observers', { count: activeIds.size })}
      </Typography>
      {/* The work the task took and has ahead: everyone's hours together (decision 68). */}
      {people.data && (people.data.spentMinutes > 0 || people.data.leftMinutes > 0) && (
        <Typography variant="body2" sx={{ color: 'text.secondary', mt: -0.75 }}>
          {t('task.people.totals', { spent: format.minutes(people.data.spentMinutes), left: format.minutes(people.data.leftMinutes) })}
        </Typography>
      )}

      {leftOut.length > 0 && (
        <Alert
          severity="info"
          onClose={() => setLeftOut([])}
          action={
            <Button color="inherit" size="small" onClick={() => {
              for (const employeeId of leftOut) add.mutate({ taskId, employeeId });
              setLeftOut([]);
            }}>
              {t('task.people.bringBackAll', { count: leftOut.length })}
            </Button>
          }
        >
          {t('task.people.madePrivate', { names: leftOut.map(name).join(', ') })}
        </Alert>
      )}

      {isOwner && people.data?.requests.map((r) => (
        <Stack key={r.employeeId} direction="row" sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1, p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
          {employees.get(r.employeeId) && <EmployeeAvatar employee={employees.get(r.employeeId)!} size={24} />}
          <Typography sx={{ flex: '1 1 120px', minWidth: 0 }}>
            {name(r.employeeId)} <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>{t('task.people.requests')}</Typography>
          </Typography>
          <Button size="small" variant="contained" onClick={() => approve.mutate({ taskId, employeeId: r.employeeId })}>{t('task.people.approve')}</Button>
          <Button size="small" color="inherit" onClick={() => reject.mutate({ taskId, employeeId: r.employeeId })}>{t('task.people.reject')}</Button>
        </Stack>
      ))}

      {inside && !p.task.isPublic && (
        <Autocomplete
          size="small"
          options={candidates}
          value={null}
          // Picked — added, and the field is empty again for the next one.
          inputValue={addInput}
          onInputChange={(_e, value, reason) => setAddInput(reason === 'reset' ? '' : value)}
          getOptionLabel={(e) => e.fullName}
          renderOption={(props, e) => employeeOption(props, e)}
          filterOptions={employeeFilter}
          onChange={(_e, value) => { if (value) add.mutate({ taskId, employeeId: value.id }); setAddInput(''); }}
          renderInput={(params) => (
            <TextField {...params} variant="outlined" placeholder={t('task.people.add')} helperText={t('task.people.addHint')} />
          )}
        />
      )}
      {inside && !p.task.isPublic && (
        <Experts
          tags={p.task.tags.map((tag) => tag.name)}
          exclude={[...activeIds]}
          onPick={(employeeId) => add.mutate({ taskId, employeeId })}
        />
      )}

      <Box>
        {people.data?.items.map((person) => {
          const employee = employees.get(person.employeeId);
          const gone = !p.task.isPublic && !person.active;
          return (
            <Tooltip key={person.employeeId} title={person.periods.length > 0 || reason(person) ? periods(person) : ''} placement="left">
              <Stack
                direction="row"
                spacing={1}
                sx={{ alignItems: 'center', minHeight: 44, borderTop: 1, borderColor: 'divider', '& .hide': { visibility: 'hidden' }, '&:hover .hide, &:focus-within .hide': { visibility: 'visible' } }}
              >
                {employee && <Box sx={{ opacity: gone ? 0.45 : 1 }}><EmployeeAvatar employee={employee} size={24} /></Box>}
                <Stack sx={{ flexGrow: 1, minWidth: 0, color: gone ? 'text.secondary' : 'text.primary' }}>
                  <Typography noWrap>{name(person.employeeId)}</Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {gone ? `${t('task.people.gone')} · ` : ''}
                    {person.lastVisit ? format.relative(person.lastVisit) : t('task.people.neverVisited', pronoun(person.employeeId))}
                    {reason(person) ? ` · ${reason(person)}` : ''}
                  </Typography>
                </Stack>
                {person.spentMinutes > 0 && (
                  <Tooltip title={t('task.people.spent', { time: format.minutes(person.spentMinutes) })}>
                    <IconButton size="small" aria-label={t('task.people.spent', { time: format.minutes(person.spentMinutes) })}><TaskAlt fontSize="small" /></IconButton>
                  </Tooltip>
                )}
                {person.leftMinutes !== null && (
                  <Tooltip title={t('task.people.plan', { time: format.minutes(person.leftMinutes) })}>
                    <IconButton size="small" aria-label={t('task.people.plan', { time: format.minutes(person.leftMinutes) })}><HourglassBottom fontSize="small" /></IconButton>
                  </Tooltip>
                )}
                <Box sx={{ width: 76, display: 'flex', justifyContent: 'flex-end' }}>
                  {person.lockedBy !== null && <Lock fontSize="small" sx={{ color: 'text.disabled', mx: 1 }} />}
                  {isOwner && person.active && person.lockedBy === null && (
                    <Button className="hide" size="small" color="inherit" onClick={() => remove.mutate({ taskId, employeeId: person.employeeId })}>
                      {t('task.people.hide')}
                    </Button>
                  )}
                  {isOwner && gone && employee?.dismissedAt === null && (
                    <Button size="small" onClick={() => add.mutate({ taskId, employeeId: person.employeeId })}>{t('task.people.bringBack')}</Button>
                  )}
                </Box>
              </Stack>
            </Tooltip>
          );
        })}
      </Box>

      {total > PAGE_SIZE && (
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'flex-end', gap: 1 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('task.people.page', { from: (page - 1) * PAGE_SIZE + 1, to: Math.min(page * PAGE_SIZE, total), total })}
          </Typography>
          <Pagination size="small" count={Math.ceil(total / PAGE_SIZE)} page={page} onChange={(_e, value) => setPage(value)} />
        </Stack>
      )}

      {isOwner && (p.task.isPublic ? (
        <Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
          <Button startIcon={<Lock />} variant="outlined" onClick={() => makePrivate.mutate({ id: taskId })}>{t('task.people.makePrivate')}</Button>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('task.people.makePrivateHint')}</Typography>
        </Stack>
      ) : (
        <Button startIcon={<Public />} color="inherit" sx={{ alignSelf: 'flex-start' }} onClick={() => makePublic.mutate({ id: taskId })}>
          {t('task.people.makePublic')}
        </Button>
      ))}
      {p.task.access === 'observer' && (
        <Button color="inherit" size="small" sx={{ alignSelf: 'flex-start' }} onClick={() => leave.mutate({ taskId })}>
          {t('task.people.leave')}
        </Button>
      )}
    </Paper>
  );
}
