# API for bots

A program — a CI pipeline, monitoring, a chat bot — acts in yartt as a
bot: an employee of its own that owns tasks, comments and is mentioned
like a person, through the same API the interface uses, with its key
instead of a browser session. People have no API keys.

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
     reaction, accept them (`Comment.acceptMentions`), upload files for
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
x-yartt-signature: sha256=<HMAC-SHA256 of the body with the secret, hex>
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
(`shared/notification.ts`); `version` changes when the envelope does.
The company's webhook (`WEBHOOK_URL`) gets people's notifications in the
same envelope. A bot's webhook gets one attempt per notification: if it
is down, the notification stays only in the bot's bell.

## Calling the API

The API is tRPC over HTTP at `https://<your yartt>/api/trpc/<Namespace>.<procedure>`,
JSON with the [superjson](https://github.com/flightcontrolhq/superjson)
envelope: the input goes inside `{"json": ...}`, the result comes back
inside `{"result": {"data": {"json": ...}}}`.

- **Queries** — `GET` with `?input=` (URL-encoded JSON); without input,
  no parameter.
- **Mutations** — `POST` with the JSON body.
- **Authorization** — `Authorization: Bearer <key>`.

Who am I:

```sh
curl -s https://yartt.company.com/api/trpc/Auth.me \
  -H "Authorization: Bearer $YARTT_KEY"
```

A comment that mentions someone (task 42, employee 7):

```sh
curl -s https://yartt.company.com/api/trpc/Comment.create \
  -H "Authorization: Bearer $YARTT_KEY" -H 'content-type: application/json' \
  -d '{"json": {"taskId": 42, "html": "<p>Build #512 failed on e2e</p>",
                "replyToId": null, "files": [], "mentionIds": [7], "taskIds": []}}'
```

Errors come back with an HTTP status and a stable code in
`error.json.message` (`no_access`, `not_found`, `bot_not_permitted` —
403, the bot lacks the permission, ...); the codes are listed in
`shared/errors.ts`. Every procedure, its input and what it throws are
described next to it in `server/trpc/<Namespace>.ts`; a mutation a bot
may call says which permission it needs (`.meta({ bot: ... })`).
