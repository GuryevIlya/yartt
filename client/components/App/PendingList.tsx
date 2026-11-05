import { Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useFormat } from '#client/hooks/format.ts';
import type { Pending } from '#client/hooks/pending.ts';

/** What waits to be sent, in words (decision 114): "Shift started at 09:03", "Comment on #12". */
export default function (p: { pending: Pending[] }) {
  const { t } = useTranslation();
  const format = useFormat();
  const describe = ({ path, input }: Pending): string => {
    const at = (key: string) => (input[key] instanceof Date ? format.time(input[key]) : '');
    const id = input.taskId ?? input.id;
    switch (path) {
      case 'Work.start': return t('offline.what.shiftStarted', { time: at('startedAt') });
      case 'Work.close': return t('offline.what.shiftEnded', { time: at('endedAt') });
      case 'Work.add': return t('offline.what.shiftAdded', { from: at('startedAt'), to: at('endedAt') });
      case 'Task.create': return t('offline.what.newTask');
      case 'Comment.create': return t('offline.what.comment', { id });
      case 'Time.set': return t('offline.what.time', { id });
      default: return typeof id === 'number' ? t('offline.what.task', { id }) : t('offline.what.other');
    }
  };
  return (
    <>
      {p.pending.map((item) => <Typography key={item.id} variant="body2">{describe(item)}</Typography>)}
    </>
  );
}
