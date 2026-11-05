import { ContentCopy } from '@mui/icons-material';
import {
  Alert, Autocomplete, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControlLabel, FormGroup,
  IconButton, MenuItem, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { BOT_PERMISSIONS, type Bot, type BotInput, type BotPermission, type BotStats } from '#shared/bot.ts';
import { PRONOUNS, type Employee, type Pronoun } from '#shared/employee.ts';
import { useDraft } from '#client/hooks/drafts.ts';
import { useFormat } from '#client/hooks/format.ts';
import { useMe } from '#client/hooks/me.ts';
import { showInfo } from '#client/hooks/store.ts';
import { useEmployees } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import { fieldErrors } from '#client/i18n/errors.ts';
import TeamChart from './TeamChart.tsx';
import HelpLink from '../App/HelpLink.tsx';
import { employeeFilter, employeeOption } from '../App/employeeOption.tsx';

/** A key or a secret shown once, with a copy button. */
function Secret(p: { label: string; value: string; onClose?: () => void }) {
  const { t } = useTranslation();
  return (
    <Alert
      severity="success"
      onClose={p.onClose}
      action={(
        <Tooltip title={t('bots.copy')}>
          <IconButton size="small" onClick={() => { void navigator.clipboard?.writeText(p.value); showInfo(t('bots.copied')); }}>
            <ContentCopy fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
    >
      <Typography variant="body2">{p.label}</Typography>
      <Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{p.value}</Typography>
    </Alert>
  );
}

const EMPTY: BotInput = { fullName: '', pronoun: null, about: null, permissions: [], webhookUrl: null };

/**
 * A bot's settings (decision 49): its direct manager changes them, replaces
 * the key (shown once), hands the bot to someone, dismisses or brings it
 * back; managers above only look. `bot` NULL — a new bot under me.
 */
export default function (p: { bot: Bot | null; stats?: BotStats; onClose: () => void }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const me = useMe();
  const format = useFormat();
  const employees = useEmployees();
  const theme = useTheme();
  const palette = (theme.vars ?? theme).palette;
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.Bot.pathKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.Employee.list.queryKey() });
  };
  const bot = p.bot;
  const mine = bot === null || bot.managerId === me.id;
  const editable = mine && !bot?.dismissedAt;
  const initial: BotInput = bot
    ? { fullName: bot.fullName, pronoun: bot.pronoun, about: bot.about, permissions: bot.permissions, webhookUrl: bot.webhookUrl }
    : EMPTY;
  const [form, setForm, clearForm] = useDraft<BotInput>(`bot:${bot?.id ?? 'new'}`, initial);
  const [key, setKey] = useState<string | null>(null);
  const [handTo, setHandTo] = useState<Employee | null>(null);

  const create = useMutation(trpc.Bot.create.mutationOptions({
    onSuccess: (created) => { clearForm(); refresh(); if (created) setKey(created.key); },
  }));
  const update = useMutation(trpc.Bot.update.mutationOptions({ onSuccess: () => { clearForm(); refresh(); } }));
  const resetKey = useMutation(trpc.Bot.resetKey.mutationOptions({ onSuccess: (r) => { refresh(); if (r) setKey(r.key); } }));
  const resetSecret = useMutation(trpc.Bot.resetWebhookSecret.mutationOptions({ onSuccess: refresh }));
  const transfer = useMutation(trpc.Bot.transfer.mutationOptions({ onSuccess: () => { refresh(); p.onClose(); } }));
  const dismiss = useMutation(trpc.Employee.dismiss.mutationOptions({ onSuccess: () => { refresh(); p.onClose(); } }));
  const restore = useMutation(trpc.Employee.restore.mutationOptions({ onSuccess: () => { refresh(); p.onClose(); } }));
  const errors = fieldErrors(bot ? update.error : create.error);

  const input = (): BotInput => ({
    ...form,
    fullName: form.fullName.trim(),
    about: form.about?.trim() || null,
    webhookUrl: form.webhookUrl?.trim() || null,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (bot) update.mutate({ id: bot.id, ...input() });
    else create.mutate(input());
  };
  const togglePermission = (perm: BotPermission, on: boolean) =>
    setForm((f) => ({ ...f, permissions: on ? [...f.permissions, perm] : f.permissions.filter((x) => x !== perm) }));
  const people = [...employees.values()].filter((e) => e.kind === 'human' && e.dismissedAt === null && e.id !== me.id);

  // A new bot, once created: only its key is left to show.
  if (!bot && key) {
    return (
      <Dialog open onClose={p.onClose} fullWidth maxWidth="sm">
        <DialogTitle>{t('bots.createdTitle')}</DialogTitle>
        <DialogContent>
          <Secret label={t('bots.keyShown')} value={key} />
          <Typography variant="body2" sx={{ mt: 1.5 }}><HelpLink to="api-calling">{t('bots.howToCall')}</HelpLink></Typography>
        </DialogContent>
        <DialogActions><Button onClick={p.onClose}>{t('common.close')}</Button></DialogActions>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={p.onClose} fullWidth maxWidth="sm">
      <form onSubmit={submit}>
        <DialogTitle>{bot ? bot.fullName : t('bots.createTitle')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {!mine && bot && (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                {t('bots.notMine', { name: employees.get(bot.managerId)?.fullName ?? `#${bot.managerId}` })}
              </Typography>
            )}
            <TextField
              label={t('bots.name')}
              required
              autoFocus={!bot}
              disabled={!editable}
              value={form.fullName}
              onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
              error={!!errors.fullName}
              helperText={errors.fullName}
            />
            <TextField
              select
              label={t('bots.pronoun')}
              disabled={!editable}
              value={form.pronoun ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, pronoun: (e.target.value || null) as Pronoun | null }))}
              helperText={t('bots.pronounHint')}
            >
              <MenuItem value="">{t('profile.pronouns.none')}</MenuItem>
              {PRONOUNS.map((value) => <MenuItem key={value} value={value}>{t(`profile.pronouns.${value}`)}</MenuItem>)}
            </TextField>
            <TextField
              label={t('bots.about')}
              multiline
              minRows={2}
              disabled={!editable}
              value={form.about ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, about: e.target.value }))}
              error={!!errors.about}
              helperText={errors.about ?? t('bots.aboutHint')}
            />
            <Stack>
              <Typography variant="subtitle2">{t('bots.permissions')}</Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('bots.permissionsHint')} <HelpLink to="api-methods">{t('bots.whatCanDo')}</HelpLink></Typography>
              <FormGroup>
                {BOT_PERMISSIONS.map((perm) => (
                  <FormControlLabel
                    key={perm}
                    disabled={!editable}
                    control={<Checkbox size="small" checked={form.permissions.includes(perm)} onChange={(e) => togglePermission(perm, e.target.checked)} />}
                    label={(
                      <Stack>
                        <Typography variant="body2">{t(`bots.permission.${perm}`)}</Typography>
                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t(`bots.permissionHint.${perm}`)}</Typography>
                      </Stack>
                    )}
                  />
                ))}
              </FormGroup>
            </Stack>
            <TextField
              label={t('bots.webhook')}
              type="url"
              disabled={!editable}
              value={form.webhookUrl ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, webhookUrl: e.target.value }))}
              error={!!errors.webhookUrl}
              helperText={errors.webhookUrl ?? <>{t('bots.webhookHint')} <HelpLink to="api-webhooks">{t('webhook.format')}</HelpLink></>}
            />
            {bot?.webhookSecret && (
              <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                <TextField
                  size="small"
                  label={t('bots.webhookSecret')}
                  value={bot.webhookSecret}
                  slotProps={{ input: { readOnly: true, sx: { fontFamily: 'monospace' } } }}
                  sx={{ flexGrow: 1 }}
                />
                <Button size="small" disabled={!editable || resetSecret.isPending} onClick={() => resetSecret.mutate({ id: bot.id })}>
                  {t('bots.resetSecret')}
                </Button>
              </Stack>
            )}

            {bot && p.stats && p.stats.requests > 0 && (
              <Box>
                <Typography variant="subtitle2">{t('bots.chart')}</Typography>
                <TeamChart
                  days={p.stats.daily.map((d) => d.day)}
                  format={(v) => String(Math.round(v))}
                  series={[
                    { id: 'requests', label: t('bots.requests'), color: palette.primary.main, values: p.stats.daily.map((d) => d.requests) },
                    { id: 'refused', label: t('bots.refusedLabel'), color: palette.error.main, values: p.stats.daily.map((d) => d.refused) },
                  ]}
                />
              </Box>
            )}
            {bot && (
              <>
                <Divider />
                <Typography variant="subtitle2">{t('bots.key')}</Typography>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  {t('bots.keyMeta', { at: format.dateTime(bot.keyIssuedAt) })}
                </Typography>
                {key && <Secret label={t('bots.keyShown')} value={key} onClose={() => setKey(null)} />}
                {editable && (
                  <Button
                    size="small"
                    sx={{ alignSelf: 'flex-start' }}
                    disabled={resetKey.isPending}
                    onClick={() => { if (window.confirm(t('bots.resetKeyConfirm'))) resetKey.mutate({ id: bot.id }); }}
                  >
                    {t('bots.resetKey')}
                  </Button>
                )}
                {editable && (
                  <>
                    <Divider />
                    <Typography variant="subtitle2">{t('bots.transfer')}</Typography>
                    <Stack direction="row" sx={{ gap: 1, alignItems: 'center' }}>
                      <Autocomplete
                        size="small"
                        sx={{ flexGrow: 1 }}
                        options={people}
                        value={handTo}
                        onChange={(_, v) => setHandTo(v)}
                        getOptionLabel={(e) => e.fullName}
                        renderOption={(props, e) => employeeOption(props, e)}
                        filterOptions={employeeFilter}
                        renderInput={(params) => <TextField {...params} label={t('bots.transferTo')} />}
                      />
                      <Button
                        size="small"
                        disabled={!handTo || transfer.isPending}
                        onClick={() => { if (handTo && window.confirm(t('bots.transferConfirm', { name: handTo.fullName }))) transfer.mutate({ id: bot.id, toId: handTo.id }); }}
                      >
                        {t('bots.transferAction')}
                      </Button>
                    </Stack>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('bots.transferHint')}</Typography>
                  </>
                )}
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          {bot && mine && !bot.dismissedAt && (
            <Button color="error" sx={{ mr: 'auto' }} disabled={dismiss.isPending}
              onClick={() => { if (window.confirm(t('team.dismissConfirm', { name: bot.fullName }))) dismiss.mutate({ id: bot.id }); }}>
              {t('team.dismiss')}
            </Button>
          )}
          {bot && mine && bot.dismissedAt && (
            <Button sx={{ mr: 'auto' }} disabled={restore.isPending} onClick={() => restore.mutate({ id: bot.id })}>{t('team.restore')}</Button>
          )}
          <Button onClick={() => { clearForm(); p.onClose(); }}>{t(editable ? 'common.cancel' : 'common.close')}</Button>
          {editable && (
            <Button type="submit" variant="contained" disabled={create.isPending || update.isPending || !form.fullName.trim()}>
              {t(bot ? 'common.save' : 'bots.createAction')}
            </Button>
          )}
        </DialogActions>
      </form>
    </Dialog>
  );
}
