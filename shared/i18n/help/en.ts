import type { Help } from './ru.ts';

// The in-app guide in English.

export const helpEn: Help = {
  title: 'How to work in yartt',
  intro: 'yartt is built on four principles. Under each: what it gives up and what it offers instead.',
  principles: [
    {
      title: 'A result has one owner',
      text: 'A task is the initiative of whoever started it: they need the result. They run the task, bring people in and may do '
        + 'the work themselves, but only they decide whether it is done. If the doer understood the task differently, the last word '
        + 'is with whoever needs the result. When two people answer for a task, nobody does, so a task has one owner, and its '
        + 'deadline is their promise, not a wish.',
      instead: [
        { usual: 'A reporter and an assignee', yartt: 'An owner and participants', text: 'The owner decides when the task is done. Participants work in it but do not close it.' },
        { usual: 'Statuses', yartt: 'A deadline and "Finish"', text: 'A task is open until its owner finishes it. When the deadline passes with the task open, it is overdue, and yartt reminds the owner.' },
      ],
    },
    {
      title: 'Seen by those invited',
      text: 'A task may hold salaries, clients and people. It may hold an idea too early to share with everyone, or a rough one '
        + 'its owner has yet to think through. So access to a task is given by name, not by a title or a project membership.',
      instead: [
        { usual: 'Access to a whole project', yartt: 'An invitation to the task', text: 'A task is seen by its participants and their managers. Everyone else sees its tags, priority and deadline: they can find it and ask for access.' },
        { usual: 'Roles and admins', yartt: 'Relationships', text: 'Rights come from owning a task, taking part in it and being someone\'s direct manager.' },
      ],
    },
    {
      title: 'Links, not a hierarchy',
      text: 'Work does not fit a tree: one task belongs to several directions at once, and several other tasks may wait for its result.',
      instead: [
        { usual: 'A title', yartt: 'A set of tags', text: '"website · homepage · banner". The set is unique and the suggestions offer existing tags, so the same thing gets the same name.' },
        { usual: 'A project', yartt: 'A shared tag', text: 'A task can be in several "projects" at once. A new tag appears when it is needed.' },
        { usual: 'A subtask', yartt: 'A "Waits for" link', text: 'A task waits for those it cannot be finished without, and may itself be needed by several. Each link may say by when '
          + 'the result is needed (a latest deadline), so a delay shows early.' },
      ],
    },
    {
      title: 'The figures tell the truth',
      text: 'The tracker forbids nothing, so there is no reason to fool it. The timesheet and scores are optional, and when kept, they show the work, not zeal.',
      instead: [
        { usual: 'Percent done', yartt: '"5h → 3h"', text: 'How much everyone has logged and still plans. An experienced '
          + 'person\'s hour costs more, so the simple part of the work goes to a junior. Shared out that way, the total depends '
          + 'on the task, not on who did it.' },
        { usual: 'Scoring results', yartt: 'Scoring the day\'s decisions', text: 'A task\'s result also depends on plans and chance, so it does not always tell much. The day\'s decisions depend on '
          + 'the person: were the priorities right, was help asked for in time.' },
      ],
    },
  ],
  quickStartTitle: 'Your first day: five steps',
  quickStart: [
    'Open My day (the main screen) and work through Waiting for me on top. The goal is an empty list.',
    'Your tasks are in Available tasks. My open: those you own or plan time on. Other open: those you take part in.',
    'Make a task: pick tags from the suggestions in the search, type your own and press "New task". There is no separate title: the tags are the title.',
    'Bring people in with "Add a participant" on the task\'s page. A participant sees the task but is not notified of comments. '
      + 'For them to answer, mention them in a comment with @.',
    'If you keep a timesheet, start the shift with ▶ in the top line, close it in the evening and log your time to tasks.',
  ],
  diagramsTitle: 'How it fits together',
  diagrams: {
    roles: {
      title: 'Who is who in a task',
      owner: 'Owner',
      ownerWho: 'Whose initiative it is — one per task',
      ownerDoes: ['decides when the task is done', 'sets and moves the deadline', 'removes participants not needed', 'answers for the result'],
      participant: 'Participants',
      participantWho: 'Those brought into the task',
      participantDoes: ['comment and answer mentions', 'bring others in', 'plan their time and log hours', 'make a task of their own when they need a deadline of their own'],
      manager: 'Managers',
      managerWho: 'Added by themselves, up the chain',
      managerDoes: ['see the tasks of their people', 'may hand over a report\'s task', 'stay while their person is in the task'],
      handover: 'Handing ownership over gives the initiative away whole: the new owner may close the task. '
        + 'Need someone only to do the work? Bring them in as a participant.',
    },
    lifecycle: {
      title: 'A task\'s life: its owner closes it',
      steps: [
        { title: 'Created', text: 'Whoever created it owns it. Only participants see it.' },
        { title: 'In work', text: 'Comments, mentions, plans and time. A day before the deadline Waiting for me reminds the owner.' },
        { title: 'Overdue', text: 'If it did not make it: the deadline passed with the task open. Waiting for me reminds the owner until they finish it or move the deadline.' },
        { title: 'Finished', text: 'The owner pressed "Finish". A moved deadline opens it again.' },
      ],
      finish: 'A task can be finished at any step. Before its deadline the deadline becomes "now"; after it, it stays as it was, so a late close shows.',
    },
    part: {
      title: 'A task of your own within someone else\'s initiative',
      main: 'The owner\'s task',
      mainOwner: 'owner — Emily',
      waits: 'waits for',
      sub: 'Jack\'s task',
      subOwner: 'owner — Jack',
      steps: [
        'Jack takes part in Emily\'s task. Usually he plans his hours right in it and says in the plan what he will do.',
        'When Jack needs a deadline of his own and to decide himself when the work is done, he presses "New task" under '
          + '"Waits for". The new task is his, and Emily\'s task waits for it.',
        'Jack closed his task. Emily\'s Waiting for me says "A task this one waits for is done".',
      ],
    },
    myDay: {
      title: 'Where things are',
      topLine: 'The top line',
      topItems: ['▶ shift', '🔔 waiting for me', '? guide', 'profile'],
      blocks: [
        { title: 'Waiting for me', text: 'mentions, new comments, requests, reminders, deadlines — by task' },
        { title: 'Waiting for others', text: 'your requests and mentions that wait for others' },
        { title: 'Available tasks', text: 'mine · team open · others · closed; the tag search' },
        { title: 'Folded blocks', text: 'my team, tags, hour budgets, bots, my files: open the one you need, it stays open' },
      ],
      side: { title: 'Timesheet', text: 'shifts, time entries and activity, today and the day before' },
    },
  },
  scenariosTitle: 'How to',
  scenarios: [
    {
      title: 'Every day',
      items: [
        {
          title: 'Sign in',
          steps: [
            'There are no passwords: enter your work email and a sign-in link is sent. Open it in the same browser: it does not work in '
              + 'another one, so a forwarded email lets nobody in as you. If the company signs in through its own accounts '
              + '(SSO), press the button to sign in with them.',
            'The company account gives no confirmed email? The first time, yartt asks for your work email and sends a link to it. '
              + 'Open it in the same browser.',
            'The sign-in email is changed in the profile: the new address is confirmed by a link sent to it.',
            'yartt can be installed as an app (browser menu → Install). Offline, changes wait in the browser and go out when the connection is back.',
          ],
        },
        {
          title: 'Work through Waiting for me',
          steps: [
            'Everything that needs your reaction sits under the line of its task. The tasks go by deadline: the overdue and the nearest on top.',
            'A mention: reply and press "Done". If there is nothing to say, press "No reply needed": the author sees you closed it without a reply.',
            'An access request to your task: approve or reject it.',
            'Whatever is new in your task is one block: comments, new links, tasks it waits for that are done, and its '
              + 'deadline a day ahead. The same block is on top of the task\'s page.',
            'A task handed to you shows only that at first, with "Accept". After it, whatever is new goes to the block.',
            'Open the new comments with "Read" and scroll them to the end. If nothing is needed of you, press "No intervention '
              + 'needed": what you saw goes away, whatever came later stays.',
            'Your task\'s deadline has passed: what to do is under "Close a task".',
            'Waiting for others, below, is the other way round: your requests and mentions waiting for others. The longest waiting '
              + 'on top; a request can be withdrawn right there.',
            'A comment with mentions stays in Waiting for others: you see who replied and who closed the mention without a reply. '
              + 'When nothing is needed from you, press "No intervention needed". The comment leaves and comes back only if someone '
              + 'else replies or closes a mention. So a comment to a hundred people does not remind you after each of them.',
          ],
        },
        {
          title: 'Find a task',
          steps: [
            'The search of Available tasks forgives typos, transliteration and the wrong keyboard layout. A task is found by number too: #12.',
            'A click in the empty field lists the rubrics of your tasks. The title of a new task works the same way.',
            'Picked tags narrow every tab. A manager also has Team open: the tasks of their people down the chain.',
            'A task number (#12) is a link to the task wherever it is shown. A click on a tag in a task\'s line adds it to the search.',
            'Hover a task in any list to see its description and how much each person has spent and still plans.',
          ],
        },
        {
          title: 'Remind yourself',
          steps: [
            'A reminder says "I will deal with this from then on". Until then the task is off your mind.',
            '"Remind me" on a task\'s page: from when and, if needed, about what. Only you see the reminder.',
            'At that moment you are notified and the task goes into Waiting for me. It stays there until you press "Done" or put the '
              + 'reminder off: by an hour, to tomorrow, to Monday, to a day before the deadline or to a time you pick.',
          ],
        },
        {
          title: 'Keep the timesheet and a plan',
          steps: [
            '"Start the shift" and "Finish" mark this moment. Add a forgotten shift with the clock icon of a day. If you worked '
              + 'but wrote no shift, yartt suggests one itself: "Looks like a shift".',
            'A shift may run past midnight. Then it shows in both days, and its hours are split between them by how many fell in '
              + 'each. A shift never lasts longer than a day. Shifts do not overlap; when another is in the way, yartt names its times.',
            'Time on a task is logged in a shift, one entry a task and shift. "Log time" shows what is there: a new value replaces '
              + 'it, 0 removes it. No more can go into a shift than it lasts, so write the shift first.',
            '"My plan" is how much more you mean to spend on a task and, if you like, on what. When the plan does not fit your time '
              + 'before the deadline, the task is "At risk".',
            'A shift and the time in it can be corrected until your manager scores it. To correct a scored shift, ask your manager '
              + 'to withdraw the score.',
            'All your days are in History.',
          ],
        },
        {
          title: 'Go on vacation',
          steps: ['The calendar icon in the top line: say when you are back. Until then your notifications are copied to your manager.'],
        },
      ],
    },
    {
      title: 'Tasks',
      items: [
        {
          title: 'Create a task',
          steps: [
            'In the search of Available tasks, pick tags from the suggestions and type what is to be done.',
            'Enter takes the existing tag spelled the same way, and if there is none, makes the text a new tag. The suggestions '
              + 'forgive typos. Until the task is saved, a new tag is dashed: you see it is new and can remove it.',
            'The task exists already? A link to it appears under the field, with similar tasks carrying the same tags below. Look before starting a new one.',
            'Press "New task" in the block\'s title row to open the new task. Add a priority, a deadline and a description.',
            'A task for someone else stays yours: bring them in under "Participants" in the form, and they plan their hours in it.',
            'A follow-up task is created from the page of the original, under "Waits for" or "Waited on by". It gets the original\'s tags.',
          ],
        },
        {
          title: 'Run your task',
          steps: [
            'The owner changes the tags, description, priority and deadline right on the task\'s page.',
            'Participants and Opened it show who opened the task and when, how much each spent and how much they plan.',
            '"Hand over" gives the whole task to another owner, and you stay a participant. A manager can hand over their report\'s task too. Every handover stays in the task\'s feed, so whose it was before is always seen.',
            'Anyone may "Leave the task" except its owner, and a manager while their report takes part.',
            'A task without an owner (they left and had no manager) any participant can "Take it".',
          ],
        },
        {
          title: 'Find who will do it',
          steps: [
            'Not sure who will take it? The task stays yours anyway: you need the result. First find someone who knows the area.',
            'Start with the tags. Under them, the new task form and the "Add participant" field show who knows the subject: those '
              + 'who worked on tasks with these tags in the past year. Click a person to make them a participant.',
            'Want to look yourself? Find tasks with the same tags in Available tasks, the Closed tab too. Hover a task to see who '
              + 'worked in it.',
            'In the Tags block, a tag\'s row unfolds who logged time on its tasks.',
            'Found nobody? Bring in the manager of the team that fits as a participant and mention them in a comment with @: '
              + '"Who of yours could take this?". They bring the right person in, and the task stays yours.',
            'Hand the task over only if it is not really yours: say, a bug in another team\'s service, and whether it is fixed is '
              + 'for that team to judge. You stay a participant and see the result.',
            'Making the task public does not help here: everyone sees it, but nobody is notified of it. A task is made public when '
              + 'it concerns everyone.',
          ],
        },
        {
          title: 'Hand out the work',
          steps: [
            'The task stays yours even when others do all the work: whether it is done is yours to decide. Bring people in as participants.',
            'In a comment, tell each one what is needed and mention them with @: "@Ivan, will you do item 1?", "@Maria, could you '
              + 'look at items 2 and 3?". The request lands in their Waiting for me, and you see the answer in Waiting for others.',
            'Taking it up, a participant puts hours into "My plan" and says what they are for. Participants shows how much each '
              + 'one has left, and the task\'s feed shows who took what.',
            'If a part needs a deadline of its own, the participant makes a task of their own with "New task" under "Waits for" '
              + '(the diagram above). When they close it, you learn of it in Waiting for me.',
          ],
        },
        {
          title: 'Ask for a review',
          steps: [
            'The owner or a participant brings the reviewer in and mentions them in a comment with @, saying what to look at.',
            'The reviewer answers in a comment and presses "Done". The owner still closes the task, when they consider it done. An owner who thinks no review is needed does not ask for one.',
          ],
        },
        {
          title: 'Do rework',
          steps: [
            'Small rework: mention the doer again in the same task. The history, the context and the hours stay together, while a new task would send people looking for them in the old one.',
            'Big rework that needs a deadline of its own: make a task with "New task" under "Waits for". It gets the tags of the original, and its hours show apart.',
            'Closed already? Move the deadline and it opens again.',
          ],
        },
        {
          title: 'Run a big task',
          steps: [
            'Make one task for the whole result and bring people in. Split it only as far as you need to see yourself: leave the level below to those doing the work.',
            'If someone can be trusted with a whole part, they make a task of their own for it and decide when it is ready. Yours waits for it, and you see who closed it and when under "Waits for" and later under "Related".',
            'If you want to accept a part yourself, make it yours and bring the doer in as a participant. You keep control, but they do not learn to split the work, so give away more with time.',
            'Closing the whole task stays with you. Closed parts do not close it.',
          ],
        },
        {
          title: 'Keep the context up to date',
          steps: [
            'The context is not only the statement of the task but your notes on where it stands: where you stopped and what is next.',
            'Notices of new comments and links remind you to correct it. If you keep it all in your head, the context can stay as it is.',
          ],
        },
        {
          title: 'Describe a tag',
          steps: [
            'A description holds what all tasks with this tag have in common: where they come from, what to watch for, a link to a regulation. Nothing has to be linked to tasks by hand.',
            'Profile, "Tags", "Description". Everyone in your tasks and your people\'s sees it.',
            'One tag may mean different things in different departments, so a task shows the line of its owner: from the top down, with each author\'s name. Everyone in the task sees the same.',
            'A manager writes for all their people, and anyone may add for themselves. A description forbids nothing. If you disagree, ask your manager to correct it or make a tag of your own.',
          ],
        },
        {
          title: 'Close a task',
          steps: [
            'Only the owner closes a task, with "Finish" on its page or in Waiting for me. It never closes by itself at its deadline.',
            'When the deadline passes and the task is not finished, it is overdue. It stays in My open with its date in red, and '
              + 'Waiting for me keeps a reminder: finish the task or move the deadline.',
            'It can be finished once nobody has time planned on it. Whoever does gets "Clear my plan" in Waiting for me.',
            'In Waiting for me an overdue task has "Finish" in place of "No intervention needed": it closes the task and takes '
              + 'its notices away, so read the new comments first.',
            'A moved deadline opens a closed task again. Closed tasks are in the Closed tab, the most recent first.',
            'Changes of the deadline within a minute count as one: owners of dependent tasks are told once it has stood for a minute.',
          ],
        },
        {
          title: 'Discuss in a task',
          steps: [
            'A comment is formatted text with images and files. # attaches a task, @ mentions a participant, and #12 in the text becomes a link.',
            'Text from a language model goes in by "Insert Markdown" in the editor and turns into formatted text at once. Pictures from outside are not kept: upload them.',
            'After "Send" a comment can be pulled back into editing for a few seconds. Then it is never changed or deleted.',
            '"Reply" starts a thread under a comment; the feed keeps a mark at the moment of the reply.',
            'Forgot to mention someone? The @ under your comment adds them. A mention can be taken back until the person has '
              + 'replied to it or closed it.',
            'An unfinished comment, form or edit stays as a draft when you leave the page.',
          ],
        },
        {
          title: 'Keep files',
          steps: [
            'The size of one file and the total of yours are limited by the administrator. Nothing is deleted by age.',
            'My files, at the bottom of My day, shows how much is taken and lets go of what you do not need.',
            'A file is kept while at least one person keeps it. Need someone else\'s file? Press "Keep in my files" by it: '
              + 'it stays with you even if its author lets it go.',
            'A file nobody keeps loses its content but not its link. Upload the same file again and the link works again.',
          ],
        },
        {
          title: 'Link tasks',
          steps: [
            'On a task\'s page, "Waits for" is what it cannot be finished without, "Waited on by" is who needs it. A task is found by tags or number.',
            'Anyone who sees both tasks links them, the same in "Waits for" and in "Waited on by": an existing one, '
              + 'or a new one with "New task". A link is removed by the owner of the waiting task or by whoever added it.',
            'A participant needs a task of their own when they need a deadline of their own. If hours in this task are enough, '
              + 'they plan them in it (see the diagram above).',
            'A latest deadline is the moment the task waited for must not finish after. The owner of the waiting task sets it by '
              + 'clicking "needed by …" or "no latest deadline" on the link\'s line. Without one the link only shows the order.',
            'Nothing is forbidden. When the task waited for is late or has no deadline, the link\'s line is highlighted '
              + 'and both tasks are "At risk".',
            'The owners of both tasks are told of a new link; the owner of the waiting one, also of every move of the other\'s deadline.',
            'Once either of two tasks is closed, the waiting is over: the line leaves "Waits for" and "Waited on by" for the folded "Related". Reopened, the task brings it back with its latest deadline.',
            '"Related" also gathers tasks mentioned by number in contexts and comments, on both sides, with a link to the mention. Nothing is added there by hand.',
            'A task that waits for another may close first, and a link may be removed. The owner of that other task then sees it in "Waiting for me" and decides whether the work is still needed. The line stays under "Related" on both, with dates, so it is clear why the task was started.',
          ],
        },
      ],
    },
    {
      title: 'People and access',
      items: [
        {
          title: 'Bring someone in and ask for help',
          steps: [
            'Any participant adds participants, like a copy in an email. The owner removes whoever is not needed.',
            'A participant gets access, not an order: they see the task and are not notified of comments.',
            'Need an answer or an action? Mention the person in a comment with @ and say what is needed. The request lands in their '
              + 'Waiting for me, and they close it with a reply or with "No reply needed".',
            'To tell everyone in the task something, pick "All participants" in the mention and, if need be, leave some out.',
            'Only those in the task can be mentioned; in a public task, anyone. Add the others first.',
          ],
        },
        {
          title: "Ask for access to someone else's task",
          steps: [
            "Someone else's private task shows in the search: tags, priority and deadline. Open it and press \"Request access\".",
            'The owner approves or rejects the request, and you are notified. Until then you can withdraw it.',
          ],
        },
        {
          title: 'Make a task public',
          steps: [
            'A task that concerns everyone (an office move, a shared service) the owner makes public. Everyone sees it, comments and '
              + 'logs time on it, and its list of participants is empty.',
            '"Make private" keeps the owner, their managers and everyone with an open mention. Those who commented come back with one click.',
          ],
        },
        {
          title: 'Invite a colleague',
          steps: ['The person-with-a-plus icon in the top line: enter their email and an invitation is sent. If the company signs in '
            + 'through its own accounts (SSO), people appear by themselves on their first sign-in.'],
        },
        {
          title: 'Make it yours',
          steps: [
            'Profile (your avatar in the top line): name, photo, about, language, time zone, keyboard layouts, light or dark theme.',
            'You pick your manager in the profile yourself, and they are notified.',
            'My tags: the color and weight of a tag are yours alone. Weight sets the order of tags in a title, color helps spot tasks in lists.',
            'Notifications come to the bell in the top line and by email in your language. The company may connect other channels too.',
          ],
        },
      ],
    },
    {
      title: 'Team, tags, automation',
      items: [
        {
          title: 'Manage a team',
          steps: [
            'The My team block: for each person, the share of the timesheet in tasks, scores, tasks at risk and delays. The longest unseen on top.',
            'A line unfolds into charts. A person\'s page shows their My day as they see it (without their reminders) and all their days for any period.',
            'A score of the day is 0 to 100 with a reason. The person gets an email. A score can be changed (another email goes out) '
              + 'or withdrawn so they can fix their timesheet.',
            '"Export" saves the timesheet, entries and scores of the picked people for a period as Excel or CSV, for payroll.',
            'Every Monday an email comes: overdue tasks and tasks at risk.',
            'Only the direct manager dismisses someone: the dismissed person\'s tasks and reports go to that manager. '
              + 'The dismissed come back from "My dismissed" under the team table.',
          ],
        },
        {
          title: 'Talk one on one',
          steps: [
            'Make a task of your own for the talk and write down in it what you noticed and what you were told.',
            'There is no need to score every day. Once a week or two, open a random day together and look at what happened: the tasks, comments and timesheet bring it back.',
            'Talk a moved deadline over on the spot: sometimes it is bad luck and sometimes it is not. That is why a person gives a score, not a formula.',
            'The employee may ask for the whole week to be scored instead of one day. If the disagreement stays, go through it with the manager above.',
          ],
        },
        {
          title: 'See how tags are doing',
          steps: [
            'The Tags block: what happened to the tasks of each tag from the day you pick to today. Open, closed, comments, people, '
              + 'who plans time; "?" by a column explains its figure.',
            'The tags with the most tasks "In work" are on top. Click a column\'s heading to sort by it.',
            'Pick several tags to see them together and one by one.',
            'A line unfolds into charts by day: how much each person logged and how much they still plan.',
            '"Export" saves it all as CSV.',
          ],
        },
        {
          title: 'Stay within an hour budget',
          steps: [
            'The Hour budgets block → New budget: tags, a period and how many hours you and your reports may spend on them. '
              + 'A task counts when it carries all those tags.',
            'A line shows what is logged and the forecast: logged plus the part of the plans that fits before the end of the period '
              + 'at the pace of the last 28 days. A plan for a year does not all go into a half-year budget. In brackets, how many '
              + 'percent the forecast is above or below the budget.',
            'Unfolded, a line shows the running total against the budget and the history of changes.',
            'Setting My plan on a task under a budget, you see the forecast it would make.',
            'Changing a budget makes a new version, and the old one stays in the history. Your managers and your reports see it.',
          ],
        },
        {
          title: 'Set up a virtual employee',
          steps: [
            'A bot is an employee that is a program: it comments, answers mentions and runs tasks of its own. It sees only what it was invited to, never its manager\'s data.',
            'Profile, "Bots": create a bot, tick what it may change and save its key. The key is shown once.',
            'For the bot to hear of mentions at once, give it a webhook address in its settings: all its notifications go there.',
            'The "Bots" block shows whether it works: calls by day and refusals.',
          ],
        },
        {
          title: 'Automate your own work',
          steps: [
            'An API key lets a program act in your name: export reports, make tasks, write comments. No bot is needed.',
            'Profile, "API keys": say what the key is for, how long it lives and what it may do. Nothing is allowed unless ticked. The key is shown once.',
            'A key sees what you see, so tick only what is needed. If it leaks, revoke it at once.',
            'A link to the API description is there too. Comments and contexts may be sent in Markdown.',
            'Shifts, time entries and scores cannot be written through the API: the figures should show what was done, not what a script did.',
          ],
        },
        {
          title: 'Get notifications in another program',
          steps: [
            'A webhook passes your notifications to another program, a Telegram bot for example. It needs neither a yartt bot nor a key.',
            'Write to the receiver\'s bot and it gives you an address. Paste it under Profile, "Webhooks", and press "Test".',
            'For each group of events choose what is sent: nothing, the event and a link, with the title or with the whole text. Emails keep coming as usual.',
            'The title and the text go wherever the address leads. If it leads outside the company, so does the data, so turn on the whole text with care.',
          ],
        },
      ],
    },
  ],
  faqTitle: 'Why it is so',
  faq: [
    {
      title: 'Tasks',
      items: [
        {
          q: 'Why does a task have no title?',
          a: 'People word titles differently, and one task is searched for five ways. A set of tags is unique, and the suggestions '
            + 'offer the tags that already exist, so the same thing usually gets the same name. Synonyms do not vanish entirely, '
            + 'but they are rare. And a tag that says exactly what is specific to a task can always be made.',
        },
        {
          q: 'Why no projects or subtasks?',
          a: 'A project is a rigid hierarchy: a task belongs to one, and access to it comes with the whole project. Tags group the '
            + 'same way without a hierarchy, and access stays with those invited. A subtask is tied to one parent; a dependency is '
            + 'not: one task may be needed by several, and deadlines are tied where it really is a promise.',
        },
        {
          q: 'How are tasks linked, and why is there no plain "related to"?',
          a: 'In three ways. Shared tags group tasks by meaning: a click on a tag finds every task with it. A task attached to a '
            + 'comment with # is linked with the reason why: its feed says "Mentioned in" and the task. "Waits for" links by a commitment: '
            + 'a task needs the result of another, and the deadlines are checked. A wordless "related to" constrains nothing and '
            + 'explains nothing: in half a year nobody remembers why it was set. "Related" gathers itself from these links, and nothing is added to it by hand.',
        },
        {
          q: 'Why no reporter and assignee?',
          a: 'With two of them responsibility blurs: the task hangs on an assignee who cannot close it. The owner is whose initiative '
            + 'it is: they decide the task is done, move its deadline and answer if it closed undone. So the doer is not made the '
            + 'owner: they could close the task without doing it.',
        },
        {
          q: 'Why can a task not be assigned to someone right away?',
          a: 'Because the task is what you need, not them. Assigning it gives away the decision on whether it is done and the deadline, while you must remember you are waiting for a result. '
            + 'Keep the task and write in "What is needed from them" in the new task form: the request goes into their "Waiting for me". If you no longer need the result, hand the task over whole.',
        },
        {
          q: 'What does the doer answer for, then?',
          a: 'For what they promised: answering a mention, their plan of hours, the date they named in a comment. It all stays in the task, and later it is clear who promised what. '
            + 'If they want to answer for a part whole, they make a task of their own, run it and decide when it is ready. Assigned a task they may change or move only by agreement, they would answer for it in name only.',
        },
        {
          q: 'Who makes a task that everyone needs?',
          a: 'Whoever has the problem. A developer needs a parser fixed to make an export: they make the task, if they want to keep an eye on it. If they only said they are stuck on the parser, the problem stays with whoever needs the export, and that person makes the task. '
            + 'There is no shared task: when everyone answers for it, nobody does.',
        },
        {
          q: 'Why not forbid closing a task until everyone has answered?',
          a: 'Closing would then depend on someone else, and one forgotten answer would hold the task open. The owner decides, and sees each answer in "Waiting for others". Only hours still planned refuse closing, since planned work is not done yet.',
        },
        {
          q: 'What if I was mentioned by mistake?',
          a: 'Say whom to ask, or press "No reply needed": the author sees it and the mention leaves "Waiting for me". If your team takes requests through a channel of its own, say so in your answer. yartt does not replace agreements about such channels.',
        },
        {
          q: 'Why is there no service desk in yartt?',
          a: 'A service desk serves those who do not use yartt, and outside requests. A task appears when someone takes on a commitment: they make it theirs and answer for the result. A request that turned into a task by itself belongs to nobody.',
        },
        {
          q: 'Why does only the owner close a task, not its deadline?',
          a: 'Closing a task says the result is there. That is for whoever answers for the result to say: a deadline does not know '
            + 'whether the work is done. So a passed deadline only makes the task overdue and reminds its owner. Everyone waiting '
            + 'for the task sees it is overdue, and a manager sees how many tasks were closed after their deadline.',
        },
        {
          q: 'Why no start date and no "planned" status?',
          a: 'Statuses and start dates go stale before anyone updates them. The deadline sets the order, and the agreement is the '
            + 'person\'s own plan: they were brought in and put hours in "My plan". When the plan does not fit their time before '
            + 'the deadline, the task is "At risk", and that shows early. How much a person has planned already shows in My team (backlog).',
        },
        {
          q: 'Why no percentage done on a task?',
          a: 'A percentage would be counted in hours: 5 logged of 8 makes 62%. But at no moment does it say how much is done. '
            + 'At the start few hours are logged and the plan is still a guess: 6% says only that the work began. At the end it '
            + 'nears 100, yet the last steps are often the longest, and a task stays at "90%" for weeks. In the middle more work '
            + 'turns up, the plan grows, and the percentage drops though the work went on. So a task\'s line shows the hours as '
            + 'they are, "5h → 3h": logged, and still in plans. How much is done, the comments and the owner will tell.',
        },
        {
          q: 'Why can a task not be deleted, nor a comment edited?',
          a: 'History should not get lost: metrics and links to the task stay right. An outdated comment is answered, not edited. '
            + 'To avoid sending something by mistake, a comment can be pulled back into editing for a few seconds.',
        },
        {
          q: 'Why is there no "All tasks" tab?',
          a: 'Open tasks need attention, closed ones are for reference, so they are on different tabs. With a search by tags every '
            + 'tab shows how many it found: a closed match shows without switching.',
        },
        {
          q: 'Why one screen, without sections or a menu?',
          a: 'What waits for you and your tasks is always on top; the rest is folded into lines below. There were separate sections, '
            + 'but a manager needs a report\'s day on one screen, seen with their eyes.',
        },
        {
          q: 'What does "At risk" mean?',
          a: "One of two. Someone's plan does not fit their working time before the deadline: each person's time is compared with "
            + 'their own. Or a latest deadline is broken: the task waits for one due later than it can live with, or it delays a '
            + 'task waiting for it. The reason is in the hint on the mark.',
        },
      ],
    },
    {
      title: 'People and access',
      items: [
        {
          q: 'Why can I not mention someone who is not in the task?',
          a: 'A mention addresses a participant; it does not open access. Access is opened openly: the person is added to the task '
            + 'and notified of it. The owner removes whoever is not needed, so a task never spreads quietly.',
        },
        {
          q: 'Why does a closed mention not leave Waiting for others by itself?',
          a: 'A mention is a request, and whoever asked should learn what came of it. The person mentioned may close it without a '
            + 'reply: sometimes a message only needs reading. So the comment waits in Waiting for others, each person marked '
            + 'whether they replied, until you press "No intervention needed". If there was no reply and one is needed, mention '
            + 'the person again.',
        },
        {
          q: 'How does "Done" differ from "No intervention needed"?',
          a: '"Done" closes a mention: whoever was mentioned presses it after replying. "No intervention needed" is pressed by the '
            + 'owner once they have gone through what is new in their task and decided nothing is needed of them. It opens only '
            + 'once the new comments are read, and takes away only what was on the screen, so nothing is skipped unread.',
        },
        {
          q: "Why do managers see their reports' tasks?",
          a: 'A manager answers for their people and needs to see what they are busy with. So they take part in every task of their '
            + 'reports, all the way up the chain, with no permissions to set. It adds no noise: comments notify only the owner '
            + 'and those mentioned.',
        },
        {
          q: 'Why does an employee choose their own manager?',
          a: 'Choosing a manager opens to them what one sees oneself: one\'s own tasks, the tasks one takes part in and the tasks of '
            + 'one\'s people. The manager gets nothing beyond that, except the right to score one\'s shifts and to dismiss one. So the '
            + 'choice is for whoever opens their data. If managers took people themselves, there would have to be rules on who may '
            + 'take whom, and a company structure someone keeps and checks. That is an administrator\'s job, and yartt has no '
            + 'administrators. The chosen manager is notified, so no swap goes unseen.',
        },
        {
          q: "How do directors see each other's tasks?",
          a: 'They pick each other as managers in the profile: managers may form a ring. Then each sees everything to do with the '
            + 'others, as a manager does. The rights stay with the direct manager: in a ring each may score the shifts of, and '
            + 'dismiss, whoever picked them as manager.',
        },
        {
          q: 'Why does my manager see my activity?',
          a: 'For transparency and trust. It works for an honest employee: the manager sees how the work really goes and trusts them '
            + 'more. And looking busy only on paper gets hard: the ribbon of the day shows when a person was here and whether that '
            + 'agrees with their shifts and entries. The rules are the same for everyone in the chain. Activity is not counted as '
            + 'time, nor scored. Opening an old task to look something up is normal work, so a closed task is not listed among '
            + '"Opened without logging".',
        },
      ],
    },
    {
      title: 'Time and scores',
      items: [
        {
          q: 'Do I have to keep the timesheet and score shifts?',
          a: 'No. The timesheet, entries, plans and scores are optional. Without them you keep tasks with tags and access by '
            + 'invitation; time and scores come in when you want transparency. Only, time on tasks is logged in a shift: whoever '
            + 'logs time keeps the timesheet too.',
        },
        {
          q: 'Why do a task\'s hours add up, while people are not compared by hours?',
          a: 'The total of hours describes the task itself. Any work has a simple part a junior can be given and a hard part '
            + 'that needs someone experienced. When the work is shared out sensibly, the total hardly depends on who did it. '
            + 'An experienced person would get through the routine a little faster, but giving it to them does not pay: their '
            + 'hour costs much more. How to share work out among people is the manager\'s call, and a task of its own. People, '
            + 'though, are not compared by hours: more hours is not more done. My team compares them by shares of their own '
            + 'time, scores and counts.',
        },
        {
          q: 'Why is time logged in a shift?',
          a: 'A shift tells when a person worked, and an entry tells what that time went to. An entry without a shift can be '
            + 'neither checked nor scored, so each belongs to its shift and cannot exceed it. A task has one entry a shift: time '
            + 'is not counted twice by accident, and a correction is replacing the value.',
        },
        {
          q: 'Why can time be logged for past days?',
          a: 'A task is often written down after the work began, and a timesheet is filled in at the end of a day or a week. A ban '
            + 'would hit the honest. Late filling shows anyway: an entry has its date, My team shows how late the timesheet is '
            + 'written, and a scored shift can no longer change.',
        },
        {
          q: 'Why does an hour budget forbid nothing?',
          a: 'A budget is a guide: it helps notice in time that the work went off plan. An overrun shows in the plan dialog, before '
            + 'the hours are spent. A ban would not make the work smaller: the time would be logged elsewhere, and the figures would '
            + 'stop being true. What to spend hours on beyond a budget is for people to decide, not a counter.',
        },
        {
          q: 'Why does the tracker not pick the days to score, or require scoring?',
          a: 'The tracker is neither the employee\'s advocate nor the manager\'s supervisor. Scores are for finding where to grow, and someone who wants that needs no control: they pick random days themselves. Someone who does not will simply not score, whatever is checked. '
            + 'A dispute over a score is settled by talking, not by a setting.',
        },
        {
          q: 'Why are there no automatic penalties for a moved deadline?',
          a: 'A formula cannot tell bad luck from a week of nothing with the deadline moved afterwards. A penalty also pushes people to close what is not done to avoid it. So a moved deadline is talked over with the manager, who weighs it in the day\'s score. '
            + 'Experience counts too: the same work may score differently for a trainee and for a senior.',
        },
        {
          q: 'Why are shifts scored, and by what?',
          a: 'A task takes months and ten people: it is unclear whom to score and for what. A task\'s result depends on plans, '
            + 'colleagues and chance; the day\'s decisions depend on the person. So decisions are scored: were the priorities right, '
            + 'was help asked for in time, was nothing needless taken on. The manager writes a reason with every score, so scores '
            + 'do not slide into liking and disliking. A task may fail while the scores are good: then the plans are the problem, '
            + 'not the person. A manager usually gives all the shifts of a day one score at once, and scores them apart when '
            + 'the day went differently.',
        },
        {
          q: 'Why no metrics of estimate accuracy, deadline moves or priorities?',
          a: 'Such metrics teach people to play the tracker instead of working: rewarded for accurate estimates, they pad them; for '
            + 'few moves, they set deadlines with a margin; for many tasks, they split them. My team shows only what cannot be '
            + 'improved by working worse: the share of one\'s time in tasks, scores, reaction to mentions, how late the timesheet is '
            + 'written, whether the backlog grows. A deadline moved the day before is often honest: the task held more work than '
            + 'thought. A task may also be reopened by moving its deadline. So moves are not counted; what counts is whether a task '
            + 'closed by its deadline. A move made in advance is seen by the owners of the tasks waiting for it, and a task closed '
            + 'after its deadline passed shows to the manager in My team.',
        },
      ],
    },
  ],
};
