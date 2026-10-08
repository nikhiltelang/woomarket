# WooMarket360

WhatsApp, email, SMS, Instagram and Messenger marketing, CRM and shared team inbox (multi-tenant SaaS).
Node.js 20+ · TypeScript · Express · Socket.IO · Drizzle ORM · MySQL 8 · React 18 · Vite · Tailwind.

## Web installer (first start)

Start the app on a fresh copy without a `DATABASE_URL` (`npm run dev`, or `npm run build && npm start`)
and it serves a setup wizard instead of the application:

1. The console prints the address and a one-time **setup code** (`INSTALL_SETUP_CODE` sets your own);
   the wizard asks for it, so only someone with access to the server can install.
2. The wizard checks requirements (Node 20+, writable `.env` and `uploads/`, the client build in
   production), then asks for the **MySQL** connection (tested live; the database is created if missing,
   MySQL 8.0.13+), the **site name and public URL** (optional demo data), the **superadmin** account,
   and optionally the platform **SMTP** server.
3. Installing creates the tables, adds plans, templates and default settings, creates your superadmin,
   and writes `.env` (mode 600, previous file backed up) with generated `SESSION_SECRET`, `JWT_SECRET`,
   `ENCRYPTION_KEY` and `WEBHOOK_VERIFY_TOKEN`. The application then starts in the same process.

The installer only runs while no `DATABASE_URL` is configured, so deployments that set it through the
environment (Docker, PM2) or an existing `.env` start normally. `ENV_FILE` points the app and the
installer at a different configuration file.

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

Or run everything in Docker: `docker compose up -d --build` (add `--profile redis` for the optional Redis service).

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
  services/        WhatsApp provider (Meta Cloud API + simulator), Meta webhook handler (WhatsApp,
                   Messenger, Instagram), messaging (24h window), campaigns, email/SMS workers,
                   outgoing webhooks, AI assistant, reports, chat widget, white-label, Socket.IO hub,
                   queue/ (database polling or Redis/BullMQ, chosen by the superadmin)
  widget/          the embeddable website chat widget (/widget.js)
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

**Email providers:** each tenant (and the platform default) sends through an SMTP server or
**Amazon SES** (SESv2 API: access key, secret, region, optional configuration set). The SES check
shows the sending quota, sandbox vs production access and whether the From address/domain is verified.
Sends follow the account's max send rate. Bounces and complaints arrive via Amazon SNS at
`/webhooks/ses/<config-id>` (signature-verified, subscription auto-confirmed, topic pinned): hard
bounces and complaints go to a per-tenant suppression list that every campaign and API send skips.
Email credentials are always stored encrypted.

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
template, SEO, frontend content, Google & Microsoft sign-in, AI assistant, queue & scaling, two-factor
policy, languages & translations, cron jobs, policy pages,
maintenance mode, GDPR cookie banner, custom CSS, sitemap.xml, robots.txt); Manage coupons (fixed or
percentage, lifetime or dated, usage limits; applied when assigning a plan, redemptions counted
atomically, price/discount/total stored on the subscription); Report & request (tenants and their team
file bug reports and support requests, the superadmin triages and replies, both sides notified in-app);
Extra → Application and Server information, Cache (settings cache, expired sessions, used verification
codes, old webhook keys) and Update; Logs (every API and webhook request with its response: method, URL,
query, headers, payload, status, response headers and body, request/response timestamps and duration;
secrets redacted before storage, bodies capped at 64 KB, buffered batch writes, filters and stats, configurable
retention, body capture and excluded paths, hourly cleanup job).

**Campaign tools:** click tracking with UTM tagging (email links and SMS short links, bot clicks
ignored), delivery at a local time or each contact's best time, quiet hours in the contact's time
zone, A/B tests on all three channels (winner picked automatically by open, click, read or reply rate),
**dynamic segments** (saved rules over contact fields, tags, groups, custom fields and engagement,
re-evaluated at send time) and a **drag-and-drop email builder** (table-based, mobile-friendly HTML
generated on the server from the design, image upload).

**Connecting WhatsApp numbers:** tenants use **Embedded Signup** (Channel settings → Connect number →
"Connect with Facebook"): Meta's popup returns a code that the server exchanges for the business's token,
then it subscribes the app to the WhatsApp Business Account and registers the number with a two-step PIN
(stored encrypted, shown once and on request). **Coexistence** ("Use my WhatsApp Business app number")
keeps the number on the WhatsApp Business app: it isn't registered; instead the contacts and up to six
months of chat history are synced (within 24 hours, retryable), and replies typed in the app arrive as
`smb_message_echoes` and show in the inbox (they also pause the chatbot). Coexistence numbers send at
most 20 messages/second. The superadmin sets the Meta App ID, App secret and Embedded Signup
configuration ID under System settings → WhatsApp Embedded Signup; the saved app secret also verifies
webhook signatures. Without a Meta app, development servers offer a simulated signup. Manual credentials
and the simulator remain available.

**Inbox channels:** WhatsApp, **Facebook Messenger and Instagram Direct** (connect a Page under
WhatsApp marketing → Instagram & Messenger; same Meta webhook as WhatsApp; 24-hour window, optional
Human Agent tag for 7 days; text and image replies) and the **website chat widget** (one `<script>` tag;
live chat into the inbox and/or a "Chat on WhatsApp" button with link and QR code; allowed-websites
list, rate limits, signed visitor tokens).

