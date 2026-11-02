import { expect, test } from '@playwright/test';
import { signIn, taskId } from './helpers.ts';

// Words that are not self-evident explain themselves on hover.
test('"My open" and a deadline explain what they mean', async ({ page }) => {
  await signIn(page);
  // Away from the task lines first: their hints would cover the tab.
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.getByRole('tab', { name: /Мои открытые/ }).hover();
  await expect(page.getByRole('tooltip').filter({ hasText: /за которые отвечаете вы/ })).toBeVisible();

  await page.goto(`/tasks/${await taskId('сайт', 'новая главная к осенней кампании')}`);
  await page.getByLabel('Дедлайн').hover();
  // Hints of the task lines under the pointer on the way may show too: the deadline's is the one looked for.
  await expect(page.getByRole('tooltip').filter({ hasText: /закрывает задачу только владелец/ })).toBeVisible();
});

test('a task whose plan does not fit the deadline is marked at risk, and says whose plan', async ({ page }) => {
  await signIn(page);
  await page.goto(`/tasks/${await taskId('сайт', 'новая главная к осенней кампании')}`);
  const chip = page.getByText('Под угрозой').first();
  await expect(chip).toBeVisible();
  await chip.hover();
  // The site is also late for Pavel's task, which needs it earlier: both reasons are said.
  await expect(page.getByRole('tooltip').filter({ hasText: /Павел Орлов в плане/ })).toContainText(/Задерживает #\d+/);
});

test('a latest deadline on the task waited for says who may change it, and is not a control there', async ({ page }) => {
  await signIn(page);
  const api = await taskId('сайт', 'api', 'перевести форму заявки на новый api');
  await page.goto(`/tasks/${await taskId('сайт', 'новая главная к осенней кампании')}`);
  await expect(page.getByRole('button', { name: /^ждёт эту до / })).toHaveCount(0);
  // What loads above it moves the line away from under the mouse: hovered again until it holds.
  await expect(async () => {
    await page.getByText(/^ждёт эту до /).first().hover();
    await expect(page.getByRole('tooltip').filter({ hasText: `может только владелец #${api}` })).toBeVisible({ timeout: 1_000 });
  }).toPass();
});

test('a participant makes a task of their own, which the task waits for, told when they need one', async ({ page }) => {
  await signIn(page, 'pavel@example.com');
  const site = await taskId('сайт', 'новая главная к осенней кампании');
  await page.goto(`/tasks/${site}`);
  // "Waits for" comes first; a participant links there too (decision 94).
  const own = page.getByRole('link', { name: 'Новая задача' }).first();
  await own.hover();
  await expect(page.getByRole('tooltip').filter({ hasText: `Задача #${site} будет её ждать` })).toBeVisible();
  await own.click();
  const form = page.getByRole('main');
  await expect(form.getByRole('heading', { name: 'Новая задача' })).toBeVisible();
  await expect(form.getByText('Её будет ждать задача')).toBeVisible();
  await expect(form.getByRole('link', { name: new RegExp(`^#${site}`) })).toBeVisible();
});

test('a person is offered with what they wrote about themselves, and found by it', async ({ page }) => {
  await signIn(page);
  await page.goto(`/tasks/${await taskId('финансы', 'квартальный отчёт для совета директоров')}`);
  await page.getByPlaceholder('Добавить участника').fill('фронтенд');
  const option = page.getByRole('option', { name: /Павел Орлов/ });
  await expect(option).toBeVisible();
  await expect(option).toContainText('Фронтенд. Telegram: @pavel');
});

test('a participant brings someone in, told that participants are not notified of comments', async ({ page }) => {
  await signIn(page, 'pavel@example.com');
  await page.goto(`/tasks/${await taskId('сайт', 'новая главная к осенней кампании')}`);
  await expect(page.getByText(/уведомления о комментариях ему не приходят/)).toBeVisible();
  await page.getByPlaceholder('Добавить участника').fill('Анна');
  await page.getByRole('option', { name: /Анна Петрова/ }).click();
  await expect(page.getByText('Анна Петрова').first()).toBeVisible();
});
