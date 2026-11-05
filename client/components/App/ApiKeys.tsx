import { Alert, Button, Checkbox, FormControlLabel, FormGroup, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiRight, type ApiKeyInput } from '#shared/apiKey.ts';
import { useFormat } from '#client/hooks/format.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import HelpLink from './HelpLink.tsx';

/**
 * A person's keys to the public API (decision 111): nothing is allowed unless
 * ticked, and every key ends by itself. The key is shown once.
 */
export default function () {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const format = useFormat();
  const queries = useQueryClient();
  const list = useQuery(trpc.ApiKey.list.queryOptions());
  const refresh = () => queries.invalidateQueries(trpc.ApiKey.list.queryFilter());
  const [name, setName] = useState('');
  const [days, setDays] = useState<ApiKeyInput['days']>(90);
  const [rights, setRights] = useState<ApiRight[]>([]);
  const [made, setMade] = useState<string | null>(null);
  const create = useMutation(trpc.ApiKey.create.mutationOptions({
    onSuccess: (key) => {
      void refresh();
      setMade((key as { key: string } | undefined)?.key ?? null);
      setName('');
      setRights([]);
    },
  }));
  const revoke = useMutation(trpc.ApiKey.revoke.mutationOptions({ onSuccess: () => { void refresh(); } }));

  return (
    <Stack spacing={2}>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {t('apiKey.intro')} <HelpLink to="api-calling">{t('apiKey.reference')}</HelpLink>
      </Typography>
      {made && (
        <Alert severity="warning" onClose={() => setMade(null)}>
          {t('apiKey.shown')}
          <Typography sx={{ fontFamily: 'monospace', fontSize: 13, overflowWrap: 'anywhere', mt: 0.5 }}>{made}</Typography>
        </Alert>
      )}
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1}>
          <TextField size="small" fullWidth label={t('apiKey.name')} value={name} onChange={(e) => setName(e.target.value)} />
          <TextField
            select
            size="small"
            label={t('apiKey.days')}
            value={days}
            onChange={(e) => setDays(Number(e.target.value) as ApiKeyInput['days'])}
            sx={{ minWidth: 140 }}
          >
            {[30, 90, 365].map((count) => <MenuItem key={count} value={count}>{t('apiKey.daysValue', { count })}</MenuItem>)}
          </TextField>
        </Stack>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>{t('apiKey.rights')}</Typography>
        <FormGroup>
          {ApiRight.options.map((right) => (
            <FormControlLabel
              key={right}
              label={t(`apiKey.rightNames.${right}`)}
              control={(
                <Checkbox
                  checked={rights.includes(right)}
                  onChange={(e) => setRights(e.target.checked ? [...rights, right] : rights.filter((r) => r !== right))}
                />
              )}
            />
          ))}
        </FormGroup>
        <div>
          <Button
            variant="contained"
            disabled={!name.trim() || rights.length === 0 || create.isPending}
            onClick={() => create.mutate({ name: name.trim(), days, rights })}
          >
            {t('apiKey.create')}
          </Button>
        </div>
      </Stack>
      {list.data?.map((key) => (
        <Paper key={key.id} variant="outlined" sx={{ p: 1.5 }} component="section" aria-label={key.name}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Stack sx={{ flexGrow: 1, minWidth: 0 }}>
              <Typography sx={{ fontWeight: 600 }}>{key.name}</Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {key.rights.map((r) => t(`apiKey.rightNames.${r}`)).join(', ')}
              </Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {t('apiKey.expires', { date: format.dateTime(key.expiresAt) })} · {key.lastUsedAt ? t('apiKey.used', { at: format.relative(key.lastUsedAt) }) : t('apiKey.unused')}
              </Typography>
            </Stack>
            <Button size="small" color="error" onClick={() => revoke.mutate({ id: key.id })}>{t('apiKey.revoke')}</Button>
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
}