**Chatbot & auto-replies** (WhatsApp marketing → Chatbot): rules answer incoming messages on WhatsApp,
Messenger, Instagram and website chat. Triggers: keywords, button/list taps, first message (welcome),
outside business hours (away) and a fallback; replies: text, WhatsApp reply buttons (3) or lists (10)
(quick replies on Messenger/Instagram, a numbered list on the website), or an AI answer grounded in the
tenant's own knowledge text that hands off when unsure. Rules can add tags, assign a teammate and hand
off. The bot pauses after a person replies (also in Meta's inbox), per-rule cooldowns and a loop guard
stop runaway replies; agents pause/resume it per chat in the inbox. Test console and activity log included.

**Automation flows** (Marketing → Automation flows): a visual builder for contact journeys. Triggers: a
contact is added (by source), a tag is added, a group is joined, a WhatsApp message (optional keywords),
a date such as a birthday (yearly, with day offsets, at a local time) or manual/group/segment enrolment.
Steps: WhatsApp template or 24-hour-window text, email (visual builder), SMS, waits (delay, time of day,
weekdays only), if/else branches on contact rules or on what the contact did with an earlier message
(delivered, read, replied, opened, clicked, failed), tags, groups, custom fields, team notifications,
webhooks and exit. Sends go through a hidden campaign per step, so the normal workers deliver them with
rate limits, retries, click/open tracking and unsubscribe handling. Per-step statistics, a per-contact
run log and re-entry rules are included; runs are processed by the queue workers (database or Redis mode).

**AI assistant** (Anthropic Claude, key set by the superadmin, per access level, monthly request limit):
drafts SMS, WhatsApp template and email copy (email drafts become builder blocks), suggests inbox
replies, and summarises conversations with sentiment, intent and urgency. Nothing is sent automatically;
customer text is treated as untrusted data. Without a key, development servers use a simulator.

**Reports:** channel overview, team performance and inbox response times (first response and every
reply: median, average, 90th percentile, time bands) for any date range in the tenant's time zone;
PDF (Noto Sans: Latin, Greek, Cyrillic, Devanagari, ₹) and CSV exports; scheduled daily/weekly/monthly
reports emailed with attachments.

**Security & sign-in:** Google and Microsoft single sign-on (accounts matched by provider id; emails
only trusted when the provider verifies them), two-factor authentication with authenticator apps and
recovery codes (the superadmin can require it for the superadmin or all admins, and reset it).

**Integrations:** outgoing **webhooks** for 14 events (messages, contacts, campaigns, email and SMS
engagement), HMAC-signed, retried for about a day, private addresses blocked; Zapier and Make via catch
hooks or REST-hook subscriptions on `/api/v1/webhooks`.

**White-label:** on access levels with white-label enabled, agencies set their own name, logo, colours
and sign-in text and connect custom domains (verified by a DNS TXT record). On those domains sign-in and
sign-up are branded, only the agency and its clients can sign in, new sign-ups become its clients, and
system emails go out in the agency's name.

In development, email and SMS fall back to simulators when nothing is configured: emails are captured
(see `GET /api/email-marketing/simulated-outbox`) and SMS receipts are played back; numbers ending in
`0000` fail on purpose. Set `EMAIL_SIMULATE=false` to require real SMTP.

## Configuration reference (additions)

Everything in `.env.example` is optional except `DATABASE_URL` and the secrets the installer generates.

| Variable | Purpose |
|---|---|
| `APP_URL` | Public base URL. Used in emails, tracking links, OAuth callbacks, widget code and as the CNAME target for agency domains. Set it in production. |
| `REDIS_URL` | Default Redis connection for Redis/BullMQ mode (the superadmin setting takes precedence). |
| `MESSAGE_RATE_PER_SECOND` | Redis mode: WhatsApp sends per second per number across all servers (default 40). |
| `NODE_APP_INSTANCE` | Server number in a cluster. Without Redis only instance `0` runs workers and cron jobs. |
| `ANTHROPIC_API_KEY` | AI assistant key if not saved in the superadmin settings. |
| `WHATSAPP_GRAPH_URL` / `WHATSAPP_API_VERSION` | Meta Graph API base (also used for Messenger and Instagram). |
| `WEBHOOK_ALLOW_PRIVATE_URLS` | Development only: let outgoing webhooks reach localhost and private networks. |
| `DEV_ALLOWED_HOSTS` | Development only: extra host names the Vite dev server accepts (testing agency domains). |

## Running several servers

1. Run Redis (`docker compose --profile redis up -d`, or a managed Redis; `rediss://` for TLS).
2. In *Superadmin → System settings → Queue & scaling*, turn on Redis mode and enter the URL
   (*Test connection* first). Servers switch within 15 seconds, no restart.
3. Start more app servers behind your load balancer, each with a different `NODE_APP_INSTANCE`.

In Redis mode every server sends; rows are claimed atomically in MySQL (the source of truth), cron
jobs run once per interval across the cluster, WhatsApp sends share a per-number rate limit and live
inbox events reach users on any server. If Redis becomes unreachable for 30 seconds, servers fall back
to database polling (instance 0 works) and return to Redis mode when it's back. The status card shows
the servers, queues and Redis memory.

## Agency domains (white-label) in production

Agencies point a CNAME at your `APP_URL` host and prove ownership with a TXT record. Serve their
domains through a reverse proxy that issues certificates on demand and asks the app first, e.g. Caddy:

```
{
  on_demand_tls {
    ask http://127.0.0.1:3000/api/white-label/tls-check
  }
}
https:// {
  tls { on_demand }
  reverse_proxy 127.0.0.1:3000
}
```

`/api/white-label/tls-check?domain=…` answers 200 only for verified, enabled agency domains.

## Not yet implemented

From the technical documentation: WhatsApp chatbot and auto-replies, automation flows, Embedded Signup
(and Coexistence), payment gateways and self-serve checkout, KYC, and a unified contact timeline.
The schema already reserves their tables (Appendix A of the documentation); `drizzle.config.ts`
only manages the tables defined in `shared/schema.ts`, so those are never dropped.
