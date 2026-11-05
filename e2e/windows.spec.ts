import { expect, test } from '@playwright/test';
import { editable, signIn, sql, taskId, unique } from './helpers.ts';

/** Waits until the comment has reached the server: "Send" holds it a few seconds first. */
async function arrived(text: string): Promise<void> {
  await expect.poll(async () => (await sql`SELECT 1 FROM comment WHERE value LIKE ${'%' + text + '%'}`).length, { timeout: 30_000 }).toBe(1);
}

// The same person in two windows at once: a tab and the installed app.
test.describe('two windows', () => {
  test('going back to the other window shows what was changed in this one', async ({ page, context }) => {
    const text = unique('Написано в другом окне');
    await signIn(page);
    const id = await taskId('финансы', 'квартальный отчёт для совета директоров');
    await page.goto(`/tasks/${id}`);
    const other = await context.newPage();
    await other.goto(`/tasks/${id}`);
    await expect(other.getByText('отчёт').filter({ visible: true }).first()).toBeVisible();

    await page.bringToFront();
    await editable(page).click();
    await page.keyboard.type(text);
    await page.getByRole('button', { name: 'Отправить' }).click();
    await arrived(text);

    // Both windows stay visible: only the focus moves. Sooner than any poll.
    await other.bringToFront();
    await other.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(other.getByText(text).first()).toBeVisible({ timeout: 5_000 });
  });

  test('what one window sent once online is shown in the other, which did not send it', async ({ page, context }) => {
    const text = unique('Отправлено из одного окна');
    await signIn(page);
    const id = await taskId('финансы', 'квартальный отчёт для совета директоров');
    await page.goto(`/tasks/${id}`);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    const other = await context.newPage();
    await other.goto(`/tasks/${id}`);
    await expect(other.getByText('отчёт').filter({ visible: true }).first()).toBeVisible();

    await context.setOffline(true);
    await editable(page).click();
    await page.keyboard.type(text);
    await page.getByRole('button', { name: 'Отправить' }).click();
    await expect(page.getByText('Не отправлено · 1')).toBeVisible({ timeout: 15_000 });
    await expect(other.getByText('Не отправлено · 1')).toBeVisible();
    await context.setOffline(false);
    await arrived(text);
    for (const [name, window] of [['the sender', page], ['the other', other]] as const) {
      await expect(window.getByText(text), name).toHaveCount(1, { timeout: 10_000 });
      await expect(window.getByText('Не отправлено · 1'), name).toHaveCount(0);
    }
  });
});
