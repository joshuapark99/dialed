# Raspberry Pi POC Hosting and CI/CD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a green, security-gated CI pipeline and an automatic, rollback-capable Dialed POC deployment on a 64-bit Raspberry Pi behind Cloudflare Tunnel and Cloudflare Access.

**Architecture:** GitHub-hosted runners verify Node.js 22/24, build matching multi-platform web/API images, and publish immutable commit tags plus a mutable `poc` discovery tag to GHCR. A root-owned systemd timer on the Pi resolves discovery tags to exact digests, backs up PostgreSQL, migrates, starts the candidate, verifies revisions, and promotes or rolls back without inbound SSH or a self-hosted Actions runner.

**Tech Stack:** Node.js 22/24, pnpm 10, Turborepo, Next.js 16, Fastify 5, Drizzle ORM/PostgreSQL 16, Docker BuildKit/Compose, GHCR, GitHub Actions, POSIX shell, systemd, Cloudflare Tunnel, Cloudflare Access.

**Spec:** `docs/superpowers/specs/2026-08-28-raspberry-pi-poc-cicd-design.md`

## Global Constraints

- Raspberry Pi OS and images are 64-bit; publish `linux/arm64` and `linux/amd64` manifests.
- Do not expose a host port for web, API, PostgreSQL, or SSH in `compose.poc.yaml`.
- Repository code runs only on GitHub-hosted Actions runners; never install a self-hosted runner on this public-repository Pi.
- Only `main` pushes may publish images or access the `poc` GitHub environment.
- GHCR images are public, contain no runtime secrets, and carry exact source/revision labels.
- Use `node:22.23.2-alpine3.24`, `postgres:16.15-alpine3.24`, and `cloudflare/cloudflared:2026.8.2` as the initial pinned runtime tags.
- Use Next.js `16.3.3`, `@fastify/swagger-ui` `6.1.1`, and Better Auth `1.7.2` as the initial patched direct dependency targets.
- The production audit must contain zero critical or high advisories; document any remaining moderate advisory and its exposure.
- Runtime migration uses compiled Drizzle ORM code, not Drizzle Kit or pnpm.
- Application deployment uses exact registry digests after discovery; mutable tags never identify the active or rollback state.
- Schema migrations remain backward compatible with the immediately previous application revision.
- Never automatically restore PostgreSQL; automatic rollback changes only web/API image digests.
- `/etc/dialed/poc.env` and deployment state are root-readable only and are never committed.
- Cloudflare Access defaults to deny, with exact-email Allow and service-token Service Auth policies.
- Host-level Compose/scripts/systemd updates remain an explicit operator action; normal CD updates application images only.

---

## Planned File Structure

### Existing files to modify

- `.github/workflows/ci.yml`: portable CI matrix, integration gates, container verification, publish, and external deployment verification.
- `.env.example`: document optional revision metadata without adding secrets.
- `.gitignore`: ignore local POC deployment state and generated backups if they are created inside a checkout.
- `Dockerfile`: pinned bases, pnpm production deploy, non-root runtimes, health checks, OCI labels.
- `README.md`: link the POC operations guide and update verification commands.
- `apps/api/package.json`: publish only compiled API files and expose the runtime migration command.
- `apps/api/src/config.ts`: parse `APP_REVISION`.
- `apps/api/src/main.ts`: pass revision to the server.
- `apps/api/src/server.ts`: revision-bearing liveness/readiness payloads.
- `apps/api/test/config.test.ts`: revision default and override coverage.
- `apps/api/test/server.test.ts`: health payload coverage.
- `apps/web/package.json`: upgrade Next.js and explicitly select webpack for the existing watcher customization.
- `apps/web/lib/dev-file-watching.ts`: pure watcher-configuration helper.
- `apps/web/lib/sync.test.ts`: explicit lock injection for destructive-operation behavior tests.
- `apps/web/next.config.ts`: pure watcher helper and same-origin health rewrites.
- `apps/web/next.config.test.ts`: host-independent watcher and rewrite tests.
- `docs/implementation-tickets.md`: add the POC delivery ticket and verification boundary.
- `package.json`: root integration/operations test commands.
- `packages/db/package.json`: runtime migration export and integration script.
- `packages/db/src/index.ts`: export the migration interface.
- `pnpm-lock.yaml`: patched dependency graph.
- `pnpm-workspace.yaml`: injected workspace packages for portable `pnpm deploy` output.
- `turbo.json`: declare revision/build inputs where required.

### New application and migration files

- `.nvmrc`: pin the local release-verification runtime to Node.js 22.23.2.
- `apps/api/src/migrate.ts`: production migration CLI using only `DATABASE_URL`.
- `apps/web/app/healthz/route.ts`: dynamic web health/revision route.
- `apps/web/app/healthz/route.test.ts`: web health contract.
- `packages/db/src/migrate.ts`: reusable Drizzle ORM runtime migrator.
- `packages/db/test/migrate.integration.test.ts`: real PostgreSQL migration/idempotency coverage.

### New POC operations files

