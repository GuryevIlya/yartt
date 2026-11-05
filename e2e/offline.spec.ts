import { expect, test } from '@playwright/test';
import { editable, employeeId, FIRST, signIn, sql, taskId, unique } from './helpers.ts';

// Working offline (decision 43): a change made without a connection is
// accepted, survives a reload, and goes out when the connection is back.
test('a comment written offline waits in the outbox, survives a reload and is sent when online', async ({ page, context }) => {
  await signIn(page);
  const id = await taskId('финансы', 'квартальный отчёт для совета директоров');
  await page.goto(`/tasks/${id}`);
  await expect(page.getByText('отчёт').filter({ visible: true }).first()).toBeVisible();
  // The service worker takes over the page once it is installed.
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await page.waitForLoadState('networkidle');

  await context.setOffline(true);
  await editable(page).click();
  await page.keyboard.type('Написано без связи');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.getByText(/Нет связи — изменение сохранено/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Не отправлено · 1')).toBeVisible();

  // Still offline, a reload brings the app back from the cache, the change still waiting.
  await page.reload();
  await expect(page.getByText('Не отправлено · 1')).toBeVisible();
  await expect(page.getByText('отчёт').filter({ visible: true }).first()).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByText(/отправлено изменений: 1/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Не отправлено · 1')).toHaveCount(0);
  await expect(page.getByText('Написано без связи').first()).toBeVisible();
});

test('a change whose answer was lost is sent again and applied once', async ({ page }) => {
  await signIn(page);
  const id = await taskId('финансы', 'квартальный отчёт для совета директоров');
  await page.goto(`/tasks/${id}`);
  const text = `Ответ потерялся ${Date.now()}`;
  // The server takes the comment, the answer never comes back.
  await page.route('**/api/trpc/Comment.create**', async (route) => {
    await route.fetch();
    await route.abort('connectionreset');
  }, { times: 1 });

  await editable(page).click();
  await page.keyboard.type(text);
  await page.getByRole('button', { name: 'Отправить' }).click();
  // Queued as unanswered, then sent again at the first chance: the server says it is applied already.
  await expect(page.getByText(/отправлено изменений: 1/)).toBeVisible({ timeout: 40_000 });
  await expect(page.getByText('Не отправлено · 1')).toHaveCount(0);
  expect(await sql`SELECT 1 FROM comment WHERE task_id = ${id} AND value LIKE ${'%' + text + '%'}`).toHaveLength(1);
});

test('a change waits while its person is signed out and goes once they are back', async ({ page, context }) => {
  await signIn(page);
  const id = await taskId('финансы', 'квартальный отчёт для совета директоров');
  await page.goto(`/tasks/${id}`);
  await expect(page.getByText('отчёт').filter({ visible: true }).first()).toBeVisible();
  const text = `Пока сессия кончилась ${Date.now()}`;

  await context.setOffline(true);
  await editable(page).click();
  await page.keyboard.type(text);
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.getByText('Не отправлено · 1')).toBeVisible({ timeout: 15_000 });

  // The session ends while offline: back online, nothing is sent or lost.
  await sql`DELETE FROM session WHERE employee_id = ${await employeeId(FIRST)}`;
  await context.setOffline(false);
  await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });
  expect(await sql`SELECT 1 FROM comment WHERE task_id = ${id} AND value LIKE ${'%' + text + '%'}`).toHaveLength(0);

  await signIn(page);
  await expect(page.getByText(/отправлено изменений: 1/)).toBeVisible({ timeout: 15_000 });
  expect(await sql`SELECT 1 FROM comment WHERE task_id = ${id} AND value LIKE ${'%' + text + '%'}`).toHaveLength(1);
});

test('a new task offline: a tag typed with Enter is taken by name, no error, and the task waits', async ({ page, context }) => {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  await signIn(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await page.waitForLoadState('networkidle');

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Новая задача' }).click();
  await expect(page.getByRole('combobox', { name: 'Теги' })).toBeFocused();
  // A tag that exists and a new one: offline both are taken by name.
  const fresh = unique('без связи');
  for (const name of ['склад', fresh]) {
    await page.keyboard.type(name);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Создать задачу' }).click();
  await expect(page.getByText('Не отправлено · 1')).toBeVisible();
  await expect(page.getByText('Что-то пошло не так')).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.setOffline(false);
  await expect(page.getByText(/отправлено изменений: 1/)).toBeVisible({ timeout: 15_000 });
});
