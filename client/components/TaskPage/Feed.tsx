import { Check, Event, ExpandLess, ExpandMore, HourglassBottom, Link as LinkIcon, Reply as ReplyIcon, TaskAlt } from '@mui/icons-material';
import { Box, Button, ButtonBase, Chip, Pagination, Paper, Stack, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CommentBase, FeedFilter, FeedItem } from '#shared/comment.ts';
import { useFormat } from '#client/hooks/format.ts';
import { fromDay } from '#client/hooks/format.ts';
import { POLL_MS, useEmployees } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import CommentItem from './CommentItem.tsx';
import Composer, { type ReplyTo } from './Composer.tsx';
import TaskLine from './TaskLine.tsx';

const PAGE_SIZE = 20;

/**
 * The feed: open mentions by default — what still waits for someone; "All
 * events" shows every comment, deadline move, mention in another task and
 * time logged or planned, with pages.
 */
export default function (p: { taskId: number }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const format = useFormat();
  const [chosen, setChosen] = useState<FeedFilter | null>(null);
  const [page, setPage] = useState(1);
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null);
  const reply = (c: CommentBase) => setReplyTo({ id: c.id, authorId: c.authorId });

  // Until the reader picks, an empty "open mentions" falls back to everything.
  const counts = useQuery(trpc.Comment.list.queryOptions({ taskId: p.taskId, filter: 'mentions', page: 1 }, { refetchInterval: POLL_MS }));
  const filter: FeedFilter = chosen ?? (counts.data && counts.data.openMentions === 0 ? 'all' : 'mentions');
  const feed = useQuery(trpc.Comment.list.queryOptions({ taskId: p.taskId, filter, page }, { refetchInterval: POLL_MS }));

  const pick = (value: FeedFilter) => {
    setChosen(value);
    setPage(1);
  };

  const pages = Math.ceil((feed.data?.total ?? 0) / PAGE_SIZE);

  return (
    <Paper sx={{ display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ p: 1.5 }}>
        <Composer taskId={p.taskId} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} shortcut />
      </Box>
      <Stack direction="row" spacing={1} sx={{ px: 1.5, pb: 1.5 }}>
        {([['mentions', t('task.feed.mentions'), feed.data?.openMentions], ['all', t('task.feed.all'), feed.data?.all]] as const).map(
          ([value, label, count]) => (
            <Chip
              key={value}
              label={`${label} · ${count ?? '…'}`}
              color={filter === value ? 'primary' : 'default'}
              variant={filter === value ? 'filled' : 'outlined'}
              onClick={() => pick(value)}
              aria-pressed={filter === value}
            />
          ),
        )}
      </Stack>

      {feed.data?.items.map((item) =>
        item.kind === 'comment' ? (
          <CommentItem key={`c${item.id}`} taskId={p.taskId} comment={item} onReply={reply} />
        ) : (
          <EventLine
            key={`${item.kind}${item.at.getTime()}${'employeeId' in item ? item.employeeId : ''}${'commentId' in item ? item.commentId : ''}`}
            taskId={p.taskId}
            item={item}
            onReply={reply}
          />
        ),
      )}

      {feed.data && feed.data.items.length === 0 && (
        <Typography sx={{ px: 2, py: 2, borderTop: 1, borderColor: 'divider', color: 'text.secondary' }}>{t('task.feed.empty')}</Typography>
      )}
      {filter === 'mentions' && (
        <Stack direction="row" spacing={1} sx={{ px: 2, py: 1.25, borderTop: 1, borderColor: 'divider', alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('task.feed.onlyMentions')}</Typography>
          <Button size="small" onClick={() => pick('all')}>{t('task.feed.all')}</Button>
        </Stack>
      )}
      {pages > 1 && (
        <Pagination
          count={pages}
          page={page}
          onChange={(_e, value) => setPage(value)}
          sx={{ display: 'flex', justifyContent: 'center', py: 1.25, borderTop: 1, borderColor: 'divider' }}
        />
      )}
    </Paper>
  );
}

