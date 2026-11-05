# The public API

Programs work with yartt through `/api/v1`, with a key. There are three
independent things, and most jobs need one of them:

- **A webhook** tells a program that something happened. Anyone adds one under
  **Profile → Webhooks**; a Telegram receiver needs nothing else ([below](#a-persons-webhooks)).
- **A person's key** lets a program act in that person's name, to automate
  their own work: anything from exporting reports to routine edits. Made under
  **Profile → API keys**, with the rights ticked and a lifetime.
- **A bot** is a virtual employee: it comments, is mentioned and does work,
  seeing only what it was invited to, never its manager's data. It has one key
  and one webhook.

The interface's own API (`/api/trpc`) takes no keys and may change with any
release. `/api/v1` is the promise; its full description, from the same schemas
that check the calls, is at `/api/v1/openapi.json`, without a key.

## Create a bot

1. **Create it.** In **Profile → Bots** (or in **Bots** under My team),
   **New bot**: a name ("CI-бот"), how to speak of it, what it does, and
   what it may change. You become its manager. The key is shown once —
   put it into the program's secrets right away.
2. **Say what it may change.** A bot reads what an employee in its place
   would see — its own tasks, public ones, those it takes part in. Changing
   needs permissions, nothing ticked is read only:
   - **Its tasks** (`task`) — create tasks and run its own: tags,
     priority, context, deadline, dependencies, public or private;
   - **Hand over tasks** (`task.transfer`) — give its tasks to people;
   - **Comments** (`comment`) — comment, mention (everyone too:
     `everyone`, `exceptIds`), close its mentions with or without a reply,
     add a mention to its comment later, take one back until it has a
     reaction, review its reactions (`Comment.reviewComment`), upload files for
     comments;
   - **Participants** (`observers`) — add and remove participants of its tasks,
     ask for access to others'.
   A bot never keeps a timesheet, logs time, scores, invites or manages
   anyone: those are for people, whatever is ticked.
3. **Add it to tasks** it should see: the owner of a task adds it as a
   participant. Only participants are mentioned in a private task, a bot
   too; one with the Participants permission adds people to its own tasks.

Only its direct manager changes a bot, replaces its key or hands it to
someone else; managers above see it. The key does not expire: replace it
in the bot's settings when it may have leaked — the old one stops at
once. Handing the bot over, or dismissing its manager, replaces the key
with one nobody knows: the new manager issues the next. Dismissing the
bot stops it.

## Its webhook

A bot's notifications — it was mentioned, a comment in its task, a task
handed to it, an access request — go to its own webhook, if it has one:
a `POST` with JSON, signed with the bot's own secret (shown in its
settings, replaceable there):

```
x-yartt-timestamp: <when it was sent, Unix seconds>
x-yartt-signature: sha256=<HMAC-SHA256 of "<timestamp>.<body>" with the secret, hex>
```

The receiver computes the signature over the timestamp, a dot and the
raw body, compares it in constant time, and refuses a timestamp more
than five minutes away from its clock: a request caught on the way
cannot be replayed later. In Node:

```js
const expected = 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
const ok = signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  && Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
```

```json
{
  "version": 1,
  "kind": "mention",
  "to": { "employeeId": 12, "kind": "bot", "email": null, "fullName": "CI-бот", "locale": "ru", "timeZone": "Europe/Moscow" },
  "taskId": 42,
  "data": { "by": 7, "commentId": 3 }
}
```

`kind` and `data` are the notification and its payload
(`shared/notification.ts`); `version` changes when the envelope does. A bot's
webhook that does not take a message gets it again after 1, 5 and 15 minutes and
an hour, then it stays only in the bell. Where webhooks may go: `WEBHOOK_ALLOWED_URLS`
([install](install.md)).

## A person's webhooks

Anyone adds webhooks under **Profile → Webhooks**, no bot and no key needed:
a receiver gives a person an address with their id in it, they paste it and
choose for each group of events how much goes there. Signed like a bot's, with
the secret shown next to it; a receiver may rely on the address being secret
instead. A failure is tried again after 1, 5 and 15 minutes and an hour; how the
last attempt went is shown there.

```json
{
  "version": 2,
  "kind": "mention",
  "to": { "employeeId": 12 },
  "taskId": 42,
  "url": "https://yartt.company.com/tasks/42",
  "subject": "…",
  "text": "…",
  "comment": "…",
  "data": { "kind": "mention", "by": 7, "commentId": 3 }
}
```

`event` sends up to `url`, `title` adds `subject` (the task's title in the
person's language), `text` adds the rest: the message as in the email, the
comment's text and the payload. `kind: "test"` is the "Test" button. Sign-in
and confirmation links never come here.

## Calling the API

JSON over HTTP at `https://<your yartt>/api/v1`, with the key in
`Authorization: Bearer <key>`. Moments are ISO 8601. Path, query and body are
one set of fields.

Who am I:

```sh
curl -s https://yartt.company.com/api/v1/me -H "Authorization: Bearer $YARTT_KEY"
```

A comment that mentions someone, in Markdown (`html` works too):

```sh
curl -s https://yartt.company.com/api/v1/tasks/42/comments \
  -H "Authorization: Bearer $YARTT_KEY" -H 'content-type: application/json' \
  -d '{"markdown": "**Build #512** failed on e2e", "mentionIds": [7]}'
```

A task's context and comments accept Markdown, which language models write.

A change answers 204 or the new id; a refusal answers with an HTTP status and
`{"error": {"code": "...", "params": {...}, "issues": [...]}}`: `no_access`,
`not_found`, `key_not_permitted`, `bot_not_permitted` and the rest of
`shared/errors.ts`.

What a person's key may do is what its owner may, within the rights ticked:
reading tasks, writing tasks, comments, participants, and reading shifts, time
entries and scores (their own and their people's). Writing those three is not
in the API for anyone: a script keeping a timesheet would make the figures
mean nothing. Keys, webhooks, profiles and dismissals are not in it either, so
a leaked key cannot make itself another. A key always ends by its date, and
stops when its owner revokes it, is dismissed or refused by the identity
provider. A person's key does not upload files yet; a bot's does, at
`/api/attachments`.