- `compose.poc.yaml`: private-network Pi topology.
- `ops/poc/poc.env.example`: complete, secret-free environment contract.
- `ops/poc/bin/common`: shared validation, Compose, digest, lock, and health helpers.
- `ops/poc/bin/backup`: verified PostgreSQL backup and retention command.
- `ops/poc/bin/reconcile`: discover, backup, migrate, verify, promote, and rollback command.
- `ops/poc/bin/install`: explicit Pi host bootstrap/update command.
- `ops/poc/lib/external-health.mjs`: testable Access-authenticated external polling.
- `ops/poc/bin/check-external.mjs`: CI CLI for the external health library.
- `ops/poc/systemd/dialed-poc-deploy.service`: one-shot reconcile unit.
- `ops/poc/systemd/dialed-poc-deploy.timer`: once-per-minute reconcile schedule.
- `ops/poc/systemd/dialed-poc-backup.service`: one-shot backup unit.
- `ops/poc/systemd/dialed-poc-backup.timer`: daily backup schedule.
- `ops/poc/test/compose.test.mjs`: rendered Compose security/topology assertions.
- `ops/poc/test/fixtures/poc.env`: non-secret values used only to render the test Compose model.
- `ops/poc/test/backup.test.mjs`: backup behavior with fake Docker commands.
- `ops/poc/test/reconcile.test.mjs`: promotion/rollback behavior with fake Docker commands.
- `ops/poc/test/external-health.test.mjs`: Access header, revision, retry, and timeout coverage.
- `ops/poc/test/systemd.test.mjs`: static systemd safety and schedule assertions.
- `ops/poc/test/workflow.test.mjs`: least-privilege workflow structure assertions.
- `ops/poc/README.md`: complete Pi, Cloudflare, OAuth, deployment, backup, restore, and teardown runbook.

---

### Task 1: Make unit tests portable across Node.js 22/24 and host paths

**Files:**

- Create: `.nvmrc`
- Modify: `apps/web/lib/dev-file-watching.ts`
- Modify: `apps/web/next.config.ts`
- Modify: `apps/web/next.config.test.ts`
- Modify: `apps/web/lib/sync.test.ts`

**Interfaces:**

- Produces: `configureFileWatching<T extends { watchOptions?: Record<string, unknown> }>(config: T, dev: boolean, poll: boolean): T`
- Preserves: `shouldPollForFileChanges(platform, workspaceRoot): boolean`
- Preserves: production `createSyncCoordinator` behavior; only tests inject deterministic `OwnerLock` instances.

- [ ] **Step 1: Write a host-independent watcher regression test that fails before the helper exists**

Replace the Next config test's direct environment-dependent assertions with direct helper coverage:

```ts
import {
  configureFileWatching,
  shouldPollForFileChanges,
} from "./lib/dev-file-watching";

it("adds polling only when the caller explicitly enables it", () => {
  const config = { watchOptions: { ignored: ["**/node_modules/**"] } };
  expect(configureFileWatching(config, true, true).watchOptions).toEqual({
    ignored: ["**/node_modules/**"],
    poll: 1_000,
    aggregateTimeout: 200,
  });
  expect(configureFileWatching(config, true, false).watchOptions).toEqual(
    config.watchOptions,
  );
  expect(configureFileWatching(config, false, true).watchOptions).toEqual(
    config.watchOptions,
  );
});
```

- [ ] **Step 2: Run the watcher test and verify it fails**

Run: `pnpm --filter @dialed/web test -- next.config.test.ts`

Expected: FAIL because `configureFileWatching` is not exported.

- [ ] **Step 3: Implement the pure helper and delegate from Next config**

Add to `dev-file-watching.ts`:

```ts
export function configureFileWatching<
  T extends { watchOptions?: Record<string, unknown> },
>(config: T, dev: boolean, poll: boolean): T {
  if (!dev || !poll) return config;
  config.watchOptions = {
    ...config.watchOptions,
    poll: 1_000,
    aggregateTimeout: 200,
  };
  return config;
}
```

Change `next.config.ts`'s webpack callback to:

```ts
webpack(config, { dev }) {
  return configureFileWatching(config, dev, pollForFileChanges);
},
```

- [ ] **Step 4: Make the three CI-sensitive sync tests prove lock independence**

In the tests beginning `waits for an in-flight sync`, `reports that the cache was cleared`, and `runs a normal sync for a joiner`, stub an unsafe global navigator and pass `fakeOwnerLock()` to the coordinator:

```ts
vi.stubGlobal("navigator", { onLine: true, locks: null });
const coordinator = createSyncCoordinator(
  dependencies({ fetch }),
  fakeOwnerLock(),
);
```

Keep the existing explicit test that unsafe browser locking rejects destructive operations; it remains the production fallback contract.

- [ ] **Step 5: Add the local runtime pin**

Create `.nvmrc` containing exactly:

