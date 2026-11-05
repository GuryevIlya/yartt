import { z } from 'zod';
import {
  MyTags, MyTagsInput, RelatedInput, SetTagInput, Suggestions, SuggestInput, TagDetail, TagDetailInput, TagStats, TagStatsInput,
} from '#shared/tags.ts';
import { Tag } from '#shared/task.ts';
import * as Tags from '../services/Tags.ts';
import { viewAs } from '../services/Team.ts';
import { authedProcedure, router } from '../trpc.ts';
import { Id } from '#shared/employee.ts';
import { SetTagDescriptionInput, TagDescription } from '#shared/tagDescription.ts';

export default router({
  /**
   * Tags for what is typed, forgiving typos, transliteration ("sklad") and
   * the other keyboard layout ("crkfl"): the closest to the whole text, and
   * ways to read it as several tags, existing and new. Anyone signed in.
   */
  suggest: authedProcedure
    .input(SuggestInput)
    .output(Suggestions)
    .query(({ input, ctx }) => Tags.suggest(ctx.employeeId, input.text)),

  /**
   * The tags that most often go with these, on the tasks carrying all of
   * them — rubrics, not a phrase of one task; without tags, the rubrics of
   * the signed-in employee's own tasks. Anyone signed in.
   */
  related: authedProcedure
    .input(RelatedInput)
    .output(Tag.array())
    .query(({ input, ctx }) => Tags.related(ctx.employeeId, input.tagIds)),

  /**
   * The tag summary from a day to today (decision 58), counting only the
   * tasks the signed-in employee sees and only people, not bots: open, at
   * risk and untouched, closed by hand and by deadline, active, comments,
   * people and the average share of their own time, who plans time on it
   * now and the last day anything happened. Without picked tags — every rubric,
   * the most active first, 20 per page; with them — those, and for two or
   * more all of them together and any of them.
   */
  stats: authedProcedure
    .input(TagStatsInput)
    .output(TagStats)
    .query(async ({ input, ctx }) => Tags.stats(await viewAs(ctx.employeeId, input.as), input)),

  /**
   * A line of the summary unfolded: comments and open tasks with a plan
   * day by day, and each person's own time and plan of time left day by
   * day, the share of all they logged and their plan now — on the tasks
   * the signed-in employee sees.
   */
  detail: authedProcedure
    .input(TagDetailInput)
    .output(TagDetail)
    .query(async ({ input, ctx }) => Tags.detail(await viewAs(ctx.employeeId, input.as), input)),

  /**
   * The tags of the tasks the signed-in employee sees, with task counts and
   * their own color and weight; 50 per page, filtered by part of the name.
   */
  mine: authedProcedure
    .input(MyTagsInput)
    .output(MyTags)
    .query(({ input, ctx }) => Tags.mine(ctx.employeeId, input.query, input.page)),

  /**
   * Sets the signed-in employee's own color and weight of a tag. Nobody else
   * sees them; the weight orders the tags of every task "title" for them.
   * @throws not_found — unknown tag.
   */
  set: authedProcedure
    .input(SetTagInput)
    .output(z.void())
    .mutation(({ input, ctx }) => Tags.set(ctx.employeeId, input)),

  /** What these tags mean along the caller's own chain, from the top down: their words and their managers'. */
  descriptions: authedProcedure
    .input(z.object({ tagIds: Id.array().max(50) }))
    .output(TagDescription.array())
    .query(({ input, ctx }) => Tags.descriptions(ctx.employeeId, input.tagIds)),

  /**
   * One's own words about a tag, seen in tasks of oneself and the people below;
   * NULL removes them. Anyone may; nothing is resolved, a description forbids nothing.
   * @throws not_found — unknown tag.
   */
  setDescription: authedProcedure
    .input(SetTagDescriptionInput)
    .output(z.void())
    .mutation(({ input, ctx }) => Tags.setDescription(ctx.employeeId, input)),
});
