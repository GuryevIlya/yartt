import { Add, AddTask, Close } from '@mui/icons-material';
import { Box, Button, Checkbox, FormControlLabel, IconButton, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { FIRST_DAY, LAST_DAY, typedMoment } from '#shared/employee.ts';
import type { TagPart } from '#shared/tags.ts';
import type { Dependency, TaskDetails, TaskHeader, TaskPage } from '#shared/task.ts';
import { fromLocalInput, toLocalInput, useFormat } from '#client/hooks/format.ts';
import { useDraft } from '#client/hooks/drafts.ts';
import { useMe } from '#client/hooks/me.ts';
import { useTaskRefresh } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import TaskLine from './TaskLine.tsx';
import RelatedTasks from './RelatedTasks.tsx';
import TaskPicker from './TaskPicker.tsx';

const label = { fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'text.secondary' } as const;

/**
 * A link being made: in "waits for" (`waits`) this task waits for the
 * picked one, otherwise the picked one — mine — waits for this. `picked`
 * is the other task once found; `parts`/`input` — what is typed to find it.
 */
type Draft = {
  waits: boolean;
  picked: TaskHeader | null;
  parts: TagPart[];
  input: string;
  /** A latest deadline is set: the task waited for has to be done by `latest` (a datetime-local value). */
  limited: boolean;
  latest: string;
  editing: number | null;
};

/**
 * "Waits for", then "Waited on by". Anyone who sees this task links on
 * either side another task they see — found by tags or number as in the
 * search (decision 55), or a new one made from here — and removes what
 * they linked; the owner of the waiting task removes any (decision 94). The latest deadline is the
 * waiting task's owner's: offered to them when linking, on the line —
 * "needed by …", or "no latest deadline" — and changed by clicking it; its
 * hint says what it means and who may change it. It forbids nothing:
 * broken, it is marked on the line and puts both tasks at risk (decision
 * 66). "+" in the search opens the new-task form with the title typed,
 * tied to this one.
 */
export default function (p: { task: TaskPage & { details: TaskDetails } }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const format = useFormat();
  const refresh = useTaskRefresh();
  const { task } = p;
  const isOwner = task.access === 'owner';
  const me = useMe();
  // The owner of the waiting task removes any link, whoever added one removes it.
  const canRemove = (dep: Dependency, waits: boolean) => (waits ? isOwner : dep.ownerId === me.id) || dep.addedBy === me.id;
  // Only the owner of the waiting task sets its latest deadline.
  const canLimit = (d: Draft) => (d.waits ? isOwner : d.picked?.ownerId === me.id);
  const [draft, setDraft] = useDraft<Draft | null>(`link:${task.id}`, null);
  // A latest deadline to start from: the earlier of the two deadlines — the task waited for is due by
  // then and the waiting one can still make it — else the one there is, else a week ahead.
  const suggest = (dependency: Date | null, dependent: Date | null) => toLocalInput(
    dependency && dependent ? (dependency < dependent ? dependency : dependent)
      : dependency ?? dependent ?? new Date(Date.now() + 7 * 86_400_000),
  );
  const start = (waits: boolean) => setDraft({ waits, picked: null, parts: [], input: '', limited: false, latest: '', editing: null });
  const set = useMutation(trpc.Dependency.set.mutationOptions({ onSuccess: () => { refresh(); setDraft(null); } }));
  const remove = useMutation(trpc.Dependency.remove.mutationOptions({ onSuccess: refresh }));

  // In "Waits for" the line is the task waited for, this one waits; in "Waited on by" the other way round.
  const sides = (dep: Dependency, waits: boolean) => (waits
    ? { dependent: task, dependency: dep as TaskHeader }
    : { dependent: dep as TaskHeader, dependency: task as TaskHeader });
  // Broken as the server counts it (dependency_risk()), so the line never disagrees with "At risk".
  const broken = (dep: Dependency, waits: boolean) => (waits ? task.late : task.delays).includes(dep.id);
  // Not set is a value too: shown as such, so it is seen that it can be set, and by whom.
  const note = (dep: Dependency, waits: boolean) =>
    dep.latestAt === null ? t('task.latestNone') : t(waits ? 'task.latestMine' : 'task.latestTheirs', { date: format.dateTime(dep.latestAt) });
  const hint = (dep: Dependency, waits: boolean) => {
    const { dependent, dependency } = sides(dep, waits);
    const params = { dependent: dependent.id, dependency: dependency.id, date: dep.latestAt ? format.dateTime(dep.latestAt) : '' };
    const state = dep.latestAt === null ? t('task.latestNoneHint', params)
      : dependency.deadline === null ? t('task.latestHintNone', params)
      : !broken(dep, waits) ? t('task.latestHint', { ...params, deadline: format.dateTime(dependency.deadline) })
      : dependency.deadline > dep.latestAt ? t('task.latestHintLate', { ...params, deadline: format.dateTime(dependency.deadline) })
      : t('task.latestHintPassed', params);
    return `${state} ${waits && isOwner ? t('task.latestClick') : t('task.latestWho', params)}`;
  };
  const edit = (dep: Dependency) => setDraft({
    waits: true,
    picked: dep,
    parts: [],
    input: '',
    limited: true,
    latest: dep.latestAt ? toLocalInput(dep.latestAt) : suggest(dep.deadline, task.deadline),
    editing: dep.id,
  });
  // A link removed while it was being edited (here or by someone else) leaves nothing to edit.
  const editedGone = draft?.editing != null && !task.details.waitsFor.some((dep) => dep.id === draft.editing);
  useEffect(() => { if (editedGone) setDraft(null); }, [editedGone, setDraft]);

  const typed = draft?.limited && canLimit(draft) ? fromLocalInput(draft.latest) : null;
  const latest = typed && typedMoment(typed) ? typed : null;
  const limited = !!draft?.limited && canLimit(draft);
  const valid = !!draft?.picked && draft.picked.id !== task.id && (!limited || latest !== null);
  // A latest deadline after the waiting task's own deadline is allowed (decision 66), but said:
  // met just in time, it already leaves the waiting task late.
  const ownDeadline = draft?.picked ? (draft.waits ? task.deadline : draft.picked.deadline) : null;
  const afterOwn = limited && latest !== null && ownDeadline !== null && latest > ownDeadline;
  const save = () => valid && set.mutate(draft!.waits
    ? { taskId: task.id, value: draft!.picked!.id, latestAt: limited ? latest : null }
    : { taskId: draft!.picked!.id, value: task.id, latestAt: limited ? latest : null });

  const groups = [
    { title: t('task.waitsFor'), items: task.details.waitsFor, waits: true },
    { title: t('task.waitedOnBy'), items: task.details.waitedOnBy, waits: false },
  ];

  // The picked task with its latest deadline: in place of its line when it is edited, under the list when it is new.
  const editor = (d: Draft) => (
    <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <Box sx={{ flexBasis: '100%', display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}><TaskLine task={d.picked!} /></Box>
        {d.editing === null && (
          <Tooltip title={t('task.dependency.other')}>
            <IconButton size="small" onClick={() => setDraft({ ...d, picked: null })}><Close fontSize="small" /></IconButton>
          </Tooltip>
        )}
      </Box>
      {canLimit(d) && <FormControlLabel
        control={<Checkbox checked={d.limited} onChange={(e) => setDraft({
          ...d,
          limited: e.target.checked,
          latest: d.latest || (d.waits ? suggest(d.picked!.deadline, task.deadline) : suggest(task.deadline, d.picked!.deadline)),
        })} />}
        label={t('task.dependency.limit')}
      />}
      {d.limited && canLimit(d) && (
        <TextField
          type="datetime-local"
          size="small"
          label={t('task.dependency.latest', { dependency: d.waits ? d.picked!.id : task.id })}
          value={d.latest}
          onChange={(e) => setDraft({ ...d, latest: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
          error={latest === null}
          autoFocus={d.editing !== null}
          slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: `${FIRST_DAY}T00:00`, max: `${LAST_DAY}T23:59` } }}
          sx={{ width: 240 }}
        />
      )}
      <Button variant="contained" disabled={!valid || set.isPending} onClick={save}>{t('common.save')}</Button>
      <Button color="inherit" onClick={() => setDraft(null)}>{t('common.cancel')}</Button>
      {afterOwn && (
        <Typography variant="caption" sx={{ color: 'warning.dark', fontWeight: 600, flexBasis: '100%' }}>
          {t('task.dependency.afterOwn', {
            dependent: d.waits ? task.id : d.picked!.id,
            dependency: d.waits ? d.picked!.id : task.id,
            deadline: format.dateTime(ownDeadline!),
          })}
        </Typography>
      )}
      <Typography variant="caption" sx={{ color: 'text.secondary', flexBasis: '100%' }}>
        {(() => {
          // Spelled out with the numbers: which task is waited for, and which one would not make it.
          const ids = d.waits
            ? { dependent: task.id, dependency: d.picked!.id }
            : { dependent: d.picked!.id, dependency: task.id };
          return t(d.limited && canLimit(d) ? 'task.dependency.limitHelp' : 'task.dependency.freeHelp', ids);
        })()}
      </Typography>
    </Stack>
  );

  return (
    <>
      {groups.map((g) => (
        <Stack key={g.title} spacing={0.75}>
          <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
            <Typography sx={label}>{g.title}</Typography>
            {!draft && (
              <Button size="small" startIcon={<Add />} onClick={() => start(g.waits)}>
                {t('task.dependency.add')}
              </Button>
            )}
            {!draft && (
              // Someone taking part: a task of their own when they need a deadline of their own, else a plan here (decision 94).
              <Tooltip title={g.waits && !isOwner ? t('task.dependency.newHint', { id: task.id }) : ''} describeChild>
                <Button
                  size="small"
                  startIcon={<AddTask />}
                  component={Link}
                  to={`/tasks/new?${g.waits ? 'waitedOnBy' : 'waitsFor'}=${task.id}`}
                >
                  {t('task.dependency.newTask')}
                </Button>
              </Tooltip>
            )}
          </Stack>
          {g.items.map((dep) => (g.waits && draft?.editing === dep.id ? <Box key={dep.id}>{editor(draft)}</Box> : (
            <Stack key={dep.id} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <TaskLine
                  task={dep}
                  note={note(dep, g.waits)}
                  noteHint={hint(dep, g.waits)}
                  noteWarn={broken(dep, g.waits)}
                  onNote={g.waits && isOwner && !draft ? () => edit(dep) : undefined}
                />
              </Box>
              {canRemove(dep, g.waits) && (
                <Tooltip title={t('task.dependency.remove')}>
                  <IconButton size="small" disabled={remove.isPending} onClick={() => remove.mutate(g.waits ? { taskId: task.id, value: dep.id } : { taskId: dep.id, value: task.id })}>
                    <Close fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
            </Stack>
          )))}
          {draft && draft.waits === g.waits && !draft.picked && (
            <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <TaskPicker
                parts={draft.parts}
                input={draft.input}
                onChange={(next) => setDraft({ ...draft, ...next })}
                exclude={task.id}
                newTask={`/tasks/new?${g.waits ? 'waitedOnBy' : 'waitsFor'}=${task.id}`}
                // A task linked already is edited where it is, not shown twice.
                onPick={(picked) => setDraft({ ...draft, picked, editing: g.items.some((dep) => dep.id === picked.id) ? picked.id : null })}
              />
              <Button color="inherit" onClick={() => setDraft(null)}>{t('common.cancel')}</Button>
            </Stack>
          )}
          {draft && draft.waits === g.waits && draft.picked && draft.editing === null && editor(draft)}
        </Stack>
      ))}
      <RelatedTasks items={task.details.related} />
    </>
  );
}
