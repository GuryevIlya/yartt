import { Alert, Box, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { isErrorCode } from '#shared/errors.ts';
import { url } from '#client/hooks/base.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import { fieldErrors } from '#client/i18n/errors.ts';
import DemoPeople, { useDemo } from './App/DemoPeople.tsx';

export default function () {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const [email, setEmail] = useState('');
  const requestLogin = useMutation(trpc.Auth.requestLogin.mutationOptions());
  const errors = fieldErrors(requestLogin.error);

  const demo = useDemo();
  const config = useQuery(trpc.Auth.config.queryOptions());
  const sso = config.data?.sso ?? null;
  // A failed sign-in through the provider comes back with its code (server/sso.ts).
  const [params] = useSearchParams();
  const error = params.get('error');
  const failure = error && isErrorCode(error) ? t(`errors.${error}`) : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    requestLogin.mutate({ email: email.trim() });
  };

  // The demo has no sign-in: whom to see the interface as.
  if (demo) {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '100%', p: 2 }}>
        <Paper sx={{ p: 3, width: '100%', maxWidth: 480 }}>
          <Typography variant="h1" sx={{ mb: 1 }}>{t('login.demo.title')}</Typography>
          <Typography sx={{ color: 'text.secondary', mb: 2 }}>{t('login.demo.hint')}</Typography>
          <DemoPeople variant="list" />
        </Paper>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'grid', placeItems: 'center', height: '100%', p: 2 }}>
      <Paper sx={{ p: 4, width: '100%', maxWidth: 400 }}>
        <Typography variant="h1" sx={{ mb: 3 }}>
          {t('login.title')}
        </Typography>
        {failure && <Alert severity="error" sx={{ mb: 2 }}>{failure}</Alert>}
        {/* With the company's identity provider it is the only way in (decision 53). */}
        {sso ? (
          <Button variant="contained" fullWidth href={url('/api/sso/start')}>{t('login.sso', { name: sso.name })}</Button>
        ) : config.isPending ? null : requestLogin.isSuccess ? (
          <Stack spacing={2}>
            <Alert severity="success" variant="standard">
              {t('login.sent')}
            </Alert>
            <Button onClick={() => requestLogin.reset()}>{t('login.again')}</Button>
          </Stack>
        ) : (
          <Stack component="form" spacing={2} onSubmit={submit}>
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
            <Button type="submit" variant="contained" disabled={requestLogin.isPending}>
              {t('login.submit')}
            </Button>
          </Stack>
        )}
      </Paper>
    </Box>
  );
}