```text
22.23.2
```

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
pnpm --filter @dialed/web test -- next.config.test.ts lib/sync.test.ts
pnpm test
```

Expected: all web tests and all workspace tests pass on the current host; the tests no longer depend on `/mnt` or Node's global Web Locks implementation.

- [ ] **Step 7: Commit**

```bash
git add .nvmrc apps/web/lib/dev-file-watching.ts apps/web/next.config.ts apps/web/next.config.test.ts apps/web/lib/sync.test.ts
git commit -m "test: make release checks environment independent"
```

---

### Task 2: Patch the production dependency graph

**Files:**

- Modify: `apps/web/package.json`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `docs/security-advisories.md`

**Interfaces:**

- Produces: Next.js 16 webpack-based `dev` and `build` scripts.
- Produces: zero critical/high results from `pnpm audit --prod --audit-level=high`.

- [ ] **Step 1: Capture the failing security gate**

Run: `pnpm audit --prod --audit-level=high`

Expected: FAIL with high advisories through Next.js `sharp`/PostCSS and Swagger UI `@fastify/static`.

- [ ] **Step 2: Upgrade the direct dependency owners**

Run:

```bash
pnpm --filter @dialed/web add next@16.3.3
pnpm --filter @dialed/api add @fastify/swagger-ui@6.1.1 better-auth@1.7.2
```

Set the web scripts explicitly because Next.js 16 defaults to Turbopack while Dialed intentionally has a webpack watcher hook:

```json
{
  "dev": "next dev --webpack",
  "build": "next build --webpack"
}
```

- [ ] **Step 3: Document any remaining moderate-only advisory**

Create `docs/security-advisories.md` with a dated table containing package, dependency path, runtime inclusion, exploitability, and follow-up. The expected remaining path is the development-only legacy esbuild dependency under Drizzle Kit; state that it is excluded from the pruned API runtime image and never runs as a network development server in production.

- [ ] **Step 4: Verify the upgraded framework and audit**

Run:

```bash
pnpm audit --prod --audit-level=high
pnpm --filter @dialed/web test
pnpm --filter @dialed/api test
pnpm build
```

Expected: audit exits 0 with zero high/critical advisories; tests and the Next.js production build pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/api/package.json pnpm-lock.yaml docs/security-advisories.md
git commit -m "build: patch production dependency advisories"
```

---

### Task 3: Add revision-bearing web and API health contracts

**Files:**

- Create: `apps/web/app/healthz/route.ts`
- Create: `apps/web/app/healthz/route.test.ts`
- Modify: `apps/web/next.config.ts`
- Modify: `apps/web/next.config.test.ts`
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/test/config.test.ts`
- Modify: `apps/api/test/server.test.ts`
- Modify: `.env.example`

**Interfaces:**

- Produces: `GET /healthz -> { status: "ok", revision: string }` on web and API.
- Produces: `GET /readyz -> { status: "ready" | "unavailable", revision: string }` on API.
- Produces: same-origin web rewrites for `/api/healthz` and `/api/readyz`.
- Produces: optional `APP_REVISION` config defaulting to `development`.

- [ ] **Step 1: Write failing web health and rewrite tests**

Create the route test:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("web health", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports the deployed revision dynamically", async () => {
    vi.stubEnv("APP_REVISION", "0123456789abcdef0123456789abcdef01234567");
    expect(await (await GET()).json()).toEqual({
      status: "ok",
      revision: "0123456789abcdef0123456789abcdef01234567",
    });
  });
});
```

Extend `next.config.test.ts` to await `nextConfig.rewrites()` and assert destinations `http://127.0.0.1:3001/healthz` and `/readyz`.

- [ ] **Step 2: Run web tests and verify failure**

Run: `pnpm --filter @dialed/web test -- app/healthz/route.test.ts next.config.test.ts`

Expected: FAIL because the route and health rewrites do not exist.

- [ ] **Step 3: Implement web health and rewrites**

Create:

```ts
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({
    status: "ok",
    revision: process.env.APP_REVISION ?? "development",
  });
}
```

Add exact rewrites:

```ts
{ source: "/api/healthz", destination: `${apiOrigin}/healthz` },
{ source: "/api/readyz", destination: `${apiOrigin}/readyz` },
```

- [ ] **Step 4: Write failing API revision assertions**

Add config assertions for default `development` and an explicit 40-character commit. Update the health test to create the server with `revision: "0123456789abcdef0123456789abcdef01234567"` and assert the revision in 200 and 503 bodies.

- [ ] **Step 5: Run API tests and verify failure**

Run: `pnpm --filter @dialed/api test`

Expected: FAIL because config and server dependencies do not expose revision.

- [ ] **Step 6: Implement API revision reporting**

Add `APP_REVISION: z.string().min(1).default("development")` to config. Extend `ServerDependencies` with `revision?: string`, use `dependencies.revision ?? "development"` in both health handlers, and pass `config.APP_REVISION` from `main.ts`.

- [ ] **Step 7: Verify all health contracts**

Run:

```bash
pnpm --filter @dialed/web test -- app/healthz/route.test.ts next.config.test.ts
pnpm --filter @dialed/api test
pnpm typecheck
```

Expected: all commands pass.

- [ ] **Step 8: Commit**

```bash
git add .env.example apps/web/app/healthz apps/web/next.config.ts apps/web/next.config.test.ts apps/api/src/config.ts apps/api/src/main.ts apps/api/src/server.ts apps/api/test/config.test.ts apps/api/test/server.test.ts
git commit -m "feat: expose deployment health revisions"
```

---

### Task 4: Add a production runtime migrator and real PostgreSQL integration test

**Files:**

- Create: `packages/db/src/migrate.ts`
- Create: `packages/db/test/migrate.integration.test.ts`
- Create: `apps/api/src/migrate.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/package.json`
- Modify: `apps/api/package.json`
- Modify: `package.json`

**Interfaces:**

