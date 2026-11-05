import { expect, test } from '@playwright/test';
import { createTask, signIn, sql, taskId, unique } from './helpers.ts';

test.describe('new task', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('the editor opens without React having to render the page again', async ({ page }) => {
    // Tiptap destroyed an editor made during a render that took longer than a tick; it shows only sometimes.
    const errors: Error[] = [];
    page.on('pageerror', (error) => errors.push(error));
    for (let i = 0; i < 5; i++) {
      await page.goto('/');
      await page.getByRole('button', { name: 'Новая задача' }).click();
      await expect(page).toHaveURL(/\/tasks\/new$/);
      await expect(page.locator('.ProseMirror[contenteditable="true"]').first()).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  test('"New task" over the search opens a new task: tags as the title, priority, then the task opens', async ({ page }) => {
    const tag = unique('форма');
    await page.getByRole('button', { name: 'Новая задача' }).click();
    await expect(page).toHaveURL(/\/tasks\/new$/);
    await expect(page.getByRole('combobox', { name: 'Теги' })).toBeFocused();
    // Enter makes a new tag when none is spelled so; the cursor stays in the field.
    await page.keyboard.type(tag.toUpperCase());
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: tag, exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Теги' })).toHaveValue('');
    await expect(page.getByRole('combobox', { name: 'Теги' })).toBeFocused();
    // The button for it holds its place while the letters are checked — the form does not jump —
    // and leaves the cursor in the field too.
    const second = unique('макет');
    await page.keyboard.type(second.slice(0, 3));
    const button = page.getByRole('button', { name: /^Новый тег «/ });
    await expect(button).toBeVisible();
    const element = await button.elementHandle();
    await page.keyboard.type(second.slice(3), { delay: 30 });
    expect(await element!.evaluate((e) => e.isConnected)).toBe(true);
    await page.getByRole('button', { name: `Новый тег «${second}»` }).click();
    await expect(page.getByRole('button', { name: second, exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Теги' })).toBeFocused();
    // A new tag exists only once the task is saved: titles change while typed.
    expect(await sql`SELECT 1 FROM tag WHERE name = ${tag}`).toHaveLength(0);
    // A tag spelled exactly so exists: it has to be picked before the task is created.
    await page.keyboard.type('склад');
    await expect(page.getByText('Тег «склад» уже есть — выберите его в подсказках')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Создать задачу' })).toBeDisabled();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await page.getByLabel('Приоритет').click();
    await page.getByRole('option', { name: 'Высокий' }).click();
    await page.getByRole('button', { name: 'Создать задачу' }).click();
    await expect(page).toHaveURL(/\/tasks\/\d+$/);
    // The title reads as text: its tags with dots between.
    const heading = page.getByRole('main').getByRole('heading', { level: 1 });
    await expect(heading).toContainText(tag);
    await expect(heading).toContainText('склад');
    await expect(page.getByText('Высокий').filter({ visible: true }).first()).toBeVisible();
  });

  test('picked tags show the similar tasks under the title', async ({ page }) => {
    await page.getByRole('button', { name: 'Новая задача' }).click();
    await expect(page.getByRole('combobox', { name: 'Теги' })).toBeFocused();
    await page.keyboard.type('склад');
    await page.getByRole('option', { name: 'склад', exact: true }).click();
    await expect(page.getByText('Похожие задачи')).toBeVisible();
    await expect(page.getByRole('link', { name: /склад · инвентаризация за октябрь/ }).filter({ visible: true }).first()).toBeVisible();
    // Who worked on such tasks is offered, and a click brings them in (decision 97).
    await expect(page.getByText('Кто разбирается:')).toBeVisible();
    await page.getByRole('button', { name: 'Марина Соколова · задач: 1' }).click();
    await expect(page.getByRole('button', { name: 'Марина Соколова · задач: 1' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Участники' }).locator('..').getByText('Марина Соколова')).toBeVisible();
  });

  test('participants are brought in from the form: the task opens with them, I stay the owner', async ({ page }) => {
    const tag = unique('для разработчика');
    await page.getByRole('button', { name: 'Новая задача' }).click();
    await expect(page.getByRole('combobox', { name: 'Теги' })).toBeFocused();
    await page.keyboard.type(tag);
    await page.keyboard.press('Enter');
    await page.getByRole('combobox', { name: 'Участники' }).click();
    await page.keyboard.type('фронтенд'); // found by what he wrote about himself
    await page.getByRole('option', { name: /Павел Орлов/ }).click();
    await expect(page.getByText('Что нужно от них')).toBeVisible();
    await page.locator('.ProseMirror[contenteditable="true"]').last().fill('Сделай выгрузку');
    await page.getByRole('button', { name: 'Создать задачу' }).click();
    await expect(page).toHaveURL(/\/tasks\/\d+$/);
    const id = Number(page.url().split('/').pop());
    const [row] = await sql`
      SELECT k.owner_id = (SELECT id FROM employee WHERE full_name = 'Алексей Громов') AS mine,
             EXISTS (SELECT 1 FROM observer o JOIN employee e ON e.id = o.value
                      WHERE o.task_id = k.id AND e.full_name = 'Павел Орлов' AND o.added_at IS NOT NULL AND o.deleted_at IS NULL) AS pavel
        FROM task k WHERE k.id = ${id}
    `;
    expect(row).toEqual({ mine: true, pavel: true });
    await expect(page.getByText('Павел Орлов', { exact: true }).last()).toBeVisible();
  });

  test('"New task" under "Waited on by" makes a task that waits for this one', async ({ page }) => {
    const id = await taskId('склад', 'инвентаризация за октябрь');
    await page.goto(`/tasks/${id}`);
    await page.getByRole('link', { name: 'Новая задача' }).last().click();
    await expect(page).toHaveURL(new RegExp(`/tasks/new\\?waitsFor=${id}$`));
    await expect(page.getByText('Будет ждать задачу')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Теги' })).toBeFocused();
    // The title starts as that task's tags; the same set is taken, so something must be added.
    await expect(page.getByRole('button', { name: 'склад', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'инвентаризация за октябрь', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Создать задачу' })).toBeDisabled();
    // Text left unpicked becomes a tag of its own: one phrase, one tag.
    const phrase = `${unique('ждёт')} акта`;
    await page.keyboard.type(phrase);
    await page.getByRole('button', { name: 'Создать задачу' }).click();
    await expect(page).toHaveURL(/\/tasks\/\d+$/);
    await expect(page.getByRole('link', { name: new RegExp(`#${id} склад · инвентаризация за октябрь`) })).toBeVisible();
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toContainText(phrase);
  });

  test('"Add" under "Waits for" finds a task by tags and links it', async ({ page }) => {
    await createTask(page, [unique('связь')]);
    await page.getByRole('button', { name: 'Добавить' }).first().click();
    await page.getByLabel('Найти задачу: теги или номер').click();
    await page.keyboard.type('офис');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: /^Выбрать задачу #\d+$/ }).first().click();
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByRole('link', { name: /офис.*(переезд|принтер)/ })).toBeVisible();
  });
});
