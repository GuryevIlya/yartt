import { Box, Link as MuiLink, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';
import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Help } from '#shared/i18n/help/ru.ts';
import { url } from '#client/hooks/base.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import Method, { type Operation } from './Method.tsx';

const SUBHEAD = { fontWeight: 600, color: 'text.primary', scrollMarginTop: 72 } as const;
const MONO = { fontFamily: 'monospace', fontSize: 13 } as const;

/** Where webhooks may go on this installation; nothing for someone not signed in. */
function WebhookAddresses(p: { where: { any: string; listed: string } }) {
  const trpc = useTRPC();
  const allowed = useQuery(trpc.Webhook.allowed.queryOptions(undefined, { retry: false, meta: { quiet: true } }));
  if (!allowed.data) return null;
  const urls = allowed.data.urls;
  return (
    <Typography variant="body2">
      {urls.length === 0 ? p.where.any : p.where.listed.replace('{{allowed}}', urls.join(', '))}
    </Typography>
  );
}

function Code(p: { children: string }) {
  return (
    <Box component="pre" sx={{ ...MONO, m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, overflowX: 'auto' }}>{p.children}</Box>
  );
}

function Grid(p: { headers: string[]; rows: ReactNode[][]; label: string }) {
  return (
    <TableContainer>
      <Table size="small" aria-label={p.label}>
        <TableHead><TableRow>{p.headers.map((h) => <TableCell key={h}>{h}</TableCell>)}</TableRow></TableHead>
        <TableBody>
          {p.rows.map((row, i) => <TableRow key={i}>{row.map((cell, j) => <TableCell key={j} sx={{ verticalAlign: 'top' }}>{cell}</TableCell>)}</TableRow>)}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function Part(p: { id: string; title: string; children: ReactNode }) {
  return (
    <Stack component="section" aria-label={p.title} id={p.id} spacing={1} sx={{ mt: 3, scrollMarginTop: 72 }}>
      <Typography variant="h3" component="h3" sx={SUBHEAD}>{p.title}</Typography>
      {p.children}
    </Stack>
  );
}

function Steps(p: { steps: string[] }) {
  return (
    <Box component="ol" sx={{ m: 0, pl: 3 }}>
      {p.steps.map((step) => <Typography key={step} component="li" variant="body2" sx={{ mb: 0.5 }}>{step}</Typography>)}
    </Box>
  );
}

const inCode = (text: string) => <Box component="span" sx={MONO}>{text}</Box>;

/**
 * The API and webhooks, for someone writing a script or a receiver: which of
 * the three ways to take, how to call, every request, the errors and what a
 * webhook gets. Written for each language; tests/guide.test.ts holds it to the
 * routes and the events. The specification is one link away, for the types.
 */
export default function (p: { api: Help['api'] }) {
  const { t } = useTranslation();
  const { api } = p;
  const base = `${window.location.origin}${url('/api/v1')}`;
  const spec = url('/api/v1/openapi.json');
  // The spec of the API, public like the guide: the methods open into their format and examples.
  const [paths, setPaths] = useState<Record<string, Record<string, Operation>> | null>(null);
  useEffect(() => {
    let current = true;
    fetch(spec)
      .then(async (response) => (await response.json()) as { paths: Record<string, Record<string, Operation>> })
      .then((loaded) => { if (current) setPaths(loaded.paths); })
      .catch(() => {}); // offline: the methods stay closed lines
    return () => { current = false; };
  }, [spec]);
  const rightName = (right: string | null) =>
    (right === null ? api.methods.noRight : t(`apiKey.rightNames.${right as 'tasks.read'}`));

  return (
    <>
      <Typography sx={{ mt: 1 }}>{api.intro}</Typography>
      <Part id="api-choose" title={api.choose.title}>
        <Grid label={api.choose.title} headers={api.choose.headers} rows={api.choose.rows.map((r) => [<b key="n">{r.name}</b>, r.when, r.where])} />
      </Part>

      <Part id="api-calling" title={api.calling.title}>
        <Steps steps={api.calling.steps.map((s) => s.replace('{{base}}', base))} />
        <Typography variant="body2">{api.calling.example}</Typography>
        <Code>{`curl ${base}/tasks/42/comments \\
  -H "Authorization: Bearer $YARTT_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"markdown": "**Сборка 512** упала", "mentionIds": [7]}'`}</Code>
        <Typography variant="body2">{api.calling.answer}</Typography>
        <Code>{`{
  "id": 42,
  "tags": [{ "id": 1, "name": "сайт" }],
  "priority": "NORMAL",
  "deadline": "2026-11-20T15:00:00.000Z",
  "closed": false,
  "ownerId": 3,
  "access": "owner",
  "details": {
    "context": "<p>…</p>",
    "waitsFor": [],
    "waitedOnBy": [],
    "related": [],
    "tagDescriptions": []
  }
}`}</Code>
      </Part>

      <Part id="api-methods" title={api.methods.title}>
        <Typography variant="body2">{api.methods.intro}</Typography>
        <Typography variant="body2">{api.methods.open}</Typography>
        {api.methods.groups.map((group) => (
          <Stack key={group.title} spacing={0.5} sx={{ pt: 1 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>{group.title}</Typography>
            {group.routes.map((r) => (
              <Method
                key={`${r.method} ${r.path}`}
                {...r}
                right={rightName(r.right)}
                base={base}
                operation={paths?.[r.path.replace(/:(\w+)/g, '{$1}')]?.[r.method.toLowerCase()]}
                texts={api.methods.method}
              />
            ))}
          </Stack>
        ))}
        <Typography variant="body2" sx={{ pt: 1 }}>{api.methods.files}</Typography>
        <Typography variant="body2">
          {api.methods.spec}: <MuiLink href={spec} target="_blank" rel="noopener">openapi.json</MuiLink>
        </Typography>
      </Part>

      <Part id="api-errors" title={api.errors.title}>
        <Typography variant="body2">{api.errors.intro}</Typography>
        <Grid label={api.errors.title} headers={api.errors.headers} rows={api.errors.rows.map((r) => [inCode(r.code), r.text])} />
      </Part>

      <Part id="api-webhooks" title={api.webhooks.title}>
        <Typography variant="body2">{api.webhooks.intro}</Typography>
        <WebhookAddresses where={api.webhooks.where} />
        <Typography variant="body2" sx={{ fontWeight: 600, pt: 1 }}>{api.webhooks.levels.title}</Typography>
        <Typography variant="body2">{api.webhooks.levels.intro}</Typography>
        <Grid label={api.webhooks.levels.title} headers={api.webhooks.levels.headers} rows={api.webhooks.levels.rows.map((r) => [r.name, r.fields])} />
        <Typography variant="body2" sx={{ fontWeight: 600, pt: 1 }}>{api.webhooks.fields.title}</Typography>
        <Grid label={api.webhooks.fields.title} headers={api.webhooks.fields.headers} rows={api.webhooks.fields.rows.map((r) => [inCode(r.name), r.text])} />
        <Typography variant="body2" sx={{ pt: 1 }}>{api.webhooks.example}</Typography>
        <Code>{`{
  "version": 2,
  "kind": "mention",
  "to": { "employeeId": 12 },
  "taskId": 42,
  "url": "${window.location.origin}${url('/tasks/42')}",
  "subject": "…",
  "text": "…",
  "comment": "…",
  "data": { "kind": "mention", "by": 7, "commentId": 3 }
}`}</Code>
        <Typography variant="body2">{api.webhooks.bot}</Typography>
        <Typography variant="body2" sx={{ fontWeight: 600, pt: 1 }}>{api.webhooks.events.title}</Typography>
        <Grid
          label={api.webhooks.events.title}
          headers={api.webhooks.events.headers}
          rows={Object.entries(api.webhooks.events.rows).map(([kind, e]) => [inCode(kind), e.text, e.group, inCode(e.fields)])}
        />
        <Typography variant="body2" sx={{ fontWeight: 600, pt: 1 }}>{api.webhooks.signature.title}</Typography>
        <Typography variant="body2">{api.webhooks.signature.intro}</Typography>
        <Code>{`const expected = 'sha256=' + createHmac('sha256', secret)
  .update(\`\${timestamp}.\${rawBody}\`).digest('hex');
const ok = signature === expected
  && Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;`}</Code>
        <Typography variant="body2">{api.webhooks.allowed}</Typography>
      </Part>

      <Part id="api-keys" title={api.keys.title}><Steps steps={api.keys.steps} /></Part>
      <Part id="api-bots" title={api.bots.title}><Steps steps={api.bots.steps} /></Part>
    </>
  );
}