- Produces: `migrateDatabase(databaseUrl: string): Promise<void>`.
- Produces: `node dist/migrate.js` in the deployed API package.
- Consumes in tests: `DIALED_INTEGRATION_DATABASE_URL`; never falls back to the developer `.env`.

- [ ] **Step 1: Write the failing migration integration test**

Create a Node test that requires the dedicated integration URL, runs migrations twice, and verifies representative schema objects:

```ts
const databaseUrl = process.env.DIALED_INTEGRATION_DATABASE_URL;
assert.ok(databaseUrl, "DIALED_INTEGRATION_DATABASE_URL is required");

await migrateDatabase(databaseUrl);
await migrateDatabase(databaseUrl);

const sql = postgres(databaseUrl, { max: 1 });
const [result] = await sql<[{ syncTable: string | null; coffeeEnum: boolean }]>`
  select
    to_regclass('public.sync_operation')::text as "syncTable",
    exists(
      select 1 from pg_enum e
      join pg_type t on t.oid = e.enumtypid
      where t.typname = 'sync_entity' and e.enumlabel = 'coffee'
    ) as "coffeeEnum"
`;
assert.equal(result.syncTable, "sync_operation");
assert.equal(result.coffeeEnum, true);
await sql.end();
```

- [ ] **Step 2: Run the integration test and verify failure**

Run with a disposable PostgreSQL URL:

```bash
DIALED_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dialed_test pnpm test:db-integration
```

Expected: FAIL because `migrateDatabase` and the script do not exist. If no disposable PostgreSQL is running locally, use the CI service in Task 11 for the red/green cycle and run the compile failure locally first.

- [ ] **Step 3: Implement the reusable migrator**

Use the package-relative migrations directory so it works in source and deployed package layouts:

```ts
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "./client.js";

const migrationsFolder = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

export async function migrateDatabase(databaseUrl: string): Promise<void> {
  const database = createDatabase(databaseUrl);
  try {
    await migrate(database.db, { migrationsFolder });
  } finally {
    await database.close();
  }
}
```

Export it from `packages/db/src/index.ts` and expose `./migrate` in package exports.

- [ ] **Step 4: Implement the API migration CLI**

Create:

```ts
import { migrateDatabase } from "@dialed/db/migrate";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
await migrateDatabase(databaseUrl);
```

Add `"migrate": "node dist/migrate.js"` to the API scripts and `"test:db-integration": "pnpm --filter @dialed/db test:integration"` to the root scripts. Add `tsx` to the DB development dependencies and define `"test:integration": "node --import tsx --test test/*.integration.test.ts"`.

- [ ] **Step 5: Verify compilation and integration**

Run:

```bash
pnpm --filter @dialed/db build
pnpm --filter @dialed/api build
DIALED_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dialed_test pnpm test:db-integration
```

Expected: builds pass; two migration runs pass against the disposable database.

- [ ] **Step 6: Commit**

```bash
git add package.json apps/api/package.json apps/api/src/migrate.ts packages/db/package.json packages/db/src/index.ts packages/db/src/migrate.ts packages/db/test/migrate.integration.test.ts pnpm-lock.yaml
git commit -m "feat: add production database migrator"
```

---

### Task 5: Produce slim, non-root, multi-platform runtime images

**Files:**

- Modify: `Dockerfile`
- Modify: `apps/api/package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `turbo.json`

**Interfaces:**

- Consumes: compiled `apps/api/dist/migrate.js` and `@dialed/db` migration files.
- Produces: `web` and `api` Docker targets with `VCS_REF` build argument and OCI labels.
- Produces: portable `/prod/api` from `pnpm --filter @dialed/api --prod deploy /prod/api`.

- [ ] **Step 1: Add a failing runtime-closure assertion**

Build the current API target, then inspect it:

```bash
docker build --target api -t dialed-api:test .
docker run --rm --entrypoint sh dialed-api:test -c 'test ! -e node_modules/typescript && test ! -e node_modules/drizzle-kit'
```

Expected: FAIL because the current image copies the complete build-stage `node_modules`.

- [ ] **Step 2: Configure portable workspace deployment**

Add to `pnpm-workspace.yaml`:

```yaml
injectWorkspacePackages: true
syncInjectedDepsAfterScripts:
  - build
```

Add `"files": ["dist"]` to `apps/api/package.json`; keep the DB package's existing `dist` and `migrations` files list.

- [ ] **Step 3: Rewrite the Docker stages**

Use `node:22.23.2-alpine3.24`, a BuildKit pnpm-store cache, and:

```dockerfile
FROM build AS api-pruned
RUN pnpm --filter @dialed/api --prod deploy /prod/api

FROM node:22.23.2-alpine3.24 AS api
ARG VCS_REF=development
ENV NODE_ENV=production APP_REVISION=$VCS_REF
WORKDIR /app
COPY --chown=node:node --from=api-pruned /prod/api ./
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3001/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
```

Apply the same pinned runtime, `USER node`, `org.opencontainers.image.source` and `org.opencontainers.image.revision` labels, `APP_REVISION`, and a `/healthz` health check to the web target. Preserve the standalone path `apps/web/server.js`.

- [ ] **Step 4: Verify runtime images**

Run:

```bash
docker build --target api --build-arg VCS_REF=0123456789abcdef0123456789abcdef01234567 -t dialed-api:test .
docker build --target web --build-arg API_INTERNAL_URL=http://api:3001 --build-arg VCS_REF=0123456789abcdef0123456789abcdef01234567 -t dialed-web:test .
docker run --rm --entrypoint sh dialed-api:test -c 'test ! -e node_modules/typescript && test ! -e node_modules/drizzle-kit && test -f dist/migrate.js'
docker image inspect dialed-api:test --format '{{.Config.User}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
docker image inspect dialed-web:test --format '{{.Config.User}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
```

Expected: no development packages, migration CLI present, both users equal `node`, both labels equal the test revision.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile apps/api/package.json pnpm-workspace.yaml turbo.json pnpm-lock.yaml
git commit -m "build: create slim production images"
```

