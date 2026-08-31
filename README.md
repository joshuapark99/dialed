# Dialed

Dialed is an offline-first espresso logging and coaching app. Log a shot, score what you tasted, and get one explainable variable to change next.

The first release is intentionally espresso-only. It supports anonymous local use, optional Google-backed cloud sync, reusable Coffee records with per-bag roast dates, equipment profiles, dialed recipes, bag-specific history comparisons, and JSON/CSV export.

## Repository

```text
apps/web        Next.js mobile-first PWA
apps/api        Fastify authentication and sync API
packages/domain Shared espresso contracts and recommendation rules
packages/db     Drizzle PostgreSQL schema and migrations
```

The workspace uses Node.js 22+, pnpm 10, Turborepo, and strict TypeScript.

## Local development

Install dependencies and create a local environment file:

```bash
corepack enable
pnpm install
cp .env.example .env
```

For frontend-only development, run:

```bash
pnpm dev:web
```

The PWA is available at `http://localhost:3000` and remains fully usable without the API. Data is stored in IndexedDB.

## Moving local data after sign-in

Signing in does not automatically upload or expose anonymous local data to the account. Dialed offers a move only when the person chooses it. The move includes the complete Coffee, bag, equipment, and brew dependency graph, and anonymous data remains on the device until every staged sync operation has been acknowledged by the cloud.

For cloud sync, start PostgreSQL, fill in the Google OAuth variables in `.env`, run migrations, and start both applications:

```bash
pnpm db:migrate
pnpm dev
```

Configure the Google OAuth callback as:

```text
http://localhost:3000/api/auth/callback/google
```

The API listens on `http://localhost:3001`; the web application proxies `/api/v1/*` and `/api/auth/*` to it under the browser's origin. OpenAPI documentation is served by the API at `/docs`.

## Verification

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:db-integration
pnpm test:ops
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
pnpm audit --prod --audit-level=high
```

The recommendation engine is deterministic and versioned. Its tests cover metric calculations, comparison selection, grinder calibration, capability filtering, mechanical flow problems, taste guidance, and the one-change invariant.

## Containers

`Dockerfile` exposes separate `web` and `api` targets. For a complete local stack with PostgreSQL:

```bash
docker compose up --build
```

Set real values for `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` before exposing the stack outside local development. Production deployments should use managed PostgreSQL backups, TLS at the ingress, and the same public origin for the web app and `/api` routes.

For the Raspberry Pi proof-of-concept stack, Cloudflare Access setup, pull-based CI/CD, backups, rollback, SSH-only Grafana observability, and independent teardown procedures, see [ops/poc/README.md](ops/poc/README.md). The POC Compose topology publishes no application host ports; observability exposes only Grafana, Loki, and Prometheus on Pi loopback and is separate from the local development stack.

### POC access boundary

Cloudflare Access is the entry gate for the private POC and invited testers. It controls who can reach the deployment before traffic reaches the Pi, but it does not create Dialed accounts or replace application authentication, data ownership, synchronization, or account recovery. While Google OAuth is disabled, invited testers use Dialed anonymously and their data remains local to each browser and device.

For a broader public release, retain Cloudflare Tunnel, TLS, and edge protection, remove the Access gate from the public application hostname, and use Dialed authentication for user identity and any application-level invitation flow. Cloudflare Access can remain on staging, administrative, and operational endpoints.

## Delivery notes

Implementation status and future work are tracked in [docs/implementation-tickets.md](docs/implementation-tickets.md). Pour-over, Bluetooth scales, public links, collaboration, and native clients are intentionally deferred.
