import { Box, Stack, Tooltip, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { cloneElement, useState, type MouseEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '#client/hooks/format.ts';
import { useMe } from '#client/hooks/me.ts';
import { useEmployees } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';

const EXCERPT = 400;

/** The context as plain text — paragraphs and list items on lines of their own — cut short: a hint is read at a glance. */
function excerpt(html: string): string {
  const lined = html.replace(/<li[^>]*>/gi, '\n• ').replace(/<\/(p|li|h[1-6]|div|blockquote|tr|pre)>|<br\s*\/?>/gi, '\n');
  const text = (new DOMParser().parseFromString(lined, 'text/html').body.textContent ?? '')
    .replace(/[ \t]+/g, ' ').replace(/ *\n[\s]*/g, '\n').trim();
  return text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text;
}

/** What the hint shows, fetched only once it opens. */
function Preview(p: { taskId: number }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const format = useFormat();
  const me = useMe();
  const employees = useEmployees();
  const preview = useQuery(trpc.Task.preview.queryOptions({ id: p.taskId }, { staleTime: 30_000 }));
  const data = preview.data;
  if (!data) return <Typography variant="caption">{t('common.loading')}</Typography>;
  if (!data.visible) return <Typography variant="caption">{t('taskHint.private')}</Typography>;
  const text = data.context ? excerpt(data.context) : '';
  return (
    <Stack spacing={0.75} sx={{ maxWidth: 360 }}>
      <Typography variant="caption" sx={{ whiteSpace: 'pre-wrap', opacity: text ? 1 : 0.8 }}>{text || t('task.contextEmpty')}</Typography>
      {data.people.length === 0 ? (
        <Typography variant="caption" sx={{ opacity: 0.8 }}>{t('taskHint.noTime')}</Typography>
      ) : (
        <Box component="table" sx={{ borderSpacing: '8px 0', mx: '-8px', '& td': { typography: 'caption', p: 0 } }}>
          <tbody>
            {data.people.map((person) => (
              <tr key={person.employeeId}>
                <td>{person.employeeId === me.id ? t('myDay.team.me') : employees.get(person.employeeId)?.fullName ?? `#${person.employeeId}`}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{format.minutes(person.spentMinutes)}</td>
                <td style={{ opacity: 0.8 }}>{person.leftMinutes !== null ? t('taskHint.left', { time: format.minutes(person.leftMinutes) }) : ''}</td>
              </tr>
            ))}
            {/* Everyone's together: the work the task took and has ahead (decision 68). */}
            {data.people.length > 1 && (
              <tr style={{ fontWeight: 600 }}>
                <td>{t('taskHint.total')}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {format.minutes(data.people.reduce((sum, x) => sum + x.spentMinutes, 0))}
                </td>
                <td>{t('taskHint.left', { time: format.minutes(data.people.reduce((sum, x) => sum + (x.leftMinutes ?? 0), 0)) })}</td>
              </tr>
            )}
          </tbody>
        </Box>
      )}
    </Stack>
  );
}

/** Marks a part of a task's line that has a hint of its own: over it, the task's hint gives way. */
export const OWN_HINT = { 'data-own-hint': true } as const;

const overOwnHint = (target: EventTarget | null) => target instanceof Element && target.closest('[data-own-hint]') !== null;

/**
 * The hint over a task in any list: its context and each person's time
 * logged and left on it — one's own and everyone else's — and, for two or
 * more, everyone's together (decision 68). Fetched when it opens, after a moment's hover.
 * Over a part with a hint of its own (OWN_HINT) it stays closed, so two
 * hints never show at once.
 */
export default function (p: { taskId: number; children: ReactElement<{ onMouseOver?: (e: MouseEvent) => void }> }) {
  const [open, setOpen] = useState(false);
  const child = cloneElement(p.children, {
    onMouseOver: (e: MouseEvent) => {
      p.children.props.onMouseOver?.(e);
      if (overOwnHint(e.target)) setOpen(false);
    },
  });
  return (
    <Tooltip
      title={<Preview taskId={p.taskId} />}
      open={open}
      onOpen={(e) => { if (!overOwnHint(e.target)) setOpen(true); }}
      onClose={() => setOpen(false)}
      enterDelay={500}
      enterNextDelay={300}
      placement="bottom-start"
      describeChild
    >
      {child}
    </Tooltip>
  );
}
