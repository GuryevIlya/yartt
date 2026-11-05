import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { signIn, unfold } from './helpers.ts';

// Tags in My day, folded until opened: anyone has it, counted on the tasks they see (decisions 58, 83).
test('the tag summary: the most active rubrics, a tag unfolds into its people, picked tags add all and any, a CSV', async ({ page }) => {
  await signIn(page, 'pavel@example.com');
  await unfold(page, 'Теги');
  const block = page.getByRole('region', { name: 'Статистика по тегам' });
  await expect(block.getByRole('row').nth(1)).toBeVisible();
  // What the block shows is under a "?", not in a line of text.
  await block.getByRole('img', { name: 'Пояснение' }).first().hover();
  await expect(page.getByRole('tooltip')).toContainText('роботы не учитываются');
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await block.getByRole('button', { name: '7 дн.' }).click();
  await block.getByLabel('С', { exact: true }).fill('2026-01-01');
  await expect(block.getByRole('button', { name: '7 дн.' })).toHaveClass(/MuiChip-outlined/);
  await block.getByRole('button', { name: '30 дн.' }).click();
  await expect(block.getByRole('row').nth(1)).toBeVisible();
  await expect(block.getByRole('columnheader', { name: /Открыто/ })).toBeVisible();

  // A line unfolds into each person's time and plan by day; bots are not people here.
  await block.getByRole('button', { name: 'Показать подробности: сайт' }).click();
  await expect(block.getByText('Списанное время по дням')).toBeVisible();
  await expect(block.getByText('План по дням')).toBeVisible();
  await expect(block.getByRole('columnheader', { name: /Доля времени/ })).toBeVisible();
  await expect(block.getByRole('cell', { name: 'Павел Орлов', exact: true })).toBeVisible();
  await expect(block.getByRole('cell', { name: 'CI-робот', exact: true })).toHaveCount(0);

  const search = block.getByRole('combobox');
  for (const tag of ['api', 'документация']) {
    await search.click();
    await page.keyboard.type(tag);
    await page.keyboard.press('Enter');
  }
  await page.keyboard.press('Escape');
  await expect(block.getByText(/^Все вместе: /)).toBeVisible();
  await expect(block.getByText(/^Любой из: /)).toBeVisible();

  const download = page.waitForEvent('download');
  await block.getByRole('button', { name: 'Выгрузить' }).click();
  const file = await (await download).path();
  const text = await readFile(file, 'utf8');
  expect(text).toMatch(/^\uFEFFТег,Сотрудник,"Списано, ч","Доля времени, %","План, ч",Комментарии/);
  expect(text.split('\r\n').length).toBeGreaterThan(1);
});
