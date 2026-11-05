import { Check, Edit, Lock, Public } from '@mui/icons-material';
import {
  Alert, Box, Button, Chip, IconButton, MenuItem, Paper, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TagPart } from '#shared/tags.ts';
import { PRIORITIES, type Priority, type TaskDetails, type TaskPage } from '#shared/task.ts';
import { fromLocalInput, toLocalInput, useFormat } from '#client/hooks/format.ts';
import { useDraft } from '#client/hooks/drafts.ts';
import { useMe } from '#client/hooks/me.ts';
import { POLL_MS, useEmployees, useTaskRefresh } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import EmployeeAvatar from '../App/EmployeeAvatar.tsx';
import TagInput, { useTitle } from '../App/TagInput.tsx';
import RichEditor, { type RichEditorHandle } from '../App/RichEditor.tsx';
import RichView from '../App/RichView.tsx';
import PriorityChip from './PriorityChip.tsx';
import { taskTitle } from './TaskLine.tsx';
import RiskChip from './RiskChip.tsx';
import TagDescriptions from '../App/TagDescriptions.tsx';
import Dependencies from './Dependencies.tsx';
import TransferDialog from './TransferDialog.tsx';
import TakenLink from '../App/TakenLink.tsx';
import { TodoList } from '../MyDayPage/Todo.tsx';

const label = { fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'text.secondary' } as const;

/**
 * Header, what waits for me here, context and dependencies — one sheet. The owner
 * edits in place; everyone else reads (decision 15). Tags and context being
 * edited are drafts: leaving the page keeps them until Save or Cancel.
 */
