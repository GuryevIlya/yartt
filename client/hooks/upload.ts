import { isErrorCode, type ErrorParams } from '#shared/errors.ts';
import i18n from '#client/i18n/index.ts';
import { url } from './base.ts';
import { useStore } from './store.ts';

/**
 * Uploads a file to /api/attachments and returns its id. Files go around
 * tRPC (raw bytes); a failure shows the translated error and rethrows.
 */
export async function uploadFile(file: File): Promise<number> {
  const res = await fetch(url('/api/attachments'), {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  const body: unknown = await res.json().catch(() => null);
  if (res.ok && typeof body === 'object' && body !== null && 'id' in body && typeof body.id === 'number') {
    return body.id;
  }
  const code = typeof body === 'object' && body !== null && 'appCode' in body ? body.appCode : null;
  const params = (typeof body === 'object' && body !== null && 'params' in body ? body.params : null) as ErrorParams | null;
  const message = i18n.t(`errors.${isErrorCode(code) ? code : 'internal'}`, params ?? {});
  useStore.setState({ error: message });
  throw new Error(message);
}

/** Where an attachment is served; `name` sets the file name of a download. */
export function attachmentUrl(id: number, name?: string): string {
  return url(name ? `/api/attachments/${id}?name=${encodeURIComponent(name)}` : `/api/attachments/${id}`);
}
