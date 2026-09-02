# Public Beta Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the minimum authenticated-account rate limits and durable 50,000-operation sync quota needed before Dialed's friend beta.

**Architecture:** Fastify authenticates every `/v1` request during `preValidation`, then `@fastify/rate-limit` applies an in-memory bucket keyed only by the verified principal. `PostgresSyncStore.push` enforces a configurable operation-count quota under its existing per-user PostgreSQL advisory lock, while the current web client keeps rejected work queued locally.

**Tech Stack:** Node.js 22+, TypeScript 5.9, Fastify 5, `@fastify/rate-limit` 11.2.0+, Better Auth, Drizzle ORM, PostgreSQL 16, Node test runner, Vitest, pnpm 10, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-01-public-beta-guardrails-design.md`

## Global Constraints

- Keep Cloudflare Access enabled during this implementation; public-hostname cutover is a separate immediate follow-up.
- Use `@fastify/rate-limit` version 11.2.0 or newer; do not install a version affected by GHSA-grpc-p53c-r64v.
- Key application rate limits only by the authenticated principal ID, never by `x-dialed-account-id`.
- Use independent buckets of 120/minute for `GET /v1/me`, 30/minute for `POST /v1/sync/push`, 120/minute for `GET /v1/sync/pull`, 5/hour for `GET /v1/account/export`, and 5/hour for `DELETE /v1/account`.
- Default `SYNC_OPERATION_QUOTA` to exactly `50000`; count only unique new operation IDs.
- Accept duplicate-only pushes at the quota and reject an over-quota push atomically with HTTP `413`.
- Return HTTP `429` with `Retry-After` and `error.code = "rate_limit_exceeded"`; return HTTP `413` with `error.code = "sync_quota_exceeded"`.
- Preserve existing `401 unauthorized`, `409 account_mismatch`, health, readiness, documentation, and Better Auth behavior.
- Do not add Redis, database-backed rate counters, new database tables, admin controls, automatic retries, usage meters, or new throttle/quota UI.
- Never add account IDs, headers, request bodies, or sync payloads to logs.

## File Map

### Durable sync quota

- Create `packages/db/test/sync-store.integration.test.ts`: exact-limit, duplicate, atomic rejection, and concurrency contracts against PostgreSQL.
- Modify `packages/db/src/sync-store.ts`: quota configuration, unique-new-ID accounting, and `SyncOperationQuotaExceededError`.
- Modify `packages/db/package.json`: serialize migration-backed integration test files.

### Authenticated API rate limits

- Create `apps/api/src/rate-limit.ts`: typed default route policies.
- Modify `apps/api/package.json` and `pnpm-lock.yaml`: add the security-fixed Fastify plugin.
- Modify `apps/api/src/server.ts`: request principal decoration, authentication hook, route limits, stable `429`, and quota-to-`413` mapping.
- Modify `apps/api/test/server.test.ts`: rate policy, ordering, spoof resistance, and quota response tests.

### Configuration and deployment

- Modify `apps/api/src/config.ts`: positive integer `SYNC_OPERATION_QUOTA` with a `50000` default.
- Modify `apps/api/test/config.test.ts`: default, override, and invalid-value contracts.
- Modify `apps/api/src/main.ts`: pass the configured quota into `PostgresSyncStore`.
- Modify `compose.yaml`: expose the local quota with a `50000` default.
- Modify `compose.poc.yaml`: expose the production POC quota with a `50000` default.
- Modify `ops/poc/poc.env.example`: document the quota value.
- Modify `ops/poc/test/fixtures/poc.env`: provide the rendered-Compose fixture value.
- Modify `ops/poc/test/compose.test.mjs`: assert the rendered API quota.
- Modify `ops/poc/README.md`: document the default and tuning boundary.

### Client regression and final verification

- Modify `apps/web/lib/sync.test.ts`: prove `429` and `413` pushes never acknowledge pending work.
- Do not modify production web code; the existing generic `Sync error` state remains.

---

### Task 1: Enforce the sync-operation quota atomically

**Files:**

- Create: `packages/db/test/sync-store.integration.test.ts`
- Modify: `packages/db/src/sync-store.ts`
- Modify: `packages/db/package.json`

**Interfaces:**

- Produces `SyncStoreOptions { maxOperations?: number }`.
- Produces `new PostgresSyncStore(db: DialedDatabase, options?: SyncStoreOptions)` with a `50000` default.
- Produces `SyncOperationQuotaExceededError` with readonly `limit`, `current`, and `attemptedNew` number fields for Task 2.
- Preserves the existing `SyncStore.push(userId, operations): Promise<PushResult[]>` interface.

- [ ] **Step 1: Write failing PostgreSQL quota tests**

Create `packages/db/test/sync-store.integration.test.ts` with migrated-database setup, isolated users, and operation helpers:

```ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  createDatabase,
  migrateDatabase,
  PostgresSyncStore,
  SyncOperationQuotaExceededError,
  users,
  type IncomingSyncOperation,
} from "../src/index.js";