export default function (p: { task: TaskPage & { details: TaskDetails } }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const format = useFormat();
  const employees = useEmployees();
  const refresh = useTaskRefresh();
  const { task } = p;
  const d = task.details;
  const isOwner = task.access === 'owner';
  const owner = task.ownerId === null ? undefined : employees.get(task.ownerId);
  // Only the owner closes a task; a passed deadline leaves it open, overdue (decision 93).
  const closed = task.closed;
  const overdue = !closed && task.deadline !== null && task.deadline <= new Date();
  const me = useMe();
  // The owner and the owner's direct manager hand the task over; an ownerless one is taken.
  const canTransfer = task.ownerId !== null && (isOwner || owner?.managerId === me.id);
  const [transferring, setTransferring] = useState(false);

  const update = useMutation(trpc.Task.update.mutationOptions({ onSuccess: refresh }));
  const setDeadline = useMutation(trpc.Task.setDeadline.mutationOptions({ onSuccess: refresh }));
  const todo = useQuery(trpc.MyDay.todo.queryOptions({ taskId: task.id }, { refetchInterval: POLL_MS }));
  const close = useMutation(trpc.Task.close.mutationOptions({ onSuccess: refresh }));
  const take = useMutation(trpc.Task.take.mutationOptions({ onSuccess: refresh }));

  // The title being changed: its tags and the text typed after them (decision 55).
  const [editingTags, setEditingTags] = useDraft<{ parts: TagPart[]; input: string } | null>(`title:${task.id}`, null);
  const title = useTitle(editingTags?.parts ?? [], editingTags?.input ?? '', task.id);
  const [contextDraft, setContextDraft] = useDraft<string | null>(`context:${task.id}`, null);
  const editingContext = contextDraft !== null;
  const editor = useRef<RichEditorHandle>(null);

  const saveContext = () => {
    const html = editor.current?.isEmpty() ? null : (editor.current?.getHtml() ?? null);
    update.mutate({ id: task.id, context: html }, { onSuccess: () => setContextDraft(null) });
  };

  // What a deadline means here: a promise that reminds its owner, never closes the task (decision 93).
  const deadlineHint = task.deadline
    ? t('task.deadlineHint', { date: format.dateTime(task.deadline), relative: format.relative(task.deadline) })
    : t('task.deadlineNoneHint');


  return (
    <Paper sx={{ p: { xs: 2, sm: 3 }, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 2, alignItems: 'flex-start' }}>
        <Stack spacing={1.25} sx={{ flex: '1 1 420px', minWidth: 0 }}>
          {editingTags ? (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
              <TagInput
                value={editingTags.parts}
                onChange={(parts) => setEditingTags((prev) => prev && { ...prev, parts })}
                input={editingTags.input}
                onInputChange={(input) => setEditingTags((prev) => prev && { ...prev, input })}
                allowNew
                autoFocus
                label={t('task.tags')}
                helperText={title.taken ? <TakenLink id={title.taken.id} />
                  : title.pickFirst ? t('title.pickFirst', { name: title.pickFirst }) : undefined}
                sx={{ flexGrow: 1 }}
              />
              <Button
                sx={{ mt: 1 }}
                disabled={!title.ready || update.isPending}
                onClick={() => update.mutate({ id: task.id, tags: title.names }, { onSuccess: () => setEditingTags(null) })}
              >
                {t('common.save')}
              </Button>
              <Button color="inherit" sx={{ mt: 1 }} onClick={() => setEditingTags(null)}>{t('common.cancel')}</Button>
            </Stack>
          ) : (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
              {/* The title is its tags, read as text, as everywhere but Current tasks. */}
              <Typography component="h1" sx={{ fontSize: 20, fontWeight: 600, overflowWrap: 'anywhere' }}>
                <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 400, color: 'text.secondary', mr: 1 }}>#{task.id}</Box>
                {taskTitle(task.tags)}
              </Typography>
              {isOwner && (
                <Tooltip title={t('task.edit')}>
                  <IconButton size="small" onClick={() => setEditingTags({ parts: task.tags.map((tag) => ({ tag })), input: '' })}>
                    <Edit fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
            </Box>
          )}

          <Stack direction="row" sx={{ flexWrap: 'wrap', alignItems: 'center', gap: '8px 20px', color: 'text.secondary' }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', color: 'text.primary' }}>
              {owner && <EmployeeAvatar employee={owner} size={24} />}
              <span>{owner?.fullName ?? t('task.ownerless')}</span>
              {canTransfer && (
                <Button size="small" color="inherit" onClick={() => setTransferring(true)}>{t('task.transfer.action')}</Button>
              )}
              {task.ownerId === null && (
                <Button size="small" variant="outlined" disabled={take.isPending} onClick={() => take.mutate({ id: task.id })}>
                  {t('task.transfer.take')}
                </Button>
              )}
            </Stack>
            {isOwner ? (
              <TextField
                select
                variant="standard"
                value={task.priority}
                onChange={(e) => update.mutate({ id: task.id, priority: e.target.value as Priority })}
                slotProps={{ input: { disableUnderline: true } }}
              >
                {PRIORITIES.map((priority) => <MenuItem key={priority} value={priority}><PriorityChip priority={priority} /></MenuItem>)}
              </TextField>
            ) : (
              <PriorityChip priority={task.priority} />
            )}
            <Tooltip title={deadlineHint} describeChild>
              {isOwner ? (
                <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                  <TextField
                    type="datetime-local"
                    variant="standard"
                    slotProps={{ htmlInput: { 'aria-label': t('task.deadline') } }}
                    value={task.deadline ? toLocalInput(task.deadline) : ''}
                    onChange={(e) => { const deadline = fromLocalInput(e.target.value); if (deadline) setDeadline.mutate({ id: task.id, deadline }); }}
                  />
                  {task.deadline && (
                    <Button size="small" color="inherit" onClick={() => setDeadline.mutate({ id: task.id, deadline: null })}>
                      {t('task.clearDeadline')}
                    </Button>
                  )}
                </Stack>
              ) : (
                <span>{task.deadline ? format.dateTime(task.deadline) : t('task.noDeadline')}</span>
              )}
            </Tooltip>
            {task.deadline && (
              <Box component="span" sx={overdue ? { color: 'error.main', fontWeight: 500 } : undefined}>
                {closed ? t('task.closed') : overdue ? t('task.overdue', { relative: format.relative(task.deadline) }) : format.relative(task.deadline)}
              </Box>
            )}
            {!closed && <RiskChip task={task} />}
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
              {task.isPublic ? <Public fontSize="small" /> : <Lock fontSize="small" />}
              <span>{task.isPublic ? t('task.public') : t('task.private')}</span>
            </Stack>
          </Stack>
        </Stack>
        {isOwner && !closed && (
          <Button variant="contained" startIcon={<Check />} disabled={close.isPending} onClick={() => close.mutate({ id: task.id })}>
            {t('task.finish')}
          </Button>
        )}
      </Stack>

      {todo.data && todo.data.length > 0 && (
        // What waits for me here, the same as in My day (decision 94).
        <Alert severity="warning" variant="outlined" icon={false} sx={{ '& .MuiAlert-message': { width: '100%' } }}>
          <Stack spacing={1}>
            <Typography sx={label}>{t('myDay.todo.title')}</Typography>
            <TodoList items={todo.data} inTask />
          </Stack>
        </Alert>
      )}

      <Stack id="context" spacing={0.75}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography sx={label}>{t('task.context')}</Typography>
          {isOwner && !editingContext && (
            <IconButton size="small" aria-label={t('task.edit')} onClick={() => setContextDraft(d.context ?? '')}>
              <Edit fontSize="small" />
            </IconButton>
          )}
        </Stack>
        {editingContext ? (
          <Stack spacing={1}>
            <RichEditor
              handle={editor}
              initial={contextDraft}
              placeholder={t('task.contextPlaceholder')}
              taskPicker={{ exclude: task.id }}
              onSubmit={saveContext}
              onChange={setContextDraft}
              autoFocus
            />
            <Stack direction="row" spacing={1}>
              <Button variant="contained" disabled={update.isPending} onClick={saveContext}>{t('common.save')}</Button>
              <Button color="inherit" onClick={() => setContextDraft(null)}>{t('common.cancel')}</Button>
            </Stack>
          </Stack>
        ) : d.context ? (
          <RichView html={d.context} />
        ) : (
          <Typography sx={{ color: 'text.secondary' }}>{t('task.contextEmpty')}</Typography>
        )}
      </Stack>

      <TagDescriptions items={d.tagDescriptions} tags={task.tags} />
      <Dependencies task={task} />
      {transferring && task.ownerId !== null && (
        <TransferDialog taskId={task.id} ownerId={task.ownerId} onClose={() => setTransferring(false)} />
      )}
    </Paper>
  );
}
