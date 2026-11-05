import { ExpandLess, ExpandMore } from '@mui/icons-material';
import { Box, Button, Link as MuiLink, Stack } from '@mui/material';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { Related } from '#shared/task.ts';
import { useFormat } from '#client/hooks/format.ts';
import TaskLine from './TaskLine.tsx';

/**
 * What is related to this task, gathered by itself and never added by hand
 * (decision 107): waiting that has ended, with when (decision 113), and tasks mentioned by number on
 * either side, each with a link to the place. Folded: it is for looking back.
 */
export default function (p: { items: Related[] }) {
  const { t } = useTranslation();
  const format = useFormat();
  const [open, setOpen] = useState(false);
  // What it was and when: why this task was started may be just that (decision 113).
  const waited = (task: Related) => {
    const what = t(task.waited === 'waits' ? 'task.relatedWaits' : 'task.relatedWaitedBy');
    const period = task.waitedFrom && task.waitedTo
      ? t('task.relatedPeriod', { what, from: format.date(task.waitedFrom), to: format.date(task.waitedTo) })
      : task.waitedTo ? t('task.relatedUntil', { what, to: format.date(task.waitedTo) }) : what;
    return task.removed ? t('task.relatedRemoved', { what: period }) : period;
  };
  if (p.items.length === 0) return null;
  return (
    <Stack spacing={0.75}>
      <Box>
        <Button
          size="small"
          color="inherit"
          startIcon={open ? <ExpandLess /> : <ExpandMore />}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? t('task.related') : t('task.relatedShow', { count: p.items.length })}
        </Button>
      </Box>
      {open && p.items.map((task) => (
        <Stack key={task.id} spacing={0.25}>
          <TaskLine
            task={task}
            {...(task.waited && { note: waited(task) })}
          />
          {task.mentions.map((m) => (
            <MuiLink
              key={`${m.out}-${m.commentId}`}
              component={Link}
              to={`/tasks/${m.taskId}#${m.commentId === null ? 'context' : `comment-${m.commentId}`}`}
              variant="caption"
              sx={{ pl: 1 }}
            >
              {t(m.out
                ? (m.commentId === null ? 'task.relatedOutContext' : 'task.relatedOutComment')
                : (m.commentId === null ? 'task.relatedInContext' : 'task.relatedInComment'))}
            </MuiLink>
          ))}
        </Stack>
      ))}
    </Stack>
  );
}
