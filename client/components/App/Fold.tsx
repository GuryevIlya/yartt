import { ExpandLess, ExpandMore } from '@mui/icons-material';
import { ButtonBase, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { storageKey } from '#client/hooks/base.ts';

const KEY = `${storageKey('yartt.fold')}.`;

function read(id: string): boolean {
  try {
    return localStorage.getItem(KEY + id) !== 'open';
  } catch {
    return true;
  }
}

function write(id: string, folded: boolean): void {
  try {
    if (folded) localStorage.removeItem(KEY + id);
    else localStorage.setItem(KEY + id, 'open');
  } catch {
    // Storage off (a private window): the block just opens folded next time.
  }
}

/**
 * A block of My day below the tasks (decision 83): folded by default to a
 * line — its title and what it is about — so the screen holds what needs me;
 * opened, it stays open next time (in this browser). Opened, the block gets
 * the button that folds it back, for its own header.
 */
export default function (p: { id: string; title: string; summary: string; children: (fold: ReactNode) => ReactNode }) {
  const { t } = useTranslation();
  const [folded, setFolded] = useState(() => read(p.id));
  const toggle = (next: boolean) => { setFolded(next); write(p.id, next); };

  if (!folded) {
    return p.children(
      <Tooltip title={t('fold.fold')}>
        <IconButton size="small" onClick={() => toggle(true)} aria-label={t('fold.fold')} aria-expanded>
          <ExpandLess />
        </IconButton>
      </Tooltip>,
    );
  }
  return (
    <Paper component="section" aria-label={p.title}>
      <ButtonBase
        onClick={() => toggle(false)}
        aria-expanded={false}
        sx={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left', p: 2, borderRadius: 1 }}
      >
        <Stack sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="h3" sx={{ fontWeight: 600 }}>{p.title}</Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>{p.summary}</Typography>
        </Stack>
        <ExpandMore sx={{ color: 'text.secondary' }} />
      </ButtonBase>
    </Paper>
  );
}
