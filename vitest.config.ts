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
      WEBHOOK_URL: '',
      // Bots' webhooks in the tests listen on this machine.
      BOT_WEBHOOK_INTERNAL_HOSTS: 'localhost',
    },
  },
});
