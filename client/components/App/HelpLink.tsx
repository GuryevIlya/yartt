import { Link } from '@mui/material';
import type { ReactNode } from 'react';
import { url } from '#client/hooks/base.ts';

/** A place in the guide, in a new tab: what is being set up here, a key shown once say, stays open. */
export default function (p: { to: string; children: ReactNode }) {
  return <Link href={url(`/help#${p.to}`)} target="_blank" rel="noopener">{p.children}</Link>;
}
