import { AlternateEmail, ChatBubbleOutline, EventBusy, HourglassEmpty, Link as LinkIcon, LockOpen, NotificationsActive, SwapHoriz, TaskAlt } from '@mui/icons-material';
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Paper, Stack, Table, TableBody, TableCell,
  TableHead, TableRow, Tooltip, Typography,
} from '@mui/material';
import { keyframes } from '@mui/material/styles';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { TodoItem, TodoReview } from '#shared/myDay.ts';
import { useFormat } from '#client/hooks/format.ts';
import { usePendingTodo } from '#client/hooks/pending.ts';
import { POLL_MS, useEmployees, usePronoun, useTaskRefresh } from '#client/hooks/task.ts';
import { markReviewRead, useStore } from '#client/hooks/store.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import { useViewAs } from '#client/hooks/viewAs.ts';
import RichView from '../App/RichView.tsx';
import Composer from '../TaskPage/Composer.tsx';
import MentionReply from '../TaskPage/MentionReply.tsx';
import { PutOff } from '../TaskPage/Reminders.tsx';
import TaskLine from '../TaskPage/TaskLine.tsx';

/** The title lights up three times, so the eye finds the block after the scroll. */
const flash = keyframes`
  0%, 100% { background-color: transparent; }
  50% { background-color: rgba(245, 124, 0, 0.28); }
`;

/**
 * What waits for my reaction, each item with its action right there, the
 * items of one task under one line of it. Empty is the goal. The bell in the
 * top line brings it into view and flashes its title.
 */
export default function () {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const { as, readOnly } = useViewAs();
  const pronoun = usePronoun();
  const todo = useQuery(trpc.MyDay.todo.queryOptions(as === undefined ? undefined : { as }, { refetchInterval: POLL_MS }));
  // My own answers waiting to be sent count as given (decision 114); a manager's view shows what the server has.
  const mine = usePendingTodo(todo.data);
  const items = as === undefined ? mine : todo.data;
  const focus = useStore((s) => s.todoFocus);
  const block = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!focus) return;
    // After the route change has shown My day (it is hidden under a task or a person).
    const timer = setTimeout(() => {
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      block.current?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
      title.current?.focus({ preventScroll: true });
    }, 50);
    return () => clearTimeout(timer);
  }, [focus]);

  return (
    <Paper ref={block} sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5, scrollMarginTop: 16 }}>
      <Typography
        key={focus}
        ref={title}
        tabIndex={-1}
        variant="h3"
        sx={{
          fontWeight: 600, borderRadius: 1, mx: -0.5, px: 0.5, outline: 'none',
          ...(focus > 0 && { animation: `${flash} 0.6s ease-in-out 3`, '@media (prefers-reduced-motion: reduce)': { animation: 'none' } }),
        }}
      >
        {readOnly ? t('myDay.todo.titleOf', pronoun(as)) : t('myDay.todo.title')}
        {items && items.length > 0 && ` · ${new Set(items.map((item) => item.task.id)).size}`}
      </Typography>
      {items?.length === 0 && (
        <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 2 }}>{t('myDay.empty')}</Typography>
      )}
      <TodoList items={items ?? []} readOnly={readOnly} />
    </Paper>
  );
}

/**
 * The items under their tasks (decision 94). `readOnly` — someone else's,
 * on their page for a manager: what waits for them, without their buttons
 * or the hints meant for them. `inTask` — on the task's own page, without
 * its line.
 */
export function TodoList(p: { items: TodoItem[]; readOnly?: boolean; inTask?: boolean }) {
  return groups(p.items).map((group) => (
    <Stack key={group.task.id} spacing={1}>
      {!p.inTask && <TaskLine task={group.task} />}
      {group.items.map((item) => (item.kind === 'review'
        ? <Review key={key(item)} item={item} readOnly={p.readOnly} />
        : <Item key={key(item)} item={item} readOnly={p.readOnly} />))}
    </Stack>
  ));
}

