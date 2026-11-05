import { expect, test } from '@playwright/test';
import { createTask, signIn, taskId, unique } from './helpers.ts';

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

test('a latest deadline passed with the task still open is said on the line, as "At risk" says it', async ({ page }) => {
  await signIn(page, 'olga@example.com');
  const pad = (n: number) => String(n).padStart(2, '0');
  const ago = (days: number) => {
    const d = new Date(Date.now() - days * 86_400_000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T12:00`;
  };
  await createTask(page, [unique('ждущая')]);
  const mine = page.url();
  await createTask(page, [unique('нужная')]);
  const needed = Number(page.url().split('/').pop());
  await page.getByLabel('Дедлайн').fill(ago(2));
  await expect(page.getByText(/Просрочена|просрочена/).first()).toBeVisible();

  await page.goto(mine);
  await page.getByRole('button', { name: 'Добавить' }).first().click();
  await page.getByLabel('Найти задачу: теги или номер').fill(`#${needed}`);
  await page.getByRole('button', { name: `Выбрать задачу #${needed}` }).click();
  await page.getByRole('checkbox', { name: 'Указать крайний дедлайн' }).check();
  await page.getByLabel(`Крайний дедлайн #${needed}`).fill(ago(1));
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(async () => {
    await page.getByText(/^нужна до /).hover();
    await expect(page.getByRole('tooltip').filter({ hasText: 'Он уже прошёл' })).toBeVisible({ timeout: 1_000 });
  }).toPass();
});

test('a closed task leaves "Waits for" for the folded "Related"', async ({ page }) => {
  await signIn(page, 'olga@example.com');
  await createTask(page, [unique('сверка')]);
  const needed = Number(page.url().split('/').pop());
  await createTask(page, [unique('акт')]);
  const waiting = Number(page.url().split('/').pop());
  await page.getByRole('button', { name: 'Добавить' }).first().click();
  await page.getByLabel('Найти задачу: теги или номер').fill(`#${needed}`);
  await page.getByRole('button', { name: `Выбрать задачу #${needed}` }).click();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('без крайнего дедлайна')).toBeVisible();

  await page.goto(`/tasks/${needed}`);
  await page.getByRole('button', { name: 'Завершить' }).first().click();
  await expect(page.getByRole('button', { name: 'Связанные: 1' })).toBeVisible();

  await page.goto(`/tasks/${waiting}`);
  await expect(page.getByText('без крайнего дедлайна')).toHaveCount(0);
  await page.getByRole('button', { name: 'Связанные: 1' }).click();
  await expect(page.getByText('эта задача её ждала')).toBeVisible();
});

test('a link is removed from "Waited on by" too', async ({ page }) => {
  await signIn(page, 'olga@example.com');
  await createTask(page, [unique('смета')]);
  const waiting = Number(page.url().split('/').pop());
  await createTask(page, [unique('подпись')]);
  await page.getByRole('button', { name: 'Добавить' }).last().click();
  await page.getByLabel('Найти задачу: теги или номер').fill(`#${waiting}`);
  await page.getByRole('button', { name: `Выбрать задачу #${waiting}` }).click();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByRole('link', { name: new RegExp(`^#${waiting}`) })).toBeVisible();
  await page.getByRole('button', { name: 'Убрать зависимость' }).click();
  await expect(page.getByRole('link', { name: new RegExp(`^#${waiting}`) })).toHaveCount(0);
});

test('Markdown goes into the context as formatted text, a table too', async ({ page }) => {
  await signIn(page, 'olga@example.com');
  await createTask(page, [unique('справка')]);
  await page.locator('#context').getByRole('button', { name: 'Изменить' }).click();
  await page.locator('#context').getByRole('button', { name: 'Вставить Markdown' }).click();
  await page.getByLabel('Текст в формате Markdown').fill('## План\n\n| Шаг | Срок |\n|---|---|\n| Выгрузка | среда |\n');
  await page.getByRole('button', { name: 'Вставить', exact: true }).click();
  await page.locator('#context').getByRole('button', { name: 'Сохранить' }).click();
  const shown = page.locator('#context');
  await expect(shown.getByRole('heading', { name: 'План' })).toBeVisible();
  await expect(shown.getByRole('cell', { name: 'Выгрузка' })).toBeVisible();
});

test('a tag is described in the profile and shown in tasks with it', async ({ page }) => {
  await signIn(page, 'olga@example.com');
  const tag = unique('регламент');
  await createTask(page, [tag]);
  const task = page.url();
  await page.getByRole('button', { name: /Ольга Белова/ }).click();
  await page.getByRole('menuitem', { name: 'Профиль' }).click();
  await page.getByRole('dialog').getByRole('tab', { name: 'Теги' }).click();
  await page.getByRole('dialog').getByRole('textbox').first().fill(tag);
  const describe = page.getByRole('dialog').getByRole('button', { name: 'Описание', exact: true });
  await expect(describe).toHaveCount(1);
  await describe.click();
  const dialog = page.getByRole('dialog', { name: /Описание тега/ });
  await dialog.locator('.ProseMirror').fill('Сверяем с бухгалтерией');
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await expect(dialog).toHaveCount(0);

  await page.goto(task);
  await page.getByRole('button', { name: 'Описания тегов: 1' }).click();
  await expect(page.getByText('Сверяем с бухгалтерией')).toBeVisible();
});

test('the guide has contents leading to the API, and the screens that speak of it link there', async ({ page }) => {
  await signIn(page, 'olga@example.com');
  await page.goto('/help');
  const contents = page.getByRole('navigation', { name: 'Содержание' });
  await contents.getByRole('link', { name: 'Что приходит в вебхук' }).click();
  await expect(page).toHaveURL(/#api-webhooks$/);
  await expect(page.getByRole('heading', { name: 'Что приходит в вебхук' })).toBeInViewport();
  await expect(page.getByRole('cell', { name: 'waiter_closed' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'openapi.json' })).toHaveAttribute('href', /api\/v1\/openapi\.json$/);

  await page.goto('/');
  await page.getByRole('button', { name: /Ольга Белова/ }).click();
  await page.getByRole('menuitem', { name: 'Профиль' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Вебхуки' }).click();
  await expect(dialog.getByRole('link', { name: 'Что и в каком виде приходит' })).toHaveAttribute('href', /help#api-webhooks$/);
  await dialog.getByRole('tab', { name: 'Ключи API' }).click();
  await expect(dialog.getByRole('link', { name: /Как пользоваться ключом/ })).toHaveAttribute('href', /help#api-calling$/);
  await dialog.getByRole('tab', { name: 'Боты' }).click();
  await expect(dialog.getByRole('link', { name: 'Как завести и настроить бота' })).toHaveAttribute('href', /help#api-bots$/);
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
