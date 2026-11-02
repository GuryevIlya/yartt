import { Box, LinearProgress, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** While a report has taken over a second: a quick one never blinks. */
export default function (p: { active: boolean }) {
  const { t } = useTranslation();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!p.active) return undefined;
    const timer = setTimeout(() => setSlow(true), 1000);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [p.active]);
  if (!slow) return null;
  return (
    <Box role="status">
      <LinearProgress />
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('common.counting')}</Typography>
    </Box>
  );
}
