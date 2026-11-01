import { expect, test, type Page } from '@playwright/test';
import { createTask, editable, signIn, sql, taskId, unique } from './helpers.ts';

// One task goes through everything its owner and observers do.
test.describe.serial('a task from creation to hand-over', () => {
  let page: Page;
  const tag = unique('e2e');

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await signIn(page);
    await createTask(page, [tag, 'проверка']);
  });
  test.afterAll(async () => {
    await page.close();
  });

  test('a new task is private, owned by its creator', async () => {
    await expect(page.getByText('Приватная')).toBeVisible();
    await expect(page.getByText('Алексей Громов').filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText('Владелец ещё не описал задачу.')).toBeVisible();
  });

  test('the owner edits priority, deadline and context in place', async () => {
    await page.getByRole('combobox').filter({ hasText: 'Обычный' }).click();
    await page.getByRole('option', { name: 'Высокий' }).click();
    await expect(page.getByRole('combobox').filter({ hasText: 'Высокий' })).toBeVisible();

    await page.getByLabel('Дедлайн').fill(`${new Date().getFullYear() + 1}-03-15T18:00`);
    // Anchored: the deadline's tooltip says it too, after "Дедлайн —".
    await expect(page.getByText(/^через \d+ (день|дня|дней|месяц|месяца|месяцев)/)).toBeVisible();
    await expect(page.getByText(/Дедлайн: 15 мар\./)).toBeVisible(); // the move is an event in the feed

    // The deadline's tooltip stays while the field has focus or the pointer, and covers the context's button.
    await page.getByLabel('Дедлайн').blur();
    await page.mouse.move(0, 0);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await page.getByRole('button', { name: 'Изменить' }).nth(1).click();
    await editable(page).first().fill('Проверить всё от начала до конца.');
    await page.getByRole('button', { name: 'Сохранить' }).first().click();
    await expect(page.getByText('Проверить всё от начала до конца.')).toBeVisible();
  });

  test('a comment waits a few seconds with "Back to editing", then appears; c focuses the composer', async () => {
    await page.locator('body').press('c');
    const composer = editable(page);
    await expect(composer).toBeFocused();
    await composer.fill('Первый комментарий');
    await page.getByRole('button', { name: 'Отправить' }).click();
    await expect(page.getByRole('button', { name: 'Вернуть в редактирование' })).toBeVisible();
    await expect(page.getByText('Первый комментарий').last()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Вернуть в редактирование' })).toHaveCount(0, { timeout: 15_000 });
  });

  test('only a participant is mentioned: the owner adds them first; a reply quotes its parent', async () => {
    await page.getByRole('button', { name: 'Упомянуть сотрудника' }).click();
    await page.keyboard.type('Павел');
    await expect(page.getByText('Упомянуть можно участников задачи; сначала добавьте человека в участники')).toBeVisible();
    await expect(page.getByRole('option', { name: 'Павел Орлов' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByPlaceholder('Добавить участника').click();
    await page.keyboard.type('Павел');
    await page.getByRole('option', { name: 'Павел Орлов' }).click();
    await expect(page.getByPlaceholder('Добавить участника')).toHaveValue('');

    await page.getByRole('button', { name: 'Упомянуть сотрудника' }).click();
    await page.keyboard.type('Павел');
    await page.getByRole('option', { name: 'Павел Орлов' }).click();
    await editable(page).fill('Павел, посмотри');
    await page.getByRole('button', { name: 'Отправить' }).click();
    await expect(page.getByText('@Павел Орлов · ответа нет')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Упомянут — остаётся/)).toBeVisible(); // an open mention keeps him, and says why

    // "All participants": everyone in the task but me.
    await page.getByRole('button', { name: 'Упомянуть сотрудника' }).click();
    await page.getByRole('button', { name: 'Все участники' }).click();
    await expect(page.getByText('Все участники')).toBeVisible();
    await editable(page).fill('Всем: смотрим в пятницу');
    await page.getByRole('button', { name: 'Отправить' }).click();
    // Pavel and his manager Marina: more than half of the people, folded until clicked.
    await page.getByText('@все участники').click({ timeout: 15_000 });
    await expect(page.getByText('@Павел Орлов · ответа нет')).toHaveCount(2);
    await expect(page.getByText('@Марина Соколова · ответа нет')).toBeVisible();

    await page.getByRole('button', { name: 'Ответить' }).first().click();
    await expect(page.getByText(/Ответ на комментарий/)).toBeVisible();
    await page.getByRole('button', { name: /Отменить ответ/ }).click();
    await expect(page.getByText(/Ответ на комментарий/)).toHaveCount(0);
  });

  test('my time: logged and planned; both show in the feed as events', async () => {
    // Time goes into a shift, my latest one by default (decision 100).
    await page.getByRole('button', { name: 'Списать время' }).click();
    // Another test may have left a minute-long shift today: a full working one is picked.
    await page.getByRole('dialog').getByLabel('Смена').click();
    await page.getByRole('option', { name: /, 9ч/ }).first().click();
    await page.getByLabel('Всего за смену').fill('1ч');
    await page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText(/^Потратил 1ч$/)).toBeVisible();
    // One entry a shift: the dialog shows it, a new value replaces it.
    await page.getByRole('button', { name: 'Списать время' }).click();
    await page.getByRole('dialog').getByLabel('Смена').click();
    await page.getByRole('option', { name: /, 9ч/ }).first().click();
    await expect(page.getByLabel('Всего за смену')).toHaveValue('1ч');
    await page.getByLabel('Всего за смену').fill('1ч 30м');
    await page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Потратил 1ч 30м')).toBeVisible();

    await page.getByRole('button', { name: 'Мой план' }).click();
    await page.getByLabel('Сколько ещё планирую потратить').fill('1д');
    await page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click();
    // A day is a working day, 8 hours.
    await expect(page.getByText('В плане ещё 8ч').filter({ visible: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Все события', exact: true }).click();
    await expect(page.getByText(/Алексей Громов: списано 1ч 30м/)).toBeVisible();
    await expect(page.getByText(/Алексей Громов: в плане ещё 8ч/)).toBeVisible();
  });

  test('participants: add, hide, public and private again', async () => {
    await page.getByPlaceholder('Добавить участника').click();
    await page.keyboard.type('Иван');
    await page.getByRole('option', { name: 'Иван Кузнецов' }).click();
    await expect(page.getByPlaceholder('Добавить участника')).toHaveValue('');
    const ivan = page.getByText('Иван Кузнецов', { exact: true }).last();
    await expect(ivan).toBeVisible();
    await ivan.hover(); // "Hide" shows on hover
    await page.getByRole('button', { name: 'Скрыть' }).click();
    await expect(page.getByText(/больше не участвует/)).toBeVisible();

    await page.getByRole('button', { name: 'Сделать публичной' }).click();
    await expect(page.getByText('Публичная — видят все')).toBeVisible();
    await page.getByRole('button', { name: 'Сделать приватной' }).click();
    await expect(page.getByText('Приватная')).toBeVisible();
    // Pavel has an open mention: he stays, and says why.
    await expect(page.getByText(/Упомянут — остаётся/)).toBeVisible();
  });

  test('a dependency on another task is added and removed', async () => {
    const site = await taskId('сайт', 'новая главная к осенней кампании');
    await page.getByRole('button', { name: 'Добавить' }).first().click();
    await page.getByLabel('Найти задачу: теги или номер').fill(`#${site}`);
    await page.getByRole('button', { name: `Выбрать задачу #${site}` }).click();
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByRole('link', { name: new RegExp(`#${site}`) })).toBeVisible();
    await page.getByRole('button', { name: 'Убрать зависимость' }).click();
    await expect(page.getByRole('link', { name: new RegExp(`#${site}`) })).toHaveCount(0);
  });

  test('a reminder for myself', async () => {
    await page.getByRole('button', { name: 'Напомнить' }).click();
    await page.getByRole('button', { name: 'Через час' }).click();
    await page.getByLabel('О чём напомнить').fill('Глянуть ещё раз');
    await page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Глянуть ещё раз')).toBeVisible();
    await page.getByRole('button', { name: 'Удалить напоминание' }).click();
    await expect(page.getByText('Глянуть ещё раз')).toHaveCount(0);
  });

  test('finish closes it once my plan is cleared; the hand-over leaves me an observer', async () => {
    // Time still planned on it is not done: closing is refused until the plan is cleared.
    await page.getByRole('button', { name: 'Завершить' }).click();
    await expect(page.getByText(/не закрыть: на ней остались планы/)).toBeVisible();
    await page.getByRole('button', { name: 'Мой план' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Убрать план' }).click();
    await page.getByRole('button', { name: 'Завершить' }).click();
    await expect(page.getByText('Закрыта', { exact: true })).toBeVisible();
    await expect(page.getByText('Задача закрыта', { exact: true })).toBeVisible(); // in the feed

    await page.getByRole('button', { name: 'Передать' }).click();
    await page.getByLabel('Новый владелец').click();
    await page.keyboard.type('Марина');
    await page.getByRole('option', { name: 'Марина Соколова' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Передать' }).click();
    // Marina owns it now; I observe as her manager — no owner's buttons, and I cannot leave.
    await expect(page.getByRole('button', { name: 'Завершить' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Сделать публичной' })).toHaveCount(0);
    await expect(page.getByText('Марина Соколова').filter({ visible: true }).first()).toBeVisible();
    // The handover stays in the feed (decision 96).
    await expect(page.getByText('Новый владелец: Марина Соколова (прежний: Алексей Громов)')).toBeVisible();
  });
});

test('someone without access sees the header and asks for it', async ({ page }) => {
  await signIn(page, 'ivan@example.com');
  const report = await taskId('финансы', 'квартальный отчёт для совета директоров');
  await page.goto(`/tasks/${report}`);
  await expect(page.getByText('Это приватная задача')).toBeVisible();
  await page.getByRole('button', { name: 'Запросить доступ' }).click();
  await expect(page.getByText('Заявка у владельца')).toBeVisible();
  await page.getByRole('button', { name: 'Отозвать заявку' }).click();
  await expect(page.getByRole('button', { name: 'Запросить доступ' })).toBeVisible();
});

test('a reply lives in its thread; the feed marks its moment with a line that unfolds the thread', async ({ page }) => {
  await signIn(page);
  await page.goto(`/tasks/${await taskId('склад', 'инвентаризация за октябрь')}`);
  await page.getByRole('button', { name: /^Все события/ }).last().click();
  const request = page.locator('[id^="comment-"]').filter({ hasText: 'Иван, пересчитай' });
  const thread = page.locator('div').filter({ has: request }).filter({ hasText: 'Пересчитал, расхождений нет.' }).first();
  await expect(thread).toBeVisible(); // the answer is under the request
  const line = page.getByRole('button', { name: /Иван Кузнецов → Марина Соколова: «Пересчитал/ });
  await expect(line).toHaveAttribute('aria-expanded', 'false');
  await line.click();
  await expect(page.getByText('Иван, пересчитай, пожалуйста, стеллаж B.')).toHaveCount(2); // unfolded in place too
});

test('a task number in the context is a link to that task', async ({ page }) => {
  await signIn(page, 'marina@example.com');
  const id = await taskId('склад', 'инвентаризация за октябрь');
  const other = await taskId('сайт', 'новая главная к осенней кампании');
  const [before] = await sql`SELECT context FROM task WHERE id = ${id}`;
  await sql`UPDATE task SET context = ${`<p>Сначала #${other}, адрес https://example.com/#3 — не ссылка на задачу.</p>`} WHERE id = ${id}`;
  try {
    await page.goto(`/tasks/${id}`);
    await expect(page.getByRole('main').getByRole('link', { name: '#3', exact: true })).toHaveCount(0);
    await page.getByRole('main').getByRole('link', { name: `#${other}`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${other}$`));
  } finally {
    await sql`UPDATE task SET context = ${before!.context} WHERE id = ${id}`;
  }
});
