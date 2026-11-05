import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useDraft } from '#client/hooks/drafts.ts';
import { useMe } from '#client/hooks/me.ts';
import { useEmployees } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import RichEditor, { type RichEditorHandle } from './RichEditor.tsx';
import RichView from './RichView.tsx';

/** One's own description of a tag, next to what the managers above wrote (decision 112). */
export default function (p: { tag: { id: number; name: string }; onClose: () => void }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const me = useMe();
  const employees = useEmployees();
  const queries = useQueryClient();
  const chain = useQuery(trpc.Tags.descriptions.queryOptions({ tagIds: [p.tag.id] }));
  const mine = chain.data?.find((d) => d.authorId === me.id);
  const above = chain.data?.filter((d) => d.authorId !== me.id) ?? [];
  const [draft, setDraft, clearDraft] = useDraft<string | null>(`tagDescription:${p.tag.id}`, null);
  const editor = useRef<RichEditorHandle>(null);
  const set = useMutation(trpc.Tags.setDescription.mutationOptions({
    onSuccess: () => { clearDraft(); void queries.invalidateQueries(); p.onClose(); },
  }));
  const close = () => { clearDraft(); p.onClose(); };

  return (
    <Dialog open fullWidth maxWidth="md" onClose={close}>
      <DialogTitle>{t('tags.descriptionTitle', { name: p.tag.name })}</DialogTitle>
      <DialogContent>
        {chain.isSuccess && (
          <Stack spacing={2}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('tags.descriptionHint')}</Typography>
            {above.length > 0 && (
              <Stack spacing={1}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{t('tags.descriptionAbove')}</Typography>
                {above.map((d) => (
                  <Box key={d.authorId} sx={{ pl: 1.5, borderLeft: 2, borderColor: 'divider' }}>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>{employees.get(d.authorId)?.fullName ?? `#${d.authorId}`}</Typography>
                    <RichView html={d.html} />
                  </Box>
                ))}
              </Stack>
            )}
            <Stack spacing={0.75}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>{t('tags.descriptionMine')}</Typography>
              <RichEditor
                handle={editor}
                initial={draft ?? mine?.html ?? ''}
                placeholder={t('tags.descriptionPlaceholder')}
                onChange={setDraft}
                noImages
              />
            </Stack>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={close}>{t('common.cancel')}</Button>
        <Button
          variant="contained"
          disabled={set.isPending || !chain.isSuccess}
          onClick={() => set.mutate({ tagId: p.tag.id, html: editor.current?.isEmpty() ? null : (editor.current?.getHtml() ?? null) })}
        >
          {t('common.save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
