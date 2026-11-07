import { Box, Stack, Tooltip, Typography } from '@mui/material';
import type { KeyboardEvent, MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { Tag, TaskHeader } from '#shared/task.ts';
import { useFormat } from '#client/hooks/format.ts';
import { useEmployees } from '#client/hooks/task.ts';
import EmployeeAvatar from '../App/EmployeeAvatar.tsx';
import TaskHint, { OWN_HINT } from '../App/TaskHint.tsx';
import TagChip from '../App/TagChip.tsx';
import PriorityChip from './PriorityChip.tsx';
import RiskChip from './RiskChip.tsx';

/** A title — the task's tags — as text, the way it reads outside Current tasks. */
export const taskTitle = (tags: Pick<Tag, 'name'>[]) => tags.map((tag) => tag.name).join(' · ');

/**
 * A task as a line: number, tags, priority, a note (`noteWarn` — something is wrong), deadline, owner. A closed
 * one (its owner closed it) is struck through; an overdue one says so by its deadline (decision 93). `dense` — only the number,
 * tags and the note, for narrow lists. Hovered, it shows its context and
 * everyone's time on it (TaskHint). The tags read as text; with `onTag`
 * (Current tasks) they are chips, and a tag clicked does that instead of
 * opening the task — it narrows the search. With `onNote` the note is a
 * control of its own: clicked, it does that instead of opening the task (a
 * latest deadline is changed by clicking it).
 */
export default function (p: {
  task: TaskHeader; note?: string; noteHint?: string; noteWarn?: boolean; dense?: boolean; onTag?: (tag: Tag) => void;
  onNote?: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const employees = useEmployees();
  const owner = p.task.ownerId === null ? undefined : employees.get(p.task.ownerId);
  const closed = p.task.closed;
  const overdue = !closed && p.task.deadline !== null && p.task.deadline <= new Date();

  return (
    <TaskHint taskId={p.task.id}>
    <Stack
      direction="row"
      component={Link}
      to={`/tasks/${p.task.id}`}
      sx={{
        alignItems: 'center', flexWrap: 'wrap', gap: 1, px: 1.25, py: p.dense ? 0.25 : 0.75, border: 1, borderColor: 'divider',
        borderRadius: 1, color: closed ? 'text.secondary' : 'text.primary', textDecoration: 'none',
        bgcolor: closed ? 'action.hover' : 'background.paper', '&:hover': { borderColor: 'primary.light' },
      }}
    >
      {/* The number looks like the link it is: the way into the task wherever it is shown. */}
      <Typography variant="body2" sx={{ fontFamily: 'monospace', color: 'primary.main', '*:hover > &': { textDecoration: 'underline' } }}>#{p.task.id}</Typography>
      {p.onTag ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, flex: '1 1 160px', minWidth: 0, textDecoration: closed ? 'line-through' : 'none' }}>
          {p.task.tags.map((tag) => (
            <Tooltip key={tag.id} title={t('search.addTag')} describeChild>
              <TagChip
                size="small"
                tag={tag}
                {...OWN_HINT}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); p.onTag!(tag); }}
              />
            </Tooltip>
          ))}
        </Box>
      ) : (
        <Typography
          variant="body2"
          sx={{ flex: '1 1 160px', minWidth: 0, overflowWrap: 'anywhere', textDecoration: closed ? 'line-through' : 'none' }}
        >
          {taskTitle(p.task.tags)}
        </Typography>
      )}
      {!p.dense && !closed && <RiskChip task={p.task} />}
      {!p.dense && <PriorityChip priority={p.task.priority} />}
      {p.note && (
        <Tooltip title={p.noteHint ?? ''} describeChild>
          <Typography
            variant="caption"
            {...(p.noteHint ? OWN_HINT : {})}
            {...(p.onNote && {
              role: 'button',
              tabIndex: 0,
              onClick: (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); p.onNote!(); },
              onKeyDown: (e: KeyboardEvent) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                e.stopPropagation();
                p.onNote!();
              },
            })}
            sx={{
              color: p.noteWarn ? 'warning.dark' : 'text.secondary',
              fontWeight: p.noteWarn ? 600 : undefined,
              ...(p.noteHint && { cursor: 'help', borderBottom: 1, borderStyle: 'dotted', borderColor: 'text.disabled' }),
              // What can be changed looks like it: the link color, a dashed line, a frame on hover.
              ...(p.onNote && {
                cursor: 'pointer', color: p.noteWarn ? 'warning.dark' : 'primary.main', borderStyle: 'dashed', borderColor: 'currentcolor',
                px: 0.5, mx: -0.5, borderRadius: 0.5, '&:hover, &:focus-visible': { bgcolor: 'action.hover', outline: 'none' },
              }),
            }}
          >
            {p.note}
          </Typography>
        </Tooltip>
      )}
      {!p.dense && (
        <>
          <Typography variant="body2" sx={{ minWidth: 64, textAlign: 'right', ...(overdue && { color: 'error.main', fontWeight: 500 }) }}>
            {p.task.deadline ? format.date(p.task.deadline) : t('task.noDeadline')}
            {overdue && ` · ${t('task.overdueShort')}`}
          </Typography>
          {owner && <EmployeeAvatar employee={owner} size={24} />}
        </>
      )}
    </Stack>
    </TaskHint>
  );
}
