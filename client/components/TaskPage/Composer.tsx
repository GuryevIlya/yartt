import { AlternateEmail, AttachFile, Close, Tag } from '@mui/icons-material';
import {
  Alert, Autocomplete, Box, Button, Chip, IconButton, Paper, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Employee } from '#shared/employee.ts';
import { useDraft } from '#client/hooks/drafts.ts';
import { useMe } from '#client/hooks/me.ts';
import { useEmployees, useTaskRefresh } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import { uploadFile } from '#client/hooks/upload.ts';
import RichEditor, { type RichEditorHandle } from '../App/RichEditor.tsx';
import { employeeFilter, employeeOption } from '../App/employeeOption.tsx';

const HOLD_SECONDS = 5;

type Draft = {
  html: string;
  files: { id: number; name: string }[];
  mentions: Employee[];
  /** "All participants" (decision 95): everyone in the task but `except`. Absent in drafts kept before it. */
  everyone?: boolean;
  except?: Employee[];
  taskIds: number[];
};

export type ReplyTo = { id: number; authorId: number };

const EMPTY: Draft = { html: '', files: [], mentions: [], everyone: false, except: [], taskIds: [] };

/**
 * New comment. After "Send" it waits a few seconds with "Back to editing"
 * and only then goes to the server — comments are never edited. Until then
 * it is a draft of this task: leaving the page and coming back keeps it.
 */
