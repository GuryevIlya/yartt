import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup.ts'],
    // All files share one test database.
    fileParallelism: false,
    env: {
      PUBLIC_URL: 'http://yartt.test',
      COOKIE_SECURE: 'false',
      // Bots' webhooks in the tests listen on this machine.
      WEBHOOK_ALLOWED_URLS: 'http://localhost/',
    },
  },
});
