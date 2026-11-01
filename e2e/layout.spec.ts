/// <reference lib="dom" />
import { expect, test, type Page } from '@playwright/test';
import { employeeId, signIn, taskId, unfold } from './helpers.ts';

/** Nothing sticks out to the side: no horizontal scroll at phone width. */
async function fits(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('My day, my team, a task, an employee page, the guide', async ({ page }) => {
    await signIn(page);
    await fits(page);
    await page.goto(`/tasks/${await taskId('сайт', 'новая главная к осенней кампании')}`);
    await expect(page.getByText('Новая главная к запуску осенней кампании.')).toBeVisible();
    await fits(page);
    await page.goto(`/employees/${await employeeId('marina@example.com')}`);
    await expect(page.getByRole('heading', { name: 'Показатели' })).toBeVisible();
    await fits(page);
    await page.goto('/');
    await unfold(page, 'Моя команда');
    await expect(page.getByRole('heading', { name: 'Моя команда' })).toBeVisible();
    await fits(page);
    // The team table fits its block, its details open too: no scroll inside either.
    const table = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Задержка' }) });
    await table.getByRole('row').filter({ hasText: 'Марина Соколова' }).first().getByRole('button', { name: /^(Подробнее и графики|Скрыть подробности)$/ }).click();
    await expect(page.getByText('Время', { exact: true })).toBeVisible();
    expect(await table.evaluate((el) => el.parentElement!.scrollWidth - el.parentElement!.clientWidth)).toBeLessThanOrEqual(1);
    await fits(page);
    await page.goto('/help');
    await expect(page.getByRole('heading', { name: 'Как работать в яртт' })).toBeVisible();
    await fits(page);
  });
});

test.describe('wide', () => {
  test.use({ viewport: { width: 1400, height: 800 } });

  test('the timesheet beside the tasks scrolls on its own', async ({ page }) => {
    await signIn(page);
    const sheet = page.getByRole('heading', { name: 'Табель' }).locator('xpath=ancestor::div[contains(@class, "MuiBox-root")][1]');
    const visits = sheet.getByRole('button', { name: /^Активность · \d+$/ });
    await expect(visits).toHaveCount(2);
    for (const button of await visits.all()) await button.click();
    // And the tasks opened without an entry: enough for the timesheet to outgrow the window.
    for (const button of await sheet.getByRole('button', { name: /^Открывались без списания/ }).all()) await button.click();
    const main = page.locator('main').first();
    const scrolled = () => Promise.all([main.evaluate((e) => e.scrollTop), sheet.evaluate((e) => e.scrollTop)]);

    // The tasks scroll; the timesheet stays in view.
    await main.evaluate((e) => e.scrollBy(0, 900));
    await expect(sheet.getByRole('heading', { name: 'Табель' })).toBeInViewport();
    // The timesheet scrolls; the tasks do not move.
    await sheet.hover();
    const [mainBefore] = await scrolled();
    await page.mouse.wheel(0, 400);
    await expect.poll(async () => (await scrolled())[1]).toBeGreaterThan(0);
    expect((await scrolled())[0]).toBe(mainBefore);
  });
});
