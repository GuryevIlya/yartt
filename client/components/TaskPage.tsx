import { Box, CircularProgress, Stack } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { POLL_MS } from '#client/hooks/task.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import Feed from './TaskPage/Feed.tsx';
import MyTime from './TaskPage/MyTime.tsx';
import NoAccess from './TaskPage/NoAccess.tsx';
import People from './TaskPage/People.tsx';
import Reminders from './TaskPage/Reminders.tsx';
import Sheet from './TaskPage/Sheet.tsx';

// The task page (docs/product/interface.md, 2): the task and its feed on the
// left, people and time on the right, the whole height. Opening it is a visit.
export default function (p: { id: number }) {
  const trpc = useTRPC();
  const task = useQuery(trpc.Task.get.queryOptions({ id: p.id }, { refetchInterval: POLL_MS }));

  if (task.isPending) return <CircularProgress sx={{ m: 'auto' }} />;
  if (!task.data) return null;
  if (!task.data.details) return <NoAccess task={task.data} />;

  const details = task.data.details;
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 2, width: '100%', maxWidth: 1280, mx: 'auto' }}>
      <Stack spacing={2} sx={{ flex: '999 1 600px', minWidth: 0 }}>
        <Sheet task={{ ...task.data, details }} />
        <Feed taskId={p.id} />
      </Stack>
      <Stack spacing={2} sx={{ flex: '1 1 340px', minWidth: 0 }}>
        <MyTime taskId={p.id} closed={task.data.closed} />
        <Reminders taskId={p.id} deadline={task.data.deadline} />
        <People task={task.data} />
      </Stack>
    </Box>
  );
}
