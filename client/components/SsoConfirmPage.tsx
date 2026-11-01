import { Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { clearOfflineCache } from '#client/hooks/offline.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import { errorMessage } from '#client/i18n/errors.ts';

// The link that confirms the email of a first sign-in through the
// provider (decision 86): opened in the browser that signed in, it signs in.
export default function () {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { token = '' } = useParams();

  const confirm = useMutation(
    trpc.Auth.ssoConfirm.mutationOptions({
      // The page itself explains a bad link; no snackbar on top.
      meta: { quiet: true },
      onSuccess: async () => {
        clearOfflineCache();
        await queryClient.invalidateQueries();
        void navigate('/', { replace: true });
      },
    }),
  );

  // The token is single-use and StrictMode runs effects twice: send it once.
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    confirm.mutate({ token });
  }, [confirm, token]);

  return (
    <Box sx={{ display: 'grid', placeItems: 'center', height: '100%', p: 2 }}>
      {confirm.error ? (
        <Stack spacing={2} sx={{ maxWidth: 400, alignItems: 'center', textAlign: 'center' }}>
          <Typography>{errorMessage(confirm.error)}</Typography>
          <Button component={Link} to="/login" variant="contained">{t('login.backToLogin')}</Button>
        </Stack>
      ) : (
        <Stack spacing={2} sx={{ alignItems: 'center' }}>
          <CircularProgress />
          <Typography>{t('login.checking')}</Typography>
        </Stack>
      )}
    </Box>
  );
}
