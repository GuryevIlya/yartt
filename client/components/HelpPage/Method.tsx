import { ExpandMore } from '@mui/icons-material';
import { Accordion, AccordionDetails, AccordionSummary, Box, Chip, Stack, Typography } from '@mui/material';

// A method of the public API in the guide (decision 111): a line that opens
// into the format of its request and answer and an example of each, built
// from /api/v1/openapi.json — the very schemas that check the calls, so the
// guide cannot drift from the API.

/** A JSON Schema as zod writes it (z.toJSONSchema), as far as the guide reads it. */
export type Schema = {
  type?: string | string[];
  format?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  enum?: unknown[];
  const?: unknown;
  description?: string;
  default?: unknown;
  minimum?: number;
};

/** An operation of the spec. */
export type Operation = {
  requestBody?: { content: { 'application/json': { schema: Schema } } };
  'x-query'?: Schema;
  responses: { 200: { content?: { 'application/json': { schema: Schema } } } };
};

export type MethodTexts = { request: string; response: string; format: string; example: string; noBody: string; empty: string };

const MONO = { fontFamily: 'monospace', fontSize: 13 } as const;

const variants = (s: Schema) => s.anyOf ?? s.oneOf;
const isNull = (s: Schema) => s.type === 'null';

/** The schema as a type a reader knows: { id: integer, deadline: string (date-time) | null }. */
export function shape(s: Schema, indent = ''): string {
  const next = `${indent}  `;
  const options = variants(s);
  if (options) return options.map((o) => shape(o, indent)).join(' | ');
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((e) => JSON.stringify(e)).join(' | ');
  const type = Array.isArray(s.type) ? s.type.join(' | ') : s.type;
  if (type === 'array') return `${s.items ? shape(s.items, indent) : 'unknown'}[]`;
  if (type === 'object' || s.properties) {
    const entries = Object.entries(s.properties ?? {});
    if (entries.length === 0) return '{}';
    const lines = entries.map(([name, field]) => `${next}${name}${s.required?.includes(name) ? '' : '?'}: ${shape(field, next)}`);
    return `{\n${lines.join(',\n')}\n${indent}}`;
  }
  if (type === 'string' && s.format) return `string (${s.format})`;
  return type ?? 'unknown';
}

/** A plausible value of the schema. */
export function example(s: Schema, name = ''): unknown {
  if (s.default !== undefined) return s.default;
  const options = variants(s);
  if (options) return example(options.find((o) => !isNull(o)) ?? options[0]!, name);
  if (s.const !== undefined) return s.const;
  if (s.enum) return s.enum[0];
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  switch (type) {
    case 'array': return s.items ? [example(s.items, name)] : [];
    case 'integer': return /minutes/i.test(name) ? 90 : s.minimum && s.minimum > 1 ? s.minimum : 42;
    case 'number': return 1.5;
    case 'boolean': return false;
    case 'null': return null;
    case 'string':
      if (s.format === 'date-time') return '2026-11-20T15:00:00.000Z';
      if (s.format === 'date') return '2026-11-20';
      if (s.format === 'email') return 'marina@example.com';
      if (s.format === 'uri') return 'https://example.com/hook';
      return /html|context|value/i.test(name) ? '<p>…</p>' : /markdown/i.test(name) ? '**…**' : '…';
    default:
      return Object.fromEntries(Object.entries(s.properties ?? {}).map(([key, field]) => [key, example(field, key)]));
  }
}

function Code(p: { children: string }) {
  return <Box component="pre" sx={{ ...MONO, m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, overflowX: 'auto' }}>{p.children}</Box>;
}

/** One method: its line, and when opened its request, answer and examples. */
export default function (p: {
  method: string; path: string; text: string; right: string; base: string;
  operation: Operation | undefined; texts: MethodTexts;
}) {
  const op = p.operation;
  const body = op?.requestBody?.content['application/json'].schema;
  // What the path names (:id) is not asked again in the query.
  const inPath = [...p.path.matchAll(/:(\w+)/g)].map((m) => m[1]!);
  const given = op?.['x-query'];
  const rest = given && Object.fromEntries(Object.entries(given.properties ?? {}).filter(([name]) => !inPath.includes(name)));
  const query = given && rest && Object.keys(rest).length > 0 ? { ...given, properties: rest } : undefined;
  const answer = op?.responses[200].content?.['application/json'].schema;
  const address = p.path.replace(/:(\w+)/g, '42');
  const queryString = query ? `?${new URLSearchParams(Object.entries(example(query) as Record<string, unknown>)
    .filter(([, v]) => v !== null && typeof v !== 'object').map(([k, v]) => [k, String(v)])).toString()}` : '';
  const curl = [
    `curl ${p.method === 'GET' ? '' : `-X ${p.method} `}"${p.base}${address}${queryString}"`,
    '-H "Authorization: Bearer $YARTT_KEY"',
    ...(body ? ['-H "Content-Type: application/json"', `-d '${JSON.stringify(example(body))}'`] : []),
  ].join(' \\\n  ');

  return (
    <Accordion disableGutters variant="outlined" slotProps={{ transition: { unmountOnExit: true } }} sx={{ '&::before': { display: 'none' } }}>
      <AccordionSummary expandIcon={<ExpandMore />} sx={{ '& .MuiAccordionSummary-content': { my: 1, minWidth: 0 } }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ gap: { xs: 0.25, sm: 1.5 }, alignItems: { sm: 'center' }, minWidth: 0, width: '100%' }}>
          <Typography sx={{ ...MONO, whiteSpace: 'nowrap', fontWeight: 600 }}>{`${p.method} ${p.path}`}</Typography>
          <Typography variant="body2" sx={{ flexGrow: 1 }}>{p.text}</Typography>
          <Chip size="small" variant="outlined" label={p.right} sx={{ alignSelf: { xs: 'flex-start', sm: 'center' } }} />
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={1}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>{p.texts.request}</Typography>
          <Code>{curl}</Code>
          {(body ?? query) ? (
            <>
              <Typography variant="body2">{p.texts.format}</Typography>
              <Code>{shape((body ?? query)!)}</Code>
            </>
          ) : <Typography variant="body2" sx={{ color: 'text.secondary' }}>{p.texts.noBody}</Typography>}
          <Typography variant="body2" sx={{ fontWeight: 600, pt: 1 }}>{p.texts.response}</Typography>
          {answer ? (
            <>
              <Typography variant="body2">{p.texts.format}</Typography>
              <Code>{shape(answer)}</Code>
              <Typography variant="body2">{p.texts.example}</Typography>
              <Code>{JSON.stringify(example(answer), null, 2)}</Code>
            </>
          ) : <Typography variant="body2" sx={{ color: 'text.secondary' }}>{p.texts.empty}</Typography>}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
