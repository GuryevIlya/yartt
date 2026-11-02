import { Alert, Box, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { url } from '#client/hooks/base.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import { fieldErrors } from '#client/i18n/errors.ts';

// The first sign-in through the company's identity provider when it vouches
// for no address (decision 86): the person confirms their work email as
// without it, so whoever is here with that address is found. The
// provider's address, if any, is offered.
export default function () {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const pending = useQuery(trpc.Auth.ssoPending.queryOptions());
  const [email, setEmail] = useState('');
  const send = useMutation(trpc.Auth.ssoSendEmail.mutationOptions({ onSuccess: () => void pending.refetch() }));
  const errors = fieldErrors(send.error);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (pending.data && email === '') setEmail(pending.data.sentTo ?? pending.data.email ?? '');
  }, [pending.data, email]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    send.mutate({ email: email.trim() }, { onSuccess: () => setEditing(false) });
  };

  if (pending.isPending) return null;
  const sentTo = editing ? null : pending.data?.sentTo ?? null;

  return (
    <Box sx={{ display: 'grid', placeItems: 'center', height: '100%', p: 2 }}>
      <Paper sx={{ p: 4, width: '100%', maxWidth: 440 }}>
        <Typography variant="h1" sx={{ mb: 2 }}>{t('login.ssoEmail.title')}</Typography>
        {!pending.data ? (
          <Stack spacing={2}>
            <Typography>{t('login.ssoEmail.expired')}</Typography>
            <Button variant="contained" href={url('/api/sso/start')}>{t('login.ssoEmail.restart')}</Button>
          </Stack>
        ) : sentTo ? (
          <Stack spacing={2}>
            <Alert severity="success">{t('login.ssoEmail.sent', { email: sentTo })}</Alert>
            <Button onClick={() => setEditing(true)}>{t('login.ssoEmail.again')}</Button>
          </Stack>
        ) : (
          <Stack component="form" spacing={2} onSubmit={submit}>
            <Typography sx={{ color: 'text.secondary' }}>{t('login.ssoEmail.hint', { name: pending.data.fullName })}</Typography>
            <TextField
              label={t('login.email')}
              type="email"
              autoComplete="email"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={!!errors.email}
              helperText={errors.email}
            />
            <Button type="submit" variant="contained" disabled={send.isPending}>{t('login.ssoEmail.submit')}</Button>
          </Stack>
        )}
      </Paper>
    </Box>
  );
}
