# Dialed

Dialed is an offline-first espresso logging and coaching app. Log a shot, score what you tasted, and get one explainable variable to change next.

The first release is intentionally espresso-only. It supports anonymous local use, optional Google-backed cloud sync, beans and equipment profiles, dialed recipes, history comparisons, and JSON/CSV export.

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
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

The recommendation engine is deterministic and versioned. Its tests cover metric calculations, comparison selection, grinder calibration, capability filtering, mechanical flow problems, taste guidance, and the one-change invariant.

## Containers

`Dockerfile` exposes separate `web` and `api` targets. For a complete local stack with PostgreSQL:

```bash
docker compose up --build
```

Set real values for `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` before exposing the stack outside local development. Production deployments should use managed PostgreSQL backups, TLS at the ingress, and the same public origin for the web app and `/api` routes.

## Delivery notes

Implementation status and future work are tracked in [docs/implementation-tickets.md](docs/implementation-tickets.md). Pour-over, Bluetooth scales, public links, collaboration, and native clients are intentionally deferred.