---

### Task 6: Define the secure Raspberry Pi Compose topology

**Files:**

- Create: `compose.poc.yaml`
- Create: `ops/poc/poc.env.example`
- Create: `ops/poc/test/compose.test.mjs`
- Create: `ops/poc/test/fixtures/poc.env`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**

- Consumes: exported `WEB_IMAGE`, `API_IMAGE`, `APP_REVISION`, and values from `/etc/dialed/poc.env`.
- Produces: services `postgres`, `migrate`, `api`, `web`, and `cloudflared`.
- Produces: internal `app`, web-only `ingress`, and API-only `api-egress` network boundaries.

- [ ] **Step 1: Write the failing rendered-model test**

The Node test should run `docker compose --env-file ops/poc/test/fixtures/poc.env -f compose.poc.yaml config --format json`, parse JSON, and assert:

```js
for (const service of Object.values(model.services)) {
  assert.deepEqual(service.ports ?? [], []);
}
assert.deepEqual(model.services.postgres.networks, { app: null });
assert.ok(Object.hasOwn(model.services.web.networks, "app"));
assert.ok(Object.hasOwn(model.services.web.networks, "ingress"));
assert.ok(Object.hasOwn(model.services.api.networks, "app"));
assert.ok(Object.hasOwn(model.services.api.networks, "api-egress"));
assert.equal(model.services.migrate.restart, "no");
assert.equal(
  model.services.api.depends_on.migrate.condition,
  "service_completed_successfully",
);
```

- [ ] **Step 2: Run the operations test and verify failure**

Run: `pnpm test:ops`

Expected: FAIL because the POC Compose model does not exist.

- [ ] **Step 3: Implement the POC Compose model**

Use these image contracts:

```yaml
postgres:
  image: postgres:16.15-alpine3.24
migrate:
  image: ${API_IMAGE:?API_IMAGE is required}
  command: ["node", "dist/migrate.js"]
api:
  image: ${API_IMAGE:?API_IMAGE is required}
web:
  image: ${WEB_IMAGE:?WEB_IMAGE is required}
cloudflared:
  image: cloudflare/cloudflared:2026.8.2
  command: ["tunnel", "--no-autoupdate", "run"]
```

Set `read_only`, `tmpfs`, `cap_drop: [ALL]`, and `security_opt: [no-new-privileges:true]` for web, API, migration, and cloudflared. Do not drop the initialization capabilities required by the official PostgreSQL entrypoint. Bind `${DIALED_DATA_DIR}/postgres` to PostgreSQL and do not declare any `ports` keys.

- [ ] **Step 4: Add the environment contract and operations test script**

List every required variable with an empty value in `poc.env.example`. Add `"test:ops": "node --test ops/poc/test/*.test.mjs"` to the root scripts. Ignore `.deploy.env`, `.rollback.env`, and `*.dump` under `ops/poc`.

- [ ] **Step 5: Validate topology**

Run:

```bash
pnpm test:ops
docker compose --env-file ops/poc/test/fixtures/poc.env -f compose.poc.yaml config --quiet
```

Expected: no published ports, expected network memberships, required health/dependency conditions, valid Compose configuration.

- [ ] **Step 6: Commit**

```bash
git add .gitignore package.json compose.poc.yaml ops/poc/poc.env.example ops/poc/test/compose.test.mjs ops/poc/test/fixtures/poc.env
git commit -m "feat: add secure Raspberry Pi compose stack"
```

---

### Task 7: Implement verified PostgreSQL backups

**Files:**

- Create: `ops/poc/bin/common`
- Create: `ops/poc/bin/backup`
- Create: `ops/poc/test/backup.test.mjs`

**Interfaces:**

- Produces: `acquire_lock`, `load_poc_env`, and `compose` shell helpers.
- Produces: `backup [predeploy|scheduled]`, returning the archive path on stdout.
- Consumes: `DIALED_BACKUP_DIR`, active deployment state, and running `postgres` service.

- [ ] **Step 1: Write failing backup command tests**

Use a temporary fake `docker` binary placed first in `PATH`. Cover:

- nonzero `pg_dump` leaves no archive;
- empty output is rejected;
- successful output becomes `dialed-<UTC>-<revision>-<reason>.dump`;
- only the newest fourteen scheduled archives remain;
- pre-deployment archives are not removed by daily retention.

The test invokes the real script through `spawnSync("sh", [backupPath, "scheduled"], { env })` and asserts exit status, files, and stderr.

- [ ] **Step 2: Run the backup tests and verify failure**

Run: `node --test ops/poc/test/backup.test.mjs`

