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

**Landing page:** a public marketing page at `/` for signed-out visitors, managed by the superadmin
(Landing page in the sidebar): on/off switch, top menu and footer, and sections that can be shown,
hidden, reordered, added and deleted — hero (with image upload), stats, features, a WhatsApp/email/SMS
channel showcase, how-it-works steps, pricing (from Plans), testimonials, FAQ, call to action and
free-form Markdown — with a live preview of unsaved changes. When off, `/` goes to sign-in; `/home`
always shows the page. Links are restricted to https, site paths, anchors and mailto.

**Custom contact fields:** any number of extra fields per contact (age, address, …) stored in
`contacts.metadata` (JSON, keys normalised to snake_case). Set them in the contact form or import them —
every CSV column besides name/phone/email/tags becomes a field, optionally merged into existing contacts.
Export writes them back as columns. Use them as `{{field}}` merge tags in email and SMS, and as WhatsApp
template variable sources.

**Public API:** `POST /api/v1/send` sends email, SMS or WhatsApp (approved template) to up to 1,000
listed recipients and/or whole contact groups (`groups`: ids or names, up to 20 groups, 50,000 people)
per call; each call becomes a campaign visible in the app. Authenticate with an Access Key ID
and Secret Access Key (Account → API keys), either as HTTP Basic or as an HMAC-SHA256 signed request
(`X-WM-Access-Key-Id`, `X-WM-Timestamp`, `X-WM-Signature`; 5-minute window, replay-protected).
Supports `Idempotency-Key`, `scheduleAt`, per-key channel limits, the access level's API flag, plan
limits and message quotas, and skips unsubscribed recipients. The in-app guide has curl, Node.js,
Python and PHP examples.

**Equal channels:** WhatsApp, email and SMS are peers in the tenant UI — one sidebar group with the
same sections each (campaigns, templates, settings), a shared channel page header with the same four
metrics, and a tenant-wide dashboard (`GET /api/dashboard/overview`) comparing the three side by side.

**Superadmin panel:** dashboard (user segments, messaging/marketing totals, daily messages and sign-ups
reports, sign-ins by browser/OS, server health); Manage users (active, banned, email/mobile unverified,
with subscription, all; ban with reason, verification toggles, plan and level assignment); Send
notification (in-app bell in real time and/or email); Manage levels (per-tenant caps on numbers,
contacts, campaigns and monthly messages plus feature switches, enforced on top of plans); System
settings (general, logo & favicon, system configuration switches, notification/SMTP & global email
template, SEO, frontend content, Google sign-in, languages & translations, cron jobs, policy pages,
maintenance mode, GDPR cookie banner, custom CSS, sitemap.xml, robots.txt); Manage coupons (fixed or
percentage, lifetime or dated, usage limits; applied when assigning a plan, redemptions counted
atomically, price/discount/total stored on the subscription); Report & request (tenants and their team
file bug reports and support requests, the superadmin triages and replies, both sides notified in-app);
Extra → Application and Server information, Cache (settings cache, expired sessions, used verification
codes, old webhook keys) and Update; Logs (every API and webhook request with its response: method, URL,
query, headers, payload, status, response headers and body, request/response timestamps and duration;
secrets redacted before storage, bodies capped at 64 KB, buffered batch writes, filters and stats, configurable
retention, body capture and excluded paths, hourly cleanup job).

In development, email and SMS fall back to simulators when nothing is configured: emails are captured
(see `GET /api/email-marketing/simulated-outbox`) and SMS receipts are played back; numbers ending in
`0000` fail on purpose. Set `EMAIL_SIMULATE=false` to require real SMTP.

Not yet implemented from the technical documentation: automations / flow builder, AI assistant &
training, chat widget, payment gateways & checkout, KYC, public REST API v1 with API keys,
installer, Redis/BullMQ.
The schema already reserves their tables (Appendix A of the documentation); `drizzle.config.ts`
only manages the tables defined in `shared/schema.ts`, so those are never dropped.
