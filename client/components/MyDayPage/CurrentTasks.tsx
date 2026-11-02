import { Add, Search } from '@mui/icons-material';
import { Button, InputAdornment, Pagination, Paper, Stack, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import type { CurrentTab } from '#shared/myDay.ts';
import type { Tag } from '#shared/task.ts';
import { BASE } from '#client/hooks/base.ts';
import { useFormat } from '#client/hooks/format.ts';
import { useStore } from '#client/hooks/store.ts';
import { POLL_MS } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import { useViewAs } from '#client/hooks/viewAs.ts';
import TagInput, { useTitle } from '../App/TagInput.tsx';
import TaskLine from '../TaskPage/TaskLine.tsx';
import TakenLink from '../App/TakenLink.tsx';

const PAGE_SIZE = 20;
const TABS = ['mine', 'team', 'others', 'closed'] as const;

/**
 * Every open task I see: mine apart from the others (decision 8) — and, for
 * a manager, those their people own (down the chain) apart too — by
 * deadline, with pages; the closed ones in a tab of their own, the most
 * recently closed first (decision 57). The search on top narrows the tabs
 * to the tasks carrying the picked tags — any task then, not mine included;
 * the typed text only finds tags ("/" focuses it from anywhere). Its "+"
 * opens a new task with the title as typed — the picked tags and the rest
 * as a new tag (decision 55); it waits while a tag spelled so is not
 * picked, and is off when a task has that title already. A tag in a line
 * below adds itself to the search.
 */
export default function (p: { team: boolean }) {
  const { t } = useTranslation();
  // A report's, on their page: their tabs, no search and no new task (decision 83).
  const { as, readOnly } = useViewAs();
  const format = useFormat();
  const trpc = useTRPC();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<CurrentTab>('mine');
  const [pages, setPages] = useState<Record<CurrentTab, number>>({ mine: 1, team: 1, others: 1, closed: 1 });
  const tabs = TABS.filter((value) => value !== 'team' || p.team);
  const [tags, setTags] = useState<Tag[]>([]);
  const [input, setInput] = useState('');
  const filtering = tags.length > 0;
  const title = useTitle(tags.map((tag) => ({ tag })), input);
  const canCreate = title.names.length === 0 || title.ready;
  const createHint = title.taken ? t('title.taken', { id: title.taken.id })
    : title.pickFirst ? t('title.pickFirst', { name: title.pickFirst })
    : title.names.length ? t('title.create', { title: title.names.join(' · ') }) : t('newTask.title');
  const page = pages[tab];

  const current = useQuery(trpc.MyDay.current.queryOptions(
    { tab, page, as },
    { enabled: !filtering, refetchInterval: POLL_MS, placeholderData: keepPreviousData },
  ));
  const found = useQuery(trpc.Task.search.queryOptions(
    { tagIds: tags.map((tag) => tag.id), tab, page },
    { enabled: filtering, placeholderData: keepPreviousData },
  ));
  const shown = filtering ? found : current;
  const counts = shown.data?.counts;
  // The time planned on a line: what makes a task someone does mine (or the team's) though owned by another;
  // then everyone's time on it, logged → left (hours of a task add up, decision 68).
  const note = (taskId: number) => {
    const minutes = shown.data?.plans.find((x) => x.taskId === taskId)?.minutes;
    const hours = (shown.data?.hours ?? []).find((x) => x.taskId === taskId); // none in a cache saved by an older release
    const parts = [
      minutes ? t(tab === 'team' ? 'myDay.current.teamPlan' : 'myDay.current.myPlan', { time: format.minutes(minutes) }) : null,
      hours ? t('myDay.current.hours', { spent: format.minutes(hours.spentMinutes), left: format.minutes(hours.leftMinutes) }) : null,
    ].filter((part) => part !== null);
    return parts.length ? parts.join(' · ') : undefined;
  };
  const total = counts?.[tab] ?? 0;

  // A new filter starts from the first page.
  const filter = (next: { tags?: Tag[]; input?: string }) => {
    if (next.tags) setTags(next.tags);
    if (next.input !== undefined) setInput(next.input);
    setPages({ mine: 1, team: 1, others: 1, closed: 1 });
  };

  // Nothing found in this tab but something in another: show the first such,
  // once per filter, so the empty tab can still be opened by hand.
  const foundCounts = found.isPlaceholderData ? undefined : found.data?.counts;
  const other = tabs.find((value) => value !== tab && (foundCounts?.[value] ?? 0) > 0);
  const filterKey = JSON.stringify(tags.map((tag) => tag.id));
  const switchedFor = useRef('');
  useEffect(() => {
    if (!filtering || !foundCounts || switchedFor.current === filterKey) return;
    switchedFor.current = filterKey;
    if (foundCounts[tab] === 0 && other) setTab(other);
  }, [filtering, foundCounts, filterKey, tab, other]);

  // The search gets the focus once My day is on screen (it is hidden under a task).
  const wantsFocus = useRef(false);
  // The address is read when the key is pressed: right after following a link
  // the last render may still think My day is on screen.
  const focusSearch = () => {
    wantsFocus.current = true;
    if (window.location.pathname.replace(/\/$/, '') === BASE) inputRef.current?.focus();
    else void navigate('/');
  };
  useEffect(() => {
    if (pathname !== '/' || !wantsFocus.current) return;
    wantsFocus.current = false;
    inputRef.current?.focus();
  }, [pathname]);

  // "/" outside inputs: back to My day and into the search.
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key !== '/' || target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      e.preventDefault();
      focusSearch();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Another place asked to search by tags (a tag in My tags).
  const requested = useStore((s) => s.searchTags);
  useEffect(() => {
    if (!requested || readOnly) return;
    filter({ tags: requested, input: '' });
    useStore.setState({ searchTags: null });
    focusSearch();
  });

  return (
    <Paper component="section" aria-label={t('myDay.current.title')} sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
        <Typography variant="h3" sx={{ fontWeight: 600, flexGrow: 1 }}>{t('myDay.current.title')}</Typography>
        {/* A button with a word, not a bare "+" in the field: creating is half of what this block is for. */}
        {!readOnly && <Tooltip title={createHint}>
          <span>
            <Button
              size="small"
              startIcon={<Add />}
              disabled={!canCreate}
              onClick={() => void navigate('/tasks/new', { state: { parts: title.parts } })}
            >
              {t('newTask.title')}
            </Button>
          </span>
        </Tooltip>}
      </Stack>
      {!readOnly && <TagInput
        value={tags.map((tag) => ({ tag }))}
        onChange={(next) => filter({ tags: next.flatMap((part) => ('tag' in part ? [part.tag] : [])) })}
        input={input}
        onInputChange={(next) => filter({ input: next })}
        placeholder={t('search.placeholder')}
        inputRef={inputRef}
        startAdornment={<InputAdornment position="start"><Search fontSize="small" /></InputAdornment>}
        sx={{ mt: 0.5 }}
      />}
      {title.taken && (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          <TakenLink id={title.taken.id} />
        </Typography>
      )}
      {title.pickFirst && (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('title.pickFirst', { name: title.pickFirst })}</Typography>
      )}
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1, mb: 1 }}>
        <Tabs value={tab} onChange={(_, value: CurrentTab) => setTab(value)} variant="scrollable" scrollButtons={false} sx={{ minHeight: 0, flexGrow: 1 }}>
          {tabs.map((value) => (
            <Tab
              key={value}
              value={value}
              label={(
                <Tooltip title={t(`myDay.current.${value}Hint`)} describeChild>
                  <span>{t(`myDay.current.${value}`, { count: counts?.[value] ?? 0 })}</span>
                </Tooltip>
              )}
              sx={{ minHeight: 0, py: 1 }}
            />
          ))}
        </Tabs>
      </Stack>
      {shown.isSuccess && total === 0 && (
        <Typography sx={{ color: 'text.secondary' }}>
          {filtering ? t('search.noResults') : t(`myDay.current.${tab}Empty`)}
        </Typography>
      )}
      <Stack spacing={0.75} sx={{ opacity: shown.isPlaceholderData ? 0.6 : 1 }}>
        {shown.data?.items.map((task) => (
          <TaskLine
            key={task.id}
            task={task}
            note={note(task.id)}
            noteHint={(shown.data?.hours ?? []).some((x) => x.taskId === task.id) ? t('myDay.current.hoursHint') : undefined}
            onTag={readOnly ? undefined : (tag) => { if (!tags.some((picked) => picked.id === tag.id)) filter({ tags: [...tags, tag] }); }}
          />
        ))}
      </Stack>
      {total > PAGE_SIZE && (
        <Pagination
          count={Math.ceil(total / PAGE_SIZE)}
          page={page}
          onChange={(_, value) => setPages((prev) => ({ ...prev, [tab]: value }))}
          sx={{ alignSelf: 'center', mt: 1 }}
        />
      )}
    </Paper>
  );
}
