import { z } from 'zod';
import { CommentBase, CreateCommentInput, Feed, FeedFilter } from '#shared/comment.ts';
import { Id } from '#shared/employee.ts';
import * as Comments from '../services/Comment.ts';
import { authedProcedure, router } from '../trpc.ts';

export default router({
  /**
   * The feed of a task, newest first, 20 per page: only comments with open
   * mentions ('mentions') or every event ('all'): comments, deadline moves,
   * comments of other tasks attaching this one, time logged and planned.
   * @throws no_access
   */
  list: authedProcedure
    .input(z.object({ taskId: Id, filter: FeedFilter, page: z.number().int().min(1) }))
    .output(Feed)
    .query(({ input, ctx }) => Comments.list(ctx.employeeId, input.taskId, input.filter, input.page)),

  /**
   * The comments by others in the owner's task since their review, oldest
   * first: what "No intervention needed" would take away (decision 94).
   * @throws forbidden — not the owner.
   * @throws not_found
   */
  unreviewed: authedProcedure
    .input(z.object({ taskId: Id }))
    .output(CommentBase.array())
    .query(({ input, ctx }) => Comments.unreviewed(ctx.employeeId, input.taskId)),

  /**
   * Leaves a comment (rich text, sanitized) with files, mentions and
   * attached tasks; returns its id. In a private task only its observers
   * can be mentioned (Observer.mentionable); `everyone` mentions every
   * person in the task but the author and `exceptIds`. Comments are never edited: the client holds a sent
   * comment back for a few seconds before calling this.
   * @throws no_access
   * @throws self_mention
   * @throws mention_not_participant — a private task, and they do not take part.
   * @throws unknown_attachment — a file the author may not read.
   * @throws not_found — unknown task, employee or reply.
   */
  create: authedProcedure
    .meta({ bot: 'comment' })
    .input(CreateCommentInput)
    .output(Id)
    .mutation(({ input, ctx }) => Comments.create(ctx.employeeId, input)),

  /**
   * "Done" after a reply, or "No reply needed" without one: the signed-in
   * employee closes their mention in a comment. It stays in the author's
   * Waiting for others until they accept it (decision 95).
   * @throws not_found — no open mention of them there.
   */
  closeMention: authedProcedure
    .meta({ bot: 'comment' })
    .input(z.object({ taskId: Id, commentId: Id }))
    .output(z.void())
    .mutation(({ input, ctx }) => Comments.closeMention(ctx.employeeId, input.taskId, input.commentId)),

  /**
   * The author mentions someone in their comment already left: the
   * reaction is counted from now. The same rules as in a new comment.
   * @throws forbidden — not the comment's author.
   * @throws self_mention
   * @throws mention_not_participant
   * @throws not_found — unknown comment or employee.
   */
  addMention: authedProcedure
    .meta({ bot: 'comment' })
    .input(z.object({ taskId: Id, commentId: Id, employeeId: Id }))
    .output(z.void())
    .mutation(({ input, ctx }) => Comments.addMention(ctx.employeeId, input.taskId, input.commentId, input.employeeId)),

  /**
   * The author takes a mention back, until its first reaction: a reply
   * or its closing.
   * @throws forbidden — not the comment's author.
   * @throws mention_answered — already replied to or closed.
   * @throws not_found
   */
  removeMention: authedProcedure
    .meta({ bot: 'comment' })
    .input(z.object({ taskId: Id, commentId: Id, employeeId: Id }))
    .output(z.void())
    .mutation(({ input, ctx }) => Comments.removeMention(ctx.employeeId, input.taskId, input.commentId, input.employeeId)),

  /**
   * "Accepted": the author accepts every mention of their comment with a
   * reaction — closed, or answered and still open (that closes it too).
   * Mentioning the person again in the task accepts the earlier ones by
   * itself.
   * @throws forbidden — not the comment's author.
   * @throws no_access
   */
  acceptMentions: authedProcedure
    .meta({ bot: 'comment' })
    .input(z.object({ taskId: Id, commentId: Id }))
    .output(z.void())
    .mutation(({ input, ctx }) => Comments.acceptMentions(ctx.employeeId, input.taskId, input.commentId)),
});
