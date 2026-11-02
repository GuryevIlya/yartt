// The end-to-end databases: fresh ones per run, next to the one vitest uses.
// TEST_DATABASE_URL is the admin connection (as for `npm test`).

const admin = process.env.TEST_DATABASE_URL;
if (!admin) throw new Error('Set TEST_DATABASE_URL (an admin connection, as for npm test) to run end-to-end tests');

export const ADMIN_URL = admin;
export const E2E_DATABASE = 'yartt_e2e';
export const E2E_PORT = 3100;
export const E2E_URL = `http://localhost:${E2E_PORT}`;
/** The demo itself (DEMO_DATA), for demo.spec.ts. */
export const E2E_DEMO_DATABASE = 'yartt_e2e_demo';
export const E2E_DEMO_PORT = 3101;
// Under a path, as a demo next to a website is: every scenario of the demo checks it.
export const E2E_DEMO_URL = `http://localhost:${E2E_DEMO_PORT}/demo`;

/** The admin URL pointed at an end-to-end database. */
export function databaseUrl(database = E2E_DATABASE): string {
  const url = new URL(admin!);
  url.pathname = `/${database}`;
  return url.toString();
}