/** A grey line between the comments: something happened to the task. */
function EventLine(p: { taskId: number; item: Exclude<FeedItem, { kind: 'comment' }>; onReply: (c: CommentBase) => void }) {
  const { t } = useTranslation();
  const format = useFormat();
  const employees = useEmployees();
  const name = (id: number) => employees.get(id)?.fullName ?? `#${id}`;
  const [open, setOpen] = useState(false);
  const { item } = p;

  let icon, text;
  switch (item.kind) {
    case 'reply':
      // The reply lives in its thread; here it marks the moment, and unfolds the thread in place.
      icon = <ReplyIcon fontSize="small" />;
      text = (
        <>
          <ButtonBase
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            sx={{ font: 'inherit', color: 'inherit', textAlign: 'left', gap: 0.5, borderRadius: 0.5 }}
          >
            {t('task.feed.replied', { name: name(item.authorId), to: name(item.toAuthorId), excerpt: item.excerpt })}
            {open ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
          </ButtonBase>
          {open && (
            <Box sx={{ mt: 1, mx: -2, color: 'text.primary' }}>
              <CommentItem taskId={p.taskId} comment={item.thread} onReply={p.onReply} />
            </Box>
          )}
        </>
      );
      break;
    case 'deadline':
      icon = <Event fontSize="small" />;
      text = item.from === null && item.to !== null ? t('task.feed.deadlineSet', { to: format.dateTime(item.to) })
        : item.to === null && item.from !== null ? t('task.feed.deadlineCleared', { from: format.dateTime(item.from) })
        : t('task.feed.deadlineMoved', { from: format.dateTime(item.from!), to: format.dateTime(item.to!) });
      break;
    case 'closed':
      icon = <Check fontSize="small" />;
      text = item.at > item.deadline ? t('task.feed.closedLate', { deadline: format.dateTime(item.deadline) }) : t('task.feed.closedTask');
      break;
    case 'mentioned_in':
      icon = <LinkIcon fontSize="small" />;
      text = (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <span>{t('task.feed.mentionedIn')}</span>
          <Box sx={{ flex: '1 1 240px', minWidth: 0 }}><TaskLine dense task={item.task} /></Box>
        </Stack>
      );
      break;
    case 'spent': {
      icon = <TaskAlt fontSize="small" />;
      const days = item.entries;
      if (days.length === 1) {
        text = t('task.feed.spent', { name: name(item.employeeId), time: format.minutes(item.minutes), day: format.date(fromDay(days[0]!.day)) });
        break;
      }
      // Several entries in a row: one line, the days on demand.
      text = (
        <>
          <ButtonBase
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            sx={{ font: 'inherit', color: 'inherit', textAlign: 'left', gap: 0.5, borderRadius: 0.5 }}
          >
            {t('task.feed.spentDays', {
              name: name(item.employeeId),
              time: format.minutes(item.minutes),
              count: days.length,
              from: format.date(fromDay(days[days.length - 1]!.day)),
              to: format.date(fromDay(days[0]!.day)),
            })}
            {open ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
          </ButtonBase>
          {open && (
            <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
              {days.map((e, i) => (
                <li key={`${e.day}-${i}`}>{format.date(fromDay(e.day))} — {format.minutes(e.minutes)}</li>
              ))}
            </Box>
          )}
        </>
      );
      break;
    }
    case 'plan':
      icon = <HourglassBottom fontSize="small" />;
      text = item.minutes === null
        ? t('task.feed.planCleared', { name: name(item.employeeId) })
        : t('task.feed.plan', { name: name(item.employeeId), time: format.minutes(item.minutes) }) + (item.about ? `: ${t('common.quote', { text: item.about })}` : '');
      break;
  }

  return (
    <Stack
      direction="row"
      spacing={1.25}
      sx={{ px: 2, py: 1.25, borderTop: 1, borderColor: 'divider', alignItems: 'flex-start', color: 'text.secondary' }}
    >
      {icon}
      <Typography component="div" variant="body2" sx={{ flexGrow: 1, minWidth: 0 }}>{text}</Typography>
      <Typography variant="caption" sx={{ fontFamily: 'monospace', flexShrink: 0 }}>{format.dateTime(item.at)}</Typography>
    </Stack>
  );
}
