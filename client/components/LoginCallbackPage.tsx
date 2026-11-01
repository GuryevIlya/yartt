import { Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { useTRPC } from '#client/hooks/trpc.ts';
import { errorMessage } from '#client/i18n/errors.ts';
import { clearOfflineCache } from '#client/hooks/offline.ts';

export default function () {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { token = '' } = useParams();

  const login = useMutation(
    trpc.Auth.login.mutationOptions({
      // The page itself explains a bad link; no snackbar on top.
      meta: { quiet: true },
      onSuccess: async () => {
        // Possibly someone else now: what the previous person had saved here goes.
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
    login.mutate({ token });
  }, [login, token]);

  return (
    <Box sx={{ display: 'grid', placeItems: 'center', height: '100%', p: 2 }}>
      {login.error ? (
        <Stack spacing={2} sx={{ maxWidth: 400, alignItems: 'center' }}>
          <Typography>{errorMessage(login.error)}</Typography>
          <Button component={Link} to="/login" variant="contained">
            {t('login.backToLogin')}
          </Button>
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
