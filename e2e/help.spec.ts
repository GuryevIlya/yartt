/// <reference lib="dom" />
import { expect, test } from '@playwright/test';
import { signIn, sql } from './helpers.ts';

// The guide behind "?" in the top line, written for each language (decision 62).
test.describe('the guide', () => {
  test.afterEach(async () => {
    await sql`UPDATE employee SET locale = 'ru' WHERE email = 'olga@example.com'`;
  });

  test('opens from the top line: the essentials, use cases and why it is so; in the person\'s language', async ({ page }) => {
    await signIn(page, 'olga@example.com');
    await page.getByRole('link', { name: 'Как работать' }).click();
    await expect(page).toHaveURL(/\/help$/);
    await expect(page.getByRole('heading', { name: 'Как работать в яртт' })).toBeVisible();
    // A newcomer starts with the principles and what each replaces, then five steps, then the diagrams.
    await expect(page.getByRole('region', { name: 'Первый день: пять шагов' }).getByRole('listitem')).toHaveCount(5);
    const diagrams = page.getByRole('region', { name: 'Как это устроено' });
    await expect(diagrams.getByText('Кто есть кто в задаче')).toBeVisible();
    await expect(diagrams.getByText('Хозяин инициативы — один на задачу')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Связи вместо иерархии' }).getByText('Зависимость «Ждёт»', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Почему задачу закрывает только владелец, а не срок?' }).click();
    await expect(page.getByText(/дедлайн не знает, сделана ли работа/)).toBeVisible();
    // Handing out the work and finding who will do it are use cases of their own: the task stays the owner's.
    await page.getByRole('button', { name: 'Раздать работу' }).click();
    await expect(page.getByText(/«@Иван, сделаешь п. 1\?»/)).toBeVisible();
    await page.getByRole('button', { name: 'Найти, кто сделает' }).click();
    await expect(page.getByText(/Публичная задача здесь не поможет/)).toBeVisible();

    await sql`UPDATE employee SET locale = 'en' WHERE email = 'olga@example.com'`;
    await page.reload();
    await expect(page.getByRole('heading', { name: 'How to work in yartt' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'How it fits together' }).getByText('Who is who in a task')).toBeVisible();
    await page.getByRole('button', { name: 'Create a task' }).click();
    await expect(page.getByText(/Press "New task" in the block/)).toBeVisible();
  });
});
