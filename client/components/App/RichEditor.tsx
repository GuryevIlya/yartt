import { Code, FormatAlignCenter, FormatAlignLeft, FormatAlignRight, Numbers } from '@mui/icons-material';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Popover, TextField } from '@mui/material';
import { marked } from 'marked';
import {
  insertImages, LinkBubbleMenu, LinkBubbleMenuHandler, MenuButton, MenuButtonAddTable, MenuButtonBlockquote, MenuButtonBold,
  MenuButtonBulletedList, MenuButtonCode, MenuButtonCodeBlock, MenuButtonEditLink, MenuButtonImageUpload, MenuButtonItalic,
  MenuButtonOrderedList, MenuButtonStrikethrough, MenuControlsContainer, MenuDivider, MenuSelectHeading, MenuSelectTextAlign,
  RichTextEditor, TableBubbleMenu, type RichTextEditorRef,
} from 'mui-tiptap';
import { useMemo, useRef, useState, type Ref, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';
import type { TagPart } from '#shared/tags.ts';
import { showInfo } from '#client/hooks/store.ts';
import { attachmentUrl, uploadFile } from '#client/hooks/upload.ts';
import TaskPicker from '../TaskPage/TaskPicker.tsx';
import { imageSx, richTextExtensions } from './richText.ts';

export type RichEditorHandle = {
  getHtml: () => string;
  setHtml: (html: string) => void;
  isEmpty: () => boolean;
  focus: () => void;
};

/**
 * mui-tiptap editor for comments and the context. Images (button, paste,
 * drop) are uploaded and shown inline; other dropped or pasted files go to
 * `onFiles` — the caller attaches them.
 */
export default function (p: {
  handle: Ref<RichEditorHandle>;
  initial: string;
  placeholder: string;
  onFiles?: (files: File[]) => void;
  /** Ctrl/Cmd+Enter. */
  onSubmit?: () => void;
  /** Every change, as HTML ('' when empty): for drafts. */
  onChange?: (html: string) => void;
  autoFocus?: boolean;
  /** A button that writes a task's number, found by tags: for the context (a comment attaches tasks its own way). */
  taskPicker?: { exclude: number };
  /** Pictures are not kept here: no button for them. */
  noImages?: boolean;
}) {
  const { t } = useTranslation();
  const rte = useRef<RichTextEditorRef>(null);
  const extensions = useMemo(() => [...richTextExtensions(p.placeholder), LinkBubbleMenuHandler], [p.placeholder]);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [picking, setPicking] = useState<HTMLElement | null>(null);
  const [search, setSearch] = useState<{ parts: TagPart[]; input: string }>({ parts: [], input: '' });
  // Language models write Markdown: it goes in as formatted text, where the cursor is.
  const insertMarkdown = () => {
    const html = marked.parse(markdown ?? '', { async: false });
    // A picture from outside is never kept (server/html.ts): said here, rather than lost quietly.
    if (/<img\s[^>]*src="(?!\/api\/attachments\/)/.test(html)) showInfo(t('editor.markdownImages'));
    rte.current?.editor?.chain().focus().insertContent(html).run();
    setMarkdown(null);
  };
  const submit = useRef(p.onSubmit);
  submit.current = p.onSubmit;
  const onFiles = useRef(p.onFiles);
  onFiles.current = p.onFiles;
  const onChange = useRef(p.onChange);
  onChange.current = p.onChange;

  useImperativeHandle(p.handle, () => ({
    getHtml: () => rte.current?.editor?.getHTML() ?? '',
    setHtml: (html) => rte.current?.editor?.commands.setContent(html),
    isEmpty: () => rte.current?.editor?.isEmpty ?? true,
    focus: () => rte.current?.editor?.commands.focus('end'),
  }));

  const uploadImages = async (files: File[]) =>
    Promise.all(files.map(async (file) => ({ src: attachmentUrl(await uploadFile(file)), alt: file.name })));

  // Images go into the text, everything else to the caller as attachments.
  const takeFiles = (files: File[], position?: number): boolean => {
    if (files.length === 0) return false;
    const images = files.filter((f) => f.type.startsWith('image/') && f.type !== 'image/svg+xml');
    const others = files.filter((f) => !images.includes(f));
    if (others.length > 0) onFiles.current?.(others);
    if (images.length > 0) {
      void uploadImages(images).then((uploaded) =>
        insertImages({ images: uploaded, editor: rte.current?.editor ?? null, position }));
    }
    return true;
  };

  return (
    <>
    <RichTextEditor
      ref={rte}
      extensions={extensions}
      content={p.initial}
      autofocus={p.autoFocus ? 'end' : false}
      immediatelyRender
      onUpdate={({ editor }) => onChange.current?.(editor.isEmpty ? '' : editor.getHTML())}
      editorProps={{
        handlePaste: (_view, event) => takeFiles(Array.from(event.clipboardData?.files ?? [])),
        handleDrop: (view, event) => {
          const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
          const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          if (files.length > 0) event.preventDefault();
          return takeFiles(files, position);
        },
        handleKeyDown: (_view, event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && submit.current) {
            submit.current();
            return true;
          }
          return false;
        },
      }}
      renderControls={() => (
        <MenuControlsContainer>
          <MenuSelectHeading
            tooltipTitle={t('editor.heading')}
            labels={{
              paragraph: t('editor.paragraph'),
              heading1: t('editor.heading1'),
              heading2: t('editor.heading2'),
              heading3: t('editor.heading3'),
              empty: t('editor.paragraph'),
            }}
          />
          <MenuDivider />
          <MenuButtonBold tooltipLabel={t('editor.bold')} />
          <MenuButtonItalic tooltipLabel={t('editor.italic')} />
          <MenuButtonStrikethrough tooltipLabel={t('editor.strike')} />
          <MenuButtonEditLink tooltipLabel={t('editor.link')} />
          <MenuDivider />
          <MenuSelectTextAlign
            tooltipTitle={t('editor.align')}
            alignmentOptions={[
              { alignment: 'left', label: t('editor.alignLeft'), IconComponent: FormatAlignLeft },
              { alignment: 'center', label: t('editor.alignCenter'), IconComponent: FormatAlignCenter },
              { alignment: 'right', label: t('editor.alignRight'), IconComponent: FormatAlignRight },
            ]}
          />
          <MenuButtonBulletedList tooltipLabel={t('editor.bulletList')} />
          <MenuButtonOrderedList tooltipLabel={t('editor.orderedList')} />
          <MenuButtonBlockquote tooltipLabel={t('editor.quote')} />
          <MenuDivider />
          <MenuButtonCode tooltipLabel={t('editor.code')} />
          <MenuButtonCodeBlock tooltipLabel={t('editor.codeBlock')} />
          <MenuButtonAddTable tooltipLabel={t('editor.table')} />
          <MenuDivider />
          {!p.noImages && <MenuButtonImageUpload tooltipLabel={t('task.composer.addImage')} onUploadFiles={uploadImages} />}
          {p.taskPicker && (
            <MenuButton tooltipLabel={t('editor.task')} IconComponent={Numbers} onClick={(e) => setPicking(e.currentTarget)} />
          )}
          <MenuButton tooltipLabel={t('editor.markdown')} IconComponent={Code} onClick={() => setMarkdown('')} />
        </MenuControlsContainer>
      )}
      RichTextFieldProps={{ variant: 'outlined' }}
      sx={{ '& .ProseMirror': { minHeight: 64, ...imageSx } }}
    >
      {() => (
        <>
          <LinkBubbleMenu
            labels={{
              viewLinkEditButtonLabel: t('task.edit'),
              viewLinkRemoveButtonLabel: t('editor.linkRemove'),
              editLinkTextInputLabel: t('editor.linkText'),
              editLinkHrefInputLabel: t('editor.linkHref'),
              editLinkCancelButtonLabel: t('common.cancel'),
              editLinkSaveButtonLabel: t('common.save'),
            }}
          />
          <TableBubbleMenu
            labels={{
              insertColumnBefore: t('editor.columnBefore'),
              insertColumnAfter: t('editor.columnAfter'),
              deleteColumn: t('editor.columnDelete'),
              insertRowAbove: t('editor.rowAbove'),
              insertRowBelow: t('editor.rowBelow'),
              deleteRow: t('editor.rowDelete'),
              mergeCells: t('editor.cellsMerge'),
              splitCell: t('editor.cellSplit'),
              toggleHeaderRow: t('editor.headerRow'),
              toggleHeaderColumn: t('editor.headerColumn'),
              toggleHeaderCell: t('editor.headerCell'),
              deleteTable: t('editor.tableDelete'),
            }}
          />
        </>
      )}
    </RichTextEditor>
    {markdown !== null && (
      <Dialog open fullWidth maxWidth="md" onClose={() => setMarkdown(null)}>
        <DialogTitle>{t('editor.markdown')}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={10}
            maxRows={24}
            label={t('editor.markdownLabel')}
            helperText={t('editor.markdownHint')}
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            sx={{ mt: 1, '& textarea': { fontFamily: 'monospace' } }}
          />
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={() => setMarkdown(null)}>{t('common.cancel')}</Button>
          <Button variant="contained" disabled={markdown.trim() === ''} onClick={insertMarkdown}>{t('editor.markdownInsert')}</Button>
        </DialogActions>
      </Dialog>
    )}
    {p.taskPicker && picking && (
      <Popover open anchorEl={picking} onClose={() => setPicking(null)} slotProps={{ paper: { sx: { p: 2, width: 480, maxWidth: '100%' } } }}>
        <TaskPicker
          parts={search.parts}
          input={search.input}
          onChange={setSearch}
          exclude={p.taskPicker.exclude}
          newTask="/tasks/new"
          onPick={(task) => {
            rte.current?.editor?.chain().focus().insertContent(`#${task.id} `).run();
            setPicking(null);
            setSearch({ parts: [], input: '' });
          }}
        />
      </Popover>
    )}
    </>
  );
}
