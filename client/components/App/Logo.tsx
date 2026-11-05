import { Box, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

/**
 * The mark: a tag — tasks have no titles, only tags — with a check: every
 * task has one owner who sees it done. The tag is a rocket taking off, with
 * fins and exhaust: done tasks are how a product gets built and shipped.
 * Also the favicon (public/favicon.svg) and the app icons made from it.
 */
export function Mark(p: { size?: number }) {
  const size = p.size ?? 24;
  return (
    <Box component="svg" viewBox="0 0 24 24" sx={{ width: size, height: size, flexShrink: 0, color: 'primary.main' }} aria-hidden>
      <path
        fill="currentColor"
        d="M20.6 3.4c.3 3.9-.9 7.7-3.6 10.4l-4.2 4.2a1.5 1.5 0 0 1-2.1 0L6 13.3a1.5 1.5 0 0 1 0-2.1l4.2-4.2C12.9 4.3 16.7 3.1 20.6 3.4z"
      />
      <Box
        component="path"
        sx={{ fill: (theme) => theme.palette.primary.dark }}
        d="M5.9 12.9 3.6 12.4a.7.7 0 0 1-.3-1.2l2.9-2.9a1 1 0 0 1 .8-.3l2.5.2zM11.1 18.1l.5 2.3a.7.7 0 0 0 1.2.3l2.9-2.9a1 1 0 0 0 .3-.8l-.2-2.5z"
      />
      <path d="M10.6 10.9l1.7 1.7 3.6-3.6" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.2 21.8l3-3M1.6 18.2l1.8-1.8M5.8 22.4l1.8-1.8" stroke="#f57c00" strokeWidth="1.9" strokeLinecap="round" />
    </Box>
  );
}

/**
 * The mark and the name of the only screen — My day — in the interface
 * language; leads there. The product name is in the window title and the
 * footer of My day (decision 30).
 */
export default function () {
  const { t } = useTranslation();
  return (
    <Box component={Link} to="/" sx={{ display: 'flex', alignItems: 'center', gap: 0.75, color: 'text.primary', textDecoration: 'none', mr: 2 }}>
      <Mark size={26} />
      <Typography sx={{ fontSize: 21, fontWeight: 800, letterSpacing: '-0.04em', lineHeight: 1 }}>{t('nav.myDay')}</Typography>
    </Box>
  );
}
