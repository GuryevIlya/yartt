import { expect, test } from '@playwright/test';
import { createTask, signIn, sql, unique } from './helpers.ts';

// The browser is far from the profile's time zone: what is typed and shown
// follows the profile, the zone days are counted in (decision 99).
test.use({ timezoneId: 'Asia/Tokyo' });

test('a deadline typed and shown in the profile\'s time zone, not the browser\'s', async ({ page }) => {
  await signIn(page);
  const tag = unique('пояс');
  await createTask(page, [tag]);
  await page.getByLabel('Дедлайн').fill('2030-03-15T10:00');
  await page.getByLabel('Дедлайн').blur();
  await expect.poll(async () => {
    const [row] = await sql<{ local: string | null }[]>`
      SELECT to_char(f.value AT TIME ZONE e.time_zone, 'YYYY-MM-DD"T"HH24:MI') AS local
        FROM task k
        JOIN tag t ON t.name = ${tag} AND k.tag_ids @> ARRAY[t.id]
        JOIN employee e ON e.id = k.owner_id
        LEFT JOIN finished_at f ON f.task_id = k.id AND f.expired_at IS NULL
    `;
    return row?.local;
  }).toBe('2030-03-15T10:00');
  await page.reload();
  await expect(page.getByLabel('Дедлайн')).toHaveValue('2030-03-15T10:00');
});
