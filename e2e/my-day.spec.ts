import { expect, test } from '@playwright/test';
import { createTask, editable, signIn, taskId, unfold, unique } from './helpers.ts';

// My day of the first employee over the demo data (scripts/seed.ts).
test.describe('My day', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('TODO: an access request is answered, a mention is closed', async ({ page }) => {
    const todo = page.locator('div.MuiPaper-root').filter({ has: page.getByRole('heading', { name: /Ждёт меня/ }) }).first();
    await expect(todo.getByText('Олег Смирнов просит доступ')).toBeVisible();
    await expect(todo.getByText('Марина Соколова упомянула вас')).toBeVisible(); // her pronoun
    await expect(todo.getByText('CI-робот упомянул(а) вас')).toBeVisible(); // a bot: no pronoun
    await expect(todo.getByText(/Новые комментарии: \d+, от Павел Орлов/)).toBeVisible();

    await todo.getByRole('button', { name: 'Принять' }).click();
    await expect(todo.getByText('Олег Смирнов просит доступ')).toHaveCount(0);

    const mention = todo.locator('div').filter({ hasText: /^Марина Соколова упомянула вас/ }).first();
    await expect(mention).toBeVisible();
    const item = todo.locator('.MuiStack-root').filter({ hasText: 'Нужна ваша подпись' }).filter({ has: page.getByRole('button', { name: 'Ответить' }) }).last();
    // Without a reply it is closed by "No reply needed"; answered right here, by "Done".
    await expect(item.getByRole('button', { name: 'Ответ не нужен' })).toBeVisible();
    await item.getByRole('button', { name: 'Ответить' }).click();
    await editable(page).click();
    await page.keyboard.type('Подпишу сегодня');
    await page.getByRole('button', { name: 'Отправить' }).click();
    await expect(item.getByRole('button', { name: 'Готово' })).toBeEnabled({ timeout: 15_000 });
    await expect(item.getByText(/Мой ответ · .*«Подпишу сегодня»/)).toBeVisible(); // the answer shows inside its mention
    await item.getByRole('button', { name: 'Готово' }).click();
    await expect(todo.getByText('Нужна ваша подпись')).toHaveCount(0);
  });

  test('TODO: a due reminder waits until it is put off', async ({ page }) => {
    const todo = page.locator('div.MuiPaper-root').filter({ has: page.getByRole('heading', { name: /Ждёт меня/ }) }).first();
    const item = todo.locator('.MuiStack-root').filter({ hasText: 'Спросить Павла' }).filter({ has: page.getByRole('button', { name: 'Перенести' }) }).last();
    await expect(item.getByText(/^Напоминание с /)).toBeVisible();
    await item.getByRole('button', { name: 'Перенести' }).click();
    await page.getByRole('menuitem', { name: 'Завтра в 9:00' }).click();
    await expect(todo.getByText('Спросить Павла')).toHaveCount(0);
  });

  test('TODO: my task due tomorrow, and a task it waits for that is done, in one review', async ({ page }) => {
    const todo = page.locator('div.MuiPaper-root').filter({ has: page.getByRole('heading', { name: /Ждёт меня/ }) }).first();
    const review = todo.locator('.MuiStack-root').filter({ hasText: 'Готова задача, которую ждёт эта' })
      .filter({ has: page.getByRole('button', { name: 'Вмешательство не требуется' }) }).last();
    await expect(review.getByText(/^Дедлайн через \d+ (час|часа|часов)/)).toBeVisible();
    await expect(review.getByRole('link', { name: 'Перенести дедлайн' })).toBeVisible();
    // Marina closed hers; Pavel's promo is overdue and open: not done for me until he closes it (decision 93).
    await expect(review.getByText('договор с новым поставщиком')).toBeVisible();
    // An access request to the task is answered first.
    const accept = todo.getByRole('button', { name: 'Принять' });
    if (await accept.count()) await accept.click();
    await review.getByRole('button', { name: 'Вмешательство не требуется' }).click();
    await expect(page.getByRole('dialog').getByText(/готовые задачи, которые она ждёт \(\d+\), дедлайн через день/)).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Вмешательство не требуется' }).click();
    await expect(todo.getByText('Готова задача, которую ждёт эта')).toHaveCount(0);
  });

  test('TODO: a link a participant added to my task is in its review, and the review is on top of the task too', async ({ page }) => {
    const site = await taskId('сайт', 'новая главная к осенней кампании');
    await page.goto(`/tasks/${site}`);
    const block = page.getByRole('alert').filter({ hasText: 'Ждёт меня' });
    await expect(block.getByText('Павел Орлов: теперь эта задача ждёт')).toBeVisible();
    await expect(block.getByText('собрать отзывы клиентов для главной')).toBeVisible();
  });

  test('TODO: reply right from My day', async ({ page }) => {
    const item = page.locator('.MuiStack-root').filter({ hasText: 'Сборка #512 упала' }).filter({ has: page.getByRole('button', { name: 'Ответить' }) }).last();
    await item.getByRole('button', { name: 'Ответить' }).click();
    await expect(page.getByText(/Ответ на комментарий CI-робот/)).toBeVisible();
  });

  test('current tasks: mine, my team\'s and others, with pages', async ({ page }) => {
    await expect(page.getByRole('tab', { name: /Мои открытые · 3/ })).toBeVisible();
    // A line says everyone's time on the task: logged → left in plans.
    await expect(page.getByRole('region', { name: 'Доступные задачи' }).getByText(/\d.* → \d/).first()).toBeVisible();
    // Ivan's tickets: he is under Marina, who is under me — my team.
    await page.getByRole('tab', { name: /Остальные открытые · \d+/ }).click();
    await expect(page.getByRole('link', { name: /переезд на 5-й этаж/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /тикет \d+/ })).toHaveCount(0);
    await page.getByRole('tab', { name: /Открытые команды · \d+/ }).click();
    await expect(page.getByRole('link', { name: /тикет \d+/ }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Go to page 2' }).first().click();
    await expect(page.getByRole('link', { name: /#\d+/ }).first()).toBeVisible();
    // The tab keeps its state when coming back from a task.
    await page.getByRole('link', { name: /#\d+/ }).first().click();
    await page.getByRole('link', { name: 'Мой день', exact: true }).click(); // the logo is the way home
    await expect(page.getByRole('tab', { name: /Открытые команды/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('a shift is started now from the top line and finished with what was done', async ({ page }) => {
    const history = page.locator('.MuiPaper-root').filter({ has: page.getByRole('heading', { name: 'Табель' }) });
    await page.getByRole('banner').getByRole('button', { name: 'Начать смену' }).click();
    await expect(history.getByText(/Смена идёт с \d\d:\d\d/)).toBeVisible();
    await expect(page.getByRole('banner').getByRole('button', { name: 'Начать смену' })).toHaveCount(0);
    await history.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.getByLabel('Что сделано').fill('Проверка e2e');
    await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect(page.getByText('Проверка e2e')).toBeVisible();
  });

  test('history: time is logged to a task I opened, right from My day, in a shift', async ({ page }) => {
    const history = page.locator('.MuiPaper-root').filter({ has: page.getByRole('heading', { name: 'Табель' }) });
    const entries = history.getByRole('button', { name: 'Удалить списание' });
    // The last day has no shift: the opened tasks wait for one, and the day offers it (decision 100).
    const opened = history.getByRole('button', { name: /Открывались без списания/ });
    await opened.last().click();
    await expect(history.getByText(/Время списывается в смену/)).toBeVisible();
    await history.getByRole('button', { name: 'Подтвердить' }).click();
    await expect(history.getByText(/Время списывается в смену/)).toHaveCount(0);
    await page.waitForLoadState('networkidle');
    const before = await entries.count();
    await opened.last().locator('xpath=..').getByRole('button', { name: 'Списать время' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '30м' }).click();
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(entries).toHaveCount(before + 1);
  });

  test('history: a shift is added to a past day, corrected and deleted while the day is not scored', async ({ page }) => {
    const history = page.locator('.MuiPaper-root').filter({ has: page.getByRole('heading', { name: 'Табель' }) });
    await expect(history.getByRole('button', { name: 'Добавить смену' }).nth(1)).toBeVisible();
    await page.waitForLoadState('networkidle');
    const edits = history.getByRole('button', { name: 'Поправить смену' });
    const before = await edits.count();
    await history.getByRole('button', { name: 'Добавить смену' }).nth(1).click();
    const dialog = page.getByRole('dialog');
    // Only the times are picked; an end before the start is the next day's (decision 100).
    await expect(dialog.getByLabel('Начало')).toHaveAttribute('type', 'time');
    const [from, to] = [await dialog.getByLabel('Начало').inputValue(), await dialog.getByLabel('Конец').inputValue()];
    await dialog.getByLabel('Начало').fill('22:00');
    await dialog.getByLabel('Конец').fill('02:00');
    // Only the next day is checked: in the first hours after midnight such a shift of yesterday
    // still ends in the future, and then the error stands where its length is.
    await expect(dialog.getByText(/заканчивается на следующий день/)).toBeVisible();
    await dialog.getByLabel('Начало').fill(from);
    await dialog.getByLabel('Конец').fill(to);
    await dialog.getByLabel('Что сделано').fill('Забытая смена');
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await expect(history.getByText('Забытая смена')).toBeVisible();
    await expect(edits).toHaveCount(before + 1);

    // A shift over the whole day is in the way of that one: named, and not saved.
    await history.getByRole('button', { name: 'Добавить смену' }).nth(1).click();
    await dialog.getByLabel('Начало').fill('00:00');
    await dialog.getByLabel('Конец').fill('23:59');
    await expect(dialog.getByRole('alert')).toContainText(/Смена пересекается с вашей сменой \d\d:\d\d–\d\d:\d\d/);
    await expect(dialog.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Отмена' }).click();

    const row = history.locator('.MuiStack-root').filter({ hasText: 'Забытая смена' }).filter({ has: page.getByRole('button', { name: 'Поправить смену' }) }).last();
    await row.getByRole('button', { name: 'Поправить смену' }).click();
    await dialog.getByLabel('Что сделано').fill('Забытая смена, поправлено');
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await expect(history.getByText('Забытая смена, поправлено')).toBeVisible();
    page.once('dialog', (d) => void d.accept());
    await row.getByRole('button', { name: 'Удалить смену' }).click();
    await expect(history.getByText('Забытая смена, поправлено')).toHaveCount(0);
  });

  test('history: activity after a written shift is offered as the shift that was not written down', async ({ page }) => {
    await signIn(page, 'pavel@example.com');
    // Older days are in History, Pavel's own page.
    await page.locator('.MuiPaper-root').filter({ has: page.getByRole('heading', { name: 'Табель' }) })
      .getByRole('link', { name: 'История' }).click();
    const hint = page.getByText('Похоже на смену 20:10–21:05');
    for (let page2 = 2; page2 <= 3; page2++) {
      await page.waitForLoadState('networkidle');
      if (await hint.isVisible()) break;
      await page.getByRole('button', { name: `Go to page ${page2}` }).click();
    }
    await page.locator('.MuiPaper-root').filter({ hasText: 'Похоже на смену 20:10–21:05' }).last()
      .getByRole('button', { name: 'Подтвердить' }).click();
    const day = page.locator('.MuiPaper-root').filter({ hasText: /Смена 20:10–21:05/ }).last();
    await expect(day).toBeVisible();
    await expect(day.getByText(/^В сменах: /)).toBeVisible(); // next to the time logged to tasks
    // The ribbon shows the visits; one by one they are a click away, in the whole day.
    await expect(day.getByLabel('Лента дня: смены, активность и действия')).toBeVisible();
    await day.getByRole('button', { name: 'Подробнее' }).click();
    const whole = page.getByRole('dialog');
    await whole.getByRole('button', { name: /^Активность · \d+$/ }).click();
    await expect(whole.getByText('20:10', { exact: true })).toBeVisible();
  });
});

test('a task hovered in any list shows its context and everyone\'s time', async ({ page }) => {
  await signIn(page);
  const line = page.getByRole('region', { name: 'Доступные задачи' }).getByRole('link', { name: /новая главная к осенней кампании/ }).first();
  await line.hover();
  await expect(page.getByRole('tooltip').getByText(/Новая главная к запуску осенней кампании/)).toBeVisible();
  await expect(page.getByRole('tooltip').getByText(/Павел Орлов|Я/).first()).toBeVisible();
});

// What I wait for from others is a list of its own (decision 67).
test('Waiting for others: my request not answered yet, withdrawn from there', async ({ page }) => {
  await signIn(page);
  const tag = unique('доступ');
  await createTask(page, [tag]);
  const id = Number(page.url().split('/').pop());

  await signIn(page, 'olga@example.com');
  await page.goto(`/tasks/${id}`);
  await page.getByRole('button', { name: 'Запросить доступ' }).click();
  await expect(page.getByText('Заявка у владельца')).toBeVisible();
  await page.goto('/');
  const block = page.getByRole('region', { name: 'Жду ответа' });
  await expect(block.getByText('Вы просили доступ — решает Алексей Громов')).toBeVisible();
  await expect(block.getByText(tag)).toBeVisible();
  await block.getByRole('button', { name: 'Отозвать заявку' }).click();
  await expect(block.getByText(tag)).toHaveCount(0);
});

test('Waiting for others: a comment waits for "No intervention needed", then only for new reactions', async ({ page }) => {
  await signIn(page);
  const block = page.getByRole('region', { name: 'Жду ответа' });
  const item = block.locator('.MuiStack-root').filter({ hasText: 'Показ заказчику' })
    .filter({ has: page.getByRole('button', { name: 'Вмешательство не требуется' }) }).last();
  await expect(item.getByText(/Павел Орлов · закрыто без ответа/)).toBeVisible();
  await expect(item.getByText(/Марина Соколова · ответа нет/)).toBeVisible();
  await item.getByRole('button', { name: 'Вмешательство не требуется' }).click();
  // Gone, though Marina has not reacted yet: she still has it in her Waiting for me (decision 98).
  await expect(block.getByText(/Павел Орлов · /)).toHaveCount(0);
  await expect(block.getByText(/Марина Соколова · ответа нет/)).toHaveCount(0);
});

test('what was done, a dot on the ribbon, opens its task', async ({ page }) => {
  await signIn(page);
  const ribbon = page.getByLabel('Лента дня: смены, активность и действия').first();
  const dot = ribbon.getByRole('link').last(); // dots of the same moment lie one on another: the top one
  await expect(dot).toHaveAccessibleName(/#\d+ /);
  await dot.click();
  await expect(page).toHaveURL(/\/tasks\/\d+$/);
});

test('My files, folded at the end of My day: the space used and the files kept, let go to free it', async ({ page }) => {
  await signIn(page, 'pavel@example.com');
  await unfold(page, 'Мои файлы');
  const block = page.getByRole('region', { name: 'Мои файлы' });
  await expect(block.getByText(/^Занято .+ из 1024 МБ$/)).toBeVisible();
  const line = block.locator('.MuiStack-root').filter({ has: page.getByRole('button', { name: 'Убрать из моих' }) }).first();
  await expect(line.getByRole('link', { name: /^#\d+$/ }).first()).toBeVisible(); // the task it is in
});

test('a file in a comment is kept in my files: it stays mine whoever lets it go', async ({ page }) => {
  await signIn(page);
  await page.goto(`/tasks/${await taskId('сайт', 'новая главная к осенней кампании')}`);
  await page.getByRole('button', { name: /^Все события/ }).last().click();
  const keep = page.getByRole('button', { name: /^Сохранить в мои файлы/ }).first();
  await keep.click();
  await expect(page.getByRole('button', { name: /^Сохранить в мои файлы/ }).first()).toBeDisabled();
  await page.goto('/');
  await unfold(page, 'Мои файлы');
  await expect(page.getByRole('region', { name: 'Мои файлы' }).getByText(/держат ещё: 1/)).toBeVisible();
});