Expected: FAIL because the backup scripts do not exist.

- [ ] **Step 3: Implement common validation and locking**

`common` must use `set -eu`, validate explicit absolute paths, source only root-owned environment/state files, and acquire the shared lock with:

```sh
exec 9>"${DIALED_LOCK_FILE:-/run/lock/dialed-poc.lock}"
flock -n 9 || exit 0
```

Allow tests to override the lock/state/config paths, but never allow tests or runtime callers to override the `docker` command as a string; command substitution is controlled only through `PATH`.

- [ ] **Step 4: Implement atomic backup creation and retention**

Write `pg_dump -Fc --no-owner --no-acl` to `mktemp` in the backup directory, require a nonempty file, then atomically rename it. Use `find`/`sort` on the exact `dialed-*-scheduled.dump` pattern and retain fourteen. Emit the final path only after promotion.

- [ ] **Step 5: Verify backup tests and shell syntax**

Run:

```bash
sh -n ops/poc/bin/common ops/poc/bin/backup
node --test ops/poc/test/backup.test.mjs
```

Expected: all cases pass.

- [ ] **Step 6: Commit**

```bash
git add ops/poc/bin/common ops/poc/bin/backup ops/poc/test/backup.test.mjs
git commit -m "feat: add verified POC database backups"
```

---

### Task 8: Implement digest-pinned reconciliation and rollback

**Files:**

- Create: `ops/poc/bin/reconcile`
- Create: `ops/poc/test/reconcile.test.mjs`

**Interfaces:**

- Consumes: `backup predeploy`, `compose.poc.yaml`, GHCR `poc` tags, `/etc/dialed/poc.env`.
- Produces: root-readable active and rollback state containing `WEB_IMAGE`, `API_IMAGE`, and `APP_REVISION`.
- Produces: exact-digest promotion only after local health/readiness succeeds.

- [ ] **Step 1: Write failing state-machine tests**

Use fake `docker` behavior and fixture state to cover:

- unchanged digests exit without backup or restart;
- different web/API OCI revisions fail before backup;
- backup failure prevents migration;
- migration failure leaves active state unchanged;
- candidate health success atomically promotes candidate state and preserves prior state as rollback;
- candidate health failure runs `compose up -d api web` with prior digests and keeps active state unchanged;
- missing prior state supports first deployment but reports no automatic rollback target;
- generated image references contain `@sha256:` rather than `:poc`.

- [ ] **Step 2: Run reconciliation tests and verify failure**

Run: `node --test ops/poc/test/reconcile.test.mjs`

Expected: FAIL because `reconcile` does not exist.

- [ ] **Step 3: Implement discovery and candidate validation**

Pull both discovery tags, resolve exact `RepoDigests`, and inspect `org.opencontainers.image.revision`. Accept only lowercase 40-character Git commits and require web/API equality. Candidate state must be written with mode `0600` to a temporary file in the same directory as active state.

- [ ] **Step 4: Implement backup, migration, and conditional health waiting**

Start the long-lived `postgres` and `cloudflared` services and wait for PostgreSQL health. For an upgrade, run the backup command before migration; on the first deployment, explicitly record that no prior database exists and skip the meaningless pre-deployment backup. Run migration exactly once with `docker compose run --rm migrate`, then start the candidate with `docker compose up --no-deps -d api web` so `depends_on` does not invoke the migration service a second time.

Poll the private endpoints through `docker compose exec -T web` and `docker compose exec -T api` until both return the candidate revision or the 120-second deadline expires. Poll every two seconds based on response state; do not publish a host port and do not use a fixed blind startup sleep.

- [ ] **Step 5: Implement atomic promotion and application-only rollback**

On success, copy active to rollback and rename candidate to active. On health failure, source rollback state and recreate only API/web with `docker compose up --no-deps -d api web`, then verify the prior revision is healthy. Never invoke `pg_restore`, delete the data directory, or change PostgreSQL volumes.

- [ ] **Step 6: Verify state-machine and syntax checks**

Run:

```bash
sh -n ops/poc/bin/reconcile
node --test ops/poc/test/reconcile.test.mjs
pnpm test:ops
```

Expected: all scenarios pass.

- [ ] **Step 7: Commit**

```bash
git add ops/poc/bin/reconcile ops/poc/test/reconcile.test.mjs
git commit -m "feat: add digest-pinned POC deployment rollback"
```

---

### Task 9: Add external Access-authenticated deployment verification

**Files:**

- Create: `ops/poc/lib/external-health.mjs`
- Create: `ops/poc/bin/check-external.mjs`
- Create: `ops/poc/test/external-health.test.mjs`

**Interfaces:**

