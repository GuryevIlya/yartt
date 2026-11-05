import { Box } from '@mui/material';
import { RichTextReadOnly } from 'mui-tiptap';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { imageSx, richTextExtensions, TaskRefs } from './richText.ts';

/**
 * Shows sanitized HTML of a comment or a context with the editor's own
 * styles. An image opens in full size in a new tab on click; a task
 * number ("#12") opens that task.
 */
export default function (p: { html: string }) {
  const navigate = useNavigate();
  const extensions = useMemo(() => [...richTextExtensions(), TaskRefs], []);
  return (
    <Box
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target instanceof HTMLImageElement) window.open(target.src, '_blank', 'noopener');
        const ref = target.closest<HTMLAnchorElement>('a[data-task-ref]');
        // A plain click stays in the app; with a modifier — the browser's own (a new tab).
        if (ref && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
          e.preventDefault();
          void navigate(`/tasks/${ref.dataset.taskRef}`);
        }
      }}
      sx={{ ...imageSx, '& img': { ...imageSx['& img'], cursor: 'zoom-in' }, '& p:first-of-type': { mt: 0 }, '& p:last-of-type': { mb: 0 } }}
    >
      <RichTextReadOnly content={p.html} extensions={extensions} immediatelyRender={false} />
    </Box>
  );
}