const databaseUrl = process.env.DIALED_INTEGRATION_DATABASE_URL;
assert.ok(databaseUrl, "DIALED_INTEGRATION_DATABASE_URL is required");
await migrateDatabase(databaseUrl);
const database = createDatabase(databaseUrl);
test.after(async () => database.close());

function operation(): IncomingSyncOperation {
  return {
    operationId: randomUUID(),
    entity: "brew",
    entityId: randomUUID(),
    action: "delete",
  };
}

async function withUser(run: (userId: string) => Promise<void>): Promise<void> {
  const suffix = randomUUID();
  const userId = `quota-${suffix}`;
  await database.db.insert(users).values({
    id: userId,
    name: "Quota Test",
    email: `${suffix}@example.com`,
  });
  try {
    await run(userId);
  } finally {
    await database.db.delete(users).where(eq(users.id, userId));
  }
}
```

Add one test that fills a quota of two with `[first]` followed by `[second, second]`, verifies the second result is a duplicate, retries both stored IDs successfully at the limit, then rejects `third` and confirms export still contains exactly two rows:

```ts
test("counts unique new IDs and keeps duplicate retries available at the quota", async () => {
  await withUser(async (userId) => {
    const store = new PostgresSyncStore(database.db, { maxOperations: 2 });
    const first = operation();
    const second = operation();
    const third = operation();

    await store.push(userId, [first]);
    const fill = await store.push(userId, [second, second]);
    assert.deepEqual(
      fill.map((result) => result.duplicate),
      [false, true],
    );
    assert.deepEqual(
      (await store.push(userId, [first, second])).map(
        (result) => result.duplicate,
      ),
      [true, true],
    );

    await assert.rejects(store.push(userId, [third]), (error: unknown) => {
      assert.ok(error instanceof SyncOperationQuotaExceededError);
      assert.deepEqual(
        {
          limit: error.limit,
          current: error.current,
          attemptedNew: error.attemptedNew,
        },
        { limit: 2, current: 2, attemptedNew: 1 },
      );
      return true;
    });
    assert.equal((await store.exportUser(userId)).length, 2);
  });
});
```

Add a concurrency test with a quota of one:

```ts
test("serializes concurrent pushes competing for the final quota slot", async () => {
  await withUser(async (userId) => {
    const store = new PostgresSyncStore(database.db, { maxOperations: 1 });
    const outcomes = await Promise.allSettled([
      store.push(userId, [operation()]),
      store.push(userId, [operation()]),
    ]);

    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1,
    );
    const [rejected] = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    assert.ok(rejected?.reason instanceof SyncOperationQuotaExceededError);
    assert.equal((await store.exportUser(userId)).length, 1);
  });
});
```

Change `packages/db/package.json` so migration-backed files cannot race one another:

```json
"test:integration": "node --import tsx --test --test-concurrency=1 test/*.integration.test.ts"
```

- [ ] **Step 2: Run the database test and verify RED**

Start the local PostgreSQL service if it is not already available:

```bash
docker compose up -d postgres
```

Run:

```bash
DIALED_INTEGRATION_DATABASE_URL=postgresql://dialed:dialed@127.0.0.1:5432/dialed pnpm test:db-integration
```

Expected: FAIL because `SyncStoreOptions`, the two-argument constructor, and `SyncOperationQuotaExceededError` do not exist.

- [ ] **Step 3: Add the quota error and store option**

Add to `packages/db/src/sync-store.ts`:

```ts
export interface SyncStoreOptions {
  maxOperations?: number;
}