- Produces: `waitForExternalRevision({ baseUrl, revision, clientId, clientSecret, timeoutMs, intervalMs, fetchImpl, delay }): Promise<void>`.
- CLI consumes: `POC_BASE_URL`, `APP_REVISION`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`.

- [ ] **Step 1: Write failing external verification tests**

Test that both `/healthz` and `/api/readyz` receive:

```js
{
  "CF-Access-Client-Id": clientId,
  "CF-Access-Client-Secret": clientSecret,
}
```

Cover immediate success, old-revision retries, Access 403 retries, mismatched web/API revisions, and timeout with the last observed status in the error.

- [ ] **Step 2: Run and verify failure**

Run: `node --test ops/poc/test/external-health.test.mjs`

Expected: FAIL because the library does not exist.

- [ ] **Step 3: Implement injectable polling and CLI validation**

Use `AbortSignal.timeout` per request, exact revision equality, and an injected delay in tests. The CLI validates an HTTPS base URL, a 40-character lowercase revision, and nonempty credentials before calling the library with a ten-minute deadline.

- [ ] **Step 4: Verify tests**

Run:

```bash
node --test ops/poc/test/external-health.test.mjs
pnpm test:ops
```

Expected: all tests pass without network access.

- [ ] **Step 5: Commit**

```bash
git add ops/poc/lib/external-health.mjs ops/poc/bin/check-external.mjs ops/poc/test/external-health.test.mjs
git commit -m "test: verify POC releases through Cloudflare Access"
```

---

### Task 10: Add systemd installation and the complete Pi/Cloudflare runbook

**Files:**

- Create: `ops/poc/bin/install`
- Create: `ops/poc/systemd/dialed-poc-deploy.service`
- Create: `ops/poc/systemd/dialed-poc-deploy.timer`
- Create: `ops/poc/systemd/dialed-poc-backup.service`
- Create: `ops/poc/systemd/dialed-poc-backup.timer`
- Create: `ops/poc/test/systemd.test.mjs`
- Create: `ops/poc/README.md`
- Modify: `README.md`
- Modify: `docs/implementation-tickets.md`

**Interfaces:**

- Produces: explicit root bootstrap/update command.
- Produces: minute deployment timer and daily 03:15 UTC backup timer.
- Documents: Access exact-email policy, Service Auth policy, named tunnel route, Google callback, GHCR visibility, restore, pause, rollback, update, and teardown.

- [ ] **Step 1: Add static unit-file assertions to operations tests**

Create `ops/poc/test/systemd.test.mjs`. Assert that deploy/backup are `Type=oneshot`, use the same lock-owning scripts, deploy starts after Docker/network, timers are persistent, deploy interval is one minute, and backup calendar is `*-*-* 03:15:00 UTC`.

- [ ] **Step 2: Run the assertions and verify failure**

Run: `pnpm test:ops`

Expected: FAIL because the unit files do not exist.

- [ ] **Step 3: Create units and an idempotent installer**

The installer must:

- require root and Docker Compose v2.24 or newer;
- require 64-bit `aarch64`/`arm64`;
- create `/etc/dialed`, `/var/lib/dialed`, data, and backup directories with explicit modes;
- copy reviewed Compose/scripts/unit files to `/opt/dialed` and `/etc/systemd/system`;
- refuse to overwrite an existing `/etc/dialed/poc.env`;
- run `systemctl daemon-reload` and enable both timers only after `docker compose config --quiet` passes.

- [ ] **Step 4: Write the operator runbook**

Document commands and expected outputs for:

1. Pi OS/SSD/Docker prerequisites.
2. Environment generation and permissions.
3. GHCR public package verification.
4. Named remotely managed tunnel creation.
5. `poc.<domain>` route to `http://web:3000`.
6. Access exact-email Allow and CI Service Auth policies.
7. GitHub `poc` environment variable/secrets.
8. Google OAuth callback `${APP_URL}/api/auth/callback/google`.
9. First install with the tunnel route disabled.
10. Manual local reconcile/health/backup/rollback rehearsal.
11. Enabling the route and testing invited-user access.
12. Pausing timers, viewing journald, selecting a prior digest, restoring a backup, updating host assets, rotating tokens, and tearing down without deleting data by default.

- [ ] **Step 5: Verify units, scripts, and docs formatting**

Run:

```bash
sh -n ops/poc/bin/install
pnpm test:ops
pnpm exec prettier --check README.md docs/implementation-tickets.md ops/poc/README.md
```

Expected: all checks pass.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/implementation-tickets.md ops/poc/bin/install ops/poc/systemd ops/poc/README.md ops/poc/test
git commit -m "docs: add Raspberry Pi POC operations runbook"
```

---

### Task 11: Rebuild CI and add gated GHCR publication/CD verification

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Create: `ops/poc/test/workflow.test.mjs`

**Interfaces:**

- Consumes: all verification commands and POC assets from Tasks 1–10.
- Produces: Node 22/24 verification, database/container/e2e gates, GHCR manifests, attestations, and `poc` external verification.

- [ ] **Step 1: Add a local workflow-structure test that fails on the current CI**

Create `ops/poc/test/workflow.test.mjs` to parse `.github/workflows/ci.yml` as text and assert:

- Node matrix contains `22` and `24`;
- no `runs-on: self-hosted` exists;
- publish conditions require push and `refs/heads/main`;
- publish job alone has `packages: write`;
- smoke job uses environment `poc` and `ops/poc/bin/check-external.mjs`;
- all `uses:` values contain a 40-character SHA.

Run `pnpm test:ops`; expect failure against the current workflow.

- [ ] **Step 2: Split CI into least-privilege jobs**

Use these immutable action references with version comments:

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
- uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10
- uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
- uses: docker/setup-qemu-action@96fe6ef7f33517b61c61be40b68a1882f3264fb8 # v4.2.0
- uses: docker/setup-buildx-action@37fe631027851001ddb9b187196cc803df7f5f0e # v4.3.0
- uses: docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0
- uses: docker/metadata-action@dc802804100637a589fabce1cb79ff13a1411302 # v6.2.0
- uses: docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a # v7.3.0
- uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2
```

