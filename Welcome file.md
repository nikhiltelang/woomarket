# WooMarket360 — Technical Documentation

> **WhatsApp marketing, CRM and customer-engagement platform (multi-tenant SaaS)**
> Stack: **Node.js** (Express, TypeScript) · **React** · **MySQL 8** · Redis (optional) · Socket.IO

| | |
|---|---|
| Version | 3.8.0 |
| Document generated | 2026-10-06 |
| API endpoints documented | 399 |
| Database tables documented | 69 |

> **Database note.** This document specifies the data layer for **MySQL 8.0.13+**. The tables in
> [Database design](#11-database-design-mysql) and the script in [Appendix A](#appendix-a--mysql-schema-script)
> are the MySQL definitions of the application's data model. The current source code connects through
> Drizzle ORM's PostgreSQL driver; [Appendix B](#appendix-b--running-the-codebase-on-mysql) lists exactly
> what changes in the code to run it on MySQL.

---

## Table of contents

1. [Introduction](#1-introduction)
2. [Technology stack](#2-technology-stack)
3. [System architecture](#3-system-architecture)
4. [Project structure](#4-project-structure)
5. [Installation and setup](#5-installation-and-setup)
6. [Configuration (environment variables)](#6-configuration-environment-variables)
7. [Backend architecture and workflow](#7-backend-architecture-and-workflow)
8. [Frontend architecture and workflow](#8-frontend-architecture-and-workflow)
9. [Frontend ↔ backend communication](#9-frontend--backend-communication)
10. [API reference](#10-api-reference)
11. [Database design (MySQL)](#11-database-design-mysql)
12. [Security](#12-security)
13. [Testing](#13-testing)
14. [Deployment](#14-deployment)
15. [Troubleshooting](#15-troubleshooting)
- [Appendix A — MySQL schema script](#appendix-a--mysql-schema-script)
- [Appendix B — Running the codebase on MySQL](#appendix-b--running-the-codebase-on-mysql)
- [Appendix C — Credits](#appendix-c--credits)

---

## 1. Introduction

WooMarket360 lets businesses run their customer communication on the **WhatsApp Business Cloud API**
from one web application: a shared team inbox, contact management, approved message templates, bulk
campaigns, visual automation flows, AI auto-replies, a website chat widget, and email/SMS marketing.

It is a **multi-tenant SaaS**: one installation serves many businesses. A platform owner (superadmin)
sells subscription plans; each business (tenant) connects its own WhatsApp numbers and manages its own
data, isolated from other tenants.

### 1.1 User roles

| Role | Who | Can do |
|---|---|---|
| `superadmin` | Platform owner | Everything: platform settings, plans, payment gateways, all users and channels, system configuration, updates |
| `admin` | A business (tenant) owner | Their own channels, contacts, inbox, campaigns, templates, automations, AI settings, team, billing |
| `team` | Staff invited by an admin | Works inside the admin's tenant, limited by permissions the admin grants (e.g. `contacts:view`, `inbox:send`) |

Fine-grained permissions are strings such as `contacts:create` or `campaigns:delete`
(defined in `shared/schema.ts` → `PERMISSIONS`).

### 1.2 Main features

| Area | Features |
|---|---|
| WhatsApp channels | Embedded Signup (Facebook login) or manual connection, health/quality monitoring, business profile and display-name management, messaging-tier limits |
| Team inbox | Real-time conversations, assignment and transfer, pins, typing indicators, read receipts, media messages |
| Contacts | Create/import/export, groups, tags, opt-in status |
| Templates | Create, submit to Meta, sync approval status, media headers, buttons, variables |
| Campaigns | Bulk template sends to contacts, groups or CSV; scheduling; pause/resume; retries; delivery statistics |
| Automations | Visual flow builder (React Flow): triggers, messages, delays, questions, conditions, assignment, webhooks |
| AI assistant | OpenAI-compatible providers (OpenAI, Gemini, custom), trigger words, knowledge-base training (documents, Q&A pairs), human escalation |
| Chat widget | Embeddable website widget with lead capture, AI answers and live agent hand-off |
| Email & SMS marketing | SMTP email campaigns with templates; SMS campaigns over configurable gateways |
| Billing | Plans with feature limits; Stripe, Razorpay, PayPal, Paystack, Mercado Pago |
| Platform admin | Branding, languages (8), SEO, policy pages, blog, notification templates, cron monitor, in-app updater, support tickets |
| Public REST API | `/api/v1/*` for external systems, authenticated with API keys |

---

## 2. Technology stack

| Layer | Technology | Purpose |
|---|---|---|
| Runtime | **Node.js** 20+ (ESM, TypeScript) | Server runtime |
| Web framework | **Express 4** | HTTP API, middleware pipeline, static files |
| Real-time | **Socket.IO 4** (+ Redis adapter) | Live inbox, typing, notifications |
| Database | **MySQL 8.0.13+** (InnoDB, utf8mb4) | All persistent data |
| ORM / query builder | **Drizzle ORM** + drizzle-kit | Typed schema, queries, migrations |
| Validation | **Zod** (+ drizzle-zod) | Request and form validation |
| Cache / queue | **Redis** (optional), **BullMQ** | Message queue, cache, multi-instance sockets |
| Auth | express-session, bcrypt, JSON Web Tokens | Sessions, password hashing, bearer tokens |
| Frontend | **React 18**, Vite, TypeScript | Single-page application |
| UI | Tailwind CSS, shadcn/ui (Radix UI), lucide icons | Components and styling |
| Data fetching | TanStack Query | Server state, caching, refetching |
| Routing | wouter | Client-side routes |
| Flow builders | @xyflow/react (React Flow) | Automation and chatbot editors |
| Charts | Recharts, Chart.js | Dashboards and analytics |
| Email | Nodemailer | SMTP delivery |
| Payments | Stripe, Razorpay, PayPal, Paystack, Mercado Pago SDKs | Subscriptions and checkout |
| Files | Multer, S3-compatible storage (AWS S3 / DigitalOcean Spaces), Google Cloud Storage | Uploads and media |
| Testing | Vitest, Supertest | Unit and HTTP tests |
| Deployment | Docker / Docker Compose, PM2, nginx | Production hosting |

---

## 3. System architecture

### 3.1 High-level view

```mermaid
flowchart LR
  subgraph Clients
    B[Browser - React SPA]
    W[Website chat widget<br/>iframe /widget-chat]
    X[External systems<br/>REST API v1]
  end
  subgraph Server["Node.js server (Express + Socket.IO)"]
    MW[Middleware pipeline<br/>session, auth, CSRF, rate limit]
    R[Routes] --> C[Controllers] --> S[Services] --> D[Storage / Repositories<br/>Drizzle ORM]
    MW --> R
    Q[Message queue worker]
    J[Cron jobs]
    IO[Socket.IO hub]
  end
  B -- HTTPS REST --> MW
  B <-- WebSocket --> IO
  W -- HTTPS + WebSocket --> MW
  X -- HTTPS + API key --> MW
  D --> DB[(MySQL 8)]
  Q --> DB
  J --> DB
  S --> RD[(Redis<br/>optional)]
  Q --> RD
  IO --> RD
  S --> META[Meta WhatsApp<br/>Cloud API]
  META -- webhooks --> MW
  S --> AI[OpenAI / Gemini]
  S --> MAIL[SMTP]
  S --> SMS[SMS gateways]
  S --> STORE[S3 / Spaces / GCS]
  PAY[Payment gateways] -- webhooks --> MW
  S --> PAY
```

### 3.2 Architectural style

- **Layered monolith.** One Node.js process serves the REST API, the WebSocket hub, background workers
  and (in production) the built React app. Layers: **Routes → Controllers → Services → Storage/Repositories → Database**.
- **Shared types.** `shared/schema.ts` defines every table once; the server uses it for queries and the
  client imports the generated TypeScript types and Zod schemas, so both sides agree on data shapes.
- **Multi-tenancy by ownership.** Every tenant resource hangs off a `channel` (a WhatsApp number) or a
  user. Channels belong to the admin who created them (`channels.created_by`); team members act for their
  admin (`users.created_by`). Middleware checks ownership on every channel-scoped request.
- **Horizontal scaling.** With Redis configured, several instances can run behind a load balancer: Socket.IO
  events are shared through the Redis adapter, the queue runs on BullMQ, and only instance `0` runs cron jobs.

---

## 4. Project structure

```
WooMarket360/
├── client/                    React single-page application
│   ├── index.html
│   └── src/
│       ├── App.tsx            Routes, guards, layout selection
│       ├── main.tsx           Entry point (React root, providers)
│       ├── pages/             85 page components (dashboard, inbox, contacts, campaigns, ...)
│       ├── components/        174 reusable components (ui/, layout/, settings/, automation-flow-builder/, ...)
│       ├── contexts/          auth, channel, socket, unread-count, sidebar, site
│       ├── hooks/             reusable React hooks
│       └── lib/               API client (queryClient.ts), i18n + translations, utilities
├── server/                    Express backend
│   ├── index.ts               Bootstrap: middleware, Socket.IO, startup jobs, graceful shutdown
│   ├── db.ts                  Database connection, first-run migrations and seed
│   ├── routes/                38 route modules (one per feature)
│   ├── controllers/           Request handlers
│   ├── services/              Business logic (WhatsApp API, queue, automation engine, AI, email, ...)
│   ├── repositories/          Data-access classes
│   ├── storage.ts / database-storage.ts   Storage facade used across the app
│   ├── middlewares/           auth, roles/permissions, tenant scoping, CSRF, rate limit, uploads, validation
│   ├── cron/                  Scheduled jobs
│   ├── utils/                 Helpers (tokens, permissions, polyfills)
│   ├── seed.ts                Initial data (superadmin, languages, plans, templates)
│   └── __tests__/             Vitest test suites
├── shared/                    Code shared by client and server
│   ├── schema.ts              All tables, Zod insert schemas, TypeScript types, PERMISSIONS
│   ├── roles.ts, payment-currencies.ts, whatsapp-error-codes.ts, update-log.ts
├── packages/diploy-core/      Internal package: branding constants, logger, error and response helpers
├── migrations/                Database migrations (drizzle-kit)
├── public/                    Static assets, chat widget (widget/widget.js), documentation pages
├── Dockerfile, docker-compose.yml, docker-compose.standalone.yml
├── ecosystem.config.cjs       PM2 process configuration
├── nginx.conf.example         Reverse-proxy example
├── drizzle.config.ts, vite.config.ts, vitest.config.ts, tsconfig.json
└── package.json
```

---

## 5. Installation and setup

### 5.1 Requirements

| Software | Version | Notes |
|---|---|---|
| Node.js | 20 or newer | npm 10+ |
| MySQL | 8.0.13 or newer | Expression defaults (`DEFAULT (UUID())`, JSON defaults) need 8.0.13+ |
| Redis | 7 (optional) | Enables BullMQ queue, shared cache, multi-instance Socket.IO |
| Meta developer app | — | WhatsApp Business Cloud API access |

### 5.2 Database

```sql
CREATE DATABASE woomarket360 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'woomarket360'@'%' IDENTIFIED BY 'change-this-password';
GRANT ALL PRIVILEGES ON woomarket360.* TO 'woomarket360'@'%';
FLUSH PRIVILEGES;
```

Create the tables with the migrations (`npm run db:push`) or by running the script in
[Appendix A](#appendix-a--mysql-schema-script):

```bash
mysql -u woomarket360 -p woomarket360 < schema.sql
```

### 5.3 Application

```bash
git clone <repository-url> woomarket360 && cd woomarket360
npm ci                       # install exact dependency versions from package-lock.json
cp .env.example .env         # then edit .env (see section 6)
npm run db:push              # create / update tables
npm run seed                 # superadmin account, languages, plans, templates
npm run dev                  # development server with hot reload on http://localhost:3000
```

Production:

```bash
npm run build                # client -> dist/public, server -> dist/index.js
npm start                    # NODE_ENV=production node dist/index.js
```

On first start against an empty database the server also applies the migrations and runs the seed
automatically. A web installer at `/install` can collect the database, superadmin and URL settings
instead; it locks itself after a successful install.

### 5.4 npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start the server with Vite middleware (hot reload) |
| `npm run build` | Build client (Vite) and bundle server (esbuild) into `dist/` |
| `npm start` | Run the production build |
| `npm run check` | TypeScript type check |
| `npm test` | Run the Vitest suites |
| `npm run db:generate` | Generate a migration from `shared/schema.ts` |
| `npm run db:push` | Apply the schema to the database |
| `npm run seed` | Insert initial data (never changes existing accounts) |
| `npm run db:studio` | Open Drizzle Studio (database browser) |
| `npm run build:prod-zip` | Build a release ZIP for the in-app updater |

### 5.5 First login

| Setup method | Superadmin login |
|---|---|
| Web installer | The username and password entered in the installer |
| `npm run seed` with `NODE_ENV=production` | `superadmin` + the value of `SEED_SUPERADMIN_PASSWORD`, or a random password printed once |
| Local development | `superadmin` / `Superadmin@123` (plus demo accounts, development only) |

---

## 6. Configuration (environment variables)

All configuration comes from environment variables, normally a `.env` file in the project root.
Many settings (SMTP, payment keys, branding, AI keys) can also be managed from the superadmin panel and
are stored in the database.

| Variable | Group | Description | Required |
|---|---|---|---|
| `NODE_ENV` | Core | `production` or `development` | Yes |
| `APP_INSTALLED` | Core | `true` once installation is complete (locks the installer) | No |
| `APP_URL` | Core | Public base URL (emails, webhooks, links) | Yes |
| `SHUTDOWN_TIMEOUT_MS` | Core | Max wait for graceful shutdown (default 8000) | No |
| `SERVER_HOST` | Core | Public host override used to build absolute URLs | No |
| `PORT` | Core | HTTP port (default 3000) | No |
| `NODE_APP_INSTANCE` | Core | Set by PM2 cluster; instance 0 runs cron jobs | No |
| `HOST` | Core | Bind address (default 0.0.0.0) | No |
| `APP_NAME` | Core | Application display name | No |
| `DATABASE_URL` | Database | MySQL connection string, e.g. `mysql://user:pass@localhost:3306/woomarket360` | Yes |
| `DATABASE_READ_URL` | Database | Optional read-replica connection string | No |
| `HOST_GATEWAY` | Database | Hostname used for the Docker host (default host.docker.internal) | No |
| `DOCKER_CONTAINER` | Database | `true` forces Docker mode (localhost → host.docker.internal) | No |
| `DB_POOL_MAX` | Database | Max pooled connections (default 25) | No |
| `DB_CONNECT_RETRIES` | Database | Startup connection attempts in production before exiting (default 10) | No |
| `ALLOW_EMBEDDED_DB_FALLBACK` | Database | Development-only embedded database fallback switch (not used with MySQL) | No |
| `SESSION_SECRET` | Security | Session signing secret, 32+ random characters (`openssl rand -hex 32`) | Yes |
| `SEED_SUPERADMIN_PASSWORD` | Security | Superadmin password used by the seed (random if unset in production) | No |
| `JWT_SECRET` | Security | Signing secret for bearer tokens (falls back to SESSION_SECRET) | No |
| `FORCE_HTTPS` | Security | `false` disables Secure CSRF cookies even over HTTPS | No |
| `SMTP_HOST` | Email | SMTP server (used when no SMTP settings are saved in the admin panel) | No |
| `SMTP_PORT` | Email | SMTP port (587 / 465) | No |
| `SMTP_USER` | Email | SMTP username | No |
| `SMTP_PASS` | Email | SMTP password | No |
| `SMTP_FROM_EMAIL` | Email | Sender address (`SMTP_FROM` also accepted) | No |
| `SMTP_FROM_NAME` | Email | Sender name | No |
| `SMTP_SECURE` | Email | `true` for SSL on port 465 | No |
| `REDIS_URL` | Redis & queue | Redis connection; enables BullMQ, shared cache, multi-instance Socket.IO | No |
| `MESSAGE_QUEUE_MAX_ATTEMPTS` | Redis & queue | Retries before a message is marked failed | No |
| `MESSAGE_QUEUE_INTERVAL_MS` | Redis & queue | Database-polling interval for the queue (default 5000) | No |
| `MESSAGE_QUEUE_BATCH_SIZE` | Redis & queue | Messages per polling batch | No |
| `MESSAGE_SEND_DELAY_MS` | Redis & queue | Delay between sends | No |
| `MESSAGE_QUEUE_CONCURRENCY` | Redis & queue | Parallel sends per batch | No |
| `CAMPAIGN_PAUSED_TOO_LONG_DAYS` | Redis & queue | Days after which a paused campaign is closed | No |
| `BULLMQ_RATE_MAX` | Redis & queue | BullMQ rate limit: jobs per window | No |
| `BULLMQ_RATE_DURATION` | Redis & queue | BullMQ rate limit window (ms) | No |
| `BULLMQ_CONCURRENCY` | Redis & queue | BullMQ worker concurrency | No |
| `AUTOMATION_MAX_HOPS` | Redis & queue | Max nodes per automation run (loop protection) | No |
| `API_RATE_LIMIT` | Rate limits | Requests per minute (all clients) | No |
| `API_RATE_LIMIT_AUTHED` | Rate limits | Requests per minute for logged-in users | No |
| `WIDGET_CONFIG_RATE_LIMIT` | Rate limits | Widget config requests per minute per IP/site (default 60) | No |
| `WIDGET_CHAT_RATE_LIMIT` | Rate limits | Widget chat requests per minute (default 30) | No |
| `API_RATE_LIMIT_UNAUTHED` | Rate limits | Requests per minute for anonymous clients | No |
| `WHATSAPP_API_VERSION` | WhatsApp | Meta Graph API version (default v25.0) | No |
| `FACEBOOK_APP_ID` | WhatsApp | Meta app ID for Embedded Signup | No |
| `WHATSAPP_MESSAGING_TIER` | WhatsApp | Default messaging tier when Meta does not report one | No |
| `WEBHOOK_VERIFY_TOKEN` | WhatsApp | Verify token for the Meta webhook | No |
| `DO_SPACES_BUCKET` | Integrations | DigitalOcean Spaces bucket for uploads | No |
| `RAZORPAY_KEY_SECRET` | Integrations | Razorpay secret (fallback; normally set in the admin panel) | No |
| `DO_SPACES_REGION` | Integrations | DigitalOcean Spaces region | No |
| `GEMINI_API_KEY` | Integrations | Google Gemini API key (AI features) | No |
| `APP_UPDATE_ROOT` | Advanced | Root folder used by the in-app updater | No |

Example `.env`:

```bash
NODE_ENV=production
PORT=3000
APP_URL=https://app.example.com
DATABASE_URL="mysql://woomarket360:change-this-password@localhost:3306/woomarket360"
SESSION_SECRET="<openssl rand -hex 32>"
REDIS_URL=redis://localhost:6379
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=postmaster@example.com
SMTP_PASS=change-me
SMTP_FROM_EMAIL=noreply@example.com
```

---

## 7. Backend architecture and workflow

### 7.1 Startup sequence (`server/index.ts`)

1. Load polyfills and `.env`; register process-level error handlers (an uncaught exception logs and exits so PM2/Docker restart the app).
2. Create the Express app, HTTP server and Socket.IO server (attach the Redis adapter when `REDIS_URL` is set).
3. Refuse to start in production without a real `SESSION_SECRET`.
4. Connect to the database (retry, then exit in production if unreachable); on an empty database apply migrations and run the seed.
5. Register the middleware pipeline and all route modules.
6. In development attach the Vite dev server; in production serve the built SPA from `dist/public`.
7. Listen on `HOST:PORT`.
8. On the cron leader (instance `0`): recover stuck campaigns, re-subscribe channels to Meta webhooks, start the message-queue worker, the scheduled-campaign cron, the status updater, the channel health monitor and the payment reconciler.
9. On `SIGTERM`/`SIGINT`: stop the queue, close sockets and HTTP connections, close the database pool, exit.

### 7.2 Request pipeline

```mermaid
flowchart TD
  A[Incoming HTTP request] --> B[trust proxy + security headers]
  B --> C{Payment webhook?}
  C -- yes --> C1[raw body parser - signature check]
  C -- no --> C2[JSON / form parser]
  C1 --> D
  C2 --> D[Static files: /uploads, public, /documentation]
  D --> E[Session middleware - cookie]
  E --> F[Bearer / x-auth-token authentication]
  F --> G[Rate limiter]
  G --> H[CSRF check on POST/PUT/PATCH/DELETE]
  H --> I[Route: requireAuth -> requireRole / requirePermission -> requireChannelAccess -> requireSubscription]
  I --> J[Controller -> Service -> Storage -> MySQL]
  J --> K[JSON response]
  I -. no route .-> L[/api/* -> JSON 404, other paths -> React app/]
  J -. throws .-> M[Error handler -> JSON error]
```

### 7.3 Layers

| Layer | Location | Responsibility |
|---|---|---|
| Routes | `server/routes/*.routes.ts` | URL + HTTP method, middleware chain, which handler runs |
| Middleware | `server/middlewares/` | Authentication, roles/permissions, tenant ownership, plan limits, validation, uploads, CSRF, rate limiting |
| Controllers | `server/controllers/` | Read the request, call services/storage, shape the response |
| Services | `server/services/` | Business logic and external integrations |
| Storage / repositories | `server/storage.ts`, `server/database-storage.ts`, `server/repositories/` | All database reads and writes through Drizzle ORM |
| Schema | `shared/schema.ts` | Table definitions, types, validation schemas |

### 7.4 Authentication and authorization

- **Sign-up** (`POST /api/auth/signup`): creates a tenant `admin`. If *Email Verification* is enabled in
  system configuration, the account starts inactive and a 6-digit code (valid 10 minutes) is emailed;
  `POST /api/users/verifyEmail` activates it and signs the user in. `POST /api/users/resend-verification` sends a new code.
- **Login** (`POST /api/auth/login`): bcrypt password check, then account checks (unverified → `403 EMAIL_NOT_VERIFIED`,
  inactive → `403`). On success the user is stored in the session and a JWT (7 days) is returned for clients
  that cannot use cookies.
- **Session**: `express-session` with a database-backed store; cookie `connect.sid`, `HttpOnly`, `SameSite=Lax`
  (`None` + `Secure` over HTTPS for iframe use).
- **Authorization middleware**:
  - `requireAuth` — any logged-in user
  - `requireRole("superadmin" | "admin" | ...)` — role check
  - `requirePermission("contacts:edit", ...)` — permission check (superadmins included; no implicit bypass)
  - `requireChannelAccess` — the channel in the URL/query must belong to the caller's tenant (404 otherwise)
  - `requireSubscription("contacts" | "channel" | ...)` — the tenant's plan must allow the feature / not exceed limits
  - `requireApiKey` — public REST API (`x-api-key` + `x-api-secret` headers)

### 7.5 Main services

| Service | File | Responsibility |
|---|---|---|
| WhatsApp API | `services/whatsapp-api.ts` | Calls to Meta Graph API: send messages, templates, media upload, business profile |
| Webhook handler | `services/webhook-handler.ts`, `controllers/webhooks.controller.ts` | Process incoming Meta webhooks: messages, statuses, template updates |
| Message queue | `services/message-queue.ts`, `services/bull-queue.ts` | Rate-limited outbound sending; BullMQ when Redis is available, database polling otherwise |
| Automation engine | `services/automation-execution-service.ts` | Runs flow graphs node by node, with delays, user replies, conditions and loop protection |
| AI / training | `services/training.service.ts` | Knowledge-base ingestion (documents, Q&A), retrieval for AI replies |
| Notifications | `services/notification.service.ts` | In-app, email and push notifications with throttling |
| Email | `services/email.service.ts` | SMTP transport, OTP and transactional emails |
| Email / SMS marketing | `services/email-marketing.service.ts`, `services/sms-marketing.service.ts` | Campaign creation and delivery |
| Payments | `services/payment-gateway.service.ts` | Checkout sessions, webhooks, subscription activation |
| System config | `services/system-config.service.ts` | Platform settings, policy pages, blog, cron registry |
| Installer | `services/installer.service.ts` | Web-based first-time installation |
| Cache / Redis | `services/cache.ts`, `services/redis.ts` | Optional Redis connection and caching |

### 7.6 Background jobs

| Job | Schedule | What it does |
|---|---|---|
| Message queue worker | Continuous | Sends queued campaign/automation messages, respects tier limits, retries failures |
| Scheduled campaigns | Every minute | Starts campaigns whose scheduled time has passed; recovers stalled ones |
| Message status updater | Every 60 s | Reconciles message delivery statuses |
| Payment reconciler | Every 15 min | Re-checks pending payments with the gateways |
| Channel health monitor | Daily 02:00 | Refreshes channel quality rating and messaging limits from Meta |

In a PM2 cluster only the instance with `NODE_APP_INSTANCE=0` runs these jobs.

### 7.7 Key backend workflows

**Incoming WhatsApp message**

1. Meta calls the webhook URL with the message payload.
2. The handler de-duplicates by message ID (`webhook_dedup`), finds the channel by phone-number ID.
3. Finds or creates the **contact** and the **conversation**, stores the **message**.
4. Emits `new_message` / `conversation_updated` over Socket.IO to agents of that tenant.
5. Sends notifications to assigned agents.
6. Fires matching **automations** (`message_received`, `new_conversation`).
7. If AI is enabled and the trigger words match, generates an AI reply from the knowledge base; escalates to a human when unsure.

**Campaign**

1. The user creates a campaign: template + audience (contacts, a group or a CSV) + optional schedule.
2. On start, one row per recipient is written to `campaign_recipients` and the outgoing messages to `message_queue`.
3. The queue worker sends them through the Meta API at the allowed rate, updating each message's status.
4. Status webhooks (`sent`, `delivered`, `read`, `failed`) update recipients and campaign counters in real time.
5. The campaign can be paused/resumed; failed sends retry up to `MESSAGE_QUEUE_MAX_ATTEMPTS`.

**Automation flow execution**

1. A trigger event (new conversation, message received) finds the tenant's active automations.
2. An `automation_executions` row is created; the engine walks `automation_nodes` along `automation_edges`.
3. Each node runs (send message/template, wait, ask a question and save the answer, condition, assign agent,
   call webhook) and logs to `automation_execution_logs`.
4. "Wait" and "ask question" nodes pause the execution; it resumes on a timer or on the contact's reply.

---

## 8. Frontend architecture and workflow

### 8.1 Bootstrapping

`client/src/main.tsx` mounts `<App/>` inside an error boundary (and silences console output in production builds).
`App.tsx` wraps the app in its providers — **QueryClientProvider** (TanStack Query), **AuthProvider**,
**ChannelProvider**, **SocketProvider**, **UnreadCountProvider** and **TooltipProvider** — decides which layout to
show (public site, installer, superadmin panel, tenant app) and registers the routes. If the platform is not yet
installed, every page redirects to `/install`.

### 8.2 State management

| Kind of state | Where | Examples |
|---|---|---|
| Server data | TanStack Query (`useQuery` / `useMutation`) | contacts, campaigns, templates; cached by API URL, refetched after mutations |
| Session / identity | `AuthContext` | current user, role, permissions, login/logout |
| Active WhatsApp channel | `ChannelContext` | the channel all tenant screens work on |
| Real-time connection | `SocketContext` | Socket.IO client, event subscriptions |
| UI | `SidebarContext`, local `useState` | collapsed sidebar, dialogs, forms (react-hook-form + Zod) |
| Language | `lib/i18n.ts` | translations loaded from the server, 8 languages |

### 8.3 Routing and access guards

Routes are declared in `App.tsx`. Protected pages are wrapped in `PermissionRoute`, which renders an
"Access Denied" page when the user's role or permission does not match. The server enforces the same rules
again on every API call, so hiding a page is never the only protection.

86 routes. "App entry" pages are public URLs that load the signed-in experience (they show the login form or redirect when there is no session).

| Path | Page component | Access | Area |
|---|---|---|---|
| `/` | `Home` | Public | Public |
| `/about` | `Header` | Public | Public |
| `/best-practices` | `Header` | Public | Public |
| `/careers` | `Header` | Public | Public |
| `/case-studies` | `Header` | Public | Public |
| `/contact` | `Header` | Public | Public |
| `/cookie-policy` | `Header` | Public | Public |
| `/demo` | `DemoPage` | Public | Public |
| `/integrations` | `Header` | Public | Public |
| `/login` | `LoginPage` | Public | Public |
| `/press-kit` | `Header` | Public | Public |
| `/privacy-policy` | `Header` | Public | Public |
| `/signup` | `Signup` | Public | Public |
| `/terms` | `Header` | Public | Public |
| `/verify-email` | `Header` | Public | Public |
| `/whatsapp-guide` | `Header` | Public | Public |
| `/widget-chat` | `WidgetChat` | Public | Public |
| `/admin-login` | `AdminLoginPage` | Public | App entry |
| `/admin/:rest*` | `AdminPortalRoute` | Public | App entry |
| `/admin/*` | `AdminPortalRoute` | Public | App entry |
| `/admin/login` | `AdminLoginPage` | Public | App entry |
| `/dashboard` | `Dashboard` | Public | App entry |
| `/install` | `InstallPage` | Public | App entry |
| `/account` | `Account` | Logged in | Tenant app |
| `/add/chatbot-builder` | `AddChatbotBuilder` | Logged in | Tenant app |
| `/ai-assistant` | `AIAssistant` | Logged in | Tenant app |
| `/analytics` | `Analytics` | Logged in | Tenant app |
| `/analytics/campaign/:campaignId` | `CampaignAnalytics` | Logged in | Tenant app |
| `/api-docs` | `ApiDocs` | Roles: admin | Tenant app |
| `/auto-responses` | `AutoResponses` | Logged in | Tenant app |
| `/automation` | `Automations` | Permission: automations:view | Tenant app |
| `/billing` | `BillingSubscriptionPage` | Logged in | Tenant app |
| `/bot-builder` | `BotFlowBuilder` | Logged in | Tenant app |
| `/bulk-import` | `BulkImport` | Logged in | Tenant app |
| `/campaigns` | `Campaigns` | Permission: campaigns:view | Tenant app |
| `/chat-hub` | `ChatHub` | Logged in | Tenant app |
| `/chatbot-builder` | `ChatbotBuilder` | Logged in | Tenant app |
| `/contacts` | `Contacts` | Permission: contacts:view | Tenant app |
| `/crm-systems` | `CRMSystem` | Logged in | Tenant app |
| `/docs` | `DocumentationPage` | Logged in | Tenant app |
| `/documentation` | `DocumentationPage` | Logged in | Tenant app |
| `/email-marketing` | `EmailMarketingPage` | Logged in | Tenant app |
| `/groups` | `GroupsUI` | Logged in | Tenant app |
| `/health-monitor` | `HealthMonitor` | Logged in | Tenant app |
| `/inbox` | `Inbox` | Permission: inbox:view | Tenant app |
| `/leads` | `LeadManagement` | Logged in | Tenant app |
| `/multi-number` | `MultiNumber` | Logged in | Tenant app |
| `/payment-success` | `PaymentSuccessPage` | Logged in | Tenant app |
| `/payment/success` | `PaymentSuccessPage` | Logged in | Tenant app |
| `/plan-upgrade` | `Plans` | Logged in | Tenant app |
| `/plans` | `Plans` | Logged in | Tenant app |
| `/qr-codes` | `QRCodes` | Logged in | Tenant app |
| `/reports` | `Reports` | Logged in | Tenant app |
| `/segmentation` | `Segmentation` | Logged in | Tenant app |
| `/settings` | `Settings` | Permission: settings:view | Tenant app |
| `/sms-marketing` | `SmsMarketingPage` | Logged in | Tenant app |
| `/team` | `Team` | Permission: team:view | Tenant app |
| `/templates` | `Templates` | Permission: templates:view | Tenant app |
| `/user-notifications` | `UserNotifications` | Logged in | Tenant app |
| `/user-support-tickets` | `UserSupportTicketsNew` | Logged in | Tenant app |
| `/waba-connection` | `WABAConnection` | Logged in | Tenant app |
| `/webhooks` | `Webhooks` | Logged in | Tenant app |
| `/websites` | `Websites` | Logged in | Tenant app |
| `/widget-builder` | `WidgetBuilder` | Logged in | Tenant app |
| `/workflows` | `Workflows` | Logged in | Tenant app |
| `/admin` | `Dashboard` | Roles: superadmin | Superadmin |
| `/admin-extra` | `AdminExtra` | Roles: superadmin | Superadmin |
| `/admin/dashboard` | `Dashboard` | Roles: superadmin | Superadmin |
| `/app-update` | `AppUpdate` | Roles: superadmin | Superadmin |
| `/channels-management` | `ChannelsManagement` | Roles: superadmin | Superadmin |
| `/contacts-management` | `ContactsManagements` | Roles: superadmin | Superadmin |
| `/gateway` | `GatewaySettings` | Roles: superadmin | Superadmin |
| `/general-settings` | `GeneralSettingsPage` | Roles: superadmin | Superadmin |
| `/languages` | `LanguageManagement` | Roles: superadmin | Superadmin |
| `/manage-ads` | `ManageAds` | Roles: superadmin | Superadmin |
| `/manage-levels` | `ManageLevels` | Roles: superadmin | Superadmin |
| `/manager-services` | `ManagerServices` | Roles: superadmin | Superadmin |
| `/master-subscriptions` | `AllSubscriptionsPage` | Roles: superadmin | Superadmin |
| `/message-logs` | `SuperadminMessageLogs` | Roles: superadmin | Superadmin |
| `/notifications` | `Notifications` | Roles: superadmin | Superadmin |
| `/reports-requests` | `ReportsRequests` | Roles: superadmin | Superadmin |
| `/support-tickets` | `SupportTicketsNew` | Roles: superadmin | Superadmin |
| `/system-settings` | `SystemSettingsPage` | Roles: superadmin | Superadmin |
| `/transactions-logs` | `TransactionsPage` | Roles: superadmin | Superadmin |
| `/users` | `User` | Roles: superadmin | Superadmin |
| `/users/:id` | `userDetails` | Roles: superadmin | Superadmin |


### 8.4 Typical user workflows

**Tenant onboarding**
1. Sign up → (verify email) → log in.
2. *Settings → Channels*: connect a WhatsApp number via Embedded Signup or manual credentials.
3. *Templates*: create or sync message templates; wait for Meta approval.
4. *Contacts*: import contacts (CSV) and organise them into groups.
5. *Campaigns*: create a campaign from an approved template, choose the audience, send or schedule.
6. *Inbox*: reply to customers in real time; assign conversations to team members.
7. *Automations / AI*: build flows and enable AI replies to handle common questions.

**Superadmin**
1. Log in at `/admin`.
2. Configure branding, SMTP, payment gateways, languages and system settings.
3. Create subscription plans with limits and prices.
4. Monitor users, channels, transactions, support tickets and scheduled jobs.

---

## 9. Frontend ↔ backend communication

### 9.1 Channels of communication

| Channel | Used for | Transport |
|---|---|---|
| REST API (`/api/*`) | All reads and writes from the React app | HTTPS + JSON |
| Socket.IO (`/socket.io`) | Live inbox, typing, statuses, notifications | WebSocket (falls back to long-polling) |
| Widget iframe | Website chat widget | `widget.js` embeds `/widget-chat`; uses `/api/widget/*` + Socket.IO |
| Webhooks (inbound) | Meta WhatsApp events (`/webhook/global`, `/webhook/:id`), payment gateways (`/webhooks/<gateway>`) | HTTPS from the provider |
| Public REST API (`/api/v1/*`) | External systems | HTTPS + `x-api-key` / `x-api-secret` |

### 9.2 REST conventions

- **Base URL**: same origin as the app (`/api/...`); JSON request and response bodies.
- **Client helper**: `client/src/lib/queryClient.ts` → `apiRequest(method, url, body)` used by all pages and by TanStack Query.
- **Credentials**: every request is sent with `credentials: "include"` (session cookie). If a token is stored
  (`localStorage.token` / `auth_token`), it is also sent as `Authorization: Bearer <token>`.
- **CSRF**: for `POST/PUT/PATCH/DELETE` the client first obtains a token from `GET /api/csrf-token`
  (also set as the `csrf_token` cookie) and sends it in the `X-CSRF-Token` header. Login, sign-up,
  password reset, webhooks, widget and `/api/v1` routes are exempt.
- **Status codes**: `200/201` success, `400` validation error, `401` not logged in, `403` role/permission/plan
  denied, `404` not found (also for resources of other tenants), `409` conflict, `429` rate limited, `5xx` server error.
- **Error body**: `{ "error": "message" }` or `{ "success": false, "message": "..." }` depending on the module.
- **Pagination**: list endpoints accept `page` and `limit` query parameters and return `{ data, total, page, limit }` or `{ data, pagination }`.

### 9.3 Login sequence

```mermaid
sequenceDiagram
  participant U as Browser (React)
  participant S as Server (Express)
  participant DB as MySQL
  U->>S: GET /api/csrf-token
  S-->>U: { csrfToken } + csrf_token cookie
  U->>S: POST /api/auth/login { username, password }
  S->>DB: SELECT user by username or email
  S->>S: bcrypt.compare(password, hash)
  S->>DB: UPDATE last_login, INSERT user_activity_logs
  S-->>U: 200 { user, token, redirect } + Set-Cookie connect.sid
  U->>S: GET /api/auth/me (cookie)
  S-->>U: current user -> AuthContext
  U->>S: Socket.IO connect (cookie)
```

### 9.4 Real-time message sequence

```mermaid
sequenceDiagram
  participant C as Customer (WhatsApp)
  participant M as Meta Cloud API
  participant S as Server
  participant DB as MySQL
  participant A as Agent browser
  C->>M: sends a message
  M->>S: POST webhook (message)
  S->>DB: upsert contact + conversation, insert message
  S-->>A: Socket.IO new_message / conversation_updated
  A->>S: POST /api/conversations/:conversationId/messages (reply)
  S->>M: Graph API send message
  M-->>S: webhook status sent / delivered / read
  S->>DB: update message status
  S-->>A: Socket.IO message_status_update
```

### 9.5 Socket.IO events

The client connects to the same origin (`transports: polling, websocket`) with the session cookie. The server
groups sockets into rooms — `user:<id>`, `channel:<id>`, `conversation:<id>` and `site:<id>` (widget) — so events
reach only the agents of the right tenant.

**Server → client**

| Event | Meaning |
|---|---|
| `new_message` | A message arrived or was sent in a conversation |
| `conversation_created` | A new conversation was opened |
| `conversation_updated` | Conversation fields changed (last message, unread count, status) |
| `conversation_assigned` | Conversation assigned to an agent |
| `new_conversation_assigned` | An agent received a widget conversation |
| `conversation_transferred` | Conversation moved to another agent |
| `conversation_status_changed` | Conversation opened/closed/resolved |
| `conversations_list` | Response to `get_conversations` |
| `message_sent` | Outbound message accepted |
| `message_status_update` | Delivery status changed (sent / delivered / read / failed) |
| `message_error` | Sending failed |
| `message_edited` | A message was edited |
| `message_reaction` | A reaction was added |
| `messages_read` | Messages in a conversation were read |
| `user_typing` | Customer/visitor typing |
| `user_stopped_typing` | Customer/visitor stopped typing |
| `agent_typing` | Agent typing (sent to widget visitors) |
| `agent_stopped_typing` | Agent stopped typing |
| `agent_joined` | An agent joined a widget conversation |
| `visitor_joined` | A widget visitor connected |
| `visitor_left` | A widget visitor disconnected |
| `visitor_typing` | Widget visitor typing |
| `visitor_stopped_typing` | Widget visitor stopped typing |
| `user_left` | A participant left a conversation room |
| `joined_channel` | Socket joined a channel room |
| `display_name_update` | WhatsApp display-name review status changed |
| `notification:new` | New in-app notification |
| `test_response` | Reply to `test_event` (diagnostics) |

**Client → server**

| Event | Meaning |
|---|---|
| `join_conversation` | Join a conversation room |
| `leave_conversation` | Leave a conversation room |
| `join_all_conversations` | Join rooms for all of the agent's conversations |
| `get_conversations` | Request the conversation list |
| `conversation_opened` | Agent opened a conversation (marks it read) |
| `message_read` | Mark a message as read |
| `user_typing` | Typing started |
| `user_stopped_typing` | Typing stopped |
| `agent_typing` | Agent typing in a widget chat |
| `agent_stopped_typing` | Agent stopped typing |
| `agent_join_conversation` | Agent takes over a widget conversation |
| `agent_send_message` | Agent sends a widget message |
| `transfer_conversation` | Transfer to another agent |
| `close_conversation` | Close a conversation |
| `conversation_status_changed` | Change conversation status |
| `broadcast_to_site` | Broadcast to all visitors of a widget site |
| `test_event` | Connectivity test |

### 9.6 Chat widget

1. A website includes `widget.js` with `data-site-id`.
2. The script adds a chat button and an iframe pointing to `https://<app>/widget-chat?siteId=...`.
3. The iframe calls `/api/widget/config/:siteId`, `/api/widget/chat`, `/api/widget/kb/:siteId` etc. (public, rate-limited).
4. Visitor messages enter the tenant's inbox; AI answers from the site's training data; an agent can take over
   live through Socket.IO (`agent_join_conversation`, `agent_send_message`).

---

## 10. API reference

**399 endpoints in 39 modules.** Generated from the route definitions in `server/routes/` and `server/index.ts`.

| Access level | Endpoints |
|---|---|
| Logged in | 191 |
| Superadmin | 105 |
| Public | 48 |
| Permission | 33 |
| API key | 19 |
| Public (setup only) | 3 |

| Module | Endpoints | Module | Endpoints |
|---|---|---|---|
| [Core (system)](#101-core-system) | 4 | [Authentication](#102-authentication) | 9 |
| [Installer](#103-installer) | 4 | [Users](#104-users) | 14 |
| [Team](#105-team) | 10 | [Channels](#106-channels) | 23 |
| [WhatsApp](#107-whatsapp) | 11 | [WhatsApp configuration](#108-whatsapp-configuration) | 4 |
| [Webhooks](#109-webhooks) | 14 | [Contacts](#1010-contacts) | 9 |
| [Groups](#1011-groups) | 9 | [Conversations](#1012-conversations) | 13 |
| [Messages](#1013-messages) | 5 | [Message logs](#1014-message-logs) | 2 |
| [Templates](#1015-templates) | 9 | [Campaigns](#1016-campaigns) | 9 |
| [Automation](#1017-automation) | 18 | [Chat widget & sites](#1018-chat-widget--sites) | 15 |
| [AI settings](#1019-ai-settings) | 6 | [Training](#1020-training) | 14 |
| [Dashboard](#1021-dashboard) | 4 | [Analytics](#1022-analytics) | 5 |
| [Notifications](#1023-notifications) | 12 | [Email marketing](#1024-email-marketing) | 8 |
| [SMS marketing](#1025-sms-marketing) | 10 | [SMTP](#1026-smtp) | 7 |
| [Plans](#1027-plans) | 7 | [Subscriptions](#1028-subscriptions) | 8 |
| [Payments & checkout](#1029-payments--checkout) | 36 | [Support tickets](#1030-support-tickets) | 7 |
| [Panel / branding](#1031-panel--branding) | 10 | [Storage settings](#1032-storage-settings) | 5 |
| [Languages](#1033-languages) | 9 | [System configuration](#1034-system-configuration) | 25 |
| [Superadmin management](#1035-superadmin-management) | 13 | [In-app updater](#1036-in-app-updater) | 7 |
| [API keys](#1037-api-keys) | 4 | [Public REST API (v1)](#1038-public-rest-api-v1) | 19 |
| [Media](#1039-media) | 1 |  |  |


**Access column**
- **Public** — no login needed · **Logged in** — any authenticated user · **Superadmin** — superadmin only
- **Roles: …** — one of the listed roles · **Permission: …** — the listed permission · **API key** — `/api/v1` key + secret
- Notes: *channel owner* — the channel must belong to the caller's tenant; *plan: X* — the tenant's plan must
  include feature X; *file upload* — `multipart/form-data`.

### 10.1 Core (system)

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/version` | Public | List version |
| `GET` | `/api/health` | Public | Health check endpoint for container orchestrators (docker, kubernetes, aws ecs) |
| `GET` | `/api/agents/online` | Public | Get online agents |
| `GET` | `/api/csrf-token` | Public | Csrf token endpoint |

### 10.2 Authentication

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `POST` | `/api/auth/signup` | Public | Sign up as a new tenant admin (email verification if enabled) |
| `POST` | `/api/auth/login` | Public | Log in (sets the session cookie, returns the user and a bearer token) |
| `POST` | `/api/auth/logout` | Public | Log out (destroys the session) |
| `GET` | `/api/auth/me` | Public | Get current user |
| `GET` | `/api/auth/check` | Public | Check if authenticated (for frontend) |
| `GET` | `/api/auth/country-data` | Public | Get country data |
| `POST` | `/api/auth/forgot-password` | Public | Forgot password |
| `POST` | `/api/auth/reset-password` | Public | Reset password |
| `POST` | `/api/auth/verify-otp` | Public | Verify OTP |

### 10.3 Installer

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/install/status` | Public | Get status |
| `POST` | `/api/install/test-db` | Public (setup only) | Test DB |
| `POST` | `/api/install/execute` | Public (setup only) | Execute |
| `POST` | `/api/install/reset` | Public (setup only) | Reset |

### 10.4 Users

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/admin/users/export` | Superadmin | Export all users |
| `GET` | `/api/admin/users` | Superadmin | Get all users |
| `GET` | `/api/admin/users/:id` | Superadmin | Get user by ID |
| `PUT` | `/api/admin/users/:id/toggle-email-verify` | Superadmin | Toggle email verified |
| `PUT` | `/api/admin/users/:id/toggle-mobile-verify` | Superadmin | Toggle mobile verified |
| `PUT` | `/api/admin/users/:id/admin-update` | Superadmin | Update user admin |
| `POST` | `/api/admin/users/create` | Superadmin | Create user superadmin |
| `POST` | `/api/users/create` | Superadmin | Create user superadmin |
| `POST` | `/api/users/verifyEmail` | Public | Verify email OTP |
| `POST` | `/api/users/resend-verification` | Public | Resend verification OTP |
| `PUT` | `/api/admin/users/bulk-status` | Logged in | Bulk update user status |
| `PUT` | `/api/users/:id` | Logged in | Update user |
| `PUT` | `/api/user/status/:id` | Logged in | Update user status |
| `DELETE` | `/api/admin/users/:id` | Superadmin | Delete user |

### 10.5 Team

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/team/members` | Permission: team:view | Get members |
| `POST` | `/api/team/membersByUserId` | Permission: team:view | Members by user ID |
| `GET` | `/api/team/members/:id` | Permission: team:view | Get member by ID |
| `POST` | `/api/team/members` | Permission: team:create | Create team member |
| `PUT` | `/api/team/members/:id` | Permission: team:edit | Update member |
| `PATCH` | `/api/team/members/:id/status` | Permission: team:edit | Update status |
| `PATCH` | `/api/team/members/:id/password` | Logged in | Update password |
| `DELETE` | `/api/team/members/:id` | Permission: team:delete | Delete member |
| `GET` | `/api/team/activity-logs` | Logged in | Get activity logs |
| `PATCH` | `/api/team/members/:id/permissions` | Permission: team:permissions | Update member permissions |

### 10.6 Channels

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/channels/all` | Superadmin | Get all |
| `GET` | `/api/channels` | Logged in | Get channels |
| `POST` | `/api/channels/userid` | Logged in | Get channels by user ID |
| `GET` | `/api/channels/active` | Logged in | Get active channel |
| `POST` | `/api/channels` | Logged in · *plan: channel* | Create channel |
| `POST` | `/api/whatsapp/embedded-signup` | Logged in · *plan: channel* | Embedded signup |
| `PUT` | `/api/channels/:id` | Logged in · *channel owner* | Update channel |
| `POST` | `/api/channels/:id/disconnect` | Logged in · *channel owner* | Disconnect channel |
| `DELETE` | `/api/channels/:id` | Logged in · *channel owner* | Delete channel |
| `POST` | `/api/channels/:id/health` | Logged in · *channel owner* | Check channel health |
| `POST` | `/api/channels/health-check-all` | Superadmin | Check all channels health |
| `GET` | `/api/channels/:id/profile` | Logged in · *channel owner* | Get business profile |
| `POST` | `/api/channels/:id/profile` | Logged in · *channel owner* | Update business profile |
| `POST` | `/api/channels/:id/profile/photo` | Logged in · *channel owner* | Upload profile photo |
| `GET` | `/api/channels/:id/display-name` | Logged in · *channel owner* | Get display name |
| `POST` | `/api/channels/:id/display-name` | Logged in · *channel owner* | Update display name |
| `GET` | `/api/channels/:id/messaging-limit` | Logged in · *channel owner* | Get messaging limit |
| `GET` | `/api/whatsapp/test-credentials` | Superadmin | Test credentials |
| `GET` | `/api/admin/channels` | Superadmin | Get all channels admin |
| `GET` | `/api/admin/channel-signup-logs` | Superadmin | Get signup logs |
| `GET` | `/api/channels/:id/webhook-subscription` | Logged in · *channel owner* | Get webhook subscription |
| `POST` | `/api/channels/:id/webhook-resubscribe` | Logged in · *channel owner* | Resubscribe webhook |
| `POST` | `/api/channels/webhook-resubscribe-all` | Logged in | Resubscribe all webhooks |

### 10.7 WhatsApp

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/whatsapp/channels` | Logged in | Get all WhatsApp channels |
| `GET` | `/api/whatsapp/channels/:id` | Superadmin | Get single WhatsApp channel |
| `POST` | `/api/whatsapp/channels` | Logged in · *plan: channel* | Create WhatsApp channel |
| `PUT` | `/api/whatsapp/channels/:id` | Superadmin | Update WhatsApp channel |
| `DELETE` | `/api/whatsapp/channels/:id` | Superadmin | Delete WhatsApp channel |
| `POST` | `/api/whatsapp/channels/:id/send` | Logged in · *channel owner* | Send |
| `GET` | `/api/whatsapp/templates/:templateId/meta` | Logged in · *channel owner* | Get meta |
| `POST` | `/api/whatsapp/channels/:id/upload-image` | Logged in · *channel owner; file upload* | Upload image |
| `POST` | `/api/whatsapp/channels/:id/upload-media` | Logged in · *channel owner; file upload* | Upload media |
| `POST` | `/api/whatsapp/channels/:id/test` | Logged in · *channel owner* | Test WhatsApp connection |
| `GET` | `/api/whatsapp/api-logs` | Logged in · *channel owner* | Get API logs |

### 10.8 WhatsApp configuration

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/embedded/config` | Logged in | Get my WhatsApp config |
| `POST` | `/api/embedded/config` | Superadmin | Save WhatsApp config |
| `PUT` | `/api/embedded/config/:id` | Superadmin | Update WhatsApp config |
| `DELETE` | `/api/embedded/config` | Superadmin | Delete WhatsApp config |

### 10.9 Webhooks

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/webhook-configs-channel-id/:id` | Logged in | Get webhook configs by channel ID |
| `GET` | `/api/webhook-configs` | Logged in | Get webhook configs |
| `POST` | `/api/webhook-configs` | Logged in | Create webhook config |
| `PATCH` | `/api/webhook-configs/:id` | Logged in | Update webhook config |
| `DELETE` | `/api/webhook-configs/:id` | Logged in | Delete webhook config |
| `POST` | `/api/webhook-configs/:id/test` | Logged in | Test webhook |
| `GET` | `/api/webhook/global-url` | Logged in | Get global webhook URL |
| `GET/POST` | `/webhook/global` | Public | Meta WhatsApp webhook (GET = verification, POST = events) — platform-wide |
| `GET/POST` | `/webhook/:id` | Public | Meta WhatsApp webhook for one channel (GET = verification, POST = events) |
| `POST` | `/webhooks/razorpay` | Public | Razorpay webhook |
| `POST` | `/webhooks/stripe` | Public | Stripe webhook |
| `POST` | `/webhooks/paypal` | Public | Paypal webhook |
| `POST` | `/webhooks/paystack` | Public | Paystack webhook |
| `POST` | `/webhooks/mercadopago` | Public | Mercadopago webhook |

### 10.10 Contacts

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/contacts-all` | Permission: contacts:view | Get contacts |
| `GET` | `/api/contacts` | Permission: contacts:view | Get contacts with pagination |
| `GET` | `/api/contacts/:id` | Permission: contacts:view | Get contact |
| `POST` | `/api/contacts` | Permission: contacts:create · *plan: contacts* | Create contact |
| `GET` | `/api/user/contacts/:userId` | Logged in | Get contacts by user |
| `PUT` | `/api/contacts/:id` | Permission: contacts:edit | Update contact |
| `DELETE` | `/api/contacts/:id` | Permission: contacts:delete | Delete contact |
| `DELETE` | `/api/contacts-bulk` | Permission: contacts:delete | Delete bulk contacts |
| `POST` | `/api/contacts/import` | Permission: contacts:export · *plan: contacts* | Import contacts |

### 10.11 Groups

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `POST` | `/api/groups` | Logged in | Create group |
| `GET` | `/api/groups` | Logged in | Get groups |
| `GET` | `/api/groups/contact-counts` | Logged in | Get group contact count |
| `GET` | `/api/groups/:id` | Logged in | Get group by ID |
| `PUT` | `/api/groups/:id` | Logged in | Update group |
| `DELETE` | `/api/groups/:id` | Logged in | Delete group |
| `POST` | `/api/groups/add-contacts` | Logged in | Add contacts to group |
| `POST` | `/api/groups/remove-contacts` | Logged in | Remove contacts from group |
| `POST` | `/api/groups/move-contacts` | Logged in | Move contacts between groups |

### 10.12 Conversations

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/conversations/unread-count` | Public | Get unread count |
| `GET` | `/api/conversations` | Logged in | Get conversations |
| `GET` | `/api/conversations/pins` | Logged in | List pins |
| `POST` | `/api/conversations/:id/pin` | Logged in | Pin conversation |
| `DELETE` | `/api/conversations/:id/pin` | Logged in | Unpin conversation |
| `GET` | `/api/conversations/:id` | Logged in | Get conversation |
| `POST` | `/api/conversations` | Logged in | Create conversation |
| `PUT` | `/api/conversations/:id` | Permission: inbox:assign | Update conversation |
| `DELETE` | `/api/conversations/:id` | Logged in | Delete conversation |
| `PUT` | `/api/conversations/:id/read` | Logged in | Mark as read |
| `PATCH` | `/api/conversations/:id/status` | Logged in | Update conversation status |
| `GET` | `/api/conversations/:conversationId/automation-status` | Logged in | Get conversation automation status |
| `POST` | `/api/conversations/:conversationId/cancel-automation` | Logged in | Cancel conversation automation |

### 10.13 Messages

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/conversations/:conversationId/messages` | Logged in | Get messages |
| `POST` | `/api/conversations/:conversationId/messages` | Logged in · *file upload* | Create message |
| `POST` | `/api/messages/send` | Logged in | Send message |
| `GET` | `/api/messages/media-url` | Logged in | Get media URL |
| `GET` | `/api/messages/media-proxy` | Logged in | Get media proxy |

### 10.14 Message logs

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/messages/logs` | Logged in | Get message logs |
| `PUT` | `/api/messages/:messageId/status` | Logged in | Update message status |

### 10.15 Templates

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/templates` | Permission: templates:view | Get templates |
| `GET` | `/api/templates/:id` | Permission: templates:view | Get template |
| `POST` | `/api/getTemplateByUserId` | Logged in | Get template by user ID |
| `GET` | `/api/templatesByUserId` | Permission: templates:view | Get templates by user |
| `POST` | `/api/templates` | Permission: templates:create · *file upload* | Create template |
| `PUT` | `/api/templates/:id` | Logged in · *file upload* | Update template |
| `DELETE` | `/api/templates/:id` | Logged in | Delete template |
| `POST` | `/api/templates/sync` | Permission: templates:sync | Sync templates |
| `POST` | `/api/templates/seed` | Logged in | Seed templates |

### 10.16 Campaigns

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/campaigns` | Permission: campaigns:view | Get campaigns |
| `GET` | `/api/campaigns/:id` | Permission: campaigns:view | Get campaign |
| `POST` | `/api/campaigns` | Permission: campaigns:create | Create campaign |
| `POST` | `/api/getCampaignsByUserId` | Logged in | Get campaign by user ID |
| `PATCH` | `/api/campaigns/:id/status` | Permission: campaigns:edit | Update campaign status |
| `DELETE` | `/api/campaigns/:id` | Permission: campaigns:delete | Delete campaign |
| `POST` | `/api/campaigns/:id/start` | Logged in | Start campaign |
| `GET` | `/api/campaigns/:id/analytics` | Logged in | Get campaign analytics |
| `POST` | `/api/campaigns/send/:apiKey` | Permission: campaigns:send | Send API campaign |

### 10.17 Automation

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/automations` | Logged in | Get automations |
| `GET` | `/api/automations/:id` | Logged in | Get automation |
| `POST` | `/api/automations` | Logged in · *plan: automation; file upload* | Create automation |
| `PUT` | `/api/automations/:id` | Logged in · *file upload* | Update automation |
| `DELETE` | `/api/automations/:id` | Logged in | Delete automation |
| `POST` | `/api/automations/:id/toggle` | Logged in | Toggle automation |
| `POST` | `/api/automations/:automationId/nodes` | Logged in | Save automation nodes |
| `POST` | `/api/automations/:automationId/edges` | Logged in | Save automation edges |
| `POST` | `/api/automations/:automationId/executions` | Logged in | Start automation execution |
| `POST` | `/api/automations/executions/:executionId/logs` | Logged in | Log automation node execution |
| `POST` | `/api/automations/:automationId/execute` | Logged in | Start automation execution |
| `GET` | `/api/automations/:id/executions` | Logged in | Get automation executions |
| `GET` | `/api/automations/executions/:executionId/status` | Logged in | Get execution status |
| `POST` | `/api/automations/triggers/new-conversation` | Logged in | Trigger new conversation |
| `POST` | `/api/automations/triggers/message-received` | Logged in | Trigger message received |
| `GET` | `/api/automations/pending-executions` | Logged in | Get all pending executions |
| `POST` | `/api/automations/cleanup-expired` | Logged in | Cleanup expired executions |
| `POST` | `/api/automations/seed-templates` | Logged in | Seed automation templates |

### 10.18 Chat widget & sites

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/widget/config/:siteId` | Public | Get widget configuration |
| `GET` | `/api/widget/kb/:siteId` | Public | Get knowledge base articles |
| `GET` | `/api/widget/qa/:siteId` | Public | Get qa by siteid |
| `GET` | `/api/widget/article/:articleId` | Public | Get article |
| `POST` | `/api/widget/contacts` | Public · *plan: contacts* | Save contact |
| `POST` | `/api/widget/chat` | Public | Chat |
| `GET` | `/api/widget/conversation/:conversationId` | Public | Get conversation history |
| `POST` | `/api/widget/request-agent` | Public | Request human agent |
| `GET` | `/api/active-site` | Public | List active site |
| `GET` | `/api/sites` | Public | List sites |
| `POST` | `/api/sites` | Logged in | Create site |
| `PATCH` | `/api/sites/:id` | Logged in | Update site |
| `GET` | `/api/get_sites` | Logged in | List get sites |
| `POST` | `/api/widget/upload-logo` | Logged in | Upload logo |
| `POST` | `/api/sites/create_or_update` | Logged in | Create or update |

### 10.19 AI settings

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/ai-settings` | Logged in | Get aisettings |
| `GET` | `/api/ai-settings/diagnostics` | Logged in | Get aisettings diagnostics |
| `POST` | `/api/ai-settings` | Logged in | Create aisettings |
| `PUT` | `/api/ai-settings/:id` | Logged in | Update aisettings |
| `DELETE` | `/api/ai-settings/:id` | Logged in | Delete aisettings |
| `GET` | `/api/ai-settings/channel/:channelId` | Logged in | Get aisetting by channel ID |

### 10.20 Training

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/training/:siteId/sources` | Logged in | Get sources |
| `POST` | `/api/training/:siteId/url` | Logged in | URL |
| `POST` | `/api/training/:siteId/document` | Logged in · *file upload* | Document |
| `POST` | `/api/training/:siteId/text` | Logged in | Text |
| `POST` | `/api/training/:siteId/kb-sync` | Logged in | KB sync |
| `DELETE` | `/api/training/source/:sourceId` | Logged in | Delete source |
| `POST` | `/api/training/source/:sourceId/reprocess` | Logged in | Reprocess |
| `GET` | `/api/training/:siteId/qa` | Logged in | Get qa |
| `POST` | `/api/training/:siteId/qa` | Logged in | Qa |
| `PUT` | `/api/training/qa/:qaId` | Logged in | Update qa |
| `DELETE` | `/api/training/qa/:qaId` | Logged in | Delete qa |
| `GET` | `/api/training/:siteId/stats` | Logged in | Get stats |
| `GET` | `/api/training/:siteId/preview` | Logged in | Get preview |
| `POST` | `/api/training/:siteId/test-chat` | Logged in | Test chat |

### 10.21 Dashboard

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/dashboard/stats` | Logged in | Get dashboard stats |
| `GET` | `/api/dashboard/admin/stats` | Logged in | Get dashboard stats for admin |
| `GET` | `/api/dashboard/user/stats` | Logged in | Get dashboard stats for user |
| `POST` | `/api/analytics` | Logged in | Create analytics |

### 10.22 Analytics

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/analytics` | Permission: analytics:view | Get analytics |
| `GET` | `/api/analytics/messages` | Permission: analytics:view | Get message analytics |
| `GET` | `/api/analytics/campaigns` | Permission: analytics:view | Get campaign analytics |
| `GET` | `/api/analytics/campaigns/:campaignId` | Permission: analytics:view | Get campaign analytics by ID |
| `GET` | `/api/analytics/export` | Permission: analytics:export | Export analytics |

### 10.23 Notifications

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `POST` | `/api/notifications` | Logged in | Admin create notification |
| `POST` | `/api/notifications/:id/send` | Logged in | Admin send notification |
| `GET` | `/api/notifications/` | Logged in | Admin get notifications |
| `GET` | `/api/notifications/users/` | Logged in | User get notifications |
| `POST` | `/api/notifications/:id/read` | Logged in | User mark as read |
| `POST` | `/api/notifications/mark-all` | Logged in | User mark all read |
| `GET` | `/api/notifications/unread-count` | Public | User unread count |
| `GET` | `/api/notification-templates` | Logged in | Get notification templates |
| `PUT` | `/api/notification-templates/:id` | Superadmin | Update notification template |
| `GET` | `/api/notification-preferences` | Logged in | Get user preferences |
| `PUT` | `/api/notification-preferences` | Logged in | Update user preference |
| `DELETE` | `/api/notifications/:id` | Logged in | Delete notification |

### 10.24 Email marketing

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/email-marketing/campaigns` | Logged in | Get /api/email-marketing/campaigns |
| `GET` | `/api/email-marketing/campaigns/:id` | Logged in | Get /api/email-marketing/campaigns/:id |
| `POST` | `/api/email-marketing/campaigns` | Logged in | Post /api/email-marketing/campaigns |
| `POST` | `/api/email-marketing/campaigns/:id/send` | Logged in | Post /api/email-marketing/campaigns/:id/send |
| `POST` | `/api/email-marketing/campaigns/:id/test` | Logged in | Post /api/email-marketing/campaigns/:id/test |
| `GET` | `/api/email-marketing/templates` | Logged in | Get /api/email-marketing/templates |
| `POST` | `/api/email-marketing/templates` | Logged in | Post /api/email-marketing/templates |
| `GET` | `/api/email-marketing/analytics` | Logged in | Get /api/email-marketing/analytics |

### 10.25 SMS marketing

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/sms-marketing/campaigns` | Logged in | Get /api/sms-marketing/campaigns |
| `GET` | `/api/sms-marketing/campaigns/:id` | Logged in | Get /api/sms-marketing/campaigns/:id |
| `POST` | `/api/sms-marketing/campaigns` | Logged in | Post /api/sms-marketing/campaigns |
| `POST` | `/api/sms-marketing/campaigns/:id/send` | Logged in | Post /api/sms-marketing/campaigns/:id/send |
| `POST` | `/api/sms-marketing/test` | Logged in | Post /api/sms-marketing/test |
| `POST` | `/api/sms-marketing/calculate-segments` | Public | Post /api/sms-marketing/calculate-segments |
| `GET` | `/api/sms-marketing/templates` | Logged in | Get /api/sms-marketing/templates |
| `GET` | `/api/sms-marketing/gateway` | Logged in | Get /api/sms-marketing/gateway |
| `POST` | `/api/sms-marketing/gateway` | Logged in | Post /api/sms-marketing/gateway |
| `GET` | `/api/sms-marketing/analytics` | Logged in | Get /api/sms-marketing/analytics |

### 10.26 SMTP

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `POST` | `/api/admin/smtpConfig` | Logged in | Upsert smtpconfig |
| `GET` | `/api/admin/getSmtpConfig` | Logged in | Get smtpconfig handler |
| `POST` | `/api/smtp/config` | Logged in | Upsert smtpconfig |
| `GET` | `/api/smtp/config` | Logged in | Get smtpconfig handler |
| `POST` | `/api/smtp/test` | Logged in | Test smtpconnection handler |
| `POST` | `/api/admin/smtp/upload-logo` | Logged in · *file upload* | Upload logo |
| `POST` | `/api/contact/sendmail` | Logged in | Send mail route |

### 10.27 Plans

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/admin/plans` | Public | Get all plans |
| `GET` | `/api/admin/plans/:id` | Logged in | Get plan by ID |
| `POST` | `/api/admin/plans` | Superadmin | Create plan |
| `PUT` | `/api/admin/plans/:id` | Superadmin | Update plan |
| `DELETE` | `/api/admin/plans/:id` | Superadmin | Delete plan |
| `POST` | `/api/admin/plans/:id/sync-gateway` | Superadmin | Sync plan to gateway |
| `POST` | `/api/admin/plans/sync-all-gateways` | Superadmin | Sync all plans to gateways |

### 10.28 Subscriptions

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/admin/subscriptions/:id` | Superadmin | Get subscription by ID |
| `GET` | `/api/subscriptions/active/:userId` | Logged in | Get active subscription by user ID |
| `POST` | `/api/assignSubscription` | Superadmin | Assign subscription |
| `PUT` | `/api/admin/subscriptions/:id` | Superadmin | Update subscription |
| `DELETE` | `/api/subscriptions/:id` | Logged in | Cancel subscription |
| `PUT` | `/api/subscriptions/renew/:id` | Logged in | Renew subscription |
| `PUT` | `/api/subscriptions/toggle-autorenew/:id` | Logged in | Toggle auto renew |
| `PUT` | `/api/admin/subscriptions/expire` | Superadmin | Check expired subscriptions |

### 10.29 Payments & checkout

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/payment-providers` | Logged in | Get all providers |
| `GET` | `/api/payment-providers/active` | Logged in | Get active providers |
| `GET` | `/api/payment-providers/currency-map` | Logged in | Get currency gateway map |
| `GET` | `/api/payment-providers/:id` | Superadmin | Get provider by ID |
| `GET` | `/api/payment-providers/key/:key` | Superadmin | Get provider by key |
| `POST` | `/api/payment-providers` | Superadmin | Create provider |
| `PUT` | `/api/payment-providers/:id` | Superadmin | Update provider |
| `PATCH` | `/api/payment-providers/:id/toggle-status` | Superadmin | Toggle provider status |
| `DELETE` | `/api/payment-providers/:id` | Superadmin | Delete provider |
| `GET` | `/api/transactions` | Superadmin | Get all transactions |
| `GET` | `/api/transactions/stats` | Superadmin | Get transaction stats |
| `GET` | `/api/transactions/export` | Superadmin | Export transactions |
| `GET` | `/api/transactions/:id` | Logged in | Get transaction by ID |
| `GET` | `/api/transactions/user/:userId` | Logged in | Get transactions by user ID |
| `POST` | `/api/transactions` | Logged in | Create transaction |
| `PATCH` | `/api/transactions/:id/status` | Superadmin | Update transaction status |
| `POST` | `/api/transactions/:id/complete` | Superadmin | Complete transaction |
| `POST` | `/api/transactions/:id/refund` | Superadmin | Refund transaction |
| `POST` | `/api/payment/initiate` | Logged in | Initiate payment |
| `POST` | `/api/payment/verify/razorpay` | Logged in | Verify razorpay payment |
| `POST` | `/api/payment/verify/stripe` | Logged in | Verify stripe payment |
| `POST` | `/api/payment/verify/paypal` | Logged in | Verify pay pal payment |
| `POST` | `/api/payment/verify/paystack` | Logged in | Verify paystack payment |
| `POST` | `/api/payment/verify/mercadopago` | Logged in | Verify mercado pago payment |
| `GET` | `/api/payment/status/:transactionId` | Logged in | Get payment status |
| `GET` | `/api/subscriptions` | Superadmin | Get all subscriptions |
| `GET` | `/api/subscriptions/:id` | Logged in | Get subscription by ID |
| `GET` | `/api/subscriptions/user/:userId` | Logged in | Get subscriptions by user ID |
| `GET` | `/api/subscriptions/user/:userId/active` | Logged in | Get active subscription by user ID |
| `POST` | `/api/subscriptions` | Superadmin | Create subscription |
| `PUT` | `/api/subscriptions/:id` | Superadmin | Update subscription |
| `PATCH` | `/api/subscriptions/:id/cancel` | Logged in | Cancel subscription |
| `POST` | `/api/subscriptions/:id/renew` | Logged in | Renew subscription |
| `PATCH` | `/api/subscriptions/:id/auto-renew` | Logged in | Toggle auto renew |
| `POST` | `/api/subscriptions/change-plan` | Logged in | Change plan |
| `POST` | `/api/subscriptions/check-expired` | Superadmin | Check expired subscriptions |

### 10.30 Support tickets

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/tickets` | Logged in | Get all tickets (with filters) |
| `GET` | `/api/tickets/:id` | Logged in | Get single ticket with messages |
| `POST` | `/api/tickets` | Logged in | Create ticket (users and listeners) |
| `PUT` | `/api/tickets/:id` | Logged in | Update ticket (admin only) |
| `POST` | `/api/tickets/:id/messages` | Logged in | Add message to ticket |
| `DELETE` | `/api/tickets/:id` | Logged in | Delete ticket (admin only) |
| `GET` | `/api/tickets/admin/stats` | Superadmin | Get ticket statistics (admin only) |

### 10.31 Panel / branding

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/platform-settings` | Public | List platform settings |
| `PUT` | `/api/platform-settings` | Superadmin | Update platform settings |
| `POST` | `/api/panel` | Superadmin · *file upload* | Create |
| `GET` | `/api/panel` | Superadmin | Get all |
| `GET` | `/api/panel/:id` | Superadmin | Get one |
| `PUT` | `/api/panel/:id` | Superadmin · *file upload* | Update |
| `DELETE` | `/api/panel/:id` | Superadmin | Remove |
| `GET` | `/api/brand-settings` | Public | Get brand settings |
| `PUT` | `/api/brand-settings` | Superadmin · *file upload* | Update brand settings |
| `POST` | `/api/brand-settings` | Superadmin · *file upload* | Create brand settings |

### 10.32 Storage settings

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/storage-settings` | Superadmin | Get storage settings |
| `GET` | `/api/storage-settings/active` | Superadmin | Get active storage |
| `POST` | `/api/storage-settings/update` | Superadmin | Update storage setting |
| `POST` | `/api/storage-settings/test` | Superadmin | Test storage connection |
| `DELETE` | `/api/storage-settings/:id` | Superadmin | Delete storage setting |

### 10.33 Languages

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/languages` | Superadmin | List languages |
| `GET` | `/api/languages/enabled` | Public | Get enabled |
| `GET` | `/api/languages/translations/:code` | Public | Get translation by code |
| `GET` | `/api/languages/:id` | Superadmin | Get language by ID |
| `POST` | `/api/languages` | Superadmin | Create language |
| `PUT` | `/api/languages/:id` | Superadmin | Update language |
| `PUT` | `/api/languages/:id/translations` | Superadmin | Update translations |
| `DELETE` | `/api/languages/:id` | Superadmin | Delete language |
| `POST` | `/api/languages/:id/copy-keys` | Superadmin | Copy keys |

### 10.34 System configuration

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/system-config/public` | Public | Public config (unauthenticated, safe fields) |
| `GET` | `/api/system-config` | Superadmin | Full system config (superadmin only) |
| `PUT` | `/api/system-config` | Superadmin | Update system config (superadmin only) |
| `POST` | `/api/system-config/test-email` | Superadmin | Test email dispatch (superadmin only) |
| `POST` | `/api/system-config/test-sms` | Superadmin | Test SMS dispatch (superadmin only) |
| `GET` | `/api/system-config/cron-jobs` | Superadmin | Cron jobs manager (superadmin only) |
| `POST` | `/api/system-config/cron-jobs/:jobKey/run` | Superadmin | Run |
| `GET` | `/api/system-config/notification-templates` | Superadmin | Notification templates list and crud |
| `POST` | `/api/system-config/notification-templates` | Superadmin | Notification templates |
| `PUT` | `/api/system-config/notification-templates/:id` | Superadmin | Update notification template |
| `DELETE` | `/api/system-config/notification-templates/:id` | Superadmin | Delete notification template |
| `GET` | `/api/policy-pages` | Public | Policy pages (public and admin) |
| `GET` | `/api/policy-pages/admin` | Superadmin | Get admin |
| `GET` | `/api/policy-pages/:slug` | Public | Get policy page by slug |
| `POST` | `/api/policy-pages` | Superadmin | Create policy page |
| `PUT` | `/api/policy-pages/:id` | Superadmin | Update policy page |
| `DELETE` | `/api/policy-pages/:id` | Superadmin | Delete policy page |
| `GET` | `/api/blogs` | Public | Platform blogs (public and admin) |
| `GET` | `/api/blogs/admin` | Superadmin | Get admin |
| `GET` | `/api/blogs/:slug` | Public | Get blog by slug |
| `POST` | `/api/blogs` | Superadmin | Create blog |
| `PUT` | `/api/blogs/:id` | Superadmin | Update blog |
| `DELETE` | `/api/blogs/:id` | Superadmin | Delete blog |
| `GET` | `/robots.txt` | Public | Dynamic robots.txt served from DB |
| `GET` | `/sitemap.xml` | Public | Dynamic sitemap.xml served from DB |

### 10.35 Superadmin management

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/superadmin/dashboard-overview` | Superadmin | Dashboard overview |
| `GET` | `/api/superadmin/services` | Superadmin | Manager services |
| `POST` | `/api/superadmin/services/action` | Superadmin | Toggle/restart service |
| `GET` | `/api/superadmin/ads` | Superadmin | Manage ads & announcements |
| `POST` | `/api/superadmin/ads` | Superadmin | Ads |
| `PUT` | `/api/superadmin/ads/:id` | Superadmin | Update ad |
| `DELETE` | `/api/superadmin/ads/:id` | Superadmin | Delete ad |
| `GET` | `/api/superadmin/levels` | Superadmin | Manage levels / tiers |
| `PUT` | `/api/superadmin/levels/:id` | Superadmin | Update level |
| `POST` | `/api/superadmin/cache/clear` | Superadmin | Cache & maintenance actions |
| `GET` | `/api/superadmin/server-info` | Superadmin | Server health & diagnostics |
| `GET` | `/api/superadmin/reports-requests` | Superadmin | Reports & requests |
| `PUT` | `/api/superadmin/requests/:id` | Superadmin | Update request |

### 10.36 In-app updater

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/app-update/status` | Superadmin | Get status |
| `POST` | `/api/app-update/upload` | Superadmin | Upload zip |
| `POST` | `/api/app-update/execute` | Superadmin | Execute update |
| `GET` | `/api/app-update/runs` | Superadmin | List runs |
| `GET` | `/api/app-update/runs/latest` | Superadmin | Get latest run |
| `GET` | `/api/app-update/runs/:id` | Superadmin | Get run by ID |
| `POST` | `/api/app-update/rollback` | Superadmin | Manual rollback |

### 10.37 API keys

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `POST` | `/api/api-keys` | Logged in | Create API key |
| `GET` | `/api/api-keys` | Logged in | List API keys |
| `POST` | `/api/api-keys/:id/revoke` | Logged in | Revoke |
| `GET` | `/api/api-keys/usage` | Logged in | Get usage |

### 10.38 Public REST API (v1)

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `POST` | `/api/v1/messages/template` | API key + messages.send | Template |
| `POST` | `/api/v1/messages/reply` | API key + messages.send | Reply |
| `GET` | `/api/v1/messages/status/:messageId` | API key + messages.read | Get statu by messageid |
| `GET` | `/api/v1/messages/:contactPhone` | API key + messages.read | Get message by contactphone |
| `GET` | `/api/v1/contacts` | API key + contacts.read | Get contacts |
| `POST` | `/api/v1/contacts` | API key + contacts.write | Contacts |
| `PUT` | `/api/v1/contacts/:id` | API key + contacts.write | Update contact |
| `DELETE` | `/api/v1/contacts/:id` | API key + contacts.write | Delete contact |
| `GET` | `/api/v1/contacts/groups` | API key + contacts.read | Get groups |
| `POST` | `/api/v1/contacts/groups/:groupId/add` | API key + contacts.write | Add |
| `POST` | `/api/v1/contacts/groups/:groupId/remove` | API key + contacts.write | Remove |
| `GET` | `/api/v1/templates` | API key + templates.read | Get templates |
| `GET` | `/api/v1/campaigns` | API key + campaigns.read | Get campaigns |
| `GET` | `/api/v1/account` | API key + account.read | Get account |
| `GET` | `/api/v1/account/usage` | API key + account.read | Get usage |
| `GET` | `/api/v1/webhooks` | API key + webhooks.manage | Get webhooks |
| `POST` | `/api/v1/webhooks` | API key + webhooks.manage | Webhooks |
| `PUT` | `/api/v1/webhooks/:id` | API key + webhooks.manage | Update webhook |
| `DELETE` | `/api/v1/webhooks/:id` | API key + webhooks.manage | Delete webhook |

### 10.39 Media

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `POST` | `/api/media/upload-url` | Logged in | Get media upload URL |

---

## 11. Database design (MySQL)

### 11.1 Conventions

| Convention | Rule |
|---|---|
| Engine / charset | InnoDB, `utf8mb4`, collation `utf8mb4_unicode_ci` |
| Primary keys | `id CHAR(36)` holding a UUID, default `(UUID())` |
| Timestamps | `created_at` / `updated_at` as `DATETIME(3)`, stored in **UTC**, default `CURRENT_TIMESTAMP(3)` |
| JSON data | Flexible structures (settings, template components, flow node data, permissions) use `JSON` columns |
| Booleans | `BOOLEAN` (`TINYINT(1)`) |
| Money | `DECIMAL(p,s)` (never floating point) |
| Foreign keys | Named `fk_<table>_<column>`; `ON DELETE CASCADE` where the child cannot exist alone |
| Naming | `snake_case` tables and columns, plural table names |

### 11.2 Overview

| Domain | Tables |
|---|---|
| Users & authentication | `users`, `otp_verifications`, `session`, `user_activity_logs`, `user_notification_preferences` |
| WhatsApp channels & templates | `channels`, `whatsapp_channels`, `whatsapp_business_accounts_config`, `channel_signup_logs`, `templates`, `api_logs`, `webhook_configs`, `webhook_dedup` |
| Contacts, inbox & messaging | `contacts`, `groups`, `conversations`, `messages`, `conversation_assignments`, `conversation_pins`, `message_queue` |
| Campaigns (WhatsApp, email, SMS) | `campaigns`, `campaign_recipients`, `email_campaigns`, `email_campaign_recipients`, `email_templates`, `sms_campaigns`, `sms_campaign_recipients`, `sms_gateways`, `smtp_config` |
| Automation, chatbot & AI | `automations`, `automation_nodes`, `automation_edges`, `automation_executions`, `automation_execution_logs`, `chatbots`, `ai_settings`, `sites`, `training_sources`, `training_data`, `training_chunks`, `training_qa_pairs`, `knowledge_categories`, `knowledge_articles` |
| Billing | `plans`, `subscriptions`, `transactions`, `payment_providers` |
| Platform & administration | `analytics`, `client_api_keys`, `client_api_usage_logs`, `client_webhooks`, `cron_job_logs`, `firebase_config`, `notification_templates`, `notifications`, `panel_config`, `platform_access_levels`, `platform_announcements`, `platform_blogs`, `platform_languages`, `platform_user_requests`, `policy_pages`, `sent_notifications`, `storage_settings`, `support_tickets`, `system_configurations`, `ticket_messages`, `update_run_events`, `update_runs` |

69 tables · 904 columns · 63 foreign keys.

### 11.3 Entity-relationship diagrams

**Users & authentication**

```mermaid
erDiagram
  channels ||--o{ users : "channel_id"
  users ||--o{ users : "created_by"
  users ||--o{ user_activity_logs : "user_id"
```

**WhatsApp channels & templates**

```mermaid
erDiagram
  channels ||--o{ templates : "channel_id"
  users ||--o{ templates : "created_by"
  channels ||--o{ api_logs : "channel_id"
```

**Contacts, inbox & messaging**

```mermaid
erDiagram
  channels ||--o{ contacts : "channel_id"
  users ||--o{ contacts : "created_by"
  users ||--o{ groups : "created_by"
  channels ||--o{ conversations : "channel_id"
  contacts ||--o{ conversations : "contact_id"
  users ||--o{ conversations : "assigned_to"
  conversations ||--o{ messages : "conversation_id"
  campaigns ||--o{ messages : "campaign_id"
  conversations ||--o{ conversation_assignments : "conversation_id"
  users ||--o{ conversation_assignments : "user_id"
  users ||--o{ conversation_assignments : "assigned_by"
  users ||--o{ conversation_pins : "user_id"
  conversations ||--o{ conversation_pins : "conversation_id"
  channels ||--o{ conversation_pins : "channel_id"
  campaigns ||--o{ message_queue : "campaign_id"
  channels ||--o{ message_queue : "channel_id"
```

**Campaigns (WhatsApp, email, SMS)**

```mermaid
erDiagram
  channels ||--o{ campaigns : "channel_id"
  users ||--o{ campaigns : "created_by"
  templates ||--o{ campaigns : "template_id"
  campaigns ||--o{ campaign_recipients : "campaign_id"
  contacts ||--o{ campaign_recipients : "contact_id"
  users ||--o{ email_campaigns : "user_id"
  email_campaigns ||--o{ email_campaign_recipients : "campaign_id"
  users ||--o{ email_templates : "user_id"
  users ||--o{ sms_campaigns : "user_id"
  sms_campaigns ||--o{ sms_campaign_recipients : "campaign_id"
  users ||--o{ sms_gateways : "user_id"
  users ||--o{ smtp_config : "user_id"
```

**Automation, chatbot & AI**

```mermaid
erDiagram
  channels ||--o{ automations : "channel_id"
  users ||--o{ automations : "created_by"
  automations ||--o{ automation_nodes : "automation_id"
  automations ||--o{ automation_edges : "automation_id"
  automations ||--o{ automation_executions : "automation_id"
  contacts ||--o{ automation_executions : "contact_id"
  conversations ||--o{ automation_executions : "conversation_id"
  automation_executions ||--o{ automation_execution_logs : "execution_id"
  channels ||--o{ ai_settings : "channel_id"
  chatbots ||--o{ training_data : "chatbot_id"
  sites ||--o{ knowledge_categories : "site_id"
```

**Billing**

```mermaid
erDiagram
  users ||--o{ subscriptions : "user_id"
  plans ||--o{ subscriptions : "plan_id"
  users ||--o{ transactions : "user_id"
  plans ||--o{ transactions : "plan_id"
  subscriptions ||--o{ transactions : "subscription_id"
  payment_providers ||--o{ transactions : "payment_provider_id"
```

**Platform & administration**

```mermaid
erDiagram
  users ||--o{ client_api_keys : "user_id"
  channels ||--o{ client_api_keys : "channel_id"
  client_api_keys ||--o{ client_api_usage_logs : "api_key_id"
  users ||--o{ client_api_usage_logs : "user_id"
  channels ||--o{ client_api_usage_logs : "channel_id"
  users ||--o{ client_webhooks : "user_id"
  channels ||--o{ client_webhooks : "channel_id"
  channels ||--o{ notifications : "channel_id"
  notifications ||--o{ sent_notifications : "notification_id"
  support_tickets ||--o{ ticket_messages : "ticket_id"
  update_runs ||--o{ update_run_events : "run_id"
  users ||--o{ update_runs : "triggered_by"
```

Relationships are implemented as foreign keys where the data must stay consistent; many tenant links (for example `contacts.channel_id`, `campaigns.channel_id`) are plain indexed columns checked by the application.

### 11.4 Table reference

Type column: MySQL type. **PK** primary key · **UQ** unique · **FK** foreign key (→ referenced table).

#### Users & authentication

##### `users`

All accounts: superadmins, tenant admins and team members, with role and permissions

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `username` | `VARCHAR(255)` | NO |  | UQ |  |
| `password` | `TEXT` | NO |  |  |  |
| `email` | `VARCHAR(255)` | NO |  | UQ |  |
| `first_name` | `TEXT` | YES |  |  |  |
| `last_name` | `TEXT` | YES |  |  |  |
| `role` | `VARCHAR(255)` | NO | `'admin'` |  |  |
| `avatar` | `TEXT` | YES |  |  |  |
| `status` | `TEXT` | NO | `('active')` |  |  |
| `permissions` | `JSON` | NO |  |  | JSON array |
| `channel_id` | `CHAR(36)` | YES |  | FK → `channels.id` (set null) | type matches referenced key |
| `last_login` | `DATETIME(3)` | YES |  |  | UTC |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `created_by` | `CHAR(36)` | YES |  | FK → `users.id` (set null) | type matches referenced key |
| `fcm_token` | `VARCHAR(512)` | YES |  |  |  |
| `phone` | `TEXT` | YES |  |  |  |
| `is_email_verified` | `BOOLEAN` | YES | `FALSE` |  |  |
| `is_mobile_verified` | `BOOLEAN` | YES | `FALSE` |  |  |
| `stripe_customer_id` | `VARCHAR(255)` | YES |  |  |  |
| `razorpay_customer_id` | `VARCHAR(255)` | YES |  |  |  |
| `paypal_customer_id` | `VARCHAR(255)` | YES |  |  |  |
| `paystack_customer_code` | `VARCHAR(255)` | YES |  |  |  |
| `mercadopago_customer_id` | `VARCHAR(255)` | YES |  |  |  |

Indexes: `users_created_by_idx` (created_by) · `users_role_idx` (role)

##### `otp_verifications`

One-time codes for email verification and password reset

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `user_id` | `VARCHAR(255)` | NO |  |  |  |
| `otp_code` | `VARCHAR(6)` | NO |  |  |  |
| `expires_at` | `DATETIME(3)` | NO |  |  | UTC |
| `is_used` | `BOOLEAN` | YES | `FALSE` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `session`

Server-side login sessions

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `sid` | `CHAR(36)` | NO |  | PK |  |
| `sess` | `JSON` | NO |  |  |  |
| `expire` | `DATETIME(3)` | NO |  |  |  |

##### `user_activity_logs`

Audit trail of user actions (logins, changes)

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `user_id` | `CHAR(36)` | NO |  | FK → `users.id` (cascade) | type matches referenced key |
| `action` | `TEXT` | NO |  |  |  |
| `entity_type` | `TEXT` | YES |  |  |  |
| `entity_id` | `VARCHAR(255)` | YES |  |  |  |
| `details` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `ip_address` | `TEXT` | YES |  |  |  |
| `user_agent` | `TEXT` | YES |  |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `user_notification_preferences`

Per-user notification channel settings

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `INT` | NO | AUTO_INCREMENT | PK | set by the application |
| `user_id` | `VARCHAR(255)` | NO |  |  |  |
| `event_type` | `VARCHAR(255)` | NO |  |  |  |
| `in_app_enabled` | `BOOLEAN` | YES | `TRUE` |  |  |
| `email_enabled` | `BOOLEAN` | YES | `TRUE` |  |  |
| `sound_enabled` | `BOOLEAN` | YES | `TRUE` |  |  |

#### WhatsApp channels & templates

##### `channels`

Connected WhatsApp numbers (phone-number ID, WABA ID, access token, health)

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `name` | `TEXT` | NO |  |  |  |
| `phone_number_id` | `TEXT` | NO |  |  |  |
| `access_token` | `TEXT` | NO |  |  |  |
| `whatsapp_business_account_id` | `TEXT` | YES |  |  |  |
| `phone_number` | `TEXT` | YES |  |  |  |
| `app_id` | `TEXT` | YES |  |  |  |
| `is_active` | `BOOLEAN` | YES | `TRUE` |  |  |
| `is_coexistence` | `BOOLEAN` | YES | `FALSE` |  |  |
| `health_status` | `TEXT` | YES | `('unknown')` |  |  |
| `last_health_check` | `DATETIME(3)` | YES |  |  | UTC |
| `health_details` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `connection_method` | `VARCHAR(20)` | YES | `'embedded'` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `created_by` | `VARCHAR(255)` | YES | `''` |  |  |

##### `whatsapp_channels`

Legacy WhatsApp channel records (superadmin only)

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `name` | `TEXT` | NO |  |  |  |
| `phone_number` | `VARCHAR(20)` | NO |  | UQ |  |
| `phone_number_id` | `VARCHAR(50)` | NO |  |  |  |
| `waba_id` | `VARCHAR(50)` | NO |  |  |  |
| `access_token` | `TEXT` | NO |  |  |  |
| `business_account_id` | `VARCHAR(50)` | YES |  |  |  |
| `rate_limit_tier` | `VARCHAR(20)` | YES | `'standard'` |  |  |
| `quality_rating` | `VARCHAR(20)` | YES | `'green'` |  |  |
| `status` | `VARCHAR(20)` | YES | `'inactive'` |  |  |
| `error_message` | `TEXT` | YES |  |  |  |
| `last_health_check` | `DATETIME(3)` | YES |  |  | UTC |
| `message_limit` | `INT` | YES |  |  |  |
| `messages_used` | `INT` | YES |  |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `whatsapp_business_accounts_config`

Platform Meta app / Embedded Signup configuration

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `app_id` | `TEXT` | NO |  |  |  |
| `app_secret` | `TEXT` | NO |  |  |  |
| `config_id` | `TEXT` | NO |  |  |  |
| `created_by` | `VARCHAR(255)` | YES | `''` |  |  |
| `is_active` | `BOOLEAN` | YES | `TRUE` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `channel_signup_logs`

Log of Embedded Signup attempts

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `user_id` | `VARCHAR(255)` | NO |  |  |  |
| `status` | `VARCHAR(20)` | NO | `'incomplete'` |  |  |
| `step` | `VARCHAR(50)` | NO | `'token_exchange'` |  |  |
| `error_message` | `TEXT` | YES |  |  |  |
| `error_details` | `JSON` | YES |  |  |  |
| `phone_number` | `TEXT` | YES |  |  |  |
| `waba_id` | `TEXT` | YES |  |  |  |
| `channel_id` | `VARCHAR(255)` | YES |  |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `templates`

WhatsApp message templates and their Meta approval status

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `channel_id` | `CHAR(36)` | NO |  | FK → `channels.id` (cascade) | type matches referenced key |
| `created_by` | `CHAR(36)` | YES |  | FK → `users.id` (set null) | type matches referenced key |
| `name` | `TEXT` | NO |  |  |  |
| `category` | `TEXT` | NO |  |  |  |
| `language` | `TEXT` | YES | `('en_US')` |  |  |
| `header` | `TEXT` | YES |  |  |  |
| `body` | `TEXT` | NO |  |  |  |
| `footer` | `TEXT` | YES |  |  |  |
| `buttons` | `JSON` | YES | `(JSON_ARRAY())` |  |  |
| `variables` | `JSON` | YES | `(JSON_ARRAY())` |  |  |
| `status` | `TEXT` | YES | `('draft')` |  |  |
| `rejection_reason` | `TEXT` | YES |  |  |  |
| `media_type` | `TEXT` | YES | `('text')` |  |  |
| `media_url` | `TEXT` | YES |  |  |  |
| `media_handle` | `TEXT` | YES |  |  |  |
| `carousel_cards` | `JSON` | YES | `(JSON_ARRAY())` |  |  |
| `whatsapp_template_id` | `VARCHAR(255)` | YES |  |  |  |
| `usage_count` | `INT` | YES | `0` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `header_type` | `TEXT` | YES |  |  |  |
| `body_variables` | `INT` | YES |  |  |  |

Indexes: `templates_channel_idx` (channel_id)

##### `api_logs`

Requests made to the Meta Graph API

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `channel_id` | `CHAR(36)` | YES |  | FK → `channels.id` (no action) | type matches referenced key |
| `request_type` | `VARCHAR(50)` | NO |  |  |  |
| `endpoint` | `TEXT` | NO |  |  |  |
| `method` | `VARCHAR(10)` | NO |  |  |  |
| `request_body` | `JSON` | YES |  |  |  |
| `response_status` | `INT` | YES |  |  |  |
| `response_body` | `JSON` | YES |  |  |  |
| `duration` | `INT` | YES |  |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `webhook_configs`

Webhook endpoint configuration per channel

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `channel_id` | `VARCHAR(255)` | YES |  |  |  |
| `webhook_url` | `TEXT` | NO |  |  |  |
| `verify_token` | `VARCHAR(100)` | NO |  |  |  |
| `events` | `JSON` | NO | `(JSON_ARRAY())` |  |  |
| `is_active` | `BOOLEAN` | YES | `TRUE` |  |  |
| `last_ping_at` | `DATETIME(3)` | YES |  |  | UTC |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `webhook_dedup`

Processed incoming message IDs (prevents double processing) *(created by the application at startup)*

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `wamid` | `VARCHAR(255)` | NO |  | PK |  |
| `created_at` | `DATETIME(3)` | NO | `CURRENT_TIMESTAMP(3)` |  |  |

#### Contacts, inbox & messaging

##### `contacts`

Customers / leads per channel

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `channel_id` | `CHAR(36)` | NO |  | FK → `channels.id` (cascade) | type matches referenced key |
| `tenant_id` | `VARCHAR(255)` | YES |  |  |  |
| `name` | `TEXT` | NO |  |  |  |
| `phone` | `VARCHAR(255)` | NO |  |  |  |
| `email` | `TEXT` | YES |  |  |  |
| `groups` | `JSON` | YES | `(JSON_ARRAY())` |  |  |
| `tags` | `JSON` | YES | `(JSON_ARRAY())` |  |  |
| `status` | `VARCHAR(255)` | YES | `'active'` |  |  |
| `source` | `VARCHAR(100)` | YES |  |  |  |
| `store_id` | `CHAR(36)` | YES |  |  | type matches referenced key |
| `external_id` | `VARCHAR(255)` | YES |  |  |  |
| `last_contact` | `DATETIME(3)` | YES |  |  | UTC |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `created_by` | `CHAR(36)` | YES |  | FK → `users.id` (set null) | type matches referenced key |

Indexes: `contacts_channel_idx` (channel_id) · `contacts_phone_idx` (phone) · `contacts_status_idx` (status) · `contacts_tenant_idx` (tenant_id) · `contacts_store_idx` (store_id) · `contacts_external_id_idx` (external_id)

##### `groups`

Contact groups for targeting

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `channelId` | `CHAR(36)` | YES |  |  |  |
| `name` | `VARCHAR(255)` | NO |  |  |  |
| `description` | `TEXT` | YES |  |  |  |
| `created_by` | `CHAR(36)` | YES |  | FK → `users.id` (cascade) | type matches referenced key |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `conversations`

One conversation per contact and channel (inbox thread)

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `channel_id` | `CHAR(36)` | YES |  | FK → `channels.id` (cascade) | type matches referenced key |
| `contact_id` | `CHAR(36)` | YES |  | FK → `contacts.id` (cascade) | type matches referenced key |
| `assigned_to` | `CHAR(36)` | YES |  | FK → `users.id` (set null) | type matches referenced key |
| `contact_phone` | `VARCHAR(255)` | YES |  |  |  |
| `contact_name` | `VARCHAR(255)` | YES |  |  |  |
| `status` | `VARCHAR(255)` | YES | `'open'` |  |  |
| `priority` | `TEXT` | YES | `('normal')` |  |  |
| `type` | `TEXT` | YES | `('whatsapp')` |  |  |
| `chatbot_id` | `VARCHAR(255)` | YES |  |  |  |
| `session_id` | `TEXT` | YES |  |  |  |
| `tags` | `JSON` | YES | `(JSON_ARRAY())` |  |  |
| `unread_count` | `INT` | YES | `0` |  |  |
| `last_message_at` | `DATETIME(3)` | YES |  |  | UTC |
| `last_incoming_message_at` | `DATETIME(3)` | YES |  |  | UTC |
| `last_message_text` | `TEXT` | YES |  |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

Indexes: `conversations_channel_idx` (channel_id) · `conversations_contact_idx` (contact_id) · `conversations_phone_idx` (contact_phone) · `conversations_status_idx` (status) · `conversations_last_msg_idx` (channel_id, last_message_at) · `conversations_assigned_idx` (assigned_to) · `conversations_last_msg_at_idx` (last_message_at)

##### `messages`

Every inbound and outbound message with delivery status

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `conversation_id` | `CHAR(36)` | YES |  | FK → `conversations.id` (cascade) | type matches referenced key |
| `whatsapp_message_id` | `VARCHAR(255)` | YES |  |  |  |
| `from_user` | `BOOLEAN` | YES | `FALSE` |  |  |
| `direction` | `VARCHAR(255)` | YES | `'outbound'` |  |  |
| `content` | `TEXT` | NO |  |  |  |
| `type` | `TEXT` | YES | `('text')` |  |  |
| `from_type` | `VARCHAR(255)` | YES | `'user'` |  |  |
| `message_type` | `VARCHAR(255)` | YES |  |  |  |
| `media_id` | `VARCHAR(255)` | YES |  |  |  |
| `media_url` | `TEXT` | YES |  |  |  |
| `media_mime_type` | `VARCHAR(100)` | YES |  |  |  |
| `media_sha256` | `VARCHAR(128)` | YES |  |  |  |
| `status` | `VARCHAR(255)` | YES | `'sent'` |  |  |
| `timestamp` | `DATETIME(3)` | YES |  |  | UTC |
| `metadata` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `delivered_at` | `DATETIME(3)` | YES |  |  | UTC |
| `read_at` | `DATETIME(3)` | YES |  |  | UTC |
| `error_code` | `VARCHAR(50)` | YES |  |  |  |
| `error_message` | `TEXT` | YES |  |  |  |
| `error_details` | `JSON` | YES |  |  |  |
| `campaign_id` | `CHAR(36)` | YES |  | FK → `campaigns.id` (set null) | type matches referenced key |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

Indexes: `messages_conversation_idx` (conversation_id) · `messages_whatsapp_idx` (whatsapp_message_id) · `messages_direction_idx` (direction) · `messages_status_idx` (status) · `messages_timestamp_idx` (timestamp) · `messages_created_idx` (created_at) · `messages_conv_created_idx` (conversation_id, created_at) · `messages_conv_status_created_idx` (conversation_id, status, created_at)

##### `conversation_assignments`

Which agent handles a conversation (history)

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `conversation_id` | `CHAR(36)` | NO |  | FK → `conversations.id` (cascade) | type matches referenced key |
| `user_id` | `CHAR(36)` | NO |  | FK → `users.id` (cascade) | type matches referenced key |
| `assigned_by` | `CHAR(36)` | YES |  | FK → `users.id` (cascade) | type matches referenced key |
| `assigned_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `status` | `TEXT` | NO | `('active')` |  |  |
| `priority` | `TEXT` | YES | `('normal')` |  |  |
| `notes` | `TEXT` | YES |  |  |  |
| `resolved_at` | `DATETIME(3)` | YES |  |  | UTC |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `conversation_pins`

Conversations pinned by a user

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `user_id` | `CHAR(36)` | NO |  | FK → `users.id` (cascade) | type matches referenced key |
| `conversation_id` | `CHAR(36)` | NO |  | FK → `conversations.id` (cascade) | type matches referenced key |
| `channel_id` | `CHAR(36)` | YES |  | FK → `channels.id` (cascade) | type matches referenced key |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

Indexes: `conversation_pins_user_idx` (user_id) · `conversation_pins_user_channel_idx` (user_id, channel_id) · `conversation_pins_user_conv_uniq` (user_id, conversation_id) unique

##### `message_queue`

Outbound messages waiting to be sent (campaigns, automations)

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `campaign_id` | `CHAR(36)` | YES |  | FK → `campaigns.id` (no action) | type matches referenced key |
| `channel_id` | `CHAR(36)` | YES |  | FK → `channels.id` (no action) | type matches referenced key |
| `recipient_phone` | `VARCHAR(20)` | NO |  |  |  |
| `template_name` | `VARCHAR(100)` | YES |  |  |  |
| `template_language` | `VARCHAR(20)` | YES | `'en_US'` |  |  |
| `template_params` | `JSON` | YES | `(JSON_ARRAY())` |  |  |
| `message_type` | `VARCHAR(20)` | NO |  |  |  |
| `status` | `VARCHAR(20)` | YES | `'queued'` |  |  |
| `attempts` | `INT` | YES | `0` |  |  |
| `whatsapp_message_id` | `VARCHAR(100)` | YES |  |  |  |
| `conversation_id` | `VARCHAR(100)` | YES |  |  |  |
| `sent_via` | `VARCHAR(20)` | YES |  |  |  |
| `cost` | `VARCHAR(20)` | YES |  |  |  |
| `error_code` | `VARCHAR(50)` | YES |  |  |  |
| `error_message` | `TEXT` | YES |  |  |  |
| `scheduled_for` | `DATETIME(3)` | YES |  |  | UTC |
| `processed_at` | `DATETIME(3)` | YES |  |  | UTC |
| `delivered_at` | `DATETIME(3)` | YES |  |  | UTC |
| `read_at` | `DATETIME(3)` | YES |  |  | UTC |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

#### Campaigns (WhatsApp, email, SMS)

##### `campaigns`

WhatsApp broadcast campaigns with schedule and counters

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `channel_id` | `CHAR(36)` | YES |  | FK → `channels.id` (cascade) | type matches referenced key |
| `created_by` | `CHAR(36)` | NO |  | FK → `users.id` (cascade) | type matches referenced key |
| `name` | `TEXT` | NO |  |  |  |
| `description` | `TEXT` | YES |  |  |  |
| `campaign_type` | `TEXT` | NO |  |  |  |
| `type` | `TEXT` | NO |  |  |  |
| `api_type` | `TEXT` | NO |  |  |  |
| `template_id` | `CHAR(36)` | YES |  | FK → `templates.id` (no action) | type matches referenced key |
| `template_name` | `TEXT` | YES |  |  |  |
| `template_language` | `TEXT` | YES |  |  |  |
| `variable_mapping` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `contact_groups` | `JSON` | YES | `(JSON_ARRAY())` |  |  |
| `audience_type` | `TEXT` | YES | `('all')` |  |  |
| `platform` | `TEXT` | YES |  |  |  |
| `csv_data` | `JSON` | YES | `(JSON_ARRAY())` |  |  |
| `api_key` | `VARCHAR(255)` | YES |  |  |  |
| `api_endpoint` | `TEXT` | YES |  |  |  |
| `status` | `VARCHAR(255)` | YES | `'draft'` |  |  |
| `scheduled_at` | `DATETIME(3)` | YES |  |  | UTC |
| `recipient_count` | `INT` | YES | `0` |  |  |
| `sent_count` | `INT` | YES | `0` |  |  |
| `delivered_count` | `INT` | YES | `0` |  |  |
| `read_count` | `INT` | YES | `0` |  |  |
| `replied_count` | `INT` | YES | `0` |  |  |
| `failed_count` | `INT` | YES | `0` |  |  |
| `completed_at` | `DATETIME(3)` | YES |  |  | UTC |
| `population_started_at` | `DATETIME(3)` | YES |  |  | UTC |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

Indexes: `campaigns_channel_idx` (channel_id) · `campaigns_status_idx` (status) · `campaigns_created_idx` (created_at)

##### `campaign_recipients`

Per-recipient status of a campaign

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `campaign_id` | `CHAR(36)` | NO |  | FK → `campaigns.id` (cascade) | type matches referenced key |
| `contact_id` | `CHAR(36)` | YES |  | FK → `contacts.id` (cascade) | type matches referenced key |
| `phone` | `VARCHAR(255)` | NO |  |  |  |
| `name` | `TEXT` | YES |  |  |  |
| `status` | `VARCHAR(255)` | YES | `'pending'` |  |  |
| `whatsapp_message_id` | `VARCHAR(255)` | YES |  |  |  |
| `template_params` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `sent_at` | `DATETIME(3)` | YES |  |  | UTC |
| `delivered_at` | `DATETIME(3)` | YES |  |  | UTC |
| `read_at` | `DATETIME(3)` | YES |  |  | UTC |
| `error_code` | `VARCHAR(255)` | YES |  |  |  |
| `error_message` | `TEXT` | YES |  |  |  |
| `retry_count` | `INT` | YES | `0` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

Indexes: `recipients_campaign_idx` (campaign_id) · `recipients_status_idx` (status) · `recipients_phone_idx` (phone)

##### `email_campaigns`

Email marketing campaigns

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `user_id` | `CHAR(36)` | NO |  | FK → `users.id` (cascade) | type matches referenced key |
| `channel_id` | `VARCHAR(255)` | YES |  |  |  |
| `name` | `TEXT` | NO |  |  |  |
| `subject` | `TEXT` | NO |  |  |  |
| `preview_text` | `TEXT` | YES |  |  |  |
| `sender_name` | `TEXT` | YES | `('Cortesys Marketing')` |  |  |
| `sender_email` | `TEXT` | YES |  |  |  |
| `reply_to` | `TEXT` | YES |  |  |  |
| `content_html` | `TEXT` | NO |  |  |  |
| `content_text` | `TEXT` | YES |  |  |  |
| `template_id` | `VARCHAR(255)` | YES |  |  |  |
| `target_audience` | `TEXT` | YES | `('all_contacts')` |  |  |
| `target_group_id` | `VARCHAR(255)` | YES |  |  |  |
| `target_group_name` | `TEXT` | YES |  |  |  |
| `csv_data` | `JSON` | YES | `(JSON_ARRAY())` |  |  |
| `status` | `VARCHAR(255)` | YES | `'draft'` |  |  |
| `scheduled_at` | `DATETIME(3)` | YES |  |  | UTC |
| `sent_at` | `DATETIME(3)` | YES |  |  | UTC |
| `total_recipients` | `INT` | YES | `0` |  |  |
| `sent_count` | `INT` | YES | `0` |  |  |
| `delivered_count` | `INT` | YES | `0` |  |  |
| `opened_count` | `INT` | YES | `0` |  |  |
| `clicked_count` | `INT` | YES | `0` |  |  |
| `failed_count` | `INT` | YES | `0` |  |  |
| `error_message` | `TEXT` | YES |  |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

Indexes: `email_campaigns_user_idx` (user_id) · `email_campaigns_status_idx` (status)

##### `email_campaign_recipients`

Per-recipient status of an email campaign

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `campaign_id` | `CHAR(36)` | NO |  | FK → `email_campaigns.id` (cascade) | type matches referenced key |
| `contact_id` | `VARCHAR(255)` | YES |  |  |  |
| `email` | `TEXT` | NO |  |  |  |
| `name` | `TEXT` | YES |  |  |  |
| `status` | `VARCHAR(255)` | YES | `'pending'` |  |  |
| `sent_at` | `DATETIME(3)` | YES |  |  | UTC |
| `delivered_at` | `DATETIME(3)` | YES |  |  | UTC |
| `opened_at` | `DATETIME(3)` | YES |  |  | UTC |
| `error_message` | `TEXT` | YES |  |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

Indexes: `email_recipients_campaign_idx` (campaign_id) · `email_recipients_status_idx` (status)

##### `email_templates`

Reusable email templates

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `user_id` | `CHAR(36)` | YES |  | FK → `users.id` (cascade) | type matches referenced key |
| `name` | `TEXT` | NO |  |  |  |
| `category` | `TEXT` | YES | `('promotional')` |  |  |
| `subject` | `TEXT` | YES |  |  |  |
| `preview_text` | `TEXT` | YES |  |  |  |
| `content_html` | `TEXT` | NO |  |  |  |
| `content_text` | `TEXT` | YES |  |  |  |
| `is_system` | `BOOLEAN` | YES | `FALSE` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `sms_campaigns`

SMS marketing campaigns

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `user_id` | `CHAR(36)` | NO |  | FK → `users.id` (cascade) | type matches referenced key |
| `channel_id` | `VARCHAR(255)` | YES |  |  |  |
| `name` | `TEXT` | NO |  |  |  |
| `sender_id` | `TEXT` | YES | `('CORTESYS')` |  |  |
| `from_number` | `TEXT` | YES |  |  |  |
| `message` | `TEXT` | NO |  |  |  |
| `media_url` | `TEXT` | YES |  |  |  |
| `gateway` | `TEXT` | YES | `('simulator')` |  |  |
| `target_audience` | `TEXT` | YES | `('all_contacts')` |  |  |
| `target_group_id` | `VARCHAR(255)` | YES |  |  |  |
| `target_group_name` | `TEXT` | YES |  |  |  |
| `csv_data` | `JSON` | YES | `(JSON_ARRAY())` |  |  |
| `status` | `VARCHAR(255)` | YES | `'draft'` |  |  |
| `scheduled_at` | `DATETIME(3)` | YES |  |  | UTC |
| `sent_at` | `DATETIME(3)` | YES |  |  | UTC |
| `total_recipients` | `INT` | YES | `0` |  |  |
| `sent_count` | `INT` | YES | `0` |  |  |
| `delivered_count` | `INT` | YES | `0` |  |  |
| `failed_count` | `INT` | YES | `0` |  |  |
| `sms_segments_per_recipient` | `INT` | YES | `1` |  |  |
| `estimated_credits` | `INT` | YES | `0` |  |  |
| `error_message` | `TEXT` | YES |  |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

Indexes: `sms_campaigns_user_idx` (user_id) · `sms_campaigns_status_idx` (status)

##### `sms_campaign_recipients`

Per-recipient status of an SMS campaign

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `campaign_id` | `CHAR(36)` | NO |  | FK → `sms_campaigns.id` (cascade) | type matches referenced key |
| `contact_id` | `VARCHAR(255)` | YES |  |  |  |
| `phone` | `TEXT` | NO |  |  |  |
| `name` | `TEXT` | YES |  |  |  |
| `segments` | `INT` | YES | `1` |  |  |
| `status` | `VARCHAR(255)` | YES | `'pending'` |  |  |
| `sent_at` | `DATETIME(3)` | YES |  |  | UTC |
| `delivered_at` | `DATETIME(3)` | YES |  |  | UTC |
| `message_id` | `TEXT` | YES |  |  |  |
| `error_message` | `TEXT` | YES |  |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

Indexes: `sms_recipients_campaign_idx` (campaign_id) · `sms_recipients_status_idx` (status)

##### `sms_gateways`

Configured SMS providers

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `user_id` | `CHAR(36)` | YES |  | FK → `users.id` (cascade) | type matches referenced key |
| `provider` | `TEXT` | NO | `('simulator')` |  |  |
| `account_sid` | `TEXT` | YES |  |  |  |
| `auth_token` | `TEXT` | YES |  |  |  |
| `from_number` | `TEXT` | YES | `('+18005550199')` |  |  |
| `sender_id` | `TEXT` | YES | `('CORTESYS')` |  |  |
| `webhook_url` | `TEXT` | YES |  |  |  |
| `is_active` | `BOOLEAN` | YES | `TRUE` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `smtp_config`

SMTP servers (platform-wide or per user)

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `user_id` | `CHAR(36)` | YES |  | FK → `users.id` (cascade) | type matches referenced key |
| `host` | `TEXT` | NO |  |  |  |
| `port` | `INT` | NO |  |  |  |
| `secure` | `BOOLEAN` | YES | `FALSE` |  |  |
| `user` | `TEXT` | NO |  |  |  |
| `password` | `TEXT` | YES |  |  |  |
| `from_name` | `TEXT` | NO |  |  |  |
| `from_email` | `TEXT` | NO |  |  |  |
| `logo` | `TEXT` | YES | `('null')` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

#### Automation, chatbot & AI

##### `automations`

Automation flows with trigger and status

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `channel_id` | `CHAR(36)` | YES |  | FK → `channels.id` (cascade) | type matches referenced key |
| `name` | `TEXT` | NO |  |  |  |
| `description` | `TEXT` | YES |  |  |  |
| `trigger` | `TEXT` | NO |  |  |  |
| `trigger_config` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `status` | `VARCHAR(255)` | YES | `'inactive'` |  |  |
| `execution_count` | `INT` | YES | `0` |  |  |
| `last_executed_at` | `DATETIME(3)` | YES |  |  | UTC |
| `created_by` | `CHAR(36)` | YES |  | FK → `users.id` (no action) | type matches referenced key |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

Indexes: `automations_channel_idx` (channel_id) · `automations_status_idx` (status)

##### `automation_nodes`

Steps (nodes) of a flow

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `automation_id` | `CHAR(36)` | NO |  | FK → `automations.id` (cascade) | type matches referenced key |
| `node_id` | `VARCHAR(255)` | NO |  |  |  |
| `type` | `TEXT` | NO |  |  |  |
| `subtype` | `TEXT` | YES |  |  |  |
| `position` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `measured` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `data` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `connections` | `JSON` | YES | `(JSON_ARRAY())` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

Indexes: `automation_nodes_automation_idx` (automation_id)

##### `automation_edges`

Connections between flow nodes

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO |  | PK |  |
| `automation_id` | `CHAR(36)` | NO |  | FK → `automations.id` (cascade) | type matches referenced key |
| `source_node_id` | `VARCHAR(255)` | NO |  |  |  |
| `target_node_id` | `VARCHAR(255)` | NO |  |  |  |
| `source_handle` | `VARCHAR(255)` | YES |  |  |  |
| `animated` | `BOOLEAN` | YES | `FALSE` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

Indexes: `automation_edges_automation_idx` (automation_id)

##### `automation_executions`

One run of a flow for a contact

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `automation_id` | `CHAR(36)` | NO |  | FK → `automations.id` (cascade) | type matches referenced key |
| `contact_id` | `CHAR(36)` | YES |  | FK → `contacts.id` (no action) | type matches referenced key |
| `conversation_id` | `CHAR(36)` | YES |  | FK → `conversations.id` (no action) | type matches referenced key |
| `trigger_data` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `trigger_message_id` | `VARCHAR(200)` | YES |  |  |  |
| `status` | `VARCHAR(255)` | NO |  |  |  |
| `current_node_id` | `VARCHAR(255)` | YES |  |  |  |
| `execution_path` | `JSON` | YES | `(JSON_ARRAY())` |  |  |
| `variables` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `result` | `TEXT` | YES |  |  |  |
| `error` | `TEXT` | YES |  |  |  |
| `started_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `completed_at` | `DATETIME(3)` | YES |  |  | UTC |

Indexes: `automation_executions_automation_idx` (automation_id) · `automation_executions_status_idx` (status) · `automation_executions_message_unique_idx` (automation_id, conversation_id, trigger_message_id) unique

##### `automation_execution_logs`

Per-node log of a run

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `execution_id` | `CHAR(36)` | NO |  | FK → `automation_executions.id` (cascade) | type matches referenced key |
| `node_id` | `VARCHAR(255)` | NO |  |  |  |
| `node_type` | `TEXT` | NO |  |  |  |
| `status` | `TEXT` | NO |  |  |  |
| `input` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `output` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `error` | `TEXT` | YES |  |  |  |
| `executed_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

Indexes: `automation_execution_logs_execution_idx` (execution_id)

##### `chatbots`

Chatbot definitions

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `uuid` | `VARCHAR(255)` | NO |  | UQ |  |
| `title` | `TEXT` | NO |  |  |  |
| `bubble_message` | `TEXT` | YES |  |  |  |
| `welcome_message` | `TEXT` | YES |  |  |  |
| `instructions` | `TEXT` | YES |  |  |  |
| `connect_message` | `TEXT` | YES |  |  |  |
| `language` | `TEXT` | YES | `('en')` |  |  |
| `interaction_type` | `TEXT` | YES | `('ai-only')` |  |  |
| `avatar_id` | `INT` | YES |  |  |  |
| `avatar_emoji` | `TEXT` | YES |  |  |  |
| `avatar_color` | `TEXT` | YES |  |  |  |
| `primary_color` | `TEXT` | YES | `('#3B82F6')` |  |  |
| `logo_url` | `TEXT` | YES |  |  |  |
| `embed_width` | `INT` | YES | `420` |  |  |
| `embed_height` | `INT` | YES | `745` |  |  |
| `is_active` | `BOOLEAN` | YES | `TRUE` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `ai_settings`

AI provider, model, key and trigger words per channel

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `channel_id` | `CHAR(36)` | YES |  | FK → `channels.id` (no action) | type matches referenced key |
| `provider` | `TEXT` | NO | `('openai')` |  |  |
| `api_key` | `TEXT` | NO |  |  |  |
| `model` | `TEXT` | NO | `('gpt-4o-mini')` |  |  |
| `endpoint` | `TEXT` | YES | `('https://api.openai.com/v1')` |  |  |
| `temperature` | `TEXT` | YES | `('0.7')` |  |  |
| `max_tokens` | `TEXT` | YES | `('2048')` |  |  |
| `is_active` | `BOOLEAN` | YES | `FALSE` |  |  |
| `words` | `JSON` | YES | `(JSON_ARRAY())` |  | JSON array |
| `site_id` | `VARCHAR(255)` | YES |  |  |  |
| `last_skip_reason` | `TEXT` | YES |  |  |  |
| `last_skip_at` | `DATETIME(3)` | YES |  |  | UTC |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `sites`

Websites with the chat widget installed

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `channel_id` | `VARCHAR(255)` | YES |  |  |  |
| `name` | `TEXT` | NO |  |  |  |
| `domain` | `TEXT` | NO |  |  |  |
| `widget_code` | `VARCHAR(255)` | NO |  | UQ |  |
| `widget_enabled` | `BOOLEAN` | NO | `TRUE` |  |  |
| `widget_config` | `JSON` | NO | `(JSON_OBJECT())` |  |  |
| `ai_training_config` | `JSON` | NO | `(CAST('{"trainFromKB": false, "trainFromDocum…` (full value in Appendix A) |  |  |
| `auto_assignment_config` | `JSON` | NO | `(CAST('{"enabled": false, "strategy": "round_…` (full value in Appendix A) |  |  |
| `created_at` | `DATETIME(3)` | NO | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `training_sources`

Knowledge sources for AI (documents, URLs)

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `site_id` | `VARCHAR(255)` | NO |  |  |  |
| `channel_id` | `VARCHAR(255)` | YES |  |  |  |
| `type` | `TEXT` | NO |  |  |  |
| `name` | `TEXT` | NO |  |  |  |
| `url` | `TEXT` | YES |  |  |  |
| `content` | `TEXT` | YES |  |  |  |
| `status` | `TEXT` | NO | `('pending')` |  |  |
| `error_message` | `TEXT` | YES |  |  |  |
| `chunk_count` | `INT` | YES | `0` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `training_data`

Processed training content

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `chatbot_id` | `CHAR(36)` | YES |  | FK → `chatbots.id` (cascade) | type matches referenced key |
| `type` | `TEXT` | NO |  |  |  |
| `title` | `TEXT` | YES |  |  |  |
| `content` | `TEXT` | YES |  |  |  |
| `metadata` | `JSON` | YES |  |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

Indexes: `training_data_chatbot_idx` (chatbot_id)

##### `training_chunks`

Searchable chunks of training content

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `source_id` | `VARCHAR(255)` | NO |  |  |  |
| `site_id` | `VARCHAR(255)` | NO |  |  |  |
| `content` | `TEXT` | NO |  |  |  |
| `embedding` | `JSON` | YES |  |  |  |
| `metadata` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `training_qa_pairs`

Question / answer pairs for AI

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `site_id` | `VARCHAR(255)` | NO |  |  |  |
| `channel_id` | `VARCHAR(255)` | YES |  |  |  |
| `question` | `TEXT` | NO |  |  |  |
| `answer` | `TEXT` | NO |  |  |  |
| `category` | `TEXT` | YES | `('general')` |  |  |
| `embedding` | `JSON` | YES |  |  |  |
| `is_active` | `BOOLEAN` | YES | `TRUE` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `knowledge_categories`

Help-center categories for the widget

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `site_id` | `CHAR(36)` | NO |  | FK → `sites.id` (cascade) | type matches referenced key |
| `parent_id` | `VARCHAR(255)` | YES |  |  |  |
| `name` | `VARCHAR(255)` | NO |  |  |  |
| `icon` | `VARCHAR(50)` | YES |  |  |  |
| `description` | `TEXT` | YES |  |  |  |
| `order` | `INT` | YES | `0` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

Indexes: `categories_site_idx` (site_id) · `categories_parent_idx` (parent_id)

##### `knowledge_articles`

Help-center articles for the widget

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `category_id` | `VARCHAR(255)` | NO |  |  |  |
| `title` | `VARCHAR(500)` | NO |  |  |  |
| `content` | `TEXT` | NO |  |  |  |
| `order` | `INT` | YES | `0` |  |  |
| `published` | `BOOLEAN` | YES | `TRUE` |  |  |
| `views` | `INT` | YES | `0` |  |  |
| `helpful` | `INT` | YES | `0` |  |  |
| `not_helpful` | `INT` | YES | `0` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

Indexes: `articles_category_idx` (category_id) · `articles_published_idx` (published)

#### Billing

##### `plans`

Subscription plans with prices, limits and features

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `name` | `VARCHAR(255)` | NO |  |  |  |
| `description` | `TEXT` | YES |  |  |  |
| `icon` | `VARCHAR(255)` | YES |  |  |  |
| `popular` | `BOOLEAN` | YES | `FALSE` |  |  |
| `badge` | `VARCHAR(255)` | YES |  |  |  |
| `color` | `VARCHAR(255)` | YES |  |  |  |
| `button_color` | `VARCHAR(255)` | YES |  |  |  |
| `monthly_price` | `DECIMAL(10,2)` | YES | `'0'` |  |  |
| `annual_price` | `DECIMAL(10,2)` | YES | `'0'` |  |  |
| `multi_currency_prices` | `JSON` | YES |  |  |  |
| `permissions` | `JSON` | YES |  |  |  |
| `features` | `JSON` | YES |  |  |  |
| `stripe_product_id` | `VARCHAR(255)` | YES |  |  |  |
| `stripe_price_id_monthly` | `VARCHAR(255)` | YES |  |  |  |
| `stripe_price_id_annual` | `VARCHAR(255)` | YES |  |  |  |
| `razorpay_plan_id_monthly` | `VARCHAR(255)` | YES |  |  |  |
| `razorpay_plan_id_annual` | `VARCHAR(255)` | YES |  |  |  |
| `paypal_product_id` | `VARCHAR(255)` | YES |  |  |  |
| `paypal_plan_id_monthly` | `VARCHAR(255)` | YES |  |  |  |
| `paypal_plan_id_annual` | `VARCHAR(255)` | YES |  |  |  |
| `paystack_plan_code_monthly` | `VARCHAR(255)` | YES |  |  |  |
| `paystack_plan_code_annual` | `VARCHAR(255)` | YES |  |  |  |
| `mercadopago_plan_id_monthly` | `VARCHAR(255)` | YES |  |  |  |
| `mercadopago_plan_id_annual` | `VARCHAR(255)` | YES |  |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `subscriptions`

A user's active / past plan subscription

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `user_id` | `CHAR(36)` | NO |  | FK → `users.id` (no action) | type matches referenced key |
| `plan_id` | `CHAR(36)` | NO |  | FK → `plans.id` (no action) | type matches referenced key |
| `plan_data` | `JSON` | NO |  |  |  |
| `status` | `VARCHAR(255)` | NO |  |  |  |
| `billing_cycle` | `VARCHAR(255)` | NO |  |  |  |
| `start_date` | `DATETIME(3)` | NO |  |  | UTC |
| `end_date` | `DATETIME(3)` | NO |  |  | UTC |
| `auto_renew` | `BOOLEAN` | YES | `TRUE` |  |  |
| `gateway_subscription_id` | `VARCHAR(255)` | YES |  |  |  |
| `gateway_provider` | `VARCHAR(255)` | YES |  |  |  |
| `gateway_status` | `VARCHAR(255)` | YES |  |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `transactions`

Payments and their gateway status

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `user_id` | `CHAR(36)` | NO |  | FK → `users.id` (no action) | type matches referenced key |
| `plan_id` | `CHAR(36)` | NO |  | FK → `plans.id` (no action) | type matches referenced key |
| `subscription_id` | `CHAR(36)` | YES |  | FK → `subscriptions.id` (no action) | type matches referenced key |
| `payment_provider_id` | `CHAR(36)` | NO |  | FK → `payment_providers.id` (no action) | type matches referenced key |
| `amount` | `DECIMAL(10,2)` | NO |  |  |  |
| `currency` | `VARCHAR(255)` | YES | `'USD'` |  |  |
| `billing_cycle` | `VARCHAR(255)` | NO |  |  |  |
| `provider_transaction_id` | `VARCHAR(255)` | YES |  |  |  |
| `provider_order_id` | `VARCHAR(255)` | YES |  |  |  |
| `provider_payment_id` | `VARCHAR(255)` | YES |  |  |  |
| `provider_subscription_id` | `VARCHAR(255)` | YES |  |  |  |
| `provider_payment_intent_id` | `VARCHAR(255)` | YES |  |  |  |
| `provider_setup_intent_id` | `VARCHAR(255)` | YES |  |  |  |
| `provider_invoice_id` | `VARCHAR(255)` | YES |  |  |  |
| `provider_customer_id` | `VARCHAR(255)` | YES |  |  |  |
| `status` | `VARCHAR(255)` | NO |  |  |  |
| `payment_method` | `VARCHAR(255)` | YES |  |  |  |
| `metadata` | `JSON` | YES |  |  |  |
| `paid_at` | `DATETIME(3)` | YES |  |  | UTC |
| `refunded_at` | `DATETIME(3)` | YES |  |  | UTC |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `payment_providers`

Configured payment gateways

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `name` | `VARCHAR(255)` | NO |  |  |  |
| `provider_key` | `VARCHAR(255)` | NO |  | UQ |  |
| `description` | `TEXT` | YES |  |  |  |
| `logo` | `VARCHAR(255)` | YES |  |  |  |
| `is_active` | `BOOLEAN` | YES | `TRUE` |  |  |
| `config` | `JSON` | YES |  |  |  |
| `supported_currencies` | `JSON` | YES |  |  |  |
| `supported_methods` | `JSON` | YES |  |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

#### Platform & administration

##### `analytics`

Daily aggregated messaging statistics

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `channel_id` | `VARCHAR(255)` | YES |  |  |  |
| `date` | `DATETIME(3)` | NO |  |  | UTC |
| `messages_sent` | `INT` | YES | `0` |  |  |
| `messages_delivered` | `INT` | YES | `0` |  |  |
| `messages_read` | `INT` | YES | `0` |  |  |
| `messages_replied` | `INT` | YES | `0` |  |  |
| `new_contacts` | `INT` | YES | `0` |  |  |
| `active_campaigns` | `INT` | YES | `0` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `client_api_keys`

API keys for the public REST API

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `user_id` | `CHAR(36)` | NO |  | FK → `users.id` (no action) | type matches referenced key |
| `channel_id` | `CHAR(36)` | YES |  | FK → `channels.id` (no action) | type matches referenced key |
| `name` | `VARCHAR(100)` | NO |  |  |  |
| `api_key` | `VARCHAR(64)` | NO |  | UQ |  |
| `secret_hash` | `VARCHAR(256)` | NO |  |  |  |
| `permissions` | `JSON` | YES | `(JSON_ARRAY())` |  |  |
| `is_active` | `BOOLEAN` | YES | `TRUE` |  |  |
| `last_used_at` | `DATETIME(3)` | YES |  |  | UTC |
| `request_count` | `INT` | YES | `0` |  |  |
| `monthly_request_count` | `INT` | YES | `0` |  |  |
| `monthly_reset_at` | `DATETIME(3)` | YES |  |  | UTC |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `revoked_at` | `DATETIME(3)` | YES |  |  | UTC |

##### `client_api_usage_logs`

Usage log of the public REST API

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `api_key_id` | `CHAR(36)` | NO |  | FK → `client_api_keys.id` (no action) | type matches referenced key |
| `user_id` | `CHAR(36)` | NO |  | FK → `users.id` (no action) | type matches referenced key |
| `channel_id` | `CHAR(36)` | YES |  | FK → `channels.id` (no action) | type matches referenced key |
| `endpoint` | `VARCHAR(255)` | NO |  |  |  |
| `method` | `VARCHAR(10)` | NO |  |  |  |
| `status_code` | `INT` | YES |  |  |  |
| `response_time` | `INT` | YES |  |  |  |
| `ip_address` | `VARCHAR(45)` | YES |  |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `client_webhooks`

Outbound webhooks to customers' systems

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `user_id` | `CHAR(36)` | NO |  | FK → `users.id` (no action) | type matches referenced key |
| `channel_id` | `CHAR(36)` | YES |  | FK → `channels.id` (no action) | type matches referenced key |
| `url` | `TEXT` | NO |  |  |  |
| `secret` | `VARCHAR(256)` | YES |  |  |  |
| `events` | `JSON` | YES | `(JSON_ARRAY())` |  |  |
| `is_active` | `BOOLEAN` | YES | `TRUE` |  |  |
| `last_triggered_at` | `DATETIME(3)` | YES |  |  | UTC |
| `failure_count` | `INT` | YES | `0` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `cron_job_logs`

History of scheduled-job runs

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `job_key` | `VARCHAR(100)` | NO |  |  |  |
| `job_name` | `VARCHAR(255)` | NO |  |  |  |
| `status` | `VARCHAR(50)` | NO |  |  |  |
| `message` | `TEXT` | YES |  |  |  |
| `duration_ms` | `INT` | YES | `0` |  |  |
| `executed_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `firebase_config`

Push-notification (Firebase) configuration

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `api_key` | `TEXT` | YES |  |  |  |
| `auth_domain` | `TEXT` | YES |  |  |  |
| `project_id` | `TEXT` | YES |  |  |  |
| `storage_bucket` | `TEXT` | YES |  |  |  |
| `messaging_sender_id` | `TEXT` | YES |  |  |  |
| `app_id` | `TEXT` | YES |  |  |  |
| `measurement_id` | `TEXT` | YES |  |  |  |
| `private_key` | `TEXT` | YES |  |  |  |
| `client_email` | `TEXT` | YES |  |  |  |
| `vapid_key` | `TEXT` | YES |  |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `notification_templates`

Templates for system notifications (email / SMS / push)

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `INT` | NO | AUTO_INCREMENT | PK | set by the application |
| `event_type` | `VARCHAR(255)` | NO |  | UQ |  |
| `label` | `VARCHAR(255)` | NO |  |  |  |
| `description` | `TEXT` | YES |  |  |  |
| `subject` | `TEXT` | NO |  |  |  |
| `html_body` | `TEXT` | NO |  |  |  |
| `sms_body` | `TEXT` | YES |  |  |  |
| `push_body` | `TEXT` | YES |  |  |  |
| `is_email_enabled` | `BOOLEAN` | YES | `TRUE` |  |  |
| `is_in_app_enabled` | `BOOLEAN` | YES | `TRUE` |  |  |
| `is_sms_enabled` | `BOOLEAN` | YES | `TRUE` |  |  |
| `is_push_enabled` | `BOOLEAN` | YES | `TRUE` |  |  |
| `variables` | `JSON` | YES | `(JSON_ARRAY())` |  | JSON array |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `notifications`

Notifications sent by admins

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `INT` | NO | AUTO_INCREMENT | PK | set by the application |
| `title` | `TEXT` | NO |  |  |  |
| `message` | `TEXT` | NO |  |  |  |
| `type` | `VARCHAR(255)` | NO | `'general'` |  |  |
| `created_by` | `VARCHAR(255)` | NO | `'system'` |  |  |
| `channel_id` | `CHAR(36)` | YES |  | FK → `channels.id` (set null) | type matches referenced key |
| `target_type` | `VARCHAR(255)` | NO |  |  |  |
| `target_ids` | `JSON` | YES | `(JSON_ARRAY())` |  | JSON array |
| `status` | `VARCHAR(255)` | NO | `'draft'` |  |  |
| `sent_at` | `DATETIME(3)` | YES |  |  | UTC |
| `created_at` | `DATETIME(3)` | NO | `CURRENT_TIMESTAMP(3)` |  | UTC |

Indexes: `notifications_channel_idx` (channel_id)

##### `panel_config`

Branding (name, logo, colors, homepage content)

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `name` | `VARCHAR(255)` | NO |  |  |  |
| `tagline` | `VARCHAR(255)` | YES |  |  |  |
| `description` | `TEXT` | YES |  |  |  |
| `logo` | `VARCHAR(255)` | YES |  |  |  |
| `logo2` | `VARCHAR(255)` | YES |  |  |  |
| `favicon` | `VARCHAR(255)` | YES |  |  |  |
| `default_language` | `VARCHAR(5)` | YES | `'en'` |  |  |
| `supported_languages` | `JSON` | YES | `(CAST('["en"]' AS JSON))` |  |  |
| `company_name` | `VARCHAR(255)` | YES |  |  |  |
| `company_website` | `VARCHAR(255)` | YES |  |  |  |
| `support_email` | `VARCHAR(255)` | YES |  |  |  |
| `currency` | `VARCHAR(10)` | YES | `'INR'` |  |  |
| `country` | `VARCHAR(2)` | YES | `'IN'` |  |  |
| `embedded_signup_enabled` | `BOOLEAN` | YES | `TRUE` |  |  |
| `public_origin` | `TEXT` | YES |  |  |  |
| `appearance_config` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `platform_access_levels`

Access-level presets for users *(created by the application at startup)*

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `level_number` | `INT` | NO |  | UQ |  |
| `name` | `VARCHAR(100)` | NO |  |  |  |
| `description` | `TEXT` | YES |  |  |  |
| `badge_color` | `VARCHAR(50)` | YES | `'blue'` |  |  |
| `max_channels` | `INT` | YES | `1` |  |  |
| `max_contacts` | `INT` | YES | `500` |  |  |
| `max_messages_monthly` | `INT` | YES | `1000` |  |  |
| `max_campaigns` | `INT` | YES | `5` |  |  |
| `ai_assistant_enabled` | `BOOLEAN` | YES | `TRUE` |  |  |
| `sms_enabled` | `BOOLEAN` | YES | `FALSE` |  |  |
| `email_enabled` | `BOOLEAN` | YES | `FALSE` |  |  |
| `priority_support` | `BOOLEAN` | YES | `FALSE` |  |  |
| `api_access` | `BOOLEAN` | YES | `FALSE` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  |  |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  |  |

##### `platform_announcements`

Announcement banners *(created by the application at startup)*

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `title` | `TEXT` | NO |  |  |  |
| `message` | `TEXT` | NO |  |  |  |
| `type` | `VARCHAR(50)` | YES | `'info'` |  |  |
| `target_audience` | `VARCHAR(50)` | YES | `'all'` |  |  |
| `position` | `VARCHAR(50)` | YES | `'dashboard_top'` |  |  |
| `cta_label` | `VARCHAR(100)` | YES |  |  |  |
| `cta_url` | `TEXT` | YES |  |  |  |
| `is_active` | `BOOLEAN` | YES | `TRUE` |  |  |
| `priority` | `INT` | YES | `1` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  |  |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  |  |

##### `platform_blogs`

Blog posts on the public site

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `title` | `VARCHAR(255)` | NO |  |  |  |
| `slug` | `VARCHAR(255)` | NO |  | UQ |  |
| `thumbnail` | `TEXT` | YES |  |  |  |
| `short_description` | `TEXT` | YES |  |  |  |
| `content` | `TEXT` | NO |  |  |  |
| `author` | `VARCHAR(100)` | YES | `'Cortesys Team'` |  |  |
| `tags` | `JSON` | YES | `(JSON_ARRAY())` |  |  |
| `is_published` | `BOOLEAN` | YES | `TRUE` |  |  |
| `views_count` | `INT` | YES | `0` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `platform_languages`

Enabled languages and translations

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `code` | `VARCHAR(10)` | NO |  | UQ |  |
| `name` | `VARCHAR(100)` | NO |  |  |  |
| `native_name` | `VARCHAR(100)` | NO |  |  |  |
| `icon` | `VARCHAR(10)` | YES |  |  |  |
| `direction` | `VARCHAR(3)` | NO | `'ltr'` |  |  |
| `is_enabled` | `BOOLEAN` | NO | `TRUE` |  |  |
| `is_default` | `BOOLEAN` | NO | `FALSE` |  |  |
| `translations` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `sort_order` | `INT` | YES | `0` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `platform_user_requests`

Requests users send to the platform admin *(created by the application at startup)*

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `user_id` | `VARCHAR(255)` | YES |  |  |  |
| `request_type` | `VARCHAR(100)` | NO |  |  |  |
| `title` | `VARCHAR(255)` | NO |  |  |  |
| `description` | `TEXT` | YES |  |  |  |
| `status` | `VARCHAR(50)` | YES | `'pending'` |  |  |
| `admin_notes` | `TEXT` | YES |  |  |  |
| `resolved_by` | `VARCHAR(255)` | YES |  |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  |  |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  |  |

##### `policy_pages`

Terms, privacy and other policy pages

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `title` | `VARCHAR(255)` | NO |  |  |  |
| `slug` | `VARCHAR(255)` | NO |  | UQ |  |
| `content` | `TEXT` | NO |  |  |  |
| `meta_title` | `TEXT` | YES |  |  |  |
| `meta_description` | `TEXT` | YES |  |  |  |
| `is_published` | `BOOLEAN` | YES | `TRUE` |  |  |
| `is_system` | `BOOLEAN` | YES | `FALSE` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `sent_notifications`

Delivery of notifications to users

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `INT` | NO | AUTO_INCREMENT | PK | set by the application |
| `notification_id` | `INT` | NO |  | FK → `notifications.id` (cascade) |  |
| `user_id` | `VARCHAR(255)` | YES |  |  |  |
| `is_read` | `BOOLEAN` | YES | `FALSE` |  |  |
| `read_at` | `DATETIME(3)` | YES |  |  | UTC |
| `sent_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `storage_settings`

File storage provider configuration

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `provider` | `TEXT` | YES | `('digitalocean')` |  |  |
| `space_name` | `TEXT` | NO |  |  |  |
| `endpoint` | `TEXT` | NO |  |  |  |
| `region` | `TEXT` | NO |  |  |  |
| `access_key` | `TEXT` | NO |  |  |  |
| `secret_key` | `TEXT` | NO |  |  |  |
| `is_active` | `BOOLEAN` | YES | `FALSE` |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `support_tickets`

Support tickets

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `title` | `TEXT` | NO |  |  |  |
| `description` | `TEXT` | NO |  |  |  |
| `status` | `ENUM('open', 'in_progress', 'resolved', 'closed')` | NO | `'open'` |  |  |
| `priority` | `ENUM('low', 'medium', 'high', 'urgent')` | NO | `'medium'` |  |  |
| `creator_id` | `VARCHAR(255)` | NO |  |  |  |
| `creator_type` | `ENUM('user', 'team', 'admin', 'superadmin')` | NO |  |  |  |
| `creator_name` | `TEXT` | NO |  |  |  |
| `creator_email` | `TEXT` | NO |  |  |  |
| `assigned_to_id` | `VARCHAR(255)` | YES |  |  |  |
| `assigned_to_name` | `TEXT` | YES |  |  |  |
| `created_at` | `DATETIME(3)` | NO | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | NO | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `resolved_at` | `DATETIME(3)` | YES |  |  | UTC |
| `closed_at` | `DATETIME(3)` | YES |  |  | UTC |

##### `system_configurations`

Global platform settings (registration, verification, SMTP, SEO, maintenance, ...)

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `'default'` | PK |  |
| `site_title` | `VARCHAR(255)` | YES | `'Cortesys'` |  |  |
| `timezone` | `VARCHAR(255)` | YES | `'UTC'` |  |  |
| `currency` | `VARCHAR(255)` | YES | `'USD'` |  |  |
| `currency_symbol` | `VARCHAR(255)` | YES | `'$'` |  |  |
| `site_base_color` | `VARCHAR(255)` | YES | `'#16a34a'` |  |  |
| `records_per_page` | `INT` | YES | `20` |  |  |
| `currency_display_mode` | `VARCHAR(255)` | YES | `'both'` |  |  |
| `home_default_service` | `VARCHAR(255)` | YES | `'whatsapp_marketing'` |  |  |
| `referral_commission` | `DOUBLE` | YES | `10` |  |  |
| `logo` | `TEXT` | YES |  |  |  |
| `favicon` | `TEXT` | YES |  |  |  |
| `user_registration` | `BOOLEAN` | YES | `TRUE` |  |  |
| `force_ssl` | `BOOLEAN` | YES | `FALSE` |  |  |
| `agree_policy` | `BOOLEAN` | YES | `TRUE` |  |  |
| `force_secure_password` | `BOOLEAN` | YES | `TRUE` |  |  |
| `kyc_verification` | `BOOLEAN` | YES | `FALSE` |  |  |
| `email_verification` | `BOOLEAN` | YES | `FALSE` |  |  |
| `email_notification` | `BOOLEAN` | YES | `TRUE` |  |  |
| `mobile_verification` | `BOOLEAN` | YES | `FALSE` |  |  |
| `sms_notification` | `BOOLEAN` | YES | `TRUE` |  |  |
| `push_notification` | `BOOLEAN` | YES | `TRUE` |  |  |
| `post_auto_approval` | `BOOLEAN` | YES | `TRUE` |  |  |
| `language_option` | `BOOLEAN` | YES | `TRUE` |  |  |
| `global_email_template` | `TEXT` | YES |  |  |  |
| `global_sms_template` | `TEXT` | YES |  |  |  |
| `global_push_template` | `TEXT` | YES |  |  |  |
| `smtp_settings` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `sms_settings` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `push_settings` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `seo_settings` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `frontend_settings` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `extension_settings` | `JSON` | YES | `(JSON_OBJECT())` |  |  |
| `maintenance_mode` | `JSON` | YES | `(CAST('{"enabled":false,"title":"Platform Mai…` (full value in Appendix A) |  |  |
| `gdpr_cookie` | `JSON` | YES | `(CAST('{"enabled":true,"bannerText":"We use c…` (full value in Appendix A) |  |  |
| `custom_css` | `TEXT` | YES | `('')` |  |  |
| `robots_txt` | `TEXT` | YES | `('User-agent: * Allow: / Disallow: /admin/ Di…` (full value in Appendix A) |  |  |
| `sitemap_xml` | `TEXT` | YES | `('<?xml version="1.0" encoding="UTF-8"?> <url…` (full value in Appendix A) |  |  |
| `created_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `updated_at` | `DATETIME(3)` | YES | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `ticket_messages`

Messages within a support ticket

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `ticket_id` | `CHAR(36)` | NO |  | FK → `support_tickets.id` (cascade) | type matches referenced key |
| `sender_id` | `VARCHAR(255)` | NO |  |  |  |
| `sender_type` | `ENUM('user', 'team', 'admin', 'superadmin')` | NO |  |  |  |
| `sender_name` | `TEXT` | NO |  |  |  |
| `message` | `TEXT` | NO |  |  |  |
| `is_internal` | `BOOLEAN` | NO | `FALSE` |  |  |
| `created_at` | `DATETIME(3)` | NO | `CURRENT_TIMESTAMP(3)` |  | UTC |

##### `update_run_events`

Progress events of an update run

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `INT` | NO | AUTO_INCREMENT | PK | set by the application |
| `run_id` | `CHAR(36)` | NO |  | FK → `update_runs.id` (cascade) | type matches referenced key |
| `step` | `VARCHAR(50)` | NO |  |  |  |
| `status` | `VARCHAR(20)` | NO |  |  |  |
| `message` | `TEXT` | NO |  |  |  |
| `progress` | `INT` | YES |  |  |  |
| `created_at` | `DATETIME(3)` | NO | `CURRENT_TIMESTAMP(3)` |  | UTC |

Indexes: `update_run_events_run_id_idx` (run_id, id)

##### `update_runs`

In-app update runs

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | `CHAR(36)` | NO | `(UUID())` | PK |  |
| `triggered_by` | `CHAR(36)` | YES |  | FK → `users.id` (set null) | type matches referenced key |
| `triggered_by_username` | `TEXT` | YES |  |  |  |
| `from_version` | `TEXT` | YES |  |  |  |
| `to_version` | `TEXT` | YES |  |  |  |
| `status` | `VARCHAR(20)` | NO | `'running'` |  |  |
| `final_message` | `TEXT` | YES |  |  |  |
| `started_at` | `DATETIME(3)` | NO | `CURRENT_TIMESTAMP(3)` |  | UTC |
| `finished_at` | `DATETIME(3)` | YES |  |  | UTC |

Indexes: `update_runs_started_at_idx` (started_at)

> `contacts.store_id` previously referenced a store table of the removed e-commerce module; it is kept as a plain nullable column.

---

## 12. Security

| Area | Measure |
|---|---|
| Passwords | bcrypt hashes; never returned by the API |
| Sessions | Database-backed sessions, `HttpOnly` cookies, `Secure` + `SameSite=None` only over HTTPS |
| Tokens | JWT (7 days) signed with `JWT_SECRET` (falls back to `SESSION_SECRET`) |
| CSRF | Double-submit token (`csrf_token` cookie + `X-CSRF-Token` header) on state-changing requests |
| Authorization | Role and permission middleware on every protected route; superadmin-only admin endpoints |
| Tenant isolation | Ownership checks on channel-scoped routes; other tenants' resources return 404 |
| Rate limiting | Per-IP / per-user limits (`API_RATE_LIMIT*`), stricter limits for public widget endpoints |
| Webhooks | Payment webhooks verified by signature and de-duplicated; WhatsApp webhooks de-duplicated by message ID |
| Installer | Setup endpoints permanently closed after installation |
| Startup checks | Production refuses placeholder `SESSION_SECRET` and an unreachable database |
| Headers | `X-Content-Type-Options: nosniff`, `Referrer-Policy`, HSTS over HTTPS (no frame blocking, so the widget can be embedded) |
| Secrets | Meta access tokens and SMTP passwords are never returned to non-owners |

---

## 13. Testing

```bash
npm test               # all suites (Vitest)
npm run check          # TypeScript type check
```

Suites live in `server/__tests__/` and `client/src/**/__tests__/`. They cover, among others: access control
(admin-only routes, tenant isolation of channels), the installer lock, sign-up/login/OTP flows, SMTP
configuration resolution, campaign queue behaviour, payment webhook de-duplication, automation cooldowns and
IDOR protection, the in-app updater and public-origin detection. HTTP tests use Supertest against an Express
app with a mocked database layer; tests that need a real database are skipped unless `DATABASE_URL` is set.

---

## 14. Deployment

### 14.1 Docker Compose

`docker-compose.yml` runs the **app** and **Redis**; MySQL runs outside the compose file (on the host, another
server or a managed service). The app reads `.env` (`env_file`), and the compose file overrides `PORT`, `HOST`
and `REDIS_URL`.

```bash
# .env
DATABASE_URL="mysql://USER:PASSWORD@localhost:3306/woomarket360"   # inside Docker, localhost -> host.docker.internal
SESSION_SECRET="<openssl rand -hex 32>"

docker compose up -d --build
docker compose logs -f app
```

The image is multi-stage (build → slim runtime), runs as a non-root user and has a health check on
`/api/health`. Persistent volume: `uploads_data` (`/app/uploads`).

### 14.2 VPS with PM2 and nginx

```mermaid
flowchart LR
  I[Internet] --> N[nginx :443<br/>TLS, X-Forwarded-Proto] --> P[PM2 cluster<br/>node dist/index.js :5000]
  P --> DB[(MySQL)]
  P --> R[(Redis)]
```

```bash
npm ci && npm run build
pm2 start ecosystem.config.cjs      # INSTANCES=n for cluster mode
pm2 save && pm2 startup
```

nginx proxies `https://your-domain` to `127.0.0.1:5000` and must forward `X-Forwarded-Proto` (secure
cookies) and the WebSocket `Upgrade` headers (Socket.IO). See `nginx.conf.example`.

### 14.3 Meta WhatsApp configuration

1. Create a Meta app with the WhatsApp product; note the App ID, App Secret and Embedded Signup config ID.
2. Enter them in *Superadmin → Settings → Embedded Signup*.
3. In the Meta app, set the webhook callback URL to `https://your-domain/webhook/global` (or the per-channel URL
   `https://your-domain/webhook/<channelId>`; `GET /api/webhook/global-url` returns the exact URL), use the verify
   token from settings, and subscribe to `messages` and `message_template_status_update`.

---

## 15. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| App exits with "database is unreachable" | Check `DATABASE_URL`, that MySQL is running and that the user can connect from the app host |
| "Login successful" but you stay on the login page | Session cookie not kept: serve over one scheme; behind a proxy forward `X-Forwarded-Proto` |
| Sign-up says the email service is not configured | Email verification is on but SMTP is incomplete: configure SMTP (username required) or turn verification off |
| `Cannot find package 'vite'` in production | Old build: rebuild; production never loads Vite |
| Docker app cannot reach a database on the host | Use `localhost` in `DATABASE_URL`; make sure no other container publishes port 3306/5432 on the host |
| Messages stay "queued" | Channel token invalid or tier limit reached: check *Channels → Health* and the server log |

---

## Appendix A — MySQL schema script

Complete DDL for all 69 tables (MySQL 8.0.13+). Tables are created first and foreign keys added
afterwards, so the script runs in one pass. Every statement was checked with a MySQL SQL parser.

```sql
-- MySQL 8.0.13+ schema (InnoDB, utf8mb4).
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE `ai_settings` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `channel_id` CHAR(36),
  `provider` TEXT NOT NULL DEFAULT ('openai'),
  `api_key` TEXT NOT NULL,
  `model` TEXT NOT NULL DEFAULT ('gpt-4o-mini'),
  `endpoint` TEXT DEFAULT ('https://api.openai.com/v1'),
  `temperature` TEXT DEFAULT ('0.7'),
  `max_tokens` TEXT DEFAULT ('2048'),
  `is_active` BOOLEAN DEFAULT FALSE,
  `words` JSON DEFAULT (JSON_ARRAY()),
  `site_id` VARCHAR(255),
  `last_skip_reason` TEXT,
  `last_skip_at` DATETIME(3),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `analytics` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `channel_id` VARCHAR(255),
  `date` DATETIME(3) NOT NULL,
  `messages_sent` INT DEFAULT 0,
  `messages_delivered` INT DEFAULT 0,
  `messages_read` INT DEFAULT 0,
  `messages_replied` INT DEFAULT 0,
  `new_contacts` INT DEFAULT 0,
  `active_campaigns` INT DEFAULT 0,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `api_logs` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `channel_id` CHAR(36),
  `request_type` VARCHAR(50) NOT NULL,
  `endpoint` TEXT NOT NULL,
  `method` VARCHAR(10) NOT NULL,
  `request_body` JSON,
  `response_status` INT,
  `response_body` JSON,
  `duration` INT,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `automation_edges` (
  `id` CHAR(36) NOT NULL,
  `automation_id` CHAR(36) NOT NULL,
  `source_node_id` VARCHAR(255) NOT NULL,
  `target_node_id` VARCHAR(255) NOT NULL,
  `source_handle` VARCHAR(255),
  `animated` BOOLEAN DEFAULT FALSE,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `automation_edges_unique_handle_idx` (`automation_id`, `source_node_id`, `target_node_id`, `source_handle`),
  KEY `automation_edges_automation_idx` (`automation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `automation_execution_logs` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `execution_id` CHAR(36) NOT NULL,
  `node_id` VARCHAR(255) NOT NULL,
  `node_type` TEXT NOT NULL,
  `status` TEXT NOT NULL,
  `input` JSON DEFAULT (JSON_OBJECT()),
  `output` JSON DEFAULT (JSON_OBJECT()),
  `error` TEXT,
  `executed_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `automation_execution_logs_execution_idx` (`execution_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `automation_executions` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `automation_id` CHAR(36) NOT NULL,
  `contact_id` CHAR(36),
  `conversation_id` CHAR(36),
  `trigger_data` JSON DEFAULT (JSON_OBJECT()),
  `trigger_message_id` VARCHAR(200),
  `status` VARCHAR(255) NOT NULL,
  `current_node_id` VARCHAR(255),
  `execution_path` JSON DEFAULT (JSON_ARRAY()),
  `variables` JSON DEFAULT (JSON_OBJECT()),
  `result` TEXT,
  `error` TEXT,
  `started_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `completed_at` DATETIME(3),
  PRIMARY KEY (`id`),
  KEY `automation_executions_automation_idx` (`automation_id`),
  KEY `automation_executions_status_idx` (`status`),
  UNIQUE KEY `automation_executions_message_unique_idx` (`automation_id`, `conversation_id`, `trigger_message_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `automation_nodes` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `automation_id` CHAR(36) NOT NULL,
  `node_id` VARCHAR(255) NOT NULL,
  `type` TEXT NOT NULL,
  `subtype` TEXT,
  `position` JSON DEFAULT (JSON_OBJECT()),
  `measured` JSON DEFAULT (JSON_OBJECT()),
  `data` JSON DEFAULT (JSON_OBJECT()),
  `connections` JSON DEFAULT (JSON_ARRAY()),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `automation_nodes_unique_idx` (`automation_id`, `node_id`),
  KEY `automation_nodes_automation_idx` (`automation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `automations` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `channel_id` CHAR(36),
  `name` TEXT NOT NULL,
  `description` TEXT,
  `trigger` TEXT NOT NULL,
  `trigger_config` JSON DEFAULT (JSON_OBJECT()),
  `status` VARCHAR(255) DEFAULT 'inactive',
  `execution_count` INT DEFAULT 0,
  `last_executed_at` DATETIME(3),
  `created_by` CHAR(36),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `automations_channel_idx` (`channel_id`),
  KEY `automations_status_idx` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `campaign_recipients` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `campaign_id` CHAR(36) NOT NULL,
  `contact_id` CHAR(36),
  `phone` VARCHAR(255) NOT NULL,
  `name` TEXT,
  `status` VARCHAR(255) DEFAULT 'pending',
  `whatsapp_message_id` VARCHAR(255),
  `template_params` JSON DEFAULT (JSON_OBJECT()),
  `sent_at` DATETIME(3),
  `delivered_at` DATETIME(3),
  `read_at` DATETIME(3),
  `error_code` VARCHAR(255),
  `error_message` TEXT,
  `retry_count` INT DEFAULT 0,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `campaign_phone_unique` (`campaign_id`, `phone`),
  KEY `recipients_campaign_idx` (`campaign_id`),
  KEY `recipients_status_idx` (`status`),
  KEY `recipients_phone_idx` (`phone`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `campaigns` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `channel_id` CHAR(36),
  `created_by` CHAR(36) NOT NULL,
  `name` TEXT NOT NULL,
  `description` TEXT,
  `campaign_type` TEXT NOT NULL,
  `type` TEXT NOT NULL,
  `api_type` TEXT NOT NULL,
  `template_id` CHAR(36),
  `template_name` TEXT,
  `template_language` TEXT,
  `variable_mapping` JSON DEFAULT (JSON_OBJECT()),
  `contact_groups` JSON DEFAULT (JSON_ARRAY()),
  `audience_type` TEXT DEFAULT ('all'),
  `platform` TEXT,
  `csv_data` JSON DEFAULT (JSON_ARRAY()),
  `api_key` VARCHAR(255),
  `api_endpoint` TEXT,
  `status` VARCHAR(255) DEFAULT 'draft',
  `scheduled_at` DATETIME(3),
  `recipient_count` INT DEFAULT 0,
  `sent_count` INT DEFAULT 0,
  `delivered_count` INT DEFAULT 0,
  `read_count` INT DEFAULT 0,
  `replied_count` INT DEFAULT 0,
  `failed_count` INT DEFAULT 0,
  `completed_at` DATETIME(3),
  `population_started_at` DATETIME(3),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `campaigns_channel_idx` (`channel_id`),
  KEY `campaigns_status_idx` (`status`),
  KEY `campaigns_created_idx` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `channel_signup_logs` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `user_id` VARCHAR(255) NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'incomplete',
  `step` VARCHAR(50) NOT NULL DEFAULT 'token_exchange',
  `error_message` TEXT,
  `error_details` JSON,
  `phone_number` TEXT,
  `waba_id` TEXT,
  `channel_id` VARCHAR(255),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `channels` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `name` TEXT NOT NULL,
  `phone_number_id` TEXT NOT NULL,
  `access_token` TEXT NOT NULL,
  `whatsapp_business_account_id` TEXT,
  `phone_number` TEXT,
  `app_id` TEXT,
  `is_active` BOOLEAN DEFAULT TRUE,
  `is_coexistence` BOOLEAN DEFAULT FALSE,
  `health_status` TEXT DEFAULT ('unknown'),
  `last_health_check` DATETIME(3),
  `health_details` JSON DEFAULT (JSON_OBJECT()),
  `connection_method` VARCHAR(20) DEFAULT 'embedded',
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `created_by` VARCHAR(255) DEFAULT '',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `chatbots` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `uuid` VARCHAR(255) NOT NULL,
  `title` TEXT NOT NULL,
  `bubble_message` TEXT,
  `welcome_message` TEXT,
  `instructions` TEXT,
  `connect_message` TEXT,
  `language` TEXT DEFAULT ('en'),
  `interaction_type` TEXT DEFAULT ('ai-only'),
  `avatar_id` INT,
  `avatar_emoji` TEXT,
  `avatar_color` TEXT,
  `primary_color` TEXT DEFAULT ('#3B82F6'),
  `logo_url` TEXT,
  `embed_width` INT DEFAULT 420,
  `embed_height` INT DEFAULT 745,
  `is_active` BOOLEAN DEFAULT TRUE,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `chatbots_uuid_unique` (`uuid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `client_api_keys` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `user_id` CHAR(36) NOT NULL,
  `channel_id` CHAR(36),
  `name` VARCHAR(100) NOT NULL,
  `api_key` VARCHAR(64) NOT NULL,
  `secret_hash` VARCHAR(256) NOT NULL,
  `permissions` JSON DEFAULT (JSON_ARRAY()),
  `is_active` BOOLEAN DEFAULT TRUE,
  `last_used_at` DATETIME(3),
  `request_count` INT DEFAULT 0,
  `monthly_request_count` INT DEFAULT 0,
  `monthly_reset_at` DATETIME(3),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `revoked_at` DATETIME(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `client_api_keys_api_key_unique` (`api_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `client_api_usage_logs` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `api_key_id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NOT NULL,
  `channel_id` CHAR(36),
  `endpoint` VARCHAR(255) NOT NULL,
  `method` VARCHAR(10) NOT NULL,
  `status_code` INT,
  `response_time` INT,
  `ip_address` VARCHAR(45),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `client_webhooks` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `user_id` CHAR(36) NOT NULL,
  `channel_id` CHAR(36),
  `url` TEXT NOT NULL,
  `secret` VARCHAR(256),
  `events` JSON DEFAULT (JSON_ARRAY()),
  `is_active` BOOLEAN DEFAULT TRUE,
  `last_triggered_at` DATETIME(3),
  `failure_count` INT DEFAULT 0,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `contacts` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `channel_id` CHAR(36) NOT NULL,
  `tenant_id` VARCHAR(255),
  `name` TEXT NOT NULL,
  `phone` VARCHAR(255) NOT NULL,
  `email` TEXT,
  `groups` JSON DEFAULT (JSON_ARRAY()),
  `tags` JSON DEFAULT (JSON_ARRAY()),
  `status` VARCHAR(255) DEFAULT 'active',
  `source` VARCHAR(100),
  `store_id` CHAR(36),
  `external_id` VARCHAR(255),
  `last_contact` DATETIME(3),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `created_by` CHAR(36),
  PRIMARY KEY (`id`),
  UNIQUE KEY `contacts_channel_phone_unique` (`channel_id`, `phone`),
  UNIQUE KEY `contacts_store_external_unique` (`store_id`, `external_id`),
  KEY `contacts_channel_idx` (`channel_id`),
  KEY `contacts_phone_idx` (`phone`),
  KEY `contacts_status_idx` (`status`),
  KEY `contacts_tenant_idx` (`tenant_id`),
  KEY `contacts_store_idx` (`store_id`),
  KEY `contacts_external_id_idx` (`external_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `conversation_assignments` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `conversation_id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NOT NULL,
  `assigned_by` CHAR(36),
  `assigned_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `status` TEXT NOT NULL DEFAULT ('active'),
  `priority` TEXT DEFAULT ('normal'),
  `notes` TEXT,
  `resolved_at` DATETIME(3),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `conversation_pins` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `user_id` CHAR(36) NOT NULL,
  `conversation_id` CHAR(36) NOT NULL,
  `channel_id` CHAR(36),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `conversation_pins_user_idx` (`user_id`),
  KEY `conversation_pins_user_channel_idx` (`user_id`, `channel_id`),
  UNIQUE KEY `conversation_pins_user_conv_uniq` (`user_id`, `conversation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `conversations` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `channel_id` CHAR(36),
  `contact_id` CHAR(36),
  `assigned_to` CHAR(36),
  `contact_phone` VARCHAR(255),
  `contact_name` VARCHAR(255),
  `status` VARCHAR(255) DEFAULT 'open',
  `priority` TEXT DEFAULT ('normal'),
  `type` TEXT DEFAULT ('whatsapp'),
  `chatbot_id` VARCHAR(255),
  `session_id` TEXT,
  `tags` JSON DEFAULT (JSON_ARRAY()),
  `unread_count` INT DEFAULT 0,
  `last_message_at` DATETIME(3),
  `last_incoming_message_at` DATETIME(3),
  `last_message_text` TEXT,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `conversations_channel_idx` (`channel_id`),
  KEY `conversations_contact_idx` (`contact_id`),
  KEY `conversations_phone_idx` (`contact_phone`),
  KEY `conversations_status_idx` (`status`),
  KEY `conversations_last_msg_idx` (`channel_id`, `last_message_at`),
  KEY `conversations_assigned_idx` (`assigned_to`),
  KEY `conversations_last_msg_at_idx` (`last_message_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `cron_job_logs` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `job_key` VARCHAR(100) NOT NULL,
  `job_name` VARCHAR(255) NOT NULL,
  `status` VARCHAR(50) NOT NULL,
  `message` TEXT,
  `duration_ms` INT DEFAULT 0,
  `executed_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `email_campaign_recipients` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `campaign_id` CHAR(36) NOT NULL,
  `contact_id` VARCHAR(255),
  `email` TEXT NOT NULL,
  `name` TEXT,
  `status` VARCHAR(255) DEFAULT 'pending',
  `sent_at` DATETIME(3),
  `delivered_at` DATETIME(3),
  `opened_at` DATETIME(3),
  `error_message` TEXT,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `email_recipients_campaign_idx` (`campaign_id`),
  KEY `email_recipients_status_idx` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `email_campaigns` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `user_id` CHAR(36) NOT NULL,
  `channel_id` VARCHAR(255),
  `name` TEXT NOT NULL,
  `subject` TEXT NOT NULL,
  `preview_text` TEXT,
  `sender_name` TEXT DEFAULT ('Cortesys Marketing'),
  `sender_email` TEXT,
  `reply_to` TEXT,
  `content_html` TEXT NOT NULL,
  `content_text` TEXT,
  `template_id` VARCHAR(255),
  `target_audience` TEXT DEFAULT ('all_contacts'),
  `target_group_id` VARCHAR(255),
  `target_group_name` TEXT,
  `csv_data` JSON DEFAULT (JSON_ARRAY()),
  `status` VARCHAR(255) DEFAULT 'draft',
  `scheduled_at` DATETIME(3),
  `sent_at` DATETIME(3),
  `total_recipients` INT DEFAULT 0,
  `sent_count` INT DEFAULT 0,
  `delivered_count` INT DEFAULT 0,
  `opened_count` INT DEFAULT 0,
  `clicked_count` INT DEFAULT 0,
  `failed_count` INT DEFAULT 0,
  `error_message` TEXT,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `email_campaigns_user_idx` (`user_id`),
  KEY `email_campaigns_status_idx` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `email_templates` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `user_id` CHAR(36),
  `name` TEXT NOT NULL,
  `category` TEXT DEFAULT ('promotional'),
  `subject` TEXT,
  `preview_text` TEXT,
  `content_html` TEXT NOT NULL,
  `content_text` TEXT,
  `is_system` BOOLEAN DEFAULT FALSE,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `firebase_config` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `api_key` TEXT,
  `auth_domain` TEXT,
  `project_id` TEXT,
  `storage_bucket` TEXT,
  `messaging_sender_id` TEXT,
  `app_id` TEXT,
  `measurement_id` TEXT,
  `private_key` TEXT,
  `client_email` TEXT,
  `vapid_key` TEXT,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `groups` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `channelId` CHAR(36),
  `name` VARCHAR(255) NOT NULL,
  `description` TEXT,
  `created_by` CHAR(36),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `knowledge_articles` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `category_id` VARCHAR(255) NOT NULL,
  `title` VARCHAR(500) NOT NULL,
  `content` TEXT NOT NULL,
  `order` INT DEFAULT 0,
  `published` BOOLEAN DEFAULT TRUE,
  `views` INT DEFAULT 0,
  `helpful` INT DEFAULT 0,
  `not_helpful` INT DEFAULT 0,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `articles_category_idx` (`category_id`),
  KEY `articles_published_idx` (`published`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `knowledge_categories` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `site_id` CHAR(36) NOT NULL,
  `parent_id` VARCHAR(255),
  `name` VARCHAR(255) NOT NULL,
  `icon` VARCHAR(50),
  `description` TEXT,
  `order` INT DEFAULT 0,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `categories_site_idx` (`site_id`),
  KEY `categories_parent_idx` (`parent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `message_queue` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `campaign_id` CHAR(36),
  `channel_id` CHAR(36),
  `recipient_phone` VARCHAR(20) NOT NULL,
  `template_name` VARCHAR(100),
  `template_language` VARCHAR(20) DEFAULT 'en_US',
  `template_params` JSON DEFAULT (JSON_ARRAY()),
  `message_type` VARCHAR(20) NOT NULL,
  `status` VARCHAR(20) DEFAULT 'queued',
  `attempts` INT DEFAULT 0,
  `whatsapp_message_id` VARCHAR(100),
  `conversation_id` VARCHAR(100),
  `sent_via` VARCHAR(20),
  `cost` VARCHAR(20),
  `error_code` VARCHAR(50),
  `error_message` TEXT,
  `scheduled_for` DATETIME(3),
  `processed_at` DATETIME(3),
  `delivered_at` DATETIME(3),
  `read_at` DATETIME(3),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `messages` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `conversation_id` CHAR(36),
  `whatsapp_message_id` VARCHAR(255),
  `from_user` BOOLEAN DEFAULT FALSE,
  `direction` VARCHAR(255) DEFAULT 'outbound',
  `content` TEXT NOT NULL,
  `type` TEXT DEFAULT ('text'),
  `from_type` VARCHAR(255) DEFAULT 'user',
  `message_type` VARCHAR(255),
  `media_id` VARCHAR(255),
  `media_url` TEXT,
  `media_mime_type` VARCHAR(100),
  `media_sha256` VARCHAR(128),
  `status` VARCHAR(255) DEFAULT 'sent',
  `timestamp` DATETIME(3),
  `metadata` JSON DEFAULT (JSON_OBJECT()),
  `delivered_at` DATETIME(3),
  `read_at` DATETIME(3),
  `error_code` VARCHAR(50),
  `error_message` TEXT,
  `error_details` JSON,
  `campaign_id` CHAR(36),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `messages_conversation_idx` (`conversation_id`),
  KEY `messages_whatsapp_idx` (`whatsapp_message_id`),
  KEY `messages_direction_idx` (`direction`),
  KEY `messages_status_idx` (`status`),
  KEY `messages_timestamp_idx` (`timestamp`),
  KEY `messages_created_idx` (`created_at`),
  KEY `messages_conv_created_idx` (`conversation_id`, `created_at`),
  KEY `messages_conv_status_created_idx` (`conversation_id`, `status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `notification_templates` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `event_type` VARCHAR(255) NOT NULL,
  `label` VARCHAR(255) NOT NULL,
  `description` TEXT,
  `subject` TEXT NOT NULL,
  `html_body` TEXT NOT NULL,
  `sms_body` TEXT,
  `push_body` TEXT,
  `is_email_enabled` BOOLEAN DEFAULT TRUE,
  `is_in_app_enabled` BOOLEAN DEFAULT TRUE,
  `is_sms_enabled` BOOLEAN DEFAULT TRUE,
  `is_push_enabled` BOOLEAN DEFAULT TRUE,
  `variables` JSON DEFAULT (JSON_ARRAY()),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `notification_templates_event_type_unique` (`event_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `notifications` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `title` TEXT NOT NULL,
  `message` TEXT NOT NULL,
  `type` VARCHAR(255) NOT NULL DEFAULT 'general',
  `created_by` VARCHAR(255) NOT NULL DEFAULT 'system',
  `channel_id` CHAR(36),
  `target_type` VARCHAR(255) NOT NULL,
  `target_ids` JSON DEFAULT (JSON_ARRAY()),
  `status` VARCHAR(255) NOT NULL DEFAULT 'draft',
  `sent_at` DATETIME(3),
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `notifications_channel_idx` (`channel_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `otp_verifications` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `user_id` VARCHAR(255) NOT NULL,
  `otp_code` VARCHAR(6) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `is_used` BOOLEAN DEFAULT FALSE,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `panel_config` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `name` VARCHAR(255) NOT NULL,
  `tagline` VARCHAR(255),
  `description` TEXT,
  `logo` VARCHAR(255),
  `logo2` VARCHAR(255),
  `favicon` VARCHAR(255),
  `default_language` VARCHAR(5) DEFAULT 'en',
  `supported_languages` JSON DEFAULT (CAST('["en"]' AS JSON)),
  `company_name` VARCHAR(255),
  `company_website` VARCHAR(255),
  `support_email` VARCHAR(255),
  `currency` VARCHAR(10) DEFAULT 'INR',
  `country` VARCHAR(2) DEFAULT 'IN',
  `embedded_signup_enabled` BOOLEAN DEFAULT TRUE,
  `public_origin` TEXT,
  `appearance_config` JSON DEFAULT (JSON_OBJECT()),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `payment_providers` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `name` VARCHAR(255) NOT NULL,
  `provider_key` VARCHAR(255) NOT NULL,
  `description` TEXT,
  `logo` VARCHAR(255),
  `is_active` BOOLEAN DEFAULT TRUE,
  `config` JSON,
  `supported_currencies` JSON,
  `supported_methods` JSON,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `payment_providers_provider_key_unique` (`provider_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `plans` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `name` VARCHAR(255) NOT NULL,
  `description` TEXT,
  `icon` VARCHAR(255),
  `popular` BOOLEAN DEFAULT FALSE,
  `badge` VARCHAR(255),
  `color` VARCHAR(255),
  `button_color` VARCHAR(255),
  `monthly_price` DECIMAL(10,2) DEFAULT '0',
  `annual_price` DECIMAL(10,2) DEFAULT '0',
  `multi_currency_prices` JSON,
  `permissions` JSON,
  `features` JSON,
  `stripe_product_id` VARCHAR(255),
  `stripe_price_id_monthly` VARCHAR(255),
  `stripe_price_id_annual` VARCHAR(255),
  `razorpay_plan_id_monthly` VARCHAR(255),
  `razorpay_plan_id_annual` VARCHAR(255),
  `paypal_product_id` VARCHAR(255),
  `paypal_plan_id_monthly` VARCHAR(255),
  `paypal_plan_id_annual` VARCHAR(255),
  `paystack_plan_code_monthly` VARCHAR(255),
  `paystack_plan_code_annual` VARCHAR(255),
  `mercadopago_plan_id_monthly` VARCHAR(255),
  `mercadopago_plan_id_annual` VARCHAR(255),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `platform_blogs` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `title` VARCHAR(255) NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `thumbnail` TEXT,
  `short_description` TEXT,
  `content` TEXT NOT NULL,
  `author` VARCHAR(100) DEFAULT 'Cortesys Team',
  `tags` JSON DEFAULT (JSON_ARRAY()),
  `is_published` BOOLEAN DEFAULT TRUE,
  `views_count` INT DEFAULT 0,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `platform_blogs_slug_unique` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `platform_languages` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `code` VARCHAR(10) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `native_name` VARCHAR(100) NOT NULL,
  `icon` VARCHAR(10),
  `direction` VARCHAR(3) NOT NULL DEFAULT 'ltr',
  `is_enabled` BOOLEAN NOT NULL DEFAULT TRUE,
  `is_default` BOOLEAN NOT NULL DEFAULT FALSE,
  `translations` JSON DEFAULT (JSON_OBJECT()),
  `sort_order` INT DEFAULT 0,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `platform_languages_code_unique` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `policy_pages` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `title` VARCHAR(255) NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `content` TEXT NOT NULL,
  `meta_title` TEXT,
  `meta_description` TEXT,
  `is_published` BOOLEAN DEFAULT TRUE,
  `is_system` BOOLEAN DEFAULT FALSE,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `policy_pages_slug_unique` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `sent_notifications` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `notification_id` INT NOT NULL,
  `user_id` VARCHAR(255),
  `is_read` BOOLEAN DEFAULT FALSE,
  `read_at` DATETIME(3),
  `sent_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `session` (
  `sid` CHAR(36) NOT NULL,
  `sess` JSON NOT NULL,
  `expire` DATETIME(3) NOT NULL,
  PRIMARY KEY (`sid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `sites` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `channel_id` VARCHAR(255),
  `name` TEXT NOT NULL,
  `domain` TEXT NOT NULL,
  `widget_code` VARCHAR(255) NOT NULL,
  `widget_enabled` BOOLEAN NOT NULL DEFAULT TRUE,
  `widget_config` JSON NOT NULL DEFAULT (JSON_OBJECT()),
  `ai_training_config` JSON NOT NULL DEFAULT (CAST('{"trainFromKB": false, "trainFromDocuments": true}' AS JSON)),
  `auto_assignment_config` JSON NOT NULL DEFAULT (CAST('{"enabled": false, "strategy": "round_robin"}' AS JSON)),
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `sites_widget_code_unique` (`widget_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `sms_campaign_recipients` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `campaign_id` CHAR(36) NOT NULL,
  `contact_id` VARCHAR(255),
  `phone` TEXT NOT NULL,
  `name` TEXT,
  `segments` INT DEFAULT 1,
  `status` VARCHAR(255) DEFAULT 'pending',
  `sent_at` DATETIME(3),
  `delivered_at` DATETIME(3),
  `message_id` TEXT,
  `error_message` TEXT,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `sms_recipients_campaign_idx` (`campaign_id`),
  KEY `sms_recipients_status_idx` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `sms_campaigns` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `user_id` CHAR(36) NOT NULL,
  `channel_id` VARCHAR(255),
  `name` TEXT NOT NULL,
  `sender_id` TEXT DEFAULT ('CORTESYS'),
  `from_number` TEXT,
  `message` TEXT NOT NULL,
  `media_url` TEXT,
  `gateway` TEXT DEFAULT ('simulator'),
  `target_audience` TEXT DEFAULT ('all_contacts'),
  `target_group_id` VARCHAR(255),
  `target_group_name` TEXT,
  `csv_data` JSON DEFAULT (JSON_ARRAY()),
  `status` VARCHAR(255) DEFAULT 'draft',
  `scheduled_at` DATETIME(3),
  `sent_at` DATETIME(3),
  `total_recipients` INT DEFAULT 0,
  `sent_count` INT DEFAULT 0,
  `delivered_count` INT DEFAULT 0,
  `failed_count` INT DEFAULT 0,
  `sms_segments_per_recipient` INT DEFAULT 1,
  `estimated_credits` INT DEFAULT 0,
  `error_message` TEXT,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `sms_campaigns_user_idx` (`user_id`),
  KEY `sms_campaigns_status_idx` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `sms_gateways` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `user_id` CHAR(36),
  `provider` TEXT NOT NULL DEFAULT ('simulator'),
  `account_sid` TEXT,
  `auth_token` TEXT,
  `from_number` TEXT DEFAULT ('+18005550199'),
  `sender_id` TEXT DEFAULT ('CORTESYS'),
  `webhook_url` TEXT,
  `is_active` BOOLEAN DEFAULT TRUE,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `smtp_config` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `user_id` CHAR(36),
  `host` TEXT NOT NULL,
  `port` INT NOT NULL,
  `secure` BOOLEAN DEFAULT FALSE,
  `user` TEXT NOT NULL,
  `password` TEXT,
  `from_name` TEXT NOT NULL,
  `from_email` TEXT NOT NULL,
  `logo` TEXT DEFAULT ('null'),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `storage_settings` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `provider` TEXT DEFAULT ('digitalocean'),
  `space_name` TEXT NOT NULL,
  `endpoint` TEXT NOT NULL,
  `region` TEXT NOT NULL,
  `access_key` TEXT NOT NULL,
  `secret_key` TEXT NOT NULL,
  `is_active` BOOLEAN DEFAULT FALSE,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `subscriptions` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `user_id` CHAR(36) NOT NULL,
  `plan_id` CHAR(36) NOT NULL,
  `plan_data` JSON NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `billing_cycle` VARCHAR(255) NOT NULL,
  `start_date` DATETIME(3) NOT NULL,
  `end_date` DATETIME(3) NOT NULL,
  `auto_renew` BOOLEAN DEFAULT TRUE,
  `gateway_subscription_id` VARCHAR(255),
  `gateway_provider` VARCHAR(255),
  `gateway_status` VARCHAR(255),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `support_tickets` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `title` TEXT NOT NULL,
  `description` TEXT NOT NULL,
  `status` ENUM('open', 'in_progress', 'resolved', 'closed') NOT NULL DEFAULT 'open',
  `priority` ENUM('low', 'medium', 'high', 'urgent') NOT NULL DEFAULT 'medium',
  `creator_id` VARCHAR(255) NOT NULL,
  `creator_type` ENUM('user', 'team', 'admin', 'superadmin') NOT NULL,
  `creator_name` TEXT NOT NULL,
  `creator_email` TEXT NOT NULL,
  `assigned_to_id` VARCHAR(255),
  `assigned_to_name` TEXT,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `resolved_at` DATETIME(3),
  `closed_at` DATETIME(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `system_configurations` (
  `id` CHAR(36) NOT NULL DEFAULT 'default',
  `site_title` VARCHAR(255) DEFAULT 'Cortesys',
  `timezone` VARCHAR(255) DEFAULT 'UTC',
  `currency` VARCHAR(255) DEFAULT 'USD',
  `currency_symbol` VARCHAR(255) DEFAULT '$',
  `site_base_color` VARCHAR(255) DEFAULT '#16a34a',
  `records_per_page` INT DEFAULT 20,
  `currency_display_mode` VARCHAR(255) DEFAULT 'both',
  `home_default_service` VARCHAR(255) DEFAULT 'whatsapp_marketing',
  `referral_commission` DOUBLE DEFAULT 10,
  `logo` TEXT,
  `favicon` TEXT,
  `user_registration` BOOLEAN DEFAULT TRUE,
  `force_ssl` BOOLEAN DEFAULT FALSE,
  `agree_policy` BOOLEAN DEFAULT TRUE,
  `force_secure_password` BOOLEAN DEFAULT TRUE,
  `kyc_verification` BOOLEAN DEFAULT FALSE,
  `email_verification` BOOLEAN DEFAULT FALSE,
  `email_notification` BOOLEAN DEFAULT TRUE,
  `mobile_verification` BOOLEAN DEFAULT FALSE,
  `sms_notification` BOOLEAN DEFAULT TRUE,
  `push_notification` BOOLEAN DEFAULT TRUE,
  `post_auto_approval` BOOLEAN DEFAULT TRUE,
  `language_option` BOOLEAN DEFAULT TRUE,
  `global_email_template` TEXT,
  `global_sms_template` TEXT,
  `global_push_template` TEXT,
  `smtp_settings` JSON DEFAULT (JSON_OBJECT()),
  `sms_settings` JSON DEFAULT (JSON_OBJECT()),
  `push_settings` JSON DEFAULT (JSON_OBJECT()),
  `seo_settings` JSON DEFAULT (JSON_OBJECT()),
  `frontend_settings` JSON DEFAULT (JSON_OBJECT()),
  `extension_settings` JSON DEFAULT (JSON_OBJECT()),
  `maintenance_mode` JSON DEFAULT (CAST('{"enabled":false,"title":"Platform Maintenance","content":"We are currently undergoing scheduled maintenance. Please check back shortly.","bypassSecret":"bypass-admin-mode"}' AS JSON)),
  `gdpr_cookie` JSON DEFAULT (CAST('{"enabled":true,"bannerText":"We use cookies to improve your experience and analyze site traffic. By continuing to use our website, you agree to our use of cookies.","acceptButtonText":"Accept All","declineButtonText":"Reject Non-Essential","policyUrl":"/cookie-policy","cookieLifespanDays":365}' AS JSON)),
  `custom_css` TEXT DEFAULT (''),
  `robots_txt` TEXT DEFAULT ('User-agent: *
Allow: /
Disallow: /admin/
Disallow: /api/
Sitemap: https://cortesys.com/sitemap.xml'),
  `sitemap_xml` TEXT DEFAULT ('<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://cortesys.com/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://cortesys.com/terms</loc>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>
  <url>
    <loc>https://cortesys.com/privacy-policy</loc>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>
</urlset>'),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `templates` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `channel_id` CHAR(36) NOT NULL,
  `created_by` CHAR(36),
  `name` TEXT NOT NULL,
  `category` TEXT NOT NULL,
  `language` TEXT DEFAULT ('en_US'),
  `header` TEXT,
  `body` TEXT NOT NULL,
  `footer` TEXT,
  `buttons` JSON DEFAULT (JSON_ARRAY()),
  `variables` JSON DEFAULT (JSON_ARRAY()),
  `status` TEXT DEFAULT ('draft'),
  `rejection_reason` TEXT,
  `media_type` TEXT DEFAULT ('text'),
  `media_url` TEXT,
  `media_handle` TEXT,
  `carousel_cards` JSON DEFAULT (JSON_ARRAY()),
  `whatsapp_template_id` VARCHAR(255),
  `usage_count` INT DEFAULT 0,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `header_type` TEXT,
  `body_variables` INT,
  PRIMARY KEY (`id`),
  UNIQUE KEY `template_channel_wa_id_unique` (`whatsapp_template_id`, `channel_id`),
  KEY `templates_channel_idx` (`channel_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `ticket_messages` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `ticket_id` CHAR(36) NOT NULL,
  `sender_id` VARCHAR(255) NOT NULL,
  `sender_type` ENUM('user', 'team', 'admin', 'superadmin') NOT NULL,
  `sender_name` TEXT NOT NULL,
  `message` TEXT NOT NULL,
  `is_internal` BOOLEAN NOT NULL DEFAULT FALSE,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `training_chunks` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `source_id` VARCHAR(255) NOT NULL,
  `site_id` VARCHAR(255) NOT NULL,
  `content` TEXT NOT NULL,
  `embedding` JSON,
  `metadata` JSON DEFAULT (JSON_OBJECT()),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `training_data` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `chatbot_id` CHAR(36),
  `type` TEXT NOT NULL,
  `title` TEXT,
  `content` TEXT,
  `metadata` JSON,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `training_data_chatbot_idx` (`chatbot_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `training_qa_pairs` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `site_id` VARCHAR(255) NOT NULL,
  `channel_id` VARCHAR(255),
  `question` TEXT NOT NULL,
  `answer` TEXT NOT NULL,
  `category` TEXT DEFAULT ('general'),
  `embedding` JSON,
  `is_active` BOOLEAN DEFAULT TRUE,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `training_sources` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `site_id` VARCHAR(255) NOT NULL,
  `channel_id` VARCHAR(255),
  `type` TEXT NOT NULL,
  `name` TEXT NOT NULL,
  `url` TEXT,
  `content` TEXT,
  `status` TEXT NOT NULL DEFAULT ('pending'),
  `error_message` TEXT,
  `chunk_count` INT DEFAULT 0,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `transactions` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `user_id` CHAR(36) NOT NULL,
  `plan_id` CHAR(36) NOT NULL,
  `subscription_id` CHAR(36),
  `payment_provider_id` CHAR(36) NOT NULL,
  `amount` DECIMAL(10,2) NOT NULL,
  `currency` VARCHAR(255) DEFAULT 'USD',
  `billing_cycle` VARCHAR(255) NOT NULL,
  `provider_transaction_id` VARCHAR(255),
  `provider_order_id` VARCHAR(255),
  `provider_payment_id` VARCHAR(255),
  `provider_subscription_id` VARCHAR(255),
  `provider_payment_intent_id` VARCHAR(255),
  `provider_setup_intent_id` VARCHAR(255),
  `provider_invoice_id` VARCHAR(255),
  `provider_customer_id` VARCHAR(255),
  `status` VARCHAR(255) NOT NULL,
  `payment_method` VARCHAR(255),
  `metadata` JSON,
  `paid_at` DATETIME(3),
  `refunded_at` DATETIME(3),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `update_run_events` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `run_id` CHAR(36) NOT NULL,
  `step` VARCHAR(50) NOT NULL,
  `status` VARCHAR(20) NOT NULL,
  `message` TEXT NOT NULL,
  `progress` INT,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `update_run_events_run_id_idx` (`run_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `update_runs` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `triggered_by` CHAR(36),
  `triggered_by_username` TEXT,
  `from_version` TEXT,
  `to_version` TEXT,
  `status` VARCHAR(20) NOT NULL DEFAULT 'running',
  `final_message` TEXT,
  `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `finished_at` DATETIME(3),
  PRIMARY KEY (`id`),
  KEY `update_runs_started_at_idx` (`started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `user_activity_logs` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `user_id` CHAR(36) NOT NULL,
  `action` TEXT NOT NULL,
  `entity_type` TEXT,
  `entity_id` VARCHAR(255),
  `details` JSON DEFAULT (JSON_OBJECT()),
  `ip_address` TEXT,
  `user_agent` TEXT,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `user_notification_preferences` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `user_id` VARCHAR(255) NOT NULL,
  `event_type` VARCHAR(255) NOT NULL,
  `in_app_enabled` BOOLEAN DEFAULT TRUE,
  `email_enabled` BOOLEAN DEFAULT TRUE,
  `sound_enabled` BOOLEAN DEFAULT TRUE,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `users` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `username` VARCHAR(255) NOT NULL,
  `password` TEXT NOT NULL,
  `email` VARCHAR(255) NOT NULL,
  `first_name` TEXT,
  `last_name` TEXT,
  `role` VARCHAR(255) NOT NULL DEFAULT 'admin',
  `avatar` TEXT,
  `status` TEXT NOT NULL DEFAULT ('active'),
  `permissions` JSON NOT NULL,
  `channel_id` CHAR(36),
  `last_login` DATETIME(3),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `created_by` CHAR(36),
  `fcm_token` VARCHAR(512),
  `phone` TEXT,
  `is_email_verified` BOOLEAN DEFAULT FALSE,
  `is_mobile_verified` BOOLEAN DEFAULT FALSE,
  `stripe_customer_id` VARCHAR(255),
  `razorpay_customer_id` VARCHAR(255),
  `paypal_customer_id` VARCHAR(255),
  `paystack_customer_code` VARCHAR(255),
  `mercadopago_customer_id` VARCHAR(255),
  PRIMARY KEY (`id`),
  UNIQUE KEY `users_username_unique` (`username`),
  UNIQUE KEY `users_email_unique` (`email`),
  KEY `users_created_by_idx` (`created_by`),
  KEY `users_role_idx` (`role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `webhook_configs` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `channel_id` VARCHAR(255),
  `webhook_url` TEXT NOT NULL,
  `verify_token` VARCHAR(100) NOT NULL,
  `events` JSON NOT NULL DEFAULT (JSON_ARRAY()),
  `is_active` BOOLEAN DEFAULT TRUE,
  `last_ping_at` DATETIME(3),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `whatsapp_business_accounts_config` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `app_id` TEXT NOT NULL,
  `app_secret` TEXT NOT NULL,
  `config_id` TEXT NOT NULL,
  `created_by` VARCHAR(255) DEFAULT '',
  `is_active` BOOLEAN DEFAULT TRUE,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `whatsapp_channels` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `name` TEXT NOT NULL,
  `phone_number` VARCHAR(20) NOT NULL,
  `phone_number_id` VARCHAR(50) NOT NULL,
  `waba_id` VARCHAR(50) NOT NULL,
  `access_token` TEXT NOT NULL,
  `business_account_id` VARCHAR(50),
  `rate_limit_tier` VARCHAR(20) DEFAULT 'standard',
  `quality_rating` VARCHAR(20) DEFAULT 'green',
  `status` VARCHAR(20) DEFAULT 'inactive',
  `error_message` TEXT,
  `last_health_check` DATETIME(3),
  `message_limit` INT,
  `messages_used` INT,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `whatsapp_channels_phone_number_unique` (`phone_number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `platform_access_levels` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `level_number` INT NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `description` TEXT,
  `badge_color` VARCHAR(50) DEFAULT 'blue',
  `max_channels` INT DEFAULT 1,
  `max_contacts` INT DEFAULT 500,
  `max_messages_monthly` INT DEFAULT 1000,
  `max_campaigns` INT DEFAULT 5,
  `ai_assistant_enabled` BOOLEAN DEFAULT TRUE,
  `sms_enabled` BOOLEAN DEFAULT FALSE,
  `email_enabled` BOOLEAN DEFAULT FALSE,
  `priority_support` BOOLEAN DEFAULT FALSE,
  `api_access` BOOLEAN DEFAULT FALSE,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `platform_access_levels_level_number_unique` (`level_number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `platform_announcements` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `title` TEXT NOT NULL,
  `message` TEXT NOT NULL,
  `type` VARCHAR(50) DEFAULT 'info',
  `target_audience` VARCHAR(50) DEFAULT 'all',
  `position` VARCHAR(50) DEFAULT 'dashboard_top',
  `cta_label` VARCHAR(100),
  `cta_url` TEXT,
  `is_active` BOOLEAN DEFAULT TRUE,
  `priority` INT DEFAULT 1,
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `platform_user_requests` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `user_id` VARCHAR(255),
  `request_type` VARCHAR(100) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `description` TEXT,
  `status` VARCHAR(50) DEFAULT 'pending',
  `admin_notes` TEXT,
  `resolved_by` VARCHAR(255),
  `created_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `webhook_dedup` (
  `wamid` VARCHAR(255) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`wamid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Foreign keys (added after all tables exist)
ALTER TABLE `ai_settings` ADD CONSTRAINT `fk_ai_settings_channel_id` FOREIGN KEY (`channel_id`) REFERENCES `channels` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `api_logs` ADD CONSTRAINT `fk_api_logs_channel_id` FOREIGN KEY (`channel_id`) REFERENCES `channels` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `automation_edges` ADD CONSTRAINT `fk_automation_edges_automation_id` FOREIGN KEY (`automation_id`) REFERENCES `automations` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `automation_execution_logs` ADD CONSTRAINT `fk_automation_execution_logs_execution_id` FOREIGN KEY (`execution_id`) REFERENCES `automation_executions` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `automation_executions` ADD CONSTRAINT `fk_automation_executions_automation_id` FOREIGN KEY (`automation_id`) REFERENCES `automations` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `automation_executions` ADD CONSTRAINT `fk_automation_executions_contact_id` FOREIGN KEY (`contact_id`) REFERENCES `contacts` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `automation_executions` ADD CONSTRAINT `fk_automation_executions_conversation_id` FOREIGN KEY (`conversation_id`) REFERENCES `conversations` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `automation_nodes` ADD CONSTRAINT `fk_automation_nodes_automation_id` FOREIGN KEY (`automation_id`) REFERENCES `automations` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `automations` ADD CONSTRAINT `fk_automations_channel_id` FOREIGN KEY (`channel_id`) REFERENCES `channels` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `automations` ADD CONSTRAINT `fk_automations_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `campaign_recipients` ADD CONSTRAINT `fk_campaign_recipients_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `campaign_recipients` ADD CONSTRAINT `fk_campaign_recipients_contact_id` FOREIGN KEY (`contact_id`) REFERENCES `contacts` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `campaigns` ADD CONSTRAINT `fk_campaigns_channel_id` FOREIGN KEY (`channel_id`) REFERENCES `channels` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `campaigns` ADD CONSTRAINT `fk_campaigns_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `campaigns` ADD CONSTRAINT `fk_campaigns_template_id` FOREIGN KEY (`template_id`) REFERENCES `templates` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `client_api_keys` ADD CONSTRAINT `fk_client_api_keys_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `client_api_keys` ADD CONSTRAINT `fk_client_api_keys_channel_id` FOREIGN KEY (`channel_id`) REFERENCES `channels` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `client_api_usage_logs` ADD CONSTRAINT `fk_client_api_usage_logs_api_key_id` FOREIGN KEY (`api_key_id`) REFERENCES `client_api_keys` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `client_api_usage_logs` ADD CONSTRAINT `fk_client_api_usage_logs_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `client_api_usage_logs` ADD CONSTRAINT `fk_client_api_usage_logs_channel_id` FOREIGN KEY (`channel_id`) REFERENCES `channels` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `client_webhooks` ADD CONSTRAINT `fk_client_webhooks_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `client_webhooks` ADD CONSTRAINT `fk_client_webhooks_channel_id` FOREIGN KEY (`channel_id`) REFERENCES `channels` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `contacts` ADD CONSTRAINT `fk_contacts_channel_id` FOREIGN KEY (`channel_id`) REFERENCES `channels` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `contacts` ADD CONSTRAINT `fk_contacts_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE `conversation_assignments` ADD CONSTRAINT `fk_conversation_assignments_conversation_id` FOREIGN KEY (`conversation_id`) REFERENCES `conversations` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `conversation_assignments` ADD CONSTRAINT `fk_conversation_assignments_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `conversation_assignments` ADD CONSTRAINT `fk_conversation_assignments_assigned_by` FOREIGN KEY (`assigned_by`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `conversation_pins` ADD CONSTRAINT `fk_conversation_pins_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `conversation_pins` ADD CONSTRAINT `fk_conversation_pins_conversation_id` FOREIGN KEY (`conversation_id`) REFERENCES `conversations` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `conversation_pins` ADD CONSTRAINT `fk_conversation_pins_channel_id` FOREIGN KEY (`channel_id`) REFERENCES `channels` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `conversations` ADD CONSTRAINT `fk_conversations_channel_id` FOREIGN KEY (`channel_id`) REFERENCES `channels` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `conversations` ADD CONSTRAINT `fk_conversations_contact_id` FOREIGN KEY (`contact_id`) REFERENCES `contacts` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `conversations` ADD CONSTRAINT `fk_conversations_assigned_to` FOREIGN KEY (`assigned_to`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE `email_campaign_recipients` ADD CONSTRAINT `fk_email_campaign_recipients_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `email_campaigns` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `email_campaigns` ADD CONSTRAINT `fk_email_campaigns_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `email_templates` ADD CONSTRAINT `fk_email_templates_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `groups` ADD CONSTRAINT `fk_groups_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `knowledge_categories` ADD CONSTRAINT `fk_knowledge_categories_site_id` FOREIGN KEY (`site_id`) REFERENCES `sites` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `message_queue` ADD CONSTRAINT `fk_message_queue_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `message_queue` ADD CONSTRAINT `fk_message_queue_channel_id` FOREIGN KEY (`channel_id`) REFERENCES `channels` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `messages` ADD CONSTRAINT `fk_messages_conversation_id` FOREIGN KEY (`conversation_id`) REFERENCES `conversations` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `messages` ADD CONSTRAINT `fk_messages_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns` (`id`) ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE `notifications` ADD CONSTRAINT `fk_notifications_channel_id` FOREIGN KEY (`channel_id`) REFERENCES `channels` (`id`) ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE `sent_notifications` ADD CONSTRAINT `fk_sent_notifications_notification_id` FOREIGN KEY (`notification_id`) REFERENCES `notifications` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `sms_campaign_recipients` ADD CONSTRAINT `fk_sms_campaign_recipients_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `sms_campaigns` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `sms_campaigns` ADD CONSTRAINT `fk_sms_campaigns_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `sms_gateways` ADD CONSTRAINT `fk_sms_gateways_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `smtp_config` ADD CONSTRAINT `fk_smtp_config_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `subscriptions` ADD CONSTRAINT `fk_subscriptions_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `subscriptions` ADD CONSTRAINT `fk_subscriptions_plan_id` FOREIGN KEY (`plan_id`) REFERENCES `plans` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `templates` ADD CONSTRAINT `fk_templates_channel_id` FOREIGN KEY (`channel_id`) REFERENCES `channels` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `templates` ADD CONSTRAINT `fk_templates_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE `ticket_messages` ADD CONSTRAINT `fk_ticket_messages_ticket_id` FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `training_data` ADD CONSTRAINT `fk_training_data_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `chatbots` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `transactions` ADD CONSTRAINT `fk_transactions_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `transactions` ADD CONSTRAINT `fk_transactions_plan_id` FOREIGN KEY (`plan_id`) REFERENCES `plans` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `transactions` ADD CONSTRAINT `fk_transactions_subscription_id` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `transactions` ADD CONSTRAINT `fk_transactions_payment_provider_id` FOREIGN KEY (`payment_provider_id`) REFERENCES `payment_providers` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `update_run_events` ADD CONSTRAINT `fk_update_run_events_run_id` FOREIGN KEY (`run_id`) REFERENCES `update_runs` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `update_runs` ADD CONSTRAINT `fk_update_runs_triggered_by` FOREIGN KEY (`triggered_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE `user_activity_logs` ADD CONSTRAINT `fk_user_activity_logs_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE `users` ADD CONSTRAINT `fk_users_channel_id` FOREIGN KEY (`channel_id`) REFERENCES `channels` (`id`) ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE `users` ADD CONSTRAINT `fk_users_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE NO ACTION;

SET FOREIGN_KEY_CHECKS = 1;
```

---

## Appendix B — Running the codebase on MySQL

The data model above is database-neutral, but the current code talks to the database through Drizzle's
PostgreSQL driver. Running it on MySQL requires these changes:

| Area | Change | Size |
|---|---|---|
| Schema | `shared/schema.ts`: `drizzle-orm/pg-core` → `drizzle-orm/mysql-core` (`pgTable` → `mysqlTable`, `jsonb` → `json`, `uuid`/`varchar` keys → `varchar(36)` with `$defaultFn(randomUUID)`, arrays → `json`) | 69 tables |
| Connection | `server/db.ts`: `pg` Pool → `mysql2` pool, `drizzle-orm/node-postgres` → `drizzle-orm/mysql2`; remove the embedded PGlite mode | 1 file |
| Inserts/updates | MySQL has no `RETURNING`: replace `.returning()` with `$returningId()` + a follow-up `SELECT` (best via one shared helper) | 178 uses |
| SQL dialect | `ILIKE` → `LIKE` (case-insensitive collation), `::type` casts → `CAST()`, `jsonb` operators → `JSON_EXTRACT`/`->>`, `gen_random_uuid()` → `UUID()`, `ON CONFLICT` → `ON DUPLICATE KEY UPDATE`, `INTERVAL '7 days'` → `INTERVAL 7 DAY`, `$1` placeholders → `?` | ~370 places |
| Sessions | `connect-pg-simple` → `express-mysql-session` | 1 file |
| Migrations | `drizzle.config.ts` dialect `mysql`; regenerate migrations | — |
| Startup DDL | Services that create tables at runtime (system config, email/SMS marketing, startup migration) → MySQL DDL | 5 files |
| Data | Copy existing data from PostgreSQL to MySQL (export/import script) | — |

---