export class SyncOperationQuotaExceededError extends Error {
  constructor(
    public readonly limit: number,
    public readonly current: number,
    public readonly attemptedNew: number,
  ) {
    super(`Sync operation quota of ${limit} exceeded`);
    this.name = "SyncOperationQuotaExceededError";
  }
}
```

Change the store constructor to validate and retain the limit:

```ts
export class PostgresSyncStore implements SyncStore {
  private readonly maxOperations: number;

  constructor(
    private readonly db: DialedDatabase,
    options: SyncStoreOptions = {},
  ) {
    this.maxOperations = options.maxOperations ?? 50_000;
    if (!Number.isInteger(this.maxOperations) || this.maxOperations < 1) {
      throw new Error("maxOperations must be a positive integer");
    }
  }
```

- [ ] **Step 4: Enforce unique-new-ID accounting under the advisory lock**

Immediately after `existingLedger` is loaded and before dependency validation or inserts, calculate the new IDs and throw atomically:

```ts
const existingOperationIds = new Set(
  existingLedger.map((operation) => operation.operationId),
);
const newOperationIds = new Set(
  operations
    .map((operation) => operation.operationId)
    .filter((operationId) => !existingOperationIds.has(operationId)),
);
if (existingLedger.length + newOperationIds.size > this.maxOperations) {
  throw new SyncOperationQuotaExceededError(
    this.maxOperations,
    existingLedger.length,
    newOperationIds.size,
  );
}
```

Keep dependency validation, revision allocation, duplicate lookup, and insertion inside the same transaction in their current order after this check.

- [ ] **Step 5: Run database and package verification and verify GREEN**

Run:

```bash
DIALED_INTEGRATION_DATABASE_URL=postgresql://dialed:dialed@127.0.0.1:5432/dialed pnpm test:db-integration
pnpm --filter @dialed/db typecheck
```

Expected: both quota tests and the existing migration test pass; TypeScript exits 0.

- [ ] **Step 6: Commit the durable quota slice**

```bash
git add packages/db/package.json packages/db/src/sync-store.ts packages/db/test/sync-store.integration.test.ts
git commit -m "feat(db): enforce sync operation quota"
```

### Task 2: Rate-limit verified accounts and expose stable API errors

**Files:**

- Create: `apps/api/src/rate-limit.ts`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/test/server.test.ts`

**Interfaces:**

- Consumes `SyncOperationQuotaExceededError` from Task 1.
- Produces `ApiRateLimitPolicy` with keys `me`, `syncPush`, `syncPull`, `accountExport`, and `accountDelete`.
- Produces `defaultApiRateLimits: ApiRateLimitPolicy`.
- Extends `ServerDependencies` with `rateLimits?: ApiRateLimitPolicy`.
- Decorates each authenticated request with `dialedPrincipal: Principal | null` for route handlers and the plugin key generator.

- [ ] **Step 1: Write failing server tests for every bucket and error contract**

Import `SyncOperationQuotaExceededError`, `defaultApiRateLimits`, and `ApiRateLimitPolicy` in `apps/api/test/server.test.ts`. Add this override helper:

```ts
function oneRequestPolicy(key: keyof ApiRateLimitPolicy): ApiRateLimitPolicy {
  return {
    ...defaultApiRateLimits,
    [key]: {
      ...defaultApiRateLimits[key],
      max: 1,
      timeWindow: 60_000,
    },
  };
}
```

Define five scenarios using new servers so counters cannot leak between cases:

```ts
const limitedRouteCases = [
  {
    name: "account lookup",
    key: "me",
    request: { method: "GET", url: "/v1/me" },
    firstStatus: 200,
  },
  {
    name: "sync push",
    key: "syncPush",
    request: {
      method: "POST",
      url: "/v1/sync/push",
      headers: { "x-dialed-account-id": "user-1" },
      payload: {
        operations: [
          {
            operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d5001",
            entity: "bean",
            entityId: syncEntityFixtures.bean.id,
            action: "upsert",
            payload: syncEntityFixtures.bean,
          },
        ],
      },
    },
    firstStatus: 200,
  },
  {
    name: "sync pull",
    key: "syncPull",
    request: {
      method: "GET",
      url: "/v1/sync/pull?cursor=0",
      headers: { "x-dialed-account-id": "user-1" },
    },
    firstStatus: 200,
  },
  {
    name: "account export",
    key: "accountExport",
    request: { method: "GET", url: "/v1/account/export?format=json" },
    firstStatus: 200,
  },
  {
    name: "account deletion",
    key: "accountDelete",
    request: {
      method: "DELETE",
      url: "/v1/account",
      headers: { "x-dialed-account-id": "user-1" },
      payload: { confirmation: "DELETE" },
    },
    firstStatus: 204,
  },
] as const;
```

For each scenario, inject twice and assert the stable contract:

```ts
for (const scenario of limitedRouteCases) {
  test(`rate limits ${scenario.name} by verified account`, async () => {
    const app = createServer({
      auth: signedIn,
      store: new MemoryStore(),
      rateLimits: oneRequestPolicy(scenario.key),
    });
    const first = await app.inject(scenario.request);
    const limited = await app.inject(scenario.request);

    assert.equal(first.statusCode, scenario.firstStatus);
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, "rate_limit_exceeded");
    assert.ok(limited.json().error.retryAfterSeconds > 0);
    assert.ok(Number(limited.headers["retry-after"]) > 0);
    await app.close();
  });
}
```

Add an authentication-order test:

```ts
test("rejects unauthenticated requests before account rate limiting", async () => {
  const app = createServer({
    auth: signedOut,
    store: new MemoryStore(),
    rateLimits: oneRequestPolicy("me"),
  });
  const first = await app.inject({ method: "GET", url: "/v1/me" });
  const second = await app.inject({ method: "GET", url: "/v1/me" });
  assert.deepEqual([first.statusCode, second.statusCode], [401, 401]);
  await app.close();
});
```

Add a table-driven spoof-resistance test. Create a fresh server for each second-request header, perform one successful push with `x-dialed-account-id: user-1`, then repeat with either a `user-2` header or no account header. Both variants must return `429`, proving neither changing nor omitting the header selects another bucket:

```ts
for (const variant of [
  { name: "changed", headers: { "x-dialed-account-id": "user-2" } },
  { name: "omitted", headers: {} },
]) {
  test(`does not let a ${variant.name} account header select another bucket`, async () => {
    const app = createServer({
      auth: signedIn,
      store: new MemoryStore(),
      rateLimits: oneRequestPolicy("syncPush"),
    });
    const payload = limitedRouteCases[1].request.payload;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/sync/push",
          headers: { "x-dialed-account-id": "user-1" },
          payload,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/sync/push",
          headers: variant.headers,
          payload,
        })
      ).statusCode,
      429,
    );
    await app.close();
  });
}
```

Add a quota mapping store and response assertion:

```ts
class QuotaStore extends MemoryStore {
  override async push(): Promise<PushResult[]> {
    throw new SyncOperationQuotaExceededError(50_000, 50_000, 1);
  }
}

test("maps sync quota exhaustion to a stable 413 response", async () => {
  const app = createServer({ auth: signedIn, store: new QuotaStore() });
  const response = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: { "x-dialed-account-id": "user-1" },
    payload: limitedRouteCases[1].request.payload,
  });
  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.json(), {
    error: {
      code: "sync_quota_exceeded",
      message: "Cloud sync storage limit reached",
      limit: 50_000,
      current: 50_000,
      attemptedNew: 1,
    },
  });
  await app.close();
});
```

- [ ] **Step 2: Run API tests and verify RED**

Run:

```bash
pnpm --filter @dialed/api test
```

Expected: FAIL because the policy module, server dependency, route limits, and quota response mapping do not exist.

- [ ] **Step 3: Install the security-fixed Fastify plugin**

Run:

```bash
pnpm --filter @dialed/api add @fastify/rate-limit@^11.2.0
```

Verify `apps/api/package.json` and `pnpm-lock.yaml` resolve a version at or above 11.2.0.

- [ ] **Step 4: Add the typed route policy**

Create `apps/api/src/rate-limit.ts`:

```ts
export interface ApiRateLimitRule {
  max: number;
  timeWindow: number;
  groupId: string;
}

export interface ApiRateLimitPolicy {
  me: ApiRateLimitRule;
  syncPush: ApiRateLimitRule;
  syncPull: ApiRateLimitRule;
  accountExport: ApiRateLimitRule;
  accountDelete: ApiRateLimitRule;
}

export const defaultApiRateLimits: ApiRateLimitPolicy = {
  me: { max: 120, timeWindow: 60_000, groupId: "me" },
  syncPush: { max: 30, timeWindow: 60_000, groupId: "sync-push" },
  syncPull: { max: 120, timeWindow: 60_000, groupId: "sync-pull" },
  accountExport: {
    max: 5,
    timeWindow: 3_600_000,
    groupId: "account-export",
  },
  accountDelete: {
    max: 5,
    timeWindow: 3_600_000,
    groupId: "account-delete",
  },
};
```

- [ ] **Step 5: Authenticate before the limiter and key only by principal**

In `apps/api/src/server.ts`, import the plugin and policy, add `rateLimits?: ApiRateLimitPolicy` to `ServerDependencies`, and augment Fastify:

```ts
declare module "fastify" {
  interface FastifyRequest {
    dialedPrincipal: Principal | null;
  }
}
```

After creating the Fastify instance, decorate the request and register the plugin before declaring routes:

```ts
app.decorateRequest("dialedPrincipal", null);
const rateLimits = dependencies.rateLimits ?? defaultApiRateLimits;

void app.register(rateLimit, {
  global: false,
  hook: "preHandler",
  keyGenerator(request) {
    if (!request.dialedPrincipal) {
      throw new Error(
        "Rate-limited route is missing an authenticated principal",
      );
    }
    return request.dialedPrincipal.id;
  },
  errorResponseBuilder(_request, context) {
    return {
      statusCode: 429,
      error: {
        code: "rate_limit_exceeded",
        message: "Too many requests; try again shortly",
        retryAfterSeconds: Math.max(1, Math.ceil(context.ttl / 1000)),
      },
    };
  },
});
```

Replace handler-local authentication with one `preValidation` function that calls `dependencies.auth.authenticate`, sends the existing `401` body on failure, and assigns the verified result to `request.dialedPrincipal` on success. Each `/v1` route must use that hook and its exact route policy:

```ts
app.get(
  "/v1/me",
  {
    preValidation: authenticateV1,
    config: { rateLimit: rateLimits.me },
  },
  async (request) => ({ user: request.dialedPrincipal! }),
);
```

Apply the same shape with `syncPush`, `syncPull`, `accountExport`, and `accountDelete`. Route handlers use `request.dialedPrincipal!` and retain their existing expected-account checks and behavior.

Place a `statusCode === 429` branch before the generic `500` branch in `setErrorHandler`:

```ts
if (error.statusCode === 429) {
  return reply.code(429).send(error);
}
```

Do not log principal values in this branch or elsewhere.

- [ ] **Step 6: Map quota exhaustion without changing other sync errors**

In the sync-push catch block, before the existing dependency-error branch, add:

```ts
if (error instanceof SyncOperationQuotaExceededError) {
  return reply.code(413).send({
    error: {
      code: "sync_quota_exceeded",
      message: "Cloud sync storage limit reached",
      limit: error.limit,
      current: error.current,
      attemptedNew: error.attemptedNew,
    },
  });
}
```

Leave `InvalidSyncDependencyError` mapped to its existing `400`, and rethrow unknown errors.

- [ ] **Step 7: Run API verification and verify GREEN**

Run:

```bash
pnpm --filter @dialed/api test
pnpm --filter @dialed/api typecheck
```

Expected: all server, logger, config, and auth tests pass; TypeScript exits 0.

- [ ] **Step 8: Commit the API protection slice**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/rate-limit.ts apps/api/src/server.ts apps/api/test/server.test.ts
git commit -m "feat(api): rate limit authenticated account routes"
```

### Task 3: Wire quota configuration into local and POC deployments

**Files:**

- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/test/config.test.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `compose.yaml`
- Modify: `compose.poc.yaml`
- Modify: `ops/poc/poc.env.example`
- Modify: `ops/poc/test/fixtures/poc.env`
- Modify: `ops/poc/test/compose.test.mjs`
- Modify: `ops/poc/README.md`

**Interfaces:**

- Consumes `PostgresSyncStore(database.db, { maxOperations })` from Task 1.
- Produces `ApiConfig.SYNC_OPERATION_QUOTA: number` with a `50000` default.
- Produces `SYNC_OPERATION_QUOTA=50000` in the rendered local and POC API container environments.

- [ ] **Step 1: Write failing configuration and Compose assertions**

In `apps/api/test/config.test.ts`, extend the default test and add override/invalid tests:

```ts
assert.equal(config.SYNC_OPERATION_QUOTA, 50_000);

test("configuration accepts a positive sync operation quota", () => {
  assert.equal(
    readConfig({ ...validEnvironment, SYNC_OPERATION_QUOTA: "250" })
      .SYNC_OPERATION_QUOTA,
    250,
  );
});

test("configuration rejects a non-positive sync operation quota", () => {
  assert.throws(
    () => readConfig({ ...validEnvironment, SYNC_OPERATION_QUOTA: "0" }),
    /SYNC_OPERATION_QUOTA/,
  );
});
```

In `ops/poc/test/compose.test.mjs`, assert:

```js
assert.equal(model.services.api.environment.SYNC_OPERATION_QUOTA, "50000");
```

- [ ] **Step 2: Run API and ops tests and verify RED**

Run:

```bash
pnpm --filter @dialed/api test
pnpm test:ops
```

Expected: the new configuration assertion fails because the API schema and rendered Compose environment lack the quota.

- [ ] **Step 3: Add and wire the API configuration**

Add this field to `configSchema` in `apps/api/src/config.ts`:

```ts
SYNC_OPERATION_QUOTA: z.coerce.number().int().positive().default(50_000),
```

Change the store construction in `apps/api/src/main.ts` to:

```ts
store: new PostgresSyncStore(database.db, {
  maxOperations: config.SYNC_OPERATION_QUOTA,
}),
```

- [ ] **Step 4: Expose the same default in Compose and POC documentation**

Add this API environment entry to both `compose.yaml` and `compose.poc.yaml`:

```yaml
SYNC_OPERATION_QUOTA: ${SYNC_OPERATION_QUOTA:-50000}
```

Add to `ops/poc/poc.env.example` and `ops/poc/test/fixtures/poc.env`:

```dotenv
SYNC_OPERATION_QUOTA=50000
```

In `ops/poc/README.md`, immediately after the paragraph describing required environment values, document: “`SYNC_OPERATION_QUOTA` defaults to `50000` unique ledger operations per account. Keep that value for the friend beta; increasing it requires reviewing Raspberry Pi database capacity.”

- [ ] **Step 5: Run configuration, ops, and type verification and verify GREEN**

Run:

```bash
pnpm --filter @dialed/api test
pnpm --filter @dialed/api typecheck
pnpm test:ops
```

Expected: API configuration tests and rendered POC Compose assertions pass; ops tests either pass or report only their existing documented Docker-dependent skips.

- [ ] **Step 6: Commit the deployment configuration slice**

```bash
git add apps/api/src/config.ts apps/api/test/config.test.ts apps/api/src/main.ts compose.yaml compose.poc.yaml ops/poc/poc.env.example ops/poc/test/fixtures/poc.env ops/poc/test/compose.test.mjs ops/poc/README.md
git commit -m "chore(ops): configure sync operation quota"
```

### Task 4: Lock in client queue safety and run release verification

**Files:**

- Modify: `apps/web/lib/sync.test.ts`

**Interfaces:**

- Consumes the stable `429 rate_limit_exceeded` and `413 sync_quota_exceeded` responses from Task 2.
- Produces no production client interface; the current `Sync error` state and manual retry behavior remain unchanged.

- [ ] **Step 1: Add explicit pending-queue regression tests**

Add a table-driven test beside the existing non-409 push-failure test:

```ts
it.each([
  {
    status: 429,
    body: {
      error: {
        code: "rate_limit_exceeded",
        message: "Too many requests; try again shortly",
        retryAfterSeconds: 30,
      },
    },
  },
  {
    status: 413,
    body: {
      error: {
        code: "sync_quota_exceeded",
        message: "Cloud sync storage limit reached",
        limit: 50_000,
        current: 50_000,
        attemptedNew: 1,
      },
    },
  },
])(
  "preserves pending operations after a $status push rejection",
  async ({ status, body }) => {
    const pending = [queuedOperation()];
    const acknowledgeOperations = vi.fn(async () => undefined);
    const getOperations = vi.fn(async () => pending);
    const sync = createSynchronizer(
      dependencies({
        fetch: vi.fn(async (input: string | URL | Request) => {
          if (String(input) === "/api/v1/me") {
            return response(200, { user: aliceAccount });
          }
          return response(status, body);
        }),
        getOperations,
        acknowledgeOperations,
      }),
    );

    await expect(sync(alice)).rejects.toThrow("Sync push failed");
    expect(acknowledgeOperations).not.toHaveBeenCalled();
    expect(await getOperations(alice)).toEqual(pending);
  },
);
```

Do not add typed errors, timers, status variants, or component changes.

- [ ] **Step 2: Run the focused web test and verify GREEN**

Run:

```bash
pnpm --filter @dialed/web exec vitest run lib/sync.test.ts
```

Expected: the new `429` and `413` cases pass with the existing production synchronizer, proving no web implementation change is necessary.

- [ ] **Step 3: Run the complete repository verification**

Run:

```bash
pnpm format:check
pnpm typecheck
pnpm test
DIALED_INTEGRATION_DATABASE_URL=postgresql://dialed:dialed@127.0.0.1:5432/dialed pnpm test:db-integration
pnpm test:ops
pnpm build
pnpm --filter @dialed/api why @fastify/rate-limit
```

Expected:

- Formatting, type checks, unit tests, database integration tests, ops tests, and production builds exit 0, aside from existing documented environment-dependent ops skips.
- `pnpm why` reports `@fastify/rate-limit` at version 11.2.0 or newer.
- No test starts a new UI or infrastructure requirement.

- [ ] **Step 4: Review the final diff against the launch-focused scope**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Confirm the diff contains only the files in this plan, no database migration, no production web change, no Cloudflare cutover change, and no logged account or payload data.

- [ ] **Step 5: Commit the client regression**

```bash
git add apps/web/lib/sync.test.ts
git commit -m "test(web): preserve pending sync work on guardrail errors"
```

- [ ] **Step 6: Record the handoff for the immediate launch task**

In the implementation completion message, state that the guardrails are ready for deployment behind Access and that the next task is strictly: update the Access-dependent external checker, configure the Cloudflare WAF rate rule, remove Access from the app hostname, and invite the initial friend cohort. Do not add another hardening milestone before that cutover unless verification found a concrete blocker.