Create jobs:

- `verify` matrix on Node 22/24: install, format, lint, typecheck, unit tests, build.
- `audit`: `pnpm audit --prod --audit-level=high`.
- `database`: PostgreSQL service, runtime migration integration test, API start, `/readyz` curl.
- `e2e`: Node 22 and Playwright Chromium.
- `containers`: Compose model tests plus local web/API target builds and runtime-closure/user/label inspections.
- `publish`: matrix for web/API, `needs: [verify, audit, database, e2e, containers]`, only push to `main`, multi-platform GHCR push with SHA and `poc` tags plus attestation.
- `smoke`: `poc` environment, non-canceling `poc-release` concurrency, external revision verification.

- [ ] **Step 3: Keep secrets out of untrusted jobs**

Set workflow-level `permissions: contents: read`. Grant publish only:

```yaml
permissions:
  contents: read
  packages: write
  attestations: write
  id-token: write
```

Use `vars.POC_BASE_URL` and `secrets.CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` only in `smoke`, which depends on successful publication and is conditioned on a `main` push.

- [ ] **Step 4: Validate workflow structure and commands locally**

Run:

```bash
pnpm test:ops
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm audit --prod --audit-level=high
```

Expected: all local gates pass; workflow test confirms immutable actions and no self-hosted runner.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml package.json ops/poc/test/workflow.test.mjs
git commit -m "ci: publish and verify Raspberry Pi POC releases"
```

---

### Task 12: Run the complete release verification and document external prerequisites

**Files:**

- Modify if evidence requires: `README.md`
- Modify if evidence requires: `ops/poc/README.md`

**Interfaces:**

- Verifies: every requirement in the approved design.
- Does not mutate: Cloudflare, Google OAuth, GitHub environments, or the Raspberry Pi without the user's credentials and explicit deployment authorization.

- [ ] **Step 1: Run all source gates without cache**

Run:

```bash
pnpm format:check
pnpm turbo run lint typecheck test --force
pnpm turbo run build --force
pnpm audit --prod --audit-level=high
pnpm test:ops
```

Expected: every command exits 0; Turbo reports zero failed tasks and `--force` bypasses cache.

- [ ] **Step 2: Run database verification against disposable PostgreSQL**

Run PostgreSQL 16.15 in a disposable container, set `DIALED_INTEGRATION_DATABASE_URL`, run `pnpm test:db-integration`, then remove only that explicitly named disposable container and volume.

Expected: migration applies twice and schema assertions pass.

- [ ] **Step 3: Run browser verification**

Run: `pnpm test:e2e`

Expected: all 17 existing browser scenarios plus any new health-specific coverage pass.

- [ ] **Step 4: Build and inspect both architectures**

Run Buildx for `linux/amd64,linux/arm64` on both targets with `--push=false` output suitable for cache-only verification, then build/load `linux/amd64` images for runtime inspection.

Expected: both architecture builds succeed; API closure has no dev tools; non-root users and revision labels are correct.

- [ ] **Step 5: Run a local Compose smoke test**

Using only fixture credentials and an isolated temporary data directory, start PostgreSQL, migration, API, and web without cloudflared. Check internal `/healthz` and `/readyz`, create a backup, exercise a no-op reconcile, and stop the named POC test project without deleting unrelated Docker resources.

Expected: migrations, health, backup, and no-op deployment pass; no host port is published.

- [ ] **Step 6: Verify GitHub Actions on the branch**

Push the feature branch and open a pull request only after local verification. Confirm verify, audit, database, e2e, and container jobs pass. Publication and smoke jobs must show as skipped because the ref is not `main`.

- [ ] **Step 7: Record the manual bootstrap boundary**

Report the exact remaining operator-owned values/actions:

- POC hostname and Cloudflare zone;
- invited email list;
- named tunnel token;
- Access service token pair;
- Google OAuth client credentials;
- Raspberry Pi `/etc/dialed/poc.env` values;
- GitHub `poc` environment variable/secrets;
- explicit first installation on the Pi.

Do not create or mutate those external resources until the user authorizes the deployment step and supplies access through the relevant tools.

- [ ] **Step 8: Commit any evidence-driven documentation correction**

If verification exposed a required documentation correction:

```bash
git add README.md ops/poc/README.md
git commit -m "docs: clarify POC deployment verification"
```

If no correction is needed, do not create an empty commit.

---

## Final Review Checklist

- [ ] Every design goal maps to at least one task above.
- [ ] No pull-request job has deployment secrets or write permissions.
- [ ] No workflow job targets a self-hosted runner.
- [ ] Docker images build for both required architectures.
- [ ] Active and rollback application state uses exact digests.
- [ ] Migration and backup complete before candidate startup.
- [ ] Failed candidates never trigger an automatic PostgreSQL restore.
- [ ] Compose publishes no host ports.
- [ ] External verification traverses Cloudflare Access with the service token.
- [ ] Manual Cloudflare, OAuth, GitHub environment, and Pi bootstrap boundaries are explicit.
- [ ] Fresh source, browser, database, container, and Compose evidence exists before completion is claimed.
