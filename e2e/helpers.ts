import { randomBytes } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import postgres from 'postgres';
import { databaseUrl, E2E_URL } from './db.ts';

/** Direct access to the end-to-end database: sign-in tokens and lookups. */
export const sql = postgres(databaseUrl(), { onnotice: () => {} });

/** The demo's CEO, the first employee. */
export const FIRST = 'alexey@example.com';

/**
 * A sign-in link for the employee, as if this page's browser asked for it:
 * the browser keeps the key the link is bound to (decision 101). NULL — no
 * link for them (dismissed, unknown).
 */
export async function loginLink(page: Page, email = FIRST): Promise<string | null> {
  const browser = randomBytes(32).toString('hex');
  const [row] = await sql<{ token: string | null }[]>`SELECT issue_token(${email}, ${browser}) AS token`;
  if (!row!.token) return null;
  await page.context().addCookies([{ name: 'yartt_login', value: browser, url: E2E_URL }]);
  return `/login/${row!.token}`;
}

/** Signs in as the employee with this email through a one-time link, as from an email. */
export async function signIn(page: Page, email = FIRST): Promise<void> {
  await page.goto((await loginLink(page, email))!);
  await expect(page.getByRole('heading', { name: /Ждёт меня|Waiting for me/ })).toBeVisible();
}

/** The id of the task with exactly these tags (the seed creates them by name). */
export async function taskId(...tags: string[]): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    SELECT id FROM task
     WHERE tag_ids = (SELECT array_agg(id ORDER BY id) FROM tag WHERE name = ANY(${tags}))
  `;
  if (!row) throw new Error(`no task with tags ${tags.join(', ')}`);
  return row.id;
}

export async function employeeId(email: string): Promise<number> {
  const [row] = await sql<{ id: number }[]>`SELECT id FROM employee WHERE email = ${email}`;
  return row!.id;
}

/** A name nobody used yet, for tags of tasks a test creates. */
export const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** The snackbar of the last error, translated. */
export const errorToast = (page: Page) => page.getByRole('alert').filter({ hasNotText: /^$/ }).last();

/** The rich text editor being typed in (comments shown in the feed are read-only editors too). */
export const editable = (page: Page) => page.locator('.ProseMirror[contenteditable="true"]').last();

/** Creates a task in the new-task form — each tag typed and made a new one with its button — and opens it. */
export async function createTask(page: Page, tags: string[]): Promise<void> {
  await page.goto('/tasks/new');
  await expect(page.getByRole('combobox', { name: 'Теги' })).toBeFocused();
  for (const tag of tags) {
    await page.keyboard.type(tag);
    await page.getByRole('button', { name: `Новый тег «${tag}»` }).click();
    await expect(page.getByRole('button', { name: tag, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Создать задачу' }).click();
  await expect(page).toHaveURL(/\/tasks\/\d+$/);
}


/** Opens a folded block of My day (decision 83) by its title. */
export async function unfold(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${title}`), expanded: false }).click();
}
