import { expect, test } from '@playwright/test';
import { FIRST, loginLink, signIn, sql } from './helpers.ts';

test.describe('sign-in', () => {
  test('a link is requested by email; the page does not tell whether the email exists', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('Email').fill('nobody@example.com');
    await page.getByRole('button', { name: 'Получить ссылку' }).click();
    await expect(page.getByText('Если такой сотрудник есть, мы отправили ссылку для входа.')).toBeVisible();
  });

  test('the link signs in once; log out returns to the sign-in page', async ({ page }) => {
    const link = (await loginLink(page))!;
    await page.goto(link);
    await expect(page.getByRole('heading', { name: /Ждёт меня/ })).toBeVisible();
    await expect(page).toHaveTitle(/яртт/);

    await page.getByRole('button', { name: /Алексей Громов/ }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login$/);

    // The same link again: single-use.
    await page.goto(link);
    await expect(page.getByText(/Ссылка недействительна/)).toBeVisible();
  });

  test('a link to a new email makes it the sign-in address, once', async ({ page }) => {
    const [row] = await sql<{ token: string }[]>`
      SELECT request_email_change(id, 'ivan.new@example.com') AS token FROM employee WHERE email = 'ivan@example.com'
    `;
    try {
      await page.goto(`/email/${row!.token}`);
      await expect(page.getByText('Готово: теперь вы входите в яртт с новым адресом.')).toBeVisible();
      await page.goto(`/email/${row!.token}`);
      await expect(page.getByText(/Ссылка недействительна/)).toBeVisible();
      await signIn(page, 'ivan.new@example.com');
    } finally {
      await sql`UPDATE employee SET email = 'ivan@example.com' WHERE email = 'ivan.new@example.com'`;
    }
  });

  test('a dismissed employee cannot sign in', async ({ page }) => {
    expect(await loginLink(page, 'sergey@example.com')).toBeNull();
    await signIn(page);
  });

  test('a link opened in another browser signs nobody in and still works where it was asked for', async ({ page, browser }) => {
    const link = (await loginLink(page))!;
    const elsewhere = await browser.newPage();
    await elsewhere.goto(link);
    await expect(elsewhere.getByText(/Откройте ссылку в том браузере, где запрашивали вход/)).toBeVisible();
    await elsewhere.close();

    await page.goto(link);
    await expect(page.getByRole('heading', { name: /Ждёт меня/ })).toBeVisible();
  });
});

test('a sign-in link switches to its person even when someone is signed in', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('region', { name: 'Моя команда' })).toBeVisible();
  await signIn(page, 'ivan@example.com');
  await expect(page.getByRole('button', { name: /Иван Кузнецов/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Моя команда' })).toHaveCount(0);
});
