# WooMarket360

WhatsApp marketing, CRM and team-inbox platform (multi-tenant SaaS).
Node.js 20+ · TypeScript · Express · Socket.IO · Drizzle ORM · MySQL 8 · React 18 · Vite · Tailwind.

## Quick start (local)

```bash
# 1. MySQL 8.0.13+
mysql -u root -p -e "CREATE DATABASE woomarket360 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  CREATE USER 'woomarket360'@'%' IDENTIFIED BY 'change-this-password';
  GRANT ALL PRIVILEGES ON woomarket360.* TO 'woomarket360'@'%';"

# 2. App
npm ci
cp .env.example .env          # set DATABASE_URL (URL-encode special characters in the password)
npm run dev                   # http://localhost:3000
```

On first start against an empty database the server applies `migrations/` and seeds:

| Account | Password | Role |
|---|---|---|
| `superadmin` | `Superadmin@123` (dev) / `SEED_SUPERADMIN_PASSWORD` or a printed random one (prod) | Platform owner |
| `demo` | `Demo@1234` | Tenant admin (development only) |
| `agent` | `Agent@1234` | Team member of `demo` (development only) |

The demo tenant has a **simulator** WhatsApp number, contacts, a group and an approved template, so the
inbox and campaigns work end-to-end without Meta credentials. Use *WhatsApp numbers → Simulate incoming*
to push a customer message into the inbox; recipients whose number ends in `0000` fail on purpose.

Or run everything in Docker: `docker compose up -d --build`.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | API + Vite dev server with HMR |
| `npm run build` / `npm start` | Production build (`dist/`) and run |
| `npm run check` | TypeScript type check |
| `npm test` | Vitest + Supertest suites |
| `npm run db:generate` | Generate a migration from `shared/schema.ts` |
| `npm run db:migrate` | Apply `migrations/` |
| `npm run db:push` | Sync schema directly (used by the in-app updater) |
| `npm run seed` | Insert plans, superadmin and (dev) demo data; never changes existing accounts |
| `npm run version:set -- X.Y.Z` / `npm run build:prod-zip` | Cut a release ZIP for the in-app updater |

## Architecture

```
shared/            schema (Drizzle, MySQL), roles & permissions, zod validators, API types
server/
  routes/          URL + middleware chain per module
  controllers/     request handling
  services/        WhatsApp provider (Meta Cloud API + simulator), webhook handler,
                   messaging (24h window), campaigns, DB-polling message queue, Socket.IO hub
  repositories/    all database access
  middlewares/     auth (session + JWT), RBAC, tenant scoping, CSRF, plan limits, rate limits
  app-update/      in-app updater (see app-update-testing.md)
client/src/        React SPA: pages, contexts (auth, channel, socket), UI kit
```

Request pipeline: security headers → JSON parser (raw body kept for webhook signatures) → session →
authenticate (session or bearer, user re-loaded per request) → rate limit → CSRF → route guards
(`requireAuth` → `requireRole` / `requirePermission` → `requireChannelAccess` → `requireSubscription`).
Other tenants' resources return 404.

## Implemented scope

Auth (signup, login, logout, profile, password), users (superadmin), team & permissions, activity log,
channels (Cloud API + simulator, health), contacts (CRUD, CSV import/export, bulk), groups, templates
(submit to Meta, sync, approval webhooks), inbox (real-time, assignment, pins, status, 24-hour window,
template sends), campaigns (audience, personalisation, scheduling, pause/resume/cancel, retries,
delivery/read/reply tracking), **email marketing** (SMTP per tenant with platform/env fallback,
templates, personalisation, scheduling, open tracking, RFC 8058 one-click unsubscribe, test sends,
pause/resume/cancel), **SMS marketing** (Twilio, Vonage or simulator; GSM-7/UCS-2 segment and
credit calculation, signed delivery-receipt webhooks), plans & subscription limits, dashboards, in-app updater.

In development, email and SMS fall back to simulators when nothing is configured: emails are captured
(see `GET /api/email-marketing/simulated-outbox`) and SMS receipts are played back; numbers ending in
`0000` fail on purpose. Set `EMAIL_SIMULATE=false` to require real SMTP.

Not yet implemented from the technical documentation: automations / flow builder, AI assistant &
training, chat widget, payment gateways & checkout, notifications centre,
languages / branding / CMS pages, public REST API v1 with API keys, installer, Redis/BullMQ.
The schema already reserves their tables (Appendix A of the documentation); `drizzle.config.ts`
only manages the tables defined in `shared/schema.ts`, so those are never dropped.
