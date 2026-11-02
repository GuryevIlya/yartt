import { expect, test } from '@playwright/test';
import { E2E_DEMO_PORT, E2E_DEMO_URL } from './db.ts';
import { editable } from './helpers.ts';

// The demo itself (DEMO_DATA=en, the second server of playwright.config.ts):
// no sign-in — a person is picked, and switched from the profile menu.
test.use({ baseURL: E2E_DEMO_URL });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('the demo: pick whose eyes to see it through, switch from the menu; kept out of search engines', async ({ page }) => {
  const response = await page.goto(`${E2E_DEMO_URL}/`);
  expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');

  // The sign-in page is the company's people, not an email form (in the browser's language until someone is picked).
  await expect(page.getByRole('heading', { name: /demo|демо/i })).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveCount(0);
  await expect(page.getByText('Michael Reed')).toBeVisible();
  await page.getByText('Emily Carter').click();

  // Signed in as Emily, in her language; the top line says it is a demo.
  await expect(page.getByRole('heading', { name: /^Waiting for me/ })).toBeVisible();
  await expect(page.getByRole('banner').getByText('Demo', { exact: true })).toBeVisible();

  await page.getByRole('banner').getByRole('button', { name: /Emily Carter/ }).click();
  await expect(page.getByText('View as')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Emily Carter' })).toHaveCount(0); // not herself
  await page.getByRole('menuitem', { name: 'Jack Turner' }).click();

  await expect(page.getByRole('heading', { name: /^Waiting for me/ })).toBeVisible();
  await expect(page.getByRole('banner').getByRole('button', { name: /Jack Turner/ })).toBeVisible();
});

test('under a path (PUBLIC_URL): pages, links, cookies, images in a text and the offline shell stay under it', async ({ page, context, request }) => {
  // The container's own address leads to the path. What a proxy that strips the path asks is answered too, and the health check.
  await page.goto(`http://localhost:${E2E_DEMO_PORT}/`);
  await expect(page).toHaveURL(`${E2E_DEMO_URL}/login`);
  expect((await request.get(`http://localhost:${E2E_DEMO_PORT}/api/health`)).ok()).toBe(true);
  expect(await (await request.get(`http://localhost:${E2E_DEMO_PORT}/tasks/1`)).text()).toContain('<base href="/demo/"');
  expect((await request.get(`http://localhost:${E2E_DEMO_PORT}/manifest.webmanifest`)).ok()).toBe(true);

  // The path as people type it, without a slash.
  await page.goto(E2E_DEMO_URL);
  await expect(page).toHaveURL(`${E2E_DEMO_URL}/login`);

  await page.getByText('Emily Carter').click();
  await expect(page.getByRole('heading', { name: /^Waiting for me/ })).toBeVisible();
  expect((await context.cookies()).find((c) => c.name === 'yartt_session')?.path).toBe('/demo');
  const scope = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.scope));
  expect(scope).toBe(`${E2E_DEMO_URL}/`);
  await expect(page.locator('img[src*="/api/avatars/"]').first()).toHaveAttribute('src', /^\/demo\/api\/avatars\//);

  await page.locator('a[href^="/demo/tasks/"]').first().click();
  await expect(page).toHaveURL(/\/demo\/tasks\/\d+$/);

  // The server keeps only /api/attachments/N: had the path been saved, the image would be gone after the reload.
  await page.locator('input[type=file][accept="image/*"]').last().setInputFiles({ name: 'pic.png', mimeType: 'image/png', buffer: PNG });
  await expect(editable(page).locator('img')).toHaveCount(1);
  await editable(page).press('Control+Enter');
  // This task opens on its open mentions; a comment without one is among all events.
  const allEvents = page.getByRole('button', { name: /^All events/ }).first();
  const image = page.locator('img[src^="/demo/api/attachments/"]').filter({ visible: true }).last();
  await allEvents.click();
  await expect(image).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await allEvents.click();
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
});
