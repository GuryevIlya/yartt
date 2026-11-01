import { AlternateEmail } from '@mui/icons-material';
import { Autocomplete, Button, Chip, IconButton, Stack, TextField, Tooltip } from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { awaitsReview, newestReaction, type CommentBase, type Mention } from '#shared/comment.ts';
import { useMe } from '#client/hooks/me.ts';
import { useEmployees, useTaskRefresh } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import { employeeFilter, employeeOption } from '../App/employeeOption.tsx';

/** Where a mention is (decision 95): open, answered, closed with or without a reply. */
export function mentionState(m: Pick<Mention, 'closedAt' | 'replies'>) {
  if (!m.closedAt) return m.replies.length ? 'answered' as const : 'open' as const;
  return m.replies.length ? 'replied' as const : 'noReply' as const;
}

/**
 * The mentions of a comment. The mentioned closes their own: "Done" after
 * a reply, "No reply needed" without one. The author adds people later,
 * takes a mention back until it has a reaction (decision 95), and once
 * they have seen the reactions presses "No intervention needed": the
 * comment leaves their Waiting for others until the next one (decision
 * 98). More than half of the people in the task are shown as "everyone
 * but …", unfolded by a click.
 */
export default function (p: { taskId: number; comment: CommentBase }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const me = useMe();
  const employees = useEmployees();
  const refresh = useTaskRefresh();
  const c = p.comment;
  const mine = c.authorId === me.id;
  const mentionable = useQuery(trpc.Observer.mentionable.queryOptions({ taskId: p.taskId }));
  const close = useMutation(trpc.Comment.closeMention.mutationOptions({ onSuccess: refresh }));
  const review = useMutation(trpc.Comment.reviewComment.mutationOptions({ onSuccess: refresh }));
  const remove = useMutation(trpc.Comment.removeMention.mutationOptions({ onSuccess: refresh }));
  const add = useMutation(trpc.Comment.addMention.mutationOptions({ onSuccess: refresh }));
  const [unfolded, setUnfolded] = useState(false);
  const [adding, setAdding] = useState(false);
  const name = (id: number) => employees.get(id)?.fullName ?? `#${id}`;

  const mentioned = new Set(c.mentions.map((m) => m.employeeId));
  // The share is taken against the people now: nothing about the comment is stored apart.
  const others = (mentionable.data?.people ?? []).filter((id) => id !== c.authorId);
  const missing = others.filter((id) => !mentioned.has(id));
  const folded = !unfolded && c.mentions.length > 1 && c.mentions.length * 2 > others.length;
  const shown = folded ? c.mentions.filter((m) => m.employeeId === me.id) : c.mentions;
  const reviewable = mine && awaitsReview(c);
  const candidates = [...employees.values()].filter((e) => e.dismissedAt === null && e.id !== me.id && !mentioned.has(e.id)
    && (mentionable.data?.everyone || mentionable.data?.ids.includes(e.id)));

  if (c.mentions.length === 0 && !mine) return null;
  return (
    <>
      {folded && (
        <Chip
          size="small"
          color="primary"
          variant="outlined"
          label={missing.length ? t('task.feed.allBut', { names: missing.map(name).join(', ') }) : t('task.feed.allPeople')}
          onClick={() => setUnfolded(true)}
        />
      )}
      {shown.map((m) => {
        const state = mentionState(m);
        return (
          <Stack key={m.employeeId} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <Chip
              size="small"
              color={m.closedAt ? 'default' : 'primary'}
              variant={m.closedAt ? 'outlined' : 'filled'}
              label={`@${name(m.employeeId)} · ${t(`task.feed.mentionState.${state}`)}`}
              // Taken back only until the first reaction: an answered request is not erased.
              onDelete={mine && state === 'open' && !remove.isPending
                ? () => remove.mutate({ taskId: p.taskId, commentId: c.id, employeeId: m.employeeId })
                : undefined}
            />
            {m.employeeId === me.id && !m.closedAt && (
              m.replies.length ? (
                <Button size="small" variant="contained" disabled={close.isPending}
                  onClick={() => close.mutate({ taskId: p.taskId, commentId: c.id })}>
                  {t('task.feed.done')}
                </Button>
              ) : (
                <Tooltip title={t('task.feed.noReplyHint')} describeChild>
                  <Button size="small" color="inherit" variant="outlined" disabled={close.isPending}
                    onClick={() => close.mutate({ taskId: p.taskId, commentId: c.id })}>
                    {t('task.feed.noReply')}
                  </Button>
                </Tooltip>
              )
            )}
          </Stack>
        );
      })}
      {mine && (adding ? (
        <Autocomplete
          size="small"
          sx={{ minWidth: 220 }}
          options={candidates}
          getOptionLabel={(e) => e.fullName}
          renderOption={(props, e) => employeeOption(props, e)}
          filterOptions={employeeFilter}
          onChange={(_e, value) => {
            if (value) add.mutate({ taskId: p.taskId, commentId: c.id, employeeId: value.id });
            setAdding(false);
          }}
          onBlur={() => setAdding(false)}
          renderInput={(params) => <TextField {...params} autoFocus placeholder={t('task.composer.mention')} />}
          openOnFocus
        />
      ) : (
        <Tooltip title={t('task.feed.addMention')}>
          <IconButton size="small" aria-label={t('task.feed.addMention')} onClick={() => setAdding(true)}>
            <AlternateEmail fontSize="small" />
          </IconButton>
        </Tooltip>
      ))}
      {reviewable && (
        <Tooltip title={t('task.feed.reviewHint')} describeChild>
          <Button size="small" variant="contained" disabled={review.isPending}
            onClick={() => review.mutate({ taskId: p.taskId, commentId: c.id, until: newestReaction(c.mentions, c.reviewedAt) })}>
            {t('task.feed.review')}
          </Button>
        </Tooltip>
      )}
    </>
  );
}