/** Items of one task together, under one line of it: the tasks in the order the server put them, by deadline. */
function groups(items: TodoItem[]): { task: TodoItem['task']; items: TodoItem[] }[] {
  const byTask = new Map<number, { task: TodoItem['task']; items: TodoItem[] }>();
  for (const item of items) {
    const group = byTask.get(item.task.id);
    if (group) group.items.push(item);
    else byTask.set(item.task.id, { task: item.task, items: [item] });
  }
  return [...byTask.values()];
}

const key = (item: TodoItem) =>
  item.kind === 'mention' ? `m${item.task.id}-${item.commentId}`
  : item.kind === 'request' ? `r${item.task.id}-${item.employeeId}`
  : item.kind === 'remind' ? `t${item.task.id}-${item.at.getTime()}`
  : item.kind === 'plan_left' ? `${item.kind}${item.task.id}`
  : `v${item.task.id}`;

/** One line of a group: its icon, what it says, and its buttons unless read only. */
function Line(p: { icon: React.ReactNode; children: React.ReactNode; actions?: React.ReactNode; readOnly?: boolean }) {
  return (
    <Stack direction="row" sx={{ alignItems: 'flex-start', pl: 1.25, gap: 1, flexWrap: 'wrap' }}>
      <Box sx={{ color: 'text.secondary', pt: 0.25 }}>{p.icon}</Box>
      <Box sx={{ flex: '1 1 220px', minWidth: 0 }}>{p.children}</Box>
      {!p.readOnly && p.actions && <Stack direction="row" spacing={1} sx={{ flexShrink: 0, ml: 'auto' }}>{p.actions}</Stack>}
    </Stack>
  );
}

/**
 * The review of my task (decision 94): every notice since I last looked,
 * and one button that takes them away — up to the newest shown, so what
 * comes later stays. "No intervention needed", after a warning; "Finish"
 * when the task is overdue. The new comments are read in a table first.
 * A task handed to me shows only that, with "Accept".
 */
