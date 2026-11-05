import { Extension, InputRule, PasteRule, type ExtendedRegExpMatchArray, type Range } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { Placeholder } from '@tiptap/extensions';
import StarterKit from '@tiptap/starter-kit';
import { ResizableImage, TableImproved } from 'mui-tiptap';
import { url } from '#client/hooks/base.ts';
import { TASK_REF } from '#shared/taskRefs.ts';

// One set of extensions for editing and for showing comments and contexts,
// matching what the server keeps (server/html.ts): structure, not looks, so
// no colors or sizes (decision 109).
// Images are resized by dragging their corner; the width is kept.

/** Only our own attachments may be images (the server enforces it too). */
const OWN_IMAGE = /^\/api\/attachments\/\d+$/;

/**
 * The text keeps an image as /api/attachments/12 wherever the application is
 * served (server/html.ts, and it may move); the editor holds the address the
 * browser can load, under the path. Going in it gains the path, coming out
 * it loses it.
 */
const stored = (src: string) => (src.startsWith(url('/api/')) ? src.slice(url('').length) : src);

const Image = ResizableImage.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (element) => {
          const src = element.getAttribute('src');
          return src && OWN_IMAGE.test(src) ? url(src) : src;
        },
        renderHTML: (attributes) => {
          const src = attributes.src as string | null;
          return { src: src && stored(src) };
        },
      },
    };
  },
});

/** An image without a chosen width is not wider than this, and opens in full on click. */
export const IMAGE_MAX_WIDTH = 480;
export const imageSx = {
  '& img': { maxWidth: '100%', height: 'auto' },
  '& img:not([width])': { maxWidth: `min(100%, ${IMAGE_MAX_WIDTH}px)` },
};
/** `[text](https://...)`, as language models and other trackers write a link. */
const MARKDOWN_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/;

function toLink({ state, range, match }: { state: EditorState; range: Range; match: ExtendedRegExpMatchArray }): void {
  const [, text, href] = match;
  const link = state.schema.marks.link;
  if (!text || !href || !link) return;
  state.tr.replaceWith(range.from, range.to, state.schema.text(text, [link.create({ href })])).removeStoredMark(link);
}

/** A Markdown link typed or pasted into the text becomes a link. */
const MarkdownLinks = Extension.create({
  name: 'markdownLinks',
  addInputRules: () => [new InputRule({ find: new RegExp(`${MARKDOWN_LINK.source}$`), handler: toLink })],
  addPasteRules: () => [new PasteRule({ find: new RegExp(MARKDOWN_LINK.source, 'g'), handler: toLink })],
});

export function richTextExtensions(placeholder?: string) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto'] },
    }),
    Image.configure({ inline: false, isAllowedImgSrc: (src) => OWN_IMAGE.test(stored(src ?? '')) }),
    TableImproved.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right'] }),
    MarkdownLinks,
    ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
  ];
}

/**
 * A task number in a comment or a context ("see #12") is a link to the
 * task, in what is shown only: nothing is stored, so old texts get it too.
 * Text already a link or code is left alone. RichView opens it in the app.
 */
export const TaskRefs = Extension.create({
  name: 'taskRefs',
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        decorations: (state) => {
          const found: Decoration[] = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name === 'codeBlock') return false;
            if (!node.isText || node.marks.some((m) => m.type.name === 'link' || m.type.name === 'code')) return;
            for (const m of node.text!.matchAll(TASK_REF)) {
              found.push(Decoration.inline(pos + m.index, pos + m.index + m[0].length, {
                nodeName: 'a',
                href: url(`/tasks/${m[1]}`),
                'data-task-ref': m[1]!,
              }));
            }
          });
          return DecorationSet.create(state.doc, found);
        },
      },
    })];
  },
});
