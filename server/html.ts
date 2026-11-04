import sanitizeHtml from 'sanitize-html';
import { TASK_REF } from '#shared/taskRefs.ts';

// Comments and the task context are rich text from the editor. Only an
// allow-list survives; images may point only at our own attachments, so a
// comment cannot load anything from outside (no tracking pixels).
const IMAGE_SRC = /^\/api\/attachments\/(\d+)$/;

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'code', 'pre', 'blockquote',
    'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'hr', 'a', 'img',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'style'],
  },
  // An image keeps the width it was resized to and its aspect ratio; nothing else.
  allowedStyles: { img: { 'aspect-ratio': [/^\d+(\.\d+)?( \/ \d+(\.\d+)?)?$/] } },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
    img: (tagName, attribs) => {
      const { width, ...rest } = attribs;
      return { tagName, attribs: width !== undefined && /^\d{1,4}$/.test(width) ? { ...rest, width } : rest };
    },
  },
  exclusiveFilter: (frame) => frame.tag === 'img' && !IMAGE_SRC.test(frame.attribs.src ?? ''),
};

export type CleanHtml = {
  /** NULL when nothing but whitespace is left. */
  html: string | null;
  /** Attachments shown as images, in order of first appearance. */
  imageIds: number[];
};

export function cleanHtml(dirty: string): CleanHtml {
  const html = sanitizeHtml(dirty, OPTIONS).trim();

  const imageIds: number[] = [];
  for (const match of html.matchAll(/<img [^>]*src="\/api\/attachments\/(\d+)"/g)) {
    const id = Number(match[1]);
    if (!imageIds.includes(id)) imageIds.push(id);
  }

  const text = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).trim();
  return { html: text === '' && imageIds.length === 0 ? null : html, imageIds };
}

/** Plain text of the HTML: for quotes and search. */
export function plainText(html: string): string {
  return sanitizeHtml(html.replace(/<\/(p|li|h[1-3]|blockquote|pre)>/g, '$& '), {
    allowedTags: [],
    allowedAttributes: {},
  }).replace(/\s+/g, ' ').trim();
}

/** The tasks a text mentions by number: what is already a link or code is left alone, as when it is shown. */
export function taskRefs(html: string): number[] {
  const text = sanitizeHtml(html.replace(/<(pre|code|a)\b.*?<\/\1>/gis, ' ').replace(/<[^>]+>/g, ' '), {
    allowedTags: [],
    allowedAttributes: {},
  });
  return [...new Set([...text.matchAll(TASK_REF)].map((m) => Number(m[1])))];
}