function Review(p: { item: TodoReview; readOnly?: boolean }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const format = useFormat();
  const employees = useEmployees();
  const refresh = useTaskRefresh();
  const [table, setTable] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const readUntil = useStore((s) => s.reviewRead[p.item.task.id]);
  const name = (id: number) => employees.get(id)?.fullName ?? `#${id}`;
  const reviewed = useMutation(trpc.Task.markReviewed.mutationOptions({ onSuccess: refresh }));
  const finish = useMutation(trpc.Task.close.mutationOptions({ onSuccess: refresh }));

  const { item } = p;
  const { deadline } = item;
  const overdue = deadline?.overdue === true;
  const read = item.comments === null || (readUntil ?? 0) >= item.comments.at.getTime();
  const blocked = !read ? t('task.review.readFirst')
    : overdue && deadline.plans.length > 0 ? t('myDay.todo.closeAfterPlans')
    : '';
  const what = [
    item.comments && t('task.review.comments', { count: item.comments.count }),
    item.links.length > 0 && t('task.review.links', { count: item.links.length }),
    item.done.length > 0 && t('task.review.done', { count: item.done.length }),
    item.waiterClosed.length > 0 && t('task.review.waiterClosed', { count: item.waiterClosed.length }),
    deadline && !overdue && t('task.review.closing'),
  ].filter(Boolean).join(', ');
  const moveDeadline = (
    // To the deadline field of the task's page: on that page itself the link only opens the field.
    <Button size="small" component={Link} to={{ pathname: `/tasks/${item.task.id}`, hash: 'deadline' }}>{t('myDay.todo.moveDeadline')}</Button>
  );

  // Handed to me and not accepted yet: the handover alone; what came before it is not mine to review.
  if (item.handedAt) {
    return (
      <Line
        icon={<SwapHoriz fontSize="small" />}
        readOnly={p.readOnly}
        actions={(
          <Button size="small" variant="contained" disabled={reviewed.isPending} onClick={() => reviewed.mutate({ id: item.task.id, until: item.at })}>
            {t('myDay.todo.accept')}
          </Button>
        )}
      >
        <Typography variant="body2">{t('myDay.todo.handed')} · {format.relative(item.handedAt)}</Typography>
        {!p.readOnly && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('myDay.todo.handedHint')}</Typography>}
      </Line>
    );
  }

  return (
    <Stack spacing={1}>
      {deadline && (
        <Line icon={<EventBusy fontSize="small" color={overdue ? 'error' : 'warning'} />} readOnly={p.readOnly} actions={moveDeadline}>
          <Typography variant="body2">
            {t(overdue ? 'myDay.todo.overdue' : 'myDay.todo.closing', { time: format.relative(deadline.at), at: format.dateTime(deadline.at) })}
          </Typography>
          {deadline.plans.length > 0 && (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {t('myDay.todo.plansLeft', {
                plans: deadline.plans
                  .map((x) => t('myDay.todo.planOf', { name: name(x.employeeId), time: format.minutes(x.minutes) }) + (x.about ? ` (${t('common.quote', { text: x.about })})` : ''))
                  .join(', '),
              })}
            </Typography>
          )}
          {!p.readOnly && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t(overdue ? 'myDay.todo.overdueHint' : 'myDay.todo.closingHint')}
            </Typography>
          )}
        </Line>
      )}
      {item.links.map((l) => (
        <Line key={`${l.waits}${l.task.id}`} icon={<LinkIcon fontSize="small" />} readOnly={p.readOnly}>
          <Typography variant="body2">
            {t(l.waits ? 'myDay.todo.linkWaits' : 'myDay.todo.linkWaitedOnBy', { name: name(l.by) })} · {format.relative(l.at)}
          </Typography>
          <TaskLine task={l.task} dense />
        </Line>
      ))}
      {item.done.map((d) => (
        <Line key={d.task.id} icon={<TaskAlt fontSize="small" color="success" />} readOnly={p.readOnly}>
          <Typography variant="body2">{t('myDay.todo.done')} · {format.relative(d.at)}</Typography>
          <TaskLine task={d.task} dense />
        </Line>
      ))}
      {item.waiterClosed.map((d) => (
        <Line key={d.task.id} icon={<TaskAlt fontSize="small" />} readOnly={p.readOnly}>
          <Typography variant="body2">{t('myDay.todo.waiterClosed')} · {format.relative(d.at)}</Typography>
          <TaskLine task={d.task} dense />
        </Line>
      ))}
      {item.comments && (
        <Line
          icon={<ChatBubbleOutline fontSize="small" />}
          readOnly={p.readOnly}
          actions={<Button size="small" variant={read ? 'text' : 'outlined'} onClick={() => setTable(true)}>{t('myDay.todo.read')}</Button>}
        >
          <Typography variant="body2">
            {t('myDay.todo.review', { count: item.comments.count, authors: item.comments.authorIds.map(name).join(', ') })}
            {' · '}{format.relative(item.comments.at)}
          </Typography>
        </Line>
      )}
      {!p.readOnly && (
        <Stack direction="row" sx={{ justifyContent: 'flex-end' }}>
          <Tooltip title={blocked}>
            <span>
              {overdue ? (
                <Button size="small" variant="contained" disabled={blocked !== '' || finish.isPending}
                  onClick={() => finish.mutate({ id: item.task.id, reviewedUntil: item.at })}>
                  {t('task.finish')}
                </Button>
              ) : (
                <Button size="small" variant="contained" disabled={blocked !== '' || reviewed.isPending} onClick={() => setConfirm(true)}>
                  {t('task.review.button')}
                </Button>
              )}
            </span>
          </Tooltip>
        </Stack>
      )}
      {table && item.comments && (
        <ReviewComments taskId={item.task.id} onClose={() => setTable(false)} />
      )}
      <Dialog open={confirm} onClose={() => setConfirm(false)}>
        <DialogTitle>{t('task.review.confirmTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t('task.review.confirm', { list: what })}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={() => setConfirm(false)}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            disabled={reviewed.isPending}
            onClick={() => { setConfirm(false); reviewed.mutate({ id: item.task.id, until: item.at }); }}
          >
            {t('task.review.button')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

/**
 * The new comments of my task in full, oldest first. Scrolled to the end,
 * they count as read up to the last one, and the review's button opens.
 */
function ReviewComments(p: { taskId: number; onClose: () => void }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const format = useFormat();
  const employees = useEmployees();
  const comments = useQuery(trpc.Comment.unreviewed.queryOptions({ taskId: p.taskId }));
  const end = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(false);
  const last = comments.data?.at(-1)?.at;

  useEffect(() => {
    if (!end.current || !last) return;
    const seen = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setAtEnd(true);
      markReviewRead(p.taskId, last);
    });
    seen.observe(end.current);
    return () => seen.disconnect();
  }, [p.taskId, last]);

  return (
    <Dialog open onClose={p.onClose} maxWidth="md" fullWidth scroll="paper">
      <DialogTitle>{t('task.review.table')}</DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell>{t('task.review.who')}</TableCell>
              <TableCell>{t('task.review.when')}</TableCell>
              <TableCell sx={{ width: '100%' }}>{t('task.review.text')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(comments.data ?? []).map((c) => (
              <TableRow key={c.id} sx={{ verticalAlign: 'top' }}>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>{employees.get(c.authorId)?.fullName ?? `#${c.authorId}`}</TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap', fontFamily: 'monospace' }}>{format.dateTime(c.at)}</TableCell>
                <TableCell>
                  {c.replyTo && (
                    <Typography variant="body2" sx={{ px: 1, py: 0.25, mb: 0.5, borderRadius: 1, bgcolor: 'action.selected', color: 'text.secondary' }}>
                      {employees.get(c.replyTo.authorId)?.fullName}: {c.replyTo.excerpt}
                    </Typography>
                  )}
                  <RichView html={c.html} />
                  {c.files.length > 0 && (
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>{c.files.map((f) => f.name).join(', ')}</Typography>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Box ref={end} sx={{ height: 1 }} />
      </DialogContent>
      <DialogActions>
        <Typography variant="body2" sx={{ color: 'text.secondary', mr: 'auto', pl: 1 }}>
          {atEnd ? t('task.review.readAll') : t('task.review.scrollDown')}
        </Typography>
        <Button onClick={p.onClose}>{t('common.close')}</Button>
      </DialogActions>
    </Dialog>
  );
}

function Item(p: { item: Exclude<TodoItem, TodoReview>; readOnly?: boolean }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const format = useFormat();
  const employees = useEmployees();
  const refresh = useTaskRefresh();
  const pronoun = usePronoun();
  const [replying, setReplying] = useState(false);
  const name = (id: number) => employees.get(id)?.fullName ?? `#${id}`;

  const closeMention = useMutation(trpc.Comment.closeMention.mutationOptions({ onSuccess: refresh }));
  const approve = useMutation(trpc.Observer.approve.mutationOptions({ onSuccess: refresh }));
  const reject = useMutation(trpc.Observer.reject.mutationOptions({ onSuccess: refresh }));
  const removeRemind = useMutation(trpc.Remind.remove.mutationOptions({ onSuccess: refresh }));
  const clearPlan = useMutation(trpc.Time.setLeft.mutationOptions({ onSuccess: refresh }));

  const { item } = p;
  let icon, text, actions;
  if (item.kind === 'mention') {
    icon = <AlternateEmail fontSize="small" />;
    text = (
      <>
        <Typography variant="body2">
          {t(p.readOnly ? 'myDay.todo.mentionOf' : 'myDay.todo.mention', { name: name(item.authorId), ...pronoun(item.authorId) })}
          {' · '}{format.relative(item.at)}
        </Typography>
        {item.excerpt && <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('common.quote', { text: item.excerpt })}</Typography>}
        {item.replies.length > 0 && (
          <Stack spacing={0.5} sx={{ mt: 0.5 }}>
            {item.replies.map((r) => <MentionReply key={r.id} who={t(p.readOnly ? 'myDay.todo.reply' : 'myDay.todo.myReply')} reply={r} />)}
          </Stack>
        )}
      </>
    );
    actions = (
      <>
        <Button size="small" onClick={() => setReplying((v) => !v)}>{t('task.feed.reply')}</Button>
        {/* After a reply "Done"; without one "No reply needed" — the author sees which (decision 95). */}
        {item.replies.length ? (
          <Button size="small" variant="contained" disabled={closeMention.isPending}
            onClick={() => closeMention.mutate({ taskId: item.task.id, commentId: item.commentId })}>
            {t('task.feed.done')}
          </Button>
        ) : (
          <Tooltip title={t('task.feed.noReplyHint')} describeChild>
            <Button size="small" variant="contained" disabled={closeMention.isPending}
              onClick={() => closeMention.mutate({ taskId: item.task.id, commentId: item.commentId })}>
              {t('task.feed.noReply')}
            </Button>
          </Tooltip>
        )}
      </>
    );
  } else if (item.kind === 'remind') {
    icon = <NotificationsActive fontSize="small" />;
    text = (
      <>
        <Typography variant="body2">{t('myDay.todo.remind', { time: format.dateTime(item.at) })}</Typography>
        {item.text && <Typography variant="body2" sx={{ color: 'text.secondary' }}>{item.text}</Typography>}
      </>
    );
    actions = (
      <>
        <PutOff taskId={item.task.id} at={item.at} deadline={item.task.deadline} />
        <Button size="small" variant="contained" disabled={removeRemind.isPending}
          onClick={() => removeRemind.mutate({ taskId: item.task.id, at: item.at })}>
          {t('task.remind.done')}
        </Button>
      </>
    );
  } else if (item.kind === 'plan_left') {
    icon = <HourglassEmpty fontSize="small" />;
    text = (
      <>
        <Typography variant="body2">{t('myDay.todo.planLeft', { time: format.minutes(item.minutes), at: format.dateTime(item.at) })}</Typography>
        {item.about && <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('common.quote', { text: item.about })}</Typography>}
        {!p.readOnly && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('myDay.todo.planLeftHint')}</Typography>}
      </>
    );
    actions = (
      <Button size="small" variant="contained" disabled={clearPlan.isPending}
        onClick={() => clearPlan.mutate({ taskId: item.task.id, minutes: null })}>
        {t('myDay.todo.clearPlan')}
      </Button>
    );
  } else {
    const input = { taskId: item.task.id, employeeId: item.employeeId };
    icon = <LockOpen fontSize="small" />;
    text = <Typography variant="body2">{t('myDay.todo.request', { name: name(item.employeeId) })}</Typography>;
    actions = (
      <>
        <Button size="small" color="inherit" disabled={reject.isPending} onClick={() => reject.mutate(input)}>
          {t('task.people.reject')}
        </Button>
        <Button size="small" variant="contained" disabled={approve.isPending} onClick={() => approve.mutate(input)}>
          {t('task.people.approve')}
        </Button>
      </>
    );
  }

  return (
    <Stack spacing={1}>
      <Line icon={icon} actions={actions} readOnly={p.readOnly}>{text}</Line>
      {replying && item.kind === 'mention' && (
        <Composer
          taskId={item.task.id}
          replyTo={{ id: item.commentId, authorId: item.authorId }}
          onCancelReply={() => setReplying(false)}
          onSent={() => setReplying(false)}
        />
      )}
    </Stack>
  );
}
