import { z } from 'zod';
import { Locale } from '#shared/employee.ts';
import { DEMO_LANGUAGES } from './demoTexts.ts';

// Node reads .env itself (--env-file-if-exists in package.json scripts);
// in Docker variables come from the environment.
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PUBLIC_URL: z.url(),
  PORT: z.coerce.number().int().positive().default(3000),
  ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  // Email: smtp://user:password@host:587 or smtps://user:password@host:465.
  SMTP_URL: z.url().optional().or(z.literal('').transform(() => undefined)),
  MAIL_FROM: z.string().optional(),
  // Optional extra channel for other messengers.
  WEBHOOK_URL: z.url().optional().or(z.literal('').transform(() => undefined)),
  WEBHOOK_SECRET: z.string().optional(),
  // A bot's own webhook reaches only outside addresses, except these hosts
  // inside the company's network (comma-separated, e.g. ci.corp.local).
  BOT_WEBHOOK_INTERNAL_HOSTS: z.string().optional()
    .transform((value) => (value ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)),
  COOKIE_SECURE: z.stringbool().default(true),
  CLIENT_DIST: z.string().optional(),
  FIRST_EMPLOYEE_EMAIL: z.email().optional(),
  FIRST_EMPLOYEE_NAME: z.string().min(1).optional(),
  FIRST_EMPLOYEE_LOCALE: Locale.default('ru'),
  FIRST_EMPLOYEE_TIME_ZONE: z.string().default('UTC'),
  // The image sets production: a real installation must be able to send its sign-in links.
  NODE_ENV: z.string().optional(),
  // The company's mail domains (comma-separated, e.g. corp.com,corp.kz): no
  // other address is written, and someone with an older one may only change
  // it. Empty — any address.
  EMAIL_DOMAINS: z.string().optional()
    .transform((value) => (value ?? '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean))
    .pipe(z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'a domain such as corp.com').array()),
  // Sign-in through the company's identity provider (OpenID Connect): its
  // issuer URL and this application's client there. Set — the only way in:
  // no sign-in links, no invites. OIDC_NAME is on the button ("Microsoft").
  OIDC_ISSUER: z.url().optional().or(z.literal('').transform(() => undefined)),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_NAME: z.string().min(1).default('SSO'),
  // Files (decision 84): at most FILE_MAX_MB each; a person's files with
  // content at most FILE_QUOTA_MB together. The demo keeps 2 MB a file.
  FILE_MAX_MB: z.coerce.number().positive().default(50),
  FILE_QUOTA_MB: z.coerce.number().positive().default(1024),
  // Files in an S3-compatible object storage instead of PostgreSQL: the
  // bucket, the storage's address and a key for it. Set later, the worker
  // moves the files already in PostgreSQL there.
  S3_BUCKET: z.string().optional().or(z.literal('').transform(() => undefined)),
  S3_ENDPOINT: z.url().default('https://s3.amazonaws.com'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  // A trial: the demo company in this language on the first start (an empty
  // database), and no sign-in — anyone picks whom to see it as. Unset for work.
  DEMO_DATA: z.enum(DEMO_LANGUAGES).optional().or(z.literal('').transform(() => undefined)),
});

const result = EnvSchema.safeParse(process.env);
if (!result.success) {
  console.error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  process.exit(1);
}
if (result.data.SMTP_URL && !result.data.MAIL_FROM) {
  console.error('Invalid configuration: MAIL_FROM is required with SMTP_URL');
  process.exit(1);
}
if (result.data.NODE_ENV === 'production' && !result.data.DEMO_DATA && !result.data.SMTP_URL) {
  console.error('Invalid configuration: SMTP_URL is required in production — sign-in links go by email (DEMO_DATA=ru|en for a trial without it)');
  process.exit(1);
}
const firstDomain = result.data.FIRST_EMPLOYEE_EMAIL?.split('@').pop()?.toLowerCase();
if (result.data.EMAIL_DOMAINS.length && firstDomain && !result.data.EMAIL_DOMAINS.includes(firstDomain)) {
  console.error(`Invalid configuration: FIRST_EMPLOYEE_EMAIL is outside EMAIL_DOMAINS (${result.data.EMAIL_DOMAINS.join(', ')})`);
  process.exit(1);
}
if (result.data.OIDC_ISSUER && (!result.data.OIDC_CLIENT_ID || !result.data.OIDC_CLIENT_SECRET)) {
  console.error('Invalid configuration: OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are required with OIDC_ISSUER');
  process.exit(1);
}
if (result.data.OIDC_ISSUER && result.data.DEMO_DATA) {
  console.error('Invalid configuration: the demo has no sign-in — unset OIDC_ISSUER or DEMO_DATA');
  process.exit(1);
}
if (result.data.S3_BUCKET && (!result.data.S3_ACCESS_KEY_ID || !result.data.S3_SECRET_ACCESS_KEY)) {
  console.error('Invalid configuration: S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required with S3_BUCKET');
  process.exit(1);
}
if (result.data.WEBHOOK_URL && !result.data.WEBHOOK_SECRET) {
  console.error('Invalid configuration: WEBHOOK_SECRET is required with WEBHOOK_URL');
  process.exit(1);
}

export default result.data;
