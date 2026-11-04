import { expect, test } from '@playwright/test';
import { signIn, sql } from './helpers.ts';

// A 1×1 PNG: enough for the browser to crop and scale.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test.describe('profile', () => {
  test.afterEach(async () => {
    await sql`UPDATE employee SET locale = 'ru' WHERE email = 'olga@example.com'`;
  });

  test.beforeEach(async ({ page }) => {
    await signIn(page, 'olga@example.com');
    await page.getByRole('button', { name: /Ольга Белова/ }).click();
    await page.getByRole('menuitem', { name: 'Профиль' }).click();
  });

  test('bots: one is created with what it may do, its key shown once, then replaced', async ({ page }) => {
    await page.getByRole('dialog').getByRole('tab', { name: 'Боты' }).click();
    await page.getByRole('button', { name: 'Новый бот' }).click();
    const form = page.getByRole('dialog', { name: 'Новый бот' });
    await form.getByLabel('Имя').fill('Мониторинг');
    await form.getByRole('checkbox', { name: /Комментарии/ }).check();
    await form.getByRole('button', { name: 'Создать' }).click();
    const created = page.getByRole('dialog', { name: 'Бот создан' });
    await expect(created.getByText(/^yartt_[0-9a-f]{64}$/)).toBeVisible();
    await created.getByRole('button', { name: 'Закрыть' }).click();

    await page.getByRole('row', { name: /Мониторинг/ }).click();
    const settings = page.getByRole('dialog', { name: 'Мониторинг' });
    await expect(settings.getByRole('checkbox', { name: /Комментарии/ })).toBeChecked();
    page.once('dialog', (confirm) => void confirm.accept());
    await settings.getByRole('button', { name: 'Выпустить новый ключ' }).click();
    await expect(settings.getByText(/^yartt_[0-9a-f]{64}$/)).toBeVisible();
  });

  test('avatar: uploaded, shown, removed', async ({ page }) => {
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[type=file]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.locator('img[src*="/api/avatars/"]').first()).toBeVisible();
    await dialog.getByRole('button', { name: 'Убрать' }).click();
    await expect(page.locator('img[src*="/api/avatars/"]')).toHaveCount(0);
  });

  test('language applies at once, and the name follows it', async ({ page }) => {
    await page.getByLabel('Язык').click();
    await page.getByRole('option', { name: 'English' }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Profile' })).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('heading', { name: /Waiting for me/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'My day', exact: true })).toBeVisible();
    await expect(page.getByText(/^yartt [0-9.]+ · ©/)).toBeVisible();

    await page.getByRole('button', { name: /Ольга Белова/ }).click();
    await page.getByRole('menuitem', { name: 'Profile' }).click();
    await page.getByLabel('Language').click();
    await page.getByRole('option', { name: 'Русский' }).click();
    await page.getByRole('button', { name: 'Закрыть' }).click();
    await expect(page.getByRole('heading', { name: /Ждёт меня/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Мой день', exact: true })).toBeVisible();
    await expect(page.getByText(/^яртт [0-9.]+ · ©/)).toBeVisible();
  });

  test('the pronoun applies at once', async ({ page }) => {
    const pronoun = page.getByRole('combobox', { name: /Как о вас писать/ });
    await pronoun.click();
    await page.getByRole('option', { name: 'Не указано' }).click();
    await expect(pronoun).toHaveText('Не указано');
    await pronoun.click();
    await page.getByRole('option', { name: 'Она' }).click();
    await expect(pronoun).toHaveText('Она');
  });

  test('the dialog keeps its size between its tabs', async ({ page }) => {
    const box = async () => {
      const b = await page.getByRole('dialog').boundingBox();
      return b && { width: b.width, height: b.height };
    };
    const first = await box();
    for (const name of ['Теги', 'Боты', 'Профиль']) {
      await page.getByRole('dialog').getByRole('tab', { name }).click();
      await expect(page.getByRole('dialog').getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
      expect(await box()).toEqual(first);
    }
  });
});
