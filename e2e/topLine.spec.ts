import { expect, test } from '@playwright/test';
import { employeeId, signIn, sql, taskId } from './helpers.ts';

test.describe('the top line', () => {
  test('how much waits for me is seen from a task; a click brings My day', async ({ page }) => {
    await signIn(page);
    // The TODO block and the counter read the same list.
    await page.waitForLoadState('networkidle');
    const items = await page.getByRole('heading', { name: /^Ждёт меня/ }).textContent();
    const count = Number(items!.match(/\d+/)?.[0] ?? 0);
    await page.goto(`/tasks/${await taskId('сайт', 'новая главная к осенней кампании')}`);
    const todo = page.getByRole('button', { name: `Ждёт меня: ${count}`, exact: true });
    await expect(todo).toBeVisible();
    await todo.click();
    await expect(page).toHaveURL(/\/$/);

    // Already in My day, scrolled away from TODO: the bell brings the block back into view.
    const heading = page.getByRole('heading', { name: /^Ждёт меня/ });
    // A short window: however little My day holds, the footer is out of sight of TODO.
    await page.setViewportSize({ width: 1400, height: 500 });
    await page.getByText(/^(яртт|yartt) /).scrollIntoViewIfNeeded(); // the footer
    await expect(heading).not.toBeInViewport();
    await todo.click();
    await expect(heading).toBeInViewport();
    await expect(heading).toBeFocused();
  });

  test('away from the top line: the day I am back in one click, and back at work again', async ({ page }) => {
    await signIn(page, 'oleg@example.com');
    await page.getByRole('button', { name: 'Меня не будет…' }).click();
    await page.getByRole('button', { name: 'Через неделю' }).click();
    const away = page.getByRole('button', { name: /^Вернусь \d+/ });
    await expect(away).toBeVisible();
    await away.click();
    await page.getByRole('button', { name: 'Я уже на работе' }).click();
    await expect(away).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Меня не будет…' })).toBeVisible();
  });

  test('an open shift shows its time and is closed from there', async ({ page }) => {
    const id = await employeeId('oleg@example.com');
    await sql`DELETE FROM work WHERE employee_id = ${id} AND spent_minutes IS NULL`;
    await sql`INSERT INTO work (employee_id, started_at) VALUES (${id}, date_trunc('minute', NOW()) - INTERVAL '2 hours 5 minutes')`;
    await signIn(page, 'oleg@example.com');
    const shift = page.getByRole('button', { name: /^Смена идёт с \d\d:\d\d — закрыть$/ });
    // A minute may turn between the insert and the screen: 2h 5m, or 6m by then.
    await expect(shift).toHaveText(/^Смена · 2ч [56]м$/);
    await shift.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Закрыть смену' })).toBeVisible();
    await dialog.getByLabel('Что сделано').fill('Проверка верхней строки');
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect(shift).toHaveCount(0);
  });
});
