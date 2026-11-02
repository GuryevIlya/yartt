import { isErrorCode } from '#shared/errors.ts';
import i18n from '#client/i18n/index.ts';
import { url } from './base.ts';
import { useStore } from './store.ts';

/** Avatars are stored this size: crisp at 56 px on a 4x screen, a few kilobytes. */
const SIZE = 256;

/** The center square of a picture, scaled to SIZE, as WebP (PNG where WebP is not supported). */
async function square(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
  return blob?.type === 'image/webp' ? blob : new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
}

async function send(method: 'PUT' | 'DELETE', body?: Blob): Promise<void> {
  const res = await fetch(url('/api/avatars'), { method, ...(body && { body, headers: { 'Content-Type': body.type } }) });
  if (res.ok) return;
  const data: unknown = await res.json().catch(() => null);
  const code = typeof data === 'object' && data !== null && 'appCode' in data ? data.appCode : null;
  const message = i18n.t(`errors.${isErrorCode(code) ? code : 'internal'}`);
  useStore.setState({ error: message });
  throw new Error(message);
}

/** Sets my avatar from any picture the browser can read. */
export async function uploadAvatar(file: File): Promise<void> {
  await send('PUT', await square(file));
}

export async function deleteAvatar(): Promise<void> {
  await send('DELETE');
}

/** Where an avatar is served; the time makes a new picture a new URL. */
export function avatarUrl(employeeId: number, at: Date): string {
  return url(`/api/avatars/${employeeId}?v=${at.getTime()}`);
}
