import { Box, Link as MuiLink } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

/**
 * "Such a task already exists: #12" — a link to it, wherever a title is
 * typed: the search, a new task, a title changed, a task made for a
 * dependency. Titles are unique; the one typed may be the one wanted.
 * `blocking` — where the title is to be saved (a new task, a title
 * changed): it cannot be, and the line says so and what to do.
 */
export default function (p: { id: number; blocking?: boolean }) {
  const { t } = useTranslation();
  const link = <MuiLink component={Link} to={`/tasks/${p.id}`}>{t('title.taken', { id: p.id })}</MuiLink>;
  if (!p.blocking) return link;
  return <Box component="span">{link}. {t('title.takenBlocks')}</Box>;
}
