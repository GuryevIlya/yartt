import { Add, Clear, Remove, Search as SearchIcon } from '@mui/icons-material';
import {
  Box, Button, ButtonBase, IconButton, InputAdornment, Pagination, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MyTag } from '#shared/tags.ts';
import { searchByTags } from '#client/hooks/store.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import TagChip, { TAG_COLORS } from './TagChip.tsx';
import TagDescriptionDialog from './TagDescriptionDialog.tsx';

const PAGE_SIZE = 50;

// My tags, in the profile (decision 31): the vocabulary of the tasks I see,
// with my own colors and weights. Nobody else sees them. A tag opens the
// search narrowed to it (`onOpen` closes the profile first).
export default function (p: { onOpen: () => void }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const tags = useQuery(trpc.Tags.mine.queryOptions({ query: query.trim(), page }, { placeholderData: keepPreviousData }));
  const total = tags.data?.total ?? 0;

  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('tags.hint')}</Typography>
      <TextField
        size="small"
        placeholder={t('tags.filter')}
        value={query}
        onChange={(e) => { setQuery(e.target.value); setPage(1); }}
        slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> } }}
      />
      {tags.isSuccess && total === 0 && <Typography sx={{ color: 'text.secondary' }}>{t('tags.empty')}</Typography>}
      <Box sx={{ opacity: tags.isPlaceholderData ? 0.6 : 1 }}>
        {tags.data?.items.map((tag) => <Row key={tag.id} tag={tag} onOpen={p.onOpen} />)}
      </Box>
      {total > PAGE_SIZE && (
        <Pagination count={Math.ceil(total / PAGE_SIZE)} page={page} onChange={(_, v) => setPage(v)} sx={{ alignSelf: 'center' }} />
      )}
    </Stack>
  );
}

function Row(p: { tag: MyTag; onOpen: () => void }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const set = useMutation(trpc.Tags.set.mutationOptions({
    // Colors and the order of tags show everywhere: refetch it all.
    onSuccess: () => queryClient.invalidateQueries(),
  }));
  const { tag } = p;
  const [describing, setDescribing] = useState(false);
  const save = (change: { color?: string | null; weight?: number }) =>
    set.mutate({ tagId: tag.id, color: change.color === undefined ? tag.color : change.color, weight: change.weight ?? tag.weight });

  return (
    <Stack direction="row" sx={{ alignItems: 'center', gap: 1.5, py: 1, borderTop: 1, borderColor: 'divider', flexWrap: 'wrap' }}>
      <Stack sx={{ flex: '1 1 200px', minWidth: 0, alignItems: 'flex-start', gap: 0.25 }}>
        <Tooltip title={t('tags.open')} describeChild>
          <TagChip tag={tag} onClick={() => { p.onOpen(); searchByTags([tag]); }} />
        </Tooltip>
        <Typography variant="caption" sx={{ color: 'text.secondary', pl: 0.5 }}>
          {t('tags.counts', { tasks: tag.tasks, open: tag.open })}
        </Typography>
      </Stack>
      <Button size="small" onClick={() => setDescribing(true)}>{t('tags.description')}</Button>
      {describing && <TagDescriptionDialog tag={tag} onClose={() => setDescribing(false)} />}
      <Stack direction="row" sx={{ gap: 0.5, alignItems: 'center' }}>
        {TAG_COLORS.map((color) => (
          <ButtonBase
            key={color}
            aria-label={color}
            onClick={() => save({ color })}
            sx={{
              width: 18, height: 18, borderRadius: '50%', bgcolor: color,
              outline: tag.color === color ? 2 : 0, outlineColor: 'text.primary', outlineOffset: 2,
            }}
          />
        ))}
        <Tooltip title={t('tags.noColor')}>
          <span>
            <IconButton size="small" disabled={tag.color === null} onClick={() => save({ color: null })}><Clear fontSize="small" /></IconButton>
          </span>
        </Tooltip>
      </Stack>
      <Tooltip title={t('tags.weightHint')}>
        <Stack direction="row" sx={{ alignItems: 'center' }}>
          <IconButton size="small" aria-label={t('tags.lighter')} onClick={() => save({ weight: tag.weight - 1 })} disabled={tag.weight <= -99}>
            <Remove fontSize="small" />
          </IconButton>
          <Typography sx={{ minWidth: 28, textAlign: 'center', fontWeight: tag.weight !== 0 ? 600 : 400 }}>{tag.weight}</Typography>
          <IconButton size="small" aria-label={t('tags.heavier')} onClick={() => save({ weight: tag.weight + 1 })} disabled={tag.weight >= 99}>
            <Add fontSize="small" />
          </IconButton>
        </Stack>
      </Tooltip>
    </Stack>
  );
}
