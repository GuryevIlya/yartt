import type { apiRu } from './api.ru.ts';

// The guide's part about the API and webhooks, in English.

export const apiEn: typeof apiRu = {
  title: 'API and webhooks',
  intro: 'There are three ways to integrate yartt with other applications. They do not depend on each other, and one of them is usually enough.',
  choose: {
    title: 'Which to choose',
    headers: ['Way', 'What for', 'Where to set it up'],
    rows: [
      { name: 'Webhook', when: 'yartt itself tells a program something happened, such as notifications in Telegram. No key and no bot are needed.', where: 'Profile → "Webhooks"' },
      { name: 'Personal API key', when: 'A program acts in your name: exports reports, makes tasks, writes comments. It sees what you see.', where: 'Profile → "API keys"' },
      { name: 'Bot', when: 'A virtual employee: invited to tasks and mentioned, it answers and does work. It sees only what it was invited to, never its manager\'s data.', where: 'Profile → "Bots"' },
    ],
  },
  calling: {
    title: 'How to call the API',
    steps: [
      'The address: {{base}}. The key goes in the header Authorization: Bearer <key>; a personal key and a bot\'s work alike.',
      'Requests and answers are JSON. Moments are ISO 8601, such as 2026-11-20T15:00:00Z. Numbers in the address, query parameters and the body count as one set of fields.',
      'The text of a context or a comment goes in the field markdown or in html. Pictures from outside are not kept.',
      'A successful request with nothing to return answers 204. The others answer 200 with data.',
    ],
    example: 'A comment mentioning employee 7 in task 42:',
    answer: 'It answers with the new comment\'s number. What a task looks like:',
  },
  methods: {
    title: 'What can be done',
    intro: 'The "Right" column says what a personal key needs. A bot is checked by its permissions, and shifts and reports are not for bots. Writing shifts, time entries and scores is in the API for nobody: the figures should show what was done, not what a script did.',
    headers: ['Request', 'What it does', 'Right'],
    noRight: 'any key',
    groups: [
      {
        title: 'Who am I and who is around',
        routes: [
          { method: 'GET', path: '/me', text: 'Whose name the key acts in', right: null },
          { method: 'GET', path: '/employees', text: 'Everyone in the company', right: 'tasks.read' },
        ],
      },
      {
        title: 'Tasks',
        routes: [
          { method: 'POST', path: '/tasks/search', text: 'Find tasks by tags, as in the tabs of "Available tasks"', right: 'tasks.read' },
          { method: 'GET', path: '/tasks/:id', text: 'A task. Its context, links and descriptions of tags only for those who see it', right: 'tasks.read' },
          { method: 'POST', path: '/tasks', text: 'A new private task, owned by whoever holds the key', right: 'tasks.write' },
          { method: 'PATCH', path: '/tasks/:id', text: 'The owner changes tags, priority or context', right: 'tasks.write' },
          { method: 'PUT', path: '/tasks/:id/deadline', text: 'The owner sets, moves or clears the deadline. Moving it opens a closed task', right: 'tasks.write' },
          { method: 'POST', path: '/tasks/:id/close', text: 'The owner finishes the task', right: 'tasks.write' },
          { method: 'POST', path: '/tasks/:id/transfer', text: 'Hand the task over whole', right: 'tasks.write' },
          { method: 'PUT', path: '/tasks/:id/waits-for/:value', text: 'This task waits for another. The latest deadline (latestAt) is its owner\'s alone', right: 'tasks.write' },
          { method: 'DELETE', path: '/tasks/:id/waits-for/:value', text: 'Remove the link', right: 'tasks.write' },
        ],
      },
      {
        title: 'Comments and participants',
        routes: [
          { method: 'GET', path: '/tasks/:id/comments', text: 'The comments of a task, by pages (page)', right: 'tasks.read' },
          { method: 'POST', path: '/tasks/:id/comments', text: 'A new comment. mentionIds puts it in their "Waiting for me", taskIds attaches tasks', right: 'comments.write' },
          { method: 'POST', path: '/tasks/:id/comments/:commentId/close', text: 'Close one\'s own mention in a comment', right: 'comments.write' },
          { method: 'PUT', path: '/tasks/:id/participants/:employeeId', text: 'Bring someone into the task', right: 'participants.write' },
          { method: 'DELETE', path: '/tasks/:id/participants/:employeeId', text: 'The owner removes a participant', right: 'participants.write' },
        ],
      },
      {
        title: 'What is waiting',
        routes: [
          { method: 'GET', path: '/waiting-for-me', text: 'The same as "Waiting for me"', right: 'tasks.read' },
          { method: 'GET', path: '/waiting-for-others', text: 'The same as "Waiting for others"', right: 'tasks.read' },
        ],
      },
      {
        title: 'Shifts and reports (read only)',
        routes: [
          { method: 'GET', path: '/days', text: 'One\'s own past days: shifts, time entries, scores. Parameters page and size', right: 'reports.read' },
          { method: 'GET', path: '/team', text: 'One\'s people over a period. Parameters from and to, dates such as 2026-11-01', right: 'reports.read' },
          { method: 'GET', path: '/employees/:id/stats', text: 'A person\'s figures over a period, for them and their manager', right: 'reports.read' },
          { method: 'GET', path: '/employees/:id/days', text: 'A person\'s past days, for their manager', right: 'reports.read' },
        ],
      },
    ],
    spec: 'All fields, answers and types are in the OpenAPI specification',
    files: 'Files for a comment are uploaded by a bot with the "Comments" permission: POST /api/attachments with the file as the body; the answer holds the number for the field files. A personal key does not upload files yet.',
  },
  errors: {
    title: 'Errors',
    intro: 'A refusal comes with an HTTP status and a body like {"error": {"code": "...", "params": {}, "issues": []}}. code never changes, so check that. The main ones:',
    headers: ['Code', 'What it means'],
    rows: [
      { code: 'unauthorized', text: '401. No key, a wrong one, revoked, expired, or its owner was dismissed' },
      { code: 'key_not_permitted', text: '403. The personal key lacks the right' },
      { code: 'bot_not_permitted', text: '403. The bot lacks the permission' },
      { code: 'forbidden', text: '403. The person may not do this, such as change someone else\'s task' },
      { code: 'no_access', text: '400. The key\'s owner does not see this task' },
      { code: 'not_found', text: '404. There is no such thing' },
      { code: 'invalid_input', text: '400. Wrong fields in the request, details in issues' },
      { code: 'plans_left', text: '400. The task cannot be finished: someone still has time planned on it' },
    ],
  },
  webhooks: {
    title: 'What a webhook gets',
    intro: 'For each event yartt POSTs JSON to the address. An answer of 2xx counts as delivered. If the address did not take it, yartt tries again after 1, 5 and 15 minutes and an hour, then stops. Emails come in any case. Sign-in links never go to a webhook.',
    levels: {
      title: 'What to send',
      intro: 'For each group of events you choose how much. That decides which fields come:',
      headers: ['Setting', 'Which fields come'],
      rows: [
        { name: 'Nothing', fields: 'No message is sent' },
        { name: 'The event and a link', fields: 'version, kind, to, taskId, url' },
        { name: 'With the title', fields: 'the same and subject: the subject of the email in your language, with the task\'s title' },
        { name: 'With the whole text', fields: 'the same and text (the text of the email), comment (the comment\'s text, if the event is about one), data (all the event\'s fields)' },
      ],
    },
    fields: {
      title: 'Fields',
      headers: ['Field', 'What it means'],
      rows: [
        { name: 'version', text: 'The format\'s version: 2 for a person\'s webhook, 1 for a bot\'s' },
        { name: 'kind', text: 'The kind of event, listed below. test comes from the "Test" button' },
        { name: 'to', text: 'Whom for: employeeId. For a bot also its name, language and time zone' },
        { name: 'taskId', text: 'The task\'s number, or null' },
        { name: 'url', text: 'A link to show a person' },
      ],
    },
    example: 'A message with "With the whole text":',
    bot: 'A bot gets all its notifications with nothing to set: version, kind, to, taskId and data with the event\'s fields.',
    events: {
      title: 'Events',
      headers: ['kind', 'When', 'Group', 'Fields in data'],
      rows: {
        mention: { text: 'You were mentioned in a comment', group: 'Mentions', fields: 'by, commentId' },
        comment: { text: 'A new comment in your task', group: 'Comments', fields: 'by, commentId' },
        task_mention: { text: 'Your task was mentioned in another', group: 'Comments', fields: 'by, commentId' },
        finished_at_change: { text: 'The deadline of a task yours waits for changed', group: 'Deadlines', fields: 'dependencyId, late' },
        dependency_added: { text: 'Someone\'s task now waits for yours. hard: the link has a latest deadline', group: 'Links', fields: 'by, dependentId, hard' },
        waits_added: { text: 'Your task now waits for another', group: 'Links', fields: 'by, dependencyId' },
        dependency_done: { text: 'A task yours waits for was closed', group: 'Links', fields: 'dependencyId' },
        waiter_closed: { text: 'A task no longer waits for yours: it was closed or the link removed', group: 'Links', fields: 'dependentId' },
        access_request: { text: 'Someone asks for access to your task', group: 'Access', fields: 'employeeId' },
        access_opened: { text: 'You were given access to a task', group: 'Access', fields: 'by' },
        access_closed: { text: 'Your access to a task was closed', group: 'Access', fields: 'by' },
        owner_change: { text: 'A task was handed to you', group: 'Handover', fields: 'from' },
        owner_handed: { text: 'A manager handed your task to someone else', group: 'Handover', fields: 'by, employeeId' },
        remind: { text: 'Your reminder is due', group: 'Reminders', fields: 'text' },
        score: { text: 'A score was given or changed', group: 'Scores', fields: 'value, reason and shift' },
        invite: { text: 'You were invited to yartt', group: 'Everything else', fields: 'by' },
        welcome: { text: 'You were added without an invite', group: 'Everything else', fields: 'none' },
        new_report: { text: 'Someone chose you as their manager', group: 'Everything else', fields: 'employeeId' },
        weekly_digest: { text: 'Monday\'s summary for a manager', group: 'Everything else', fields: 'overdue, atRisk, blocked' },
        bot_key_old: { text: 'Your bot\'s key is a year old', group: 'Everything else', fields: 'employeeId, issuedAt' },
      },
    },
    signature: {
      title: 'How to check the signature',
      intro: 'The address itself is secret, so checking is optional. To be sure a message is from yartt, take the secret from the webhook\'s settings. The header x-yartt-signature holds HMAC-SHA256 of "x-yartt-timestamp, a dot, the body", and messages older than five minutes are best refused.',
    },
    allowed: 'The administrator may limit where webhooks are allowed to go. Without that setting they go only outside the company\'s network.',
  },
  bots: {
    title: 'How to set up a bot',
    steps: [
      'Profile → "Bots" → "New bot". Tick what it may change. With nothing ticked it only reads.',
      'Save the key, it is shown once. Only the bot\'s direct manager can replace it.',
      'Bring the bot into the tasks it needs as a participant: it sees only those and public tasks.',
      'For the bot to hear of mentions at once, give it a webhook address in its settings. Without one it has to ask GET /waiting-for-me.',
      'A bot keeps no timesheet, logs no time, scores nobody and manages nobody.',
    ],
  },
  keys: {
    title: 'How a personal key works',
    steps: [
      'Profile → "API keys": say what the key is for, its lifetime and its rights. Nothing is allowed unless ticked, not even reading.',
      'The key is shown once. If it leaks, revoke it at once.',
      'A key stops when revoked, when it expires, when its owner is dismissed or the company closes their sign-in.',
      'A key cannot make keys, set up webhooks or change a profile: a leaked key cannot give itself a replacement.',
    ],
  },
};
