import { describe, expect, test } from 'vitest';
import { helpEn } from '../shared/i18n/help/en.ts';
import { helpRu } from '../shared/i18n/help/ru.ts';
import { NotificationPayload } from '../shared/notification.ts';
import { ROUTES } from '../server/publicApi.ts';

// The guide's description of the API is written by hand for each language:
// here it is held to the routes and the events themselves.
describe.each([['ru', helpRu], ['en', helpEn]] as const)('the guide in %s', (_lang, help) => {
  test('lists every route of the public API with its right, and nothing else', () => {
    const inGuide = help.api.methods.groups.flatMap((g) => g.routes).map((r) => `${r.method} ${r.path} ${r.right}`).sort();
    const inApi = ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path} ${r.right}`).sort();
    expect(inGuide).toEqual(inApi);
  });

  test('lists every event a webhook can get', () => {
    const kinds = NotificationPayload.options.map((o) => o.shape.kind.value).sort();
    expect(Object.keys(help.api.webhooks.events.rows).sort()).toEqual(kinds);
  });
});
