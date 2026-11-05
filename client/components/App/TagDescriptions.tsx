import { ExpandLess, ExpandMore } from '@mui/icons-material';
import { Box, Button, Stack, Typography } from '@mui/material';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TagDescription } from '#shared/tagDescription.ts';
import { useEmployees } from '#client/hooks/task.ts';
import RichView from './RichView.tsx';

/**
 * What the tags mean along a chain, from the top down, each with its author
 * (decision 112). Folded: with several tags it may be long.
 */
export default function (p: { items: TagDescription[]; tags: { id: number; name: string }[] }) {
  const { t } = useTranslation();
  const employees = useEmployees();
  const [open, setOpen] = useState(false);
  if (p.items.length === 0) return null;
  return (
    <Stack spacing={1}>
      <Box>
        <Button size="small" color="inherit" startIcon={open ? <ExpandLess /> : <ExpandMore />} aria-expanded={open} onClick={() => setOpen(!open)}>
          {t('tags.descriptionsShow', { count: p.items.length })}
        </Button>
      </Box>
      {open && p.tags.filter((tag) => p.items.some((d) => d.tagId === tag.id)).map((tag) => (
        <Stack key={tag.id} spacing={0.5}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>{tag.name}</Typography>
          {p.items.filter((d) => d.tagId === tag.id).map((d) => (
            <Box key={d.authorId} sx={{ pl: 1.5, borderLeft: 2, borderColor: 'divider' }}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>{employees.get(d.authorId)?.fullName ?? `#${d.authorId}`}</Typography>
              <RichView html={d.html} />
            </Box>
          ))}
        </Stack>
      ))}
    </Stack>
  );
}
