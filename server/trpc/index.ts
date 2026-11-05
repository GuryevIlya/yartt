import { router } from '../trpc.ts';
import Attachment from './Attachment.ts';
import Auth from './Auth.ts';
import ApiKey from './ApiKey.ts';
import Bot from './Bot.ts';
import Webhook from './Webhook.ts';
import Comment from './Comment.ts';
import Dependency from './Dependency.ts';
import Employee from './Employee.ts';
import MyDay from './MyDay.ts';
import Observer from './Observer.ts';
import Remind from './Remind.ts';
import TagLimit from './TagLimit.ts';
import Tags from './Tags.ts';
import Task from './Task.ts';
import Team from './Team.ts';
import Time from './Time.ts';
import Visit from './Visit.ts';
import Work from './Work.ts';

// Root router: keys are the namespaces on the client (trpc.Employee.list).
const trpc = router({ ApiKey, Attachment, Auth, Bot, Comment, Dependency, Employee, MyDay, Observer, Remind, TagLimit, Tags, Task, Team, Time, Visit, Webhook, Work });

export default trpc;
export type AppRouter = typeof trpc;