export default function (p: {
  taskId: number;
  replyTo: ReplyTo | null;
  onCancelReply: () => void;
  /** "c" anywhere on the page (outside inputs) focuses this composer: the task page has one. */
  shortcut?: boolean;
  /**
   * Called once the comment went out (after the hold). Given (a reply from
   * My day), "Send" keeps the composer and its reply target until then.
   */
  onSent?: () => void;
}) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const me = useMe();
  const employees = useEmployees();
  const refresh = useTaskRefresh();
  const editor = useRef<RichEditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const [draft, setDraft, clearDraft] = useDraft<Draft>(`comment:${p.taskId}`, EMPTY);
  const { files, mentions, taskIds } = draft;
  const everyone = draft.everyone ?? false;
  const except = draft.except ?? [];
  const setEveryone = (on: boolean) => setDraft((d) => ({ ...d, everyone: on, except: [] }));
  const setExcept = (next: Employee[]) => setDraft((d) => ({ ...d, except: next }));
  const setFiles = (next: (prev: Draft['files']) => Draft['files']) => setDraft((d) => ({ ...d, files: next(d.files) }));
  const setMentions = (next: Employee[]) => setDraft((d) => ({ ...d, mentions: next }));
  const setTaskIds = (next: number[]) => setDraft((d) => ({ ...d, taskIds: next }));
  const [uploading, setUploading] = useState(0);
  const [showMention, setShowMention] = useState(false);
  const mentionable = useQuery(trpc.Observer.mentionable.queryOptions({ taskId: p.taskId }));
  const [taskInput, setTaskInput] = useState<string | null>(null);
  const [held, setHeld] = useState<(Draft & { replyTo: ReplyTo | null; seconds: number }) | null>(null);
  const [editorKey, setEditorKey] = useState(0);

  const create = useMutation(trpc.Comment.create.mutationOptions({ onSuccess: refresh }));

  // "Reply" far down the feed brings the composer into view, ready to type.
  const root = useRef<HTMLDivElement>(null);
  const replyId = p.replyTo?.id;
  useEffect(() => {
    if (replyId === undefined) return;
    root.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    editor.current?.focus();
  }, [replyId]);

  useEffect(() => {
    if (!p.shortcut) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key !== 'c' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      e.preventDefault();
      root.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      editor.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p.shortcut]);

  // The countdown of a held comment; at zero it goes out.
  useEffect(() => {
    if (!held) return;
    if (held.seconds === 0) {
      sendNow.current?.(held);
      setHeld(null);
      return;
    }
    const timer = setTimeout(() => setHeld({ ...held, seconds: held.seconds - 1 }), 1000);
    return () => clearTimeout(timer);
  }, [held]);

  // Leaving the page does not lose a held comment: it goes out at once.
  const heldRef = useRef(held);
  heldRef.current = held;
  const sendNow = useRef<(draft: NonNullable<typeof held>) => void>(null);
  const onSent = useRef(p.onSent);
  onSent.current = p.onSent;
  sendNow.current = (draft) => create.mutate({
    taskId: p.taskId,
    html: draft.html,
    replyToId: draft.replyTo?.id ?? null,
    files: draft.files,
    mentionIds: draft.mentions.map((m) => m.id),
    everyone: draft.everyone ?? false,
    exceptIds: (draft.except ?? []).map((e) => e.id),
    taskIds: draft.taskIds,
  }, { onSuccess: () => onSent.current?.(), onError: () => restore(draft) });
  useEffect(() => () => {
    if (heldRef.current) sendNow.current?.(heldRef.current);
  }, []);

  const attach = async (picked: File[]) => {
    setUploading((n) => n + picked.length);
    for (const file of picked) {
      try {
        const id = await uploadFile(file);
        setFiles((prev) => [...prev, { id, name: file.name }]);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const send = () => {
    if (!editor.current || editor.current.isEmpty() || uploading > 0) return;
    const next = { html: editor.current.getHtml(), files, mentions, everyone, except, taskIds, replyTo: p.replyTo, seconds: HOLD_SECONDS };
    // Set at once: if the composer unmounts before rendering again, the
    // unmount still finds the held comment and sends it.
    heldRef.current = next;
    setHeld(next);
    reset('');
    if (!p.onSent) p.onCancelReply();
  };

  // The editor is uncontrolled: a new key makes it take the draft's text.
  const reset = (html: string) => {
    if (html) setDraft({ ...EMPTY, html });
    else clearDraft();
    setEditorKey((k) => k + 1);
  };

  const restore = (held: Draft) => {
    setDraft({ html: held.html, files: held.files, mentions: held.mentions, everyone: held.everyone, except: held.except, taskIds: held.taskIds });
    setEditorKey((k) => k + 1);
  };

  const plain = (html: string) => new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
  const replyAuthor = p.replyTo ? employees.get(p.replyTo.authorId)?.fullName : null;
  // A private task: its participants only — who takes part is the owner's decision.
  const candidates = [...employees.values()].filter((e) => e.dismissedAt === null && e.id !== me.id
    && (mentionable.data?.everyone || mentionable.data?.ids.includes(e.id)));
  const people = new Set(mentionable.data?.people ?? []);

  return (
    <Stack ref={root} spacing={1.5} sx={{ scrollMarginTop: 16 }}>
      {held && (
        <Alert
          severity="warning"
          variant="outlined"
          icon={false}
          action={<Button color="inherit" onClick={() => { const h = held; setHeld(null); restore(h); }}>{t('task.composer.backToEditing')}</Button>}
        >
          {t('task.composer.sending', { text: plain(held.html).slice(0, 80), seconds: held.seconds })}
        </Alert>
      )}
      <Paper variant="outlined" sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {p.replyTo && (
          <Chip
            size="small"
            sx={{ alignSelf: 'flex-start' }}
            label={t('task.composer.replyTo', { name: replyAuthor ?? `#${p.replyTo.authorId}` })}
            onDelete={p.onCancelReply}
          />
        )}
        <RichEditor
          key={editorKey}
          handle={editor}
          initial={draft.html}
          placeholder={t('task.composer.placeholder')}
          onFiles={attach}
          onSubmit={send}
          onChange={(html) => setDraft((d) => ({ ...d, html }))}
        />
        {(files.length > 0 || mentions.length > 0 || everyone || taskIds.length > 0 || uploading > 0) && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
            {everyone && (
              <Chip size="small" color="primary" label={t('task.composer.everyone')} onDelete={() => setEveryone(false)} />
            )}
            {except.map((e) => (
              <Chip key={`x${e.id}`} size="small" variant="outlined" label={t('task.composer.except', { name: e.fullName })}
                onDelete={() => setExcept(except.filter((x) => x.id !== e.id))} />
            ))}
            {mentions.map((m) => (
              <Chip key={`m${m.id}`} size="small" color="primary" variant="outlined" label={`@${m.fullName}`}
                onDelete={() => setMentions(mentions.filter((x) => x.id !== m.id))} />
            ))}
            {taskIds.map((id) => (
              <Chip key={`t${id}`} size="small" variant="outlined" label={`#${id}`} onDelete={() => setTaskIds(taskIds.filter((x) => x !== id))} />
            ))}
            {files.map((f) => (
              <Chip key={`f${f.id}`} size="small" icon={<AttachFile />} label={f.name} onDelete={() => setFiles((prev) => prev.filter((x) => x.id !== f.id))} />
            ))}
            {uploading > 0 && <Chip size="small" label={t('task.composer.uploading')} />}
          </Box>
        )}
        {showMention && (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
            {/* With "All participants" on, a pick is an exception. */}
            <Autocomplete
              sx={{ flexGrow: 1 }}
              options={everyone
                ? candidates.filter((e) => people.has(e.id) && !except.some((x) => x.id === e.id))
                : candidates.filter((e) => !mentions.some((m) => m.id === e.id))}
              getOptionLabel={(e) => e.fullName}
              renderOption={(props, e) => employeeOption(props, e)}
              filterOptions={employeeFilter}
              onChange={(_e, value) => {
                if (value) {
                  if (everyone) setExcept([...except, value]);
                  else setMentions([...mentions, value]);
                }
                setShowMention(false);
              }}
              onBlur={() => setShowMention(false)}
              renderInput={(params) => (
                <TextField {...params} autoFocus placeholder={t(everyone ? 'task.composer.exceptWho' : 'task.composer.mention')}
                  helperText={t(mentionable.data?.everyone ? 'task.composer.mentionHintPublic' : 'task.composer.mentionHint')} />
              )}
              openOnFocus
            />
            {!everyone && (
              // onMouseDown: pressed before the field's blur closes it.
              <Button sx={{ mt: 1 }} onMouseDown={(e) => { e.preventDefault(); setEveryone(true); setShowMention(false); }}>
                {t('task.composer.everyone')}
              </Button>
            )}
          </Stack>
        )}
        {taskInput !== null && (
          <TextField
            autoFocus
            placeholder={t('task.composer.attachTask')}
            value={taskInput}
            onChange={(e) => setTaskInput(e.target.value.replace(/\D/g, ''))}
            onBlur={() => setTaskInput(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && taskInput) {
                e.preventDefault();
                const id = Number(taskInput);
                if (id !== p.taskId && !taskIds.includes(id)) setTaskIds([...taskIds, id]);
                setTaskInput(null);
              }
              if (e.key === 'Escape') setTaskInput(null);
            }}
            slotProps={{ input: { startAdornment: <Typography sx={{ color: 'text.secondary', pr: 0.5 }}>#</Typography> } }}
          />
        )}
        <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
          <Tooltip title={t('task.composer.mention')}>
            <IconButton onClick={() => setShowMention(true)}><AlternateEmail /></IconButton>
          </Tooltip>
          <Tooltip title={t('task.composer.attachTask')}>
            <IconButton onClick={() => setTaskInput('')}><Tag /></IconButton>
          </Tooltip>
          <Tooltip title={t('task.composer.attachFile')}>
            <IconButton onClick={() => fileInput.current?.click()}><AttachFile /></IconButton>
          </Tooltip>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => { void attach(Array.from(e.target.files ?? [])); e.target.value = ''; }}
          />
          {p.replyTo && (
            <Tooltip title={t('task.composer.cancelReply')}>
              <IconButton onClick={p.onCancelReply}><Close /></IconButton>
            </Tooltip>
          )}
          <Box sx={{ flexGrow: 1 }} />
          <Button variant="contained" disabled={uploading > 0 || create.isPending} onClick={send}>{t('task.composer.send')}</Button>
        </Stack>
      </Paper>
    </Stack>
  );
}
