import { Delete } from '@mui/icons-material';
import { Box, Button, IconButton, MenuItem, Paper, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WEBHOOK_GROUPS, type Webhook, type WebhookGroup, type WebhookLevel, type WebhookLevels } from '#shared/webhook.ts';
import { useFormat } from '#client/hooks/format.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import HelpLink from './HelpLink.tsx';

/** A new webhook says that things happened, with a link: nothing of a task leaves until its owner asks for it. */
const DEFAULT_LEVELS = Object.fromEntries(WEBHOOK_GROUPS.map((g) => [g, 'event'])) as WebhookLevels;
const LEVELS: WebhookLevel[] = ['off', 'event', 'title', 'text'];

/**
 * A person's webhooks (decision 110): an address a receiver gave them, and
 * for each group of events how much goes there.
 */
export default function () {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const queries = useQueryClient();
  const list = useQuery(trpc.Webhook.list.queryOptions());
  const refresh = { onSuccess: () => queries.invalidateQueries(trpc.Webhook.list.queryFilter()) };
  const create = useMutation(trpc.Webhook.create.mutationOptions(refresh));
  const [url, setUrl] = useState('');
  const add = () => create.mutate({ url: url.trim(), levels: DEFAULT_LEVELS }, { onSuccess: () => setUrl('') });

  return (
    <Stack spacing={2}>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {t('webhook.intro')} <HelpLink to="api-webhooks">{t('webhook.format')}</HelpLink>
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
        <TextField
          size="small"
          fullWidth
          label={t('webhook.url')}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && url.trim()) add(); }}
        />
        <Button variant="contained" sx={{ flexShrink: 0 }} disabled={!url.trim() || create.isPending} onClick={add}>
          {t('webhook.add')}
        </Button>
      </Stack>
      {list.data?.map((webhook) => <Item key={webhook.id} webhook={webhook} />)}
    </Stack>
  );
}

function Item(p: { webhook: Webhook }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const format = useFormat();
  const queries = useQueryClient();
  const refresh = { onSuccess: () => queries.invalidateQueries(trpc.Webhook.list.queryFilter()) };
  const update = useMutation(trpc.Webhook.update.mutationOptions(refresh));
  const remove = useMutation(trpc.Webhook.remove.mutationOptions(refresh));
  const test = useMutation(trpc.Webhook.test.mutationOptions(refresh));
  const { webhook } = p;
  const at = webhook.lastAt ? format.relative(webhook.lastAt) : '';
  const set = (group: WebhookGroup, level: WebhookLevel) =>
    update.mutate({ id: webhook.id, url: webhook.url, levels: { ...webhook.levels, [group]: level } });
  return (
    <Paper variant="outlined" sx={{ p: 2 }} component="section" aria-label={webhook.url}>
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography sx={{ flexGrow: 1, minWidth: 0, overflowWrap: 'anywhere', fontFamily: 'monospace', fontSize: 13 }}>{webhook.url}</Typography>
          <Button size="small" disabled={test.isPending} onClick={() => test.mutate({ id: webhook.id })}>{t('webhook.test')}</Button>
          <Tooltip title={t('webhook.remove')}>
            <IconButton size="small" aria-label={t('webhook.remove')} onClick={() => remove.mutate({ id: webhook.id })}><Delete fontSize="small" /></IconButton>
          </Tooltip>
        </Stack>
        <Typography variant="caption" sx={{ color: webhook.lastError ? 'error.main' : 'text.secondary' }}>
          {!webhook.lastAt ? t('webhook.none')
            : webhook.lastError ? t('webhook.failed', { at, error: webhook.lastError }) : t('webhook.ok', { at })}
        </Typography>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>{t('webhook.send')}</Typography>
        <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
          {WEBHOOK_GROUPS.map((group) => (
            <TextField
              key={group}
              select
              size="small"
              label={t(`webhook.groups.${group}`)}
              value={webhook.levels[group]}
              onChange={(e) => set(group, e.target.value as WebhookLevel)}
            >
              {LEVELS.map((level) => <MenuItem key={level} value={level}>{t(`webhook.levels.${level}`)}</MenuItem>)}
            </TextField>
          ))}
        </Box>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('webhook.outside')}</Typography>
        <TextField
          size="small"
          label={t('webhook.secret')}
          helperText={t('webhook.secretHint')}
          value={webhook.secret}
          slotProps={{ input: { readOnly: true, sx: { fontFamily: 'monospace', fontSize: 13 } } }}
        />
      </Stack>
    </Paper>
  );
}
