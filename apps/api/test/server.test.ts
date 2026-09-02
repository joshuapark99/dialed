import assert from "node:assert/strict";
import test from "node:test";
import type {
  IncomingSyncOperation,
  PushResult,
  StoredSyncOperation,
  SyncStore,
} from "@dialed/db";
import {
  SyncOperationQuotaExceededError,
  validateCoffeeBagDependencies,
} from "@dialed/db";
import type { AuthService } from "../src/auth.js";
import {
  defaultApiRateLimits,
  type ApiRateLimitPolicy,
} from "../src/rate-limit.js";
import { createServer } from "../src/server.js";
import { syncEntityFixtures } from "../../../test-fixtures/sync-entities.js";

class MemoryStore implements SyncStore {
  operations: Array<StoredSyncOperation & { userId: string }> = [];
  deletedUsers: string[] = [];
  pushCalls = 0;
  pullCalls = 0;
  unavailable = false;

  async health() {
    if (this.unavailable) throw new Error("unavailable");
  }
  async push(
    userId: string,
    incoming: IncomingSyncOperation[],
  ): Promise<PushResult[]> {
    this.pushCalls += 1;
    validateCoffeeBagDependencies(
      this.operations.filter((operation) => operation.userId === userId),
      incoming,
    );
    return incoming.map((operation) => {
      const duplicate = this.operations.find(
        (item) =>
          item.userId === userId && item.operationId === operation.operationId,
      );
      if (duplicate)
        return {
          operationId: operation.operationId,
          revision: duplicate.revision,
          duplicate: true,
        };
      const stored = {
        ...operation,
        userId,
        payload: operation.payload ?? null,
        revision: this.operations.length + 1,
        receivedAt: new Date().toISOString(),
      };
      this.operations.push(stored);
      return {
        operationId: operation.operationId,
        revision: stored.revision,
        duplicate: false,
      };
    });
  }
  async pull(userId: string, cursor: number, limit: number) {
    this.pullCalls += 1;
    return this.operations
      .filter(
        (operation) =>
          operation.userId === userId && operation.revision > cursor,
      )
      .slice(0, limit)
      .map(({ userId: _userId, ...operation }) => operation);
  }
  async exportUser(userId: string) {
    return this.operations
      .filter((operation) => operation.userId === userId)
      .map(({ userId: _userId, ...operation }) => operation);
  }
  async deleteUser(userId: string) {
    this.deletedUsers.push(userId);
  }
}

const signedIn: AuthService = {
  async authenticate() {
    return { id: "user-1", email: "barista@example.com", name: "Barista" };
  },
};
const signedOut: AuthService = {
  async authenticate() {
    return null;
  },
};

function signedInAs(id: string): AuthService {
  return {
    async authenticate() {
      return { id, email: `${id}@example.com`, name: id };
    },
  };
}

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
    const retryAfterSeconds = Number(limited.headers["retry-after"]);
    assert.ok(Number.isInteger(retryAfterSeconds));
    assert.ok(retryAfterSeconds > 0);
    assert.deepEqual(limited.json(), {
      error: {
        code: "rate_limit_exceeded",
        message: "Too many requests; try again shortly",
        retryAfterSeconds,
      },
    });
    await app.close();
  });
}

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

const coffeePayload = {
  id: "0198d4a4-3ad8-7fa1-b653-9a51a55d4f90",
  name: "Hualalai Kona",
  roaster: "Coffee Purveyors",
  originCountry: "United States",
  originRegion: "Kona, Hawaii",
  producer: "Kona Hills Estate",
  process: "Washed",
  varietal: "Typica",
  elevationMeters: 610,
  roastLevel: "medium-light",
  notes: "Milk chocolate and orange",
  createdAt: "2026-08-22T12:00:00.000Z",
} as const;

const coffeeBagPayload = {
  id: "0198d4a4-3ad8-7fa1-b653-9a51a55d4f91",
  coffeeId: coffeePayload.id,
  roastedOn: "2026-08-15",
  purchasedOn: "2026-08-18",
  openedOn: "2026-08-22",
  startingWeightGrams: 340,
  notes: "First bag",
  createdAt: "2026-08-22T12:00:00.000Z",
} as const;

test("health and readiness expose revision and dependency state", async () => {
  const store = new MemoryStore();
  const revision = "0123456789abcdef0123456789abcdef01234567";
  const app = createServer({ auth: signedOut, store, revision });

  const health = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: "ok", revision });

  const ready = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), { status: "ready", revision });

  store.unavailable = true;
  const unavailable = await app.inject({
    method: "GET",
    url: "/readyz",
  });
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.json(), {
    status: "unavailable",
    revision,
  });

  await app.close();
});

test("health defaults to the development revision", async () => {
  const app = createServer({ auth: signedOut, store: new MemoryStore() });

  assert.deepEqual(
    (await app.inject({ method: "GET", url: "/healthz" })).json(),
    { status: "ok", revision: "development" },
  );

  await app.close();
});

test("auth endpoints forward parsed JSON bodies to the auth handler", async () => {
  let receivedBody: unknown;
  const auth: AuthService = {
    async authenticate() {
      return null;
    },
    handler: async (request) => {
      receivedBody = await request.json();
      return Response.json({
        url: "https://accounts.google.com/o/oauth2/v2/auth",
        redirect: true,
      });
    },
  };
  const app = createServer({ auth, store: new MemoryStore() });

  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/social",
    headers: {
      origin: "http://localhost:3000",
    },
    payload: {
      provider: "google",
      callbackURL: "http://localhost:3000",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(receivedBody, {
    provider: "google",
    callbackURL: "http://localhost:3000",
  });
  assert.deepEqual(response.json(), {
    url: "https://accounts.google.com/o/oauth2/v2/auth",
    redirect: true,
  });
  await app.close();
});

test("protected endpoints require authentication", async () => {
  const app = createServer({ auth: signedOut, store: new MemoryStore() });
  const response = await app.inject({ method: "GET", url: "/v1/me" });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "unauthorized");
  await app.close();
});

test("sync accepts UUIDv7 envelopes, is idempotent, and advances its cursor", async () => {
  const app = createServer({ auth: signedIn, store: new MemoryStore() });
  const operation = {
    operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4f78",
    entity: "bean",
    entityId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4f79",
    action: "upsert",
    payload: syncEntityFixtures.bean,
  };
  const first = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: { "x-dialed-account-id": "user-1" },
    payload: { operations: [operation] },
  });
  const retry = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: { "x-dialed-account-id": "user-1" },
    payload: { operations: [operation] },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().results[0].duplicate, false);
  assert.equal(retry.json().results[0].duplicate, true);

  const pull = await app.inject({
    method: "GET",
    url: "/v1/sync/pull?cursor=0",
    headers: { "x-dialed-account-id": "user-1" },
  });
  assert.equal(pull.json().operations.length, 1);
  assert.equal(pull.json().cursor, 1);
  await app.close();
});

test("sync accepts each valid entity payload before storing it", async () => {
  const store = new MemoryStore();
  const app = createServer({ auth: signedIn, store });
  const operations = Object.entries(syncEntityFixtures).map(
    ([entity, payload], index) => ({
      operationId: `0198d4a4-3ad8-7fa1-b653-9a51a55d4f9${index}`,
      entity,
      entityId: payload.id,
      action: "upsert",
      payload,
    }),
  );

  const response = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: { "x-dialed-account-id": "user-1" },
    payload: { operations },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(store.pushCalls, 1);
  assert.equal(store.operations.length, 4);
  await app.close();
});

test("sync accepts current Coffee and bag payloads", async () => {
  const store = new MemoryStore();
  const app = createServer({ auth: signedIn, store });
  const response = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: { "x-dialed-account-id": "user-1" },
    payload: {
      operations: [
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4fa0",
          entity: "coffee",
          entityId: coffeePayload.id,
          action: "upsert",
          payload: coffeePayload,
        },
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4fa1",
          entity: "bean",
          entityId: coffeeBagPayload.id,
          action: "upsert",
          payload: coffeeBagPayload,
        },
      ],
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(store.pushCalls, 1);
  assert.equal(store.operations.length, 2);
  await app.close();
});

test("sync atomically rejects Coffee deletion while a current bag remains active", async () => {
  const store = new MemoryStore();
  const app = createServer({ auth: signedIn, store });
  const response = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: { "x-dialed-account-id": "user-1" },
    payload: {
      operations: [
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4fb0",
          entity: "coffee",
          entityId: coffeePayload.id,
          action: "upsert",
          payload: coffeePayload,
        },
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4fb1",
          entity: "bean",
          entityId: coffeeBagPayload.id,
          action: "upsert",
          payload: coffeeBagPayload,
        },
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4fb2",
          entity: "coffee",
          entityId: coffeePayload.id,
          action: "delete",
        },
      ],
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "invalid_dependency");
  assert.equal(response.json().error.entityId, coffeeBagPayload.id);
  assert.equal(response.json().error.coffeeId, coffeePayload.id);
  assert.equal(store.operations.length, 0);
  await app.close();
});

test("sync rejects Coffee deletion while a prior-ledger bag remains active", async () => {
  const store = new MemoryStore();
  const app = createServer({ auth: signedIn, store });
  const headers = { "x-dialed-account-id": "user-1" };
  const setupResponse = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers,
    payload: {
      operations: [
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4fb3",
          entity: "coffee",
          entityId: coffeePayload.id,
          action: "upsert",
          payload: coffeePayload,
        },
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4fb4",
          entity: "bean",
          entityId: coffeeBagPayload.id,
          action: "upsert",
          payload: coffeeBagPayload,
        },
      ],
    },
  });
  const deleteResponse = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers,
    payload: {
      operations: [
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4fb5",
          entity: "coffee",
          entityId: coffeePayload.id,
          action: "delete",
        },
      ],
    },
  });

  assert.equal(setupResponse.statusCode, 200);
  assert.equal(deleteResponse.statusCode, 400);
  assert.equal(deleteResponse.json().error.code, "invalid_dependency");
  assert.equal(store.operations.length, 2);
  await app.close();
});

for (const scenario of [
  {
    label: "current bag",
    operationIds: [
      "0198d4a4-3ad8-7fa1-b653-9a51a55d4fc0",
      "0198d4a4-3ad8-7fa1-b653-9a51a55d4fc1",
      "0198d4a4-3ad8-7fa1-b653-9a51a55d4fc2",
      "0198d4a4-3ad8-7fa1-b653-9a51a55d4fc3",
      "0198d4a4-3ad8-7fa1-b653-9a51a55d4fc4",
      "0198d4a4-3ad8-7fa1-b653-9a51a55d4fc5",
    ],
    bagPayload: coffeeBagPayload,
  },
  {
    label: "marked legacy pair",
    operationIds: [
      "0198d4a4-3ad8-7fa1-b653-9a51a55d4fd0",
      "0198d4a4-3ad8-7fa1-b653-9a51a55d4fd1",
      "0198d4a4-3ad8-7fa1-b653-9a51a55d4fd2",
      "0198d4a4-3ad8-7fa1-b653-9a51a55d4fd3",
      "0198d4a4-3ad8-7fa1-b653-9a51a55d4fd4",
      "0198d4a4-3ad8-7fa1-b653-9a51a55d4fd5",
    ],
    bagPayload: { ...coffeeBagPayload, legacyPairedCoffee: true as const },
  },
] as const) {
  test(`sync accepts ordered bag-first removal for a ${scenario.label} and keeps its retry idempotent`, async () => {
    const store = new MemoryStore();
    const app = createServer({ auth: signedIn, store });
    const headers = { "x-dialed-account-id": "user-1" };
    const coffeeDelete = {
      operationId: scenario.operationIds[3],
      entity: "coffee",
      entityId: coffeePayload.id,
      action: "delete",
    } as const;
    const first = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers,
      payload: {
        operations: [
          {
            operationId: scenario.operationIds[0],
            entity: "coffee",
            entityId: coffeePayload.id,
            action: "upsert",
            payload: coffeePayload,
          },
          {
            operationId: scenario.operationIds[1],
            entity: "bean",
            entityId: coffeeBagPayload.id,
            action: "upsert",
            payload: scenario.bagPayload,
          },
          {
            operationId: scenario.operationIds[2],
            entity: "bean",
            entityId: coffeeBagPayload.id,
            action: "delete",
          },
          coffeeDelete,
        ],
      },
    });
    const recreate = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers,
      payload: {
        operations: [
          {
            operationId: scenario.operationIds[4],
            entity: "coffee",
            entityId: coffeePayload.id,
            action: "upsert",
            payload: coffeePayload,
          },
          {
            operationId: scenario.operationIds[5],
            entity: "bean",
            entityId: coffeeBagPayload.id,
            action: "upsert",
            payload: scenario.bagPayload,
          },
        ],
      },
    });
    const retry = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers,
      payload: { operations: [coffeeDelete] },
    });

    assert.equal(first.statusCode, 200);
    assert.equal(recreate.statusCode, 200);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().results[0].duplicate, true);
    assert.equal(store.operations.length, 6);
    await app.close();
  });
}

test("sync scopes Coffee-delete dependencies to the authenticated owner", async () => {
  const store = new MemoryStore();
  const otherUserApp = createServer({ auth: signedInAs("user-2"), store });
  const otherUserResponse = await otherUserApp.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: { "x-dialed-account-id": "user-2" },
    payload: {
      operations: [
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4fe0",
          entity: "coffee",
          entityId: coffeePayload.id,
          action: "upsert",
          payload: coffeePayload,
        },
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4fe1",
          entity: "bean",
          entityId: coffeeBagPayload.id,
          action: "upsert",
          payload: coffeeBagPayload,
        },
      ],
    },
  });
  assert.equal(otherUserResponse.statusCode, 200);
  await otherUserApp.close();

  const app = createServer({ auth: signedIn, store });
  const response = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: { "x-dialed-account-id": "user-1" },
    payload: {
      operations: [
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4fe2",
          entity: "coffee",
          entityId: coffeePayload.id,
          action: "upsert",
          payload: coffeePayload,
        },
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4fe3",
          entity: "coffee",
          entityId: coffeePayload.id,
          action: "delete",
        },
      ],
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(
    store.operations.filter((operation) => operation.userId === "user-1")
      .length,
    2,
  );
  assert.equal(
    store.operations.filter((operation) => operation.userId === "user-2")
      .length,
    2,
  );
  await app.close();
});

test("sync accepts a current bag whose Coffee is in existing ledger state", async () => {
  const store = new MemoryStore();
  const app = createServer({ auth: signedIn, store });
  const headers = { "x-dialed-account-id": "user-1" };

  const coffeeResponse = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers,
    payload: {
      operations: [
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4fa3",
          entity: "coffee",
          entityId: coffeePayload.id,
          action: "upsert",
          payload: coffeePayload,
        },
      ],
    },
  });
  const bagResponse = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers,
    payload: {
      operations: [
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4fa4",
          entity: "bean",
          entityId: coffeeBagPayload.id,
          action: "upsert",
          payload: coffeeBagPayload,
        },
      ],
    },
  });

  assert.equal(coffeeResponse.statusCode, 200);
  assert.equal(bagResponse.statusCode, 200);
  assert.equal(store.operations.length, 2);
  await app.close();
});

test("sync rejects a current bag when its Coffee is missing", async () => {
  const store = new MemoryStore();
  const app = createServer({ auth: signedIn, store });
  const response = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: { "x-dialed-account-id": "user-1" },
    payload: {
      operations: [
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4fa5",
          entity: "bean",
          entityId: coffeeBagPayload.id,
          action: "upsert",
          payload: coffeeBagPayload,
        },
      ],
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "invalid_dependency");
  assert.equal(store.operations.length, 0);
  await app.close();
});

test("sync rejects a current bag when its Coffee belongs to another user", async () => {
  const store = new MemoryStore();
  const otherUserApp = createServer({ auth: signedInAs("user-2"), store });
  const coffeeResponse = await otherUserApp.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: { "x-dialed-account-id": "user-2" },
    payload: {
      operations: [
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4fa6",
          entity: "coffee",
          entityId: coffeePayload.id,
          action: "upsert",
          payload: coffeePayload,
        },
      ],
    },
  });
  assert.equal(coffeeResponse.statusCode, 200);
  await otherUserApp.close();

  const app = createServer({ auth: signedIn, store });
  const bagResponse = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: { "x-dialed-account-id": "user-1" },
    payload: {
      operations: [
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4fa7",
          entity: "bean",
          entityId: coffeeBagPayload.id,
          action: "upsert",
          payload: coffeeBagPayload,
        },
      ],
    },
  });

  assert.equal(bagResponse.statusCode, 400);
  assert.equal(bagResponse.json().error.code, "invalid_dependency");
  assert.equal(
    store.operations.filter((operation) => operation.userId === "user-1")
      .length,
    0,
  );
  await app.close();
});

test("sync accepts transfer-compatible marked bags", async () => {
  const store = new MemoryStore();
  const app = createServer({ auth: signedIn, store });
  const response = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: { "x-dialed-account-id": "user-1" },
    payload: {
      operations: [
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4fa8",
          entity: "coffee",
          entityId: coffeePayload.id,
          action: "upsert",
          payload: coffeePayload,
        },
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4fa9",
          entity: "bean",
          entityId: coffeeBagPayload.id,
          action: "upsert",
          payload: { ...coffeeBagPayload, legacyPairedCoffee: true },
        },
      ],
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(store.operations.length, 2);
  await app.close();
});

test("sync continues to accept a legacy bean payload", async () => {
  const store = new MemoryStore();
  const app = createServer({ auth: signedIn, store });
  const response = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: { "x-dialed-account-id": "user-1" },
    payload: {
      operations: [
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4fa2",
          entity: "bean",
          entityId: syncEntityFixtures.bean.id,
          action: "upsert",
          payload: syncEntityFixtures.bean,
        },
      ],
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(store.pushCalls, 1);
  assert.equal(store.operations.length, 1);
  await app.close();
});

test("sync keeps oversized legacy bean text compatible", async () => {
  const store = new MemoryStore();
  const app = createServer({ auth: signedIn, store });
  const response = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: { "x-dialed-account-id": "user-1" },
    payload: {
      operations: [
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4faa",
          entity: "bean",
          entityId: syncEntityFixtures.bean.id,
          action: "upsert",
          payload: {
            ...syncEntityFixtures.bean,
            name: "n".repeat(121),
            roaster: "r".repeat(121),
            origin: "o".repeat(241),
          },
        },
      ],
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(store.operations.length, 1);
  await app.close();
});

test("sync rejects payloads that clients cannot replay before store access", async () => {
  const malformed = [
    {
      label: "payload and envelope IDs differ",
      entity: "bean",
      payload: syncEntityFixtures.bean,
      entityId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4f89",
    },
    {
      label: "bean has an unknown field",
      entity: "bean",
      payload: { ...syncEntityFixtures.bean, unknown: true },
    },
    {
      label: "bag has zero starting weight",
      entity: "bean",
      payload: { ...coffeeBagPayload, startingWeightGrams: 0 },
    },
    {
      label: "bag has an invalid Coffee ID",
      entity: "bean",
      payload: { ...coffeeBagPayload, coffeeId: "coffee-1" },
    },
    ...(
      [
        ["name", 121],
        ["roaster", 121],
        ["originCountry", 121],
        ["originRegion", 121],
        ["producer", 241],
        ["process", 121],
        ["varietal", 241],
        ["notes", 2_001],
      ] as const
    ).map(([field, length]) => ({
      label: `coffee has oversized ${field}`,
      entity: "coffee" as const,
      payload: { ...coffeePayload, [field]: "x".repeat(length) },
    })),
    {
      label: "bag has oversized notes",
      entity: "bean",
      payload: { ...coffeeBagPayload, notes: "x".repeat(2_001) },
    },
    {
      label: "machine has an invalid capability",
      entity: "machine",
      payload: {
        ...syncEntityFixtures.machine,
        temperatureControl: "thermostat",
      },
    },
    {
      label: "grinder has an invalid timestamp",
      entity: "grinder",
      payload: { ...syncEntityFixtures.grinder, createdAt: "yesterday" },
    },
    {
      label: "brew has a non-v7 reference",
      entity: "brew",
      payload: { ...syncEntityFixtures.brew, beanId: "bean-1" },
    },
    {
      label: "brew has a non-positive measurement",
      entity: "brew",
      payload: { ...syncEntityFixtures.brew, dose: 0 },
    },
    {
      label: "brew has zero pressure",
      entity: "brew",
      payload: { ...syncEntityFixtures.brew, pressure: 0 },
    },
    {
      label: "brew has negative pre-infusion",
      entity: "brew",
      payload: { ...syncEntityFixtures.brew, preinfusion: -1 },
    },
    {
      label: "brew has an out-of-range taste score",
      entity: "brew",
      payload: {
        ...syncEntityFixtures.brew,
        taste: { ...syncEntityFixtures.brew.taste, enjoyment: 6 },
      },
    },
    {
      label: "brew has a malformed recommendation",
      entity: "brew",
      payload: {
        ...syncEntityFixtures.brew,
        recommendation: {
          ...syncEntityFixtures.brew.recommendation,
          confidence: "certain",
        },
      },
    },
    {
      label: "brew has an invalid sync state",
      entity: "brew",
      payload: { ...syncEntityFixtures.brew, syncState: "uploaded" },
    },
  ] as const;

  for (const [index, candidate] of malformed.entries()) {
    const store = new MemoryStore();
    const app = createServer({ auth: signedIn, store });
    const response = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers: { "x-dialed-account-id": "user-1" },
      payload: {
        operations: [
          {
            operationId: `0198d4a4-3ad8-7fa1-b653-9a51a55d4e${index.toString(16).padStart(2, "0")}`,
            entity: candidate.entity,
            entityId:
              "entityId" in candidate
                ? candidate.entityId
                : candidate.payload.id,
            action: "upsert",
            payload: candidate.payload,
          },
        ],
      },
    });

    assert.equal(response.statusCode, 400, candidate.label);
    assert.equal(
      response.json().error.code,
      "invalid_request",
      candidate.label,
    );
    assert.equal(store.pushCalls, 0, candidate.label);
    assert.deepEqual(store.operations, [], candidate.label);
    await app.close();
  }
});

test("sync accepts a delete without a payload", async () => {
  const store = new MemoryStore();
  const app = createServer({ auth: signedIn, store });
  const response = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: { "x-dialed-account-id": "user-1" },
    payload: {
      operations: [
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4e20",
          entity: "bean",
          entityId: syncEntityFixtures.bean.id,
          action: "delete",
        },
      ],
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(store.pushCalls, 1);
  await app.close();
});

test("sync rejects unsupported entities before store access", async () => {
  const store = new MemoryStore();
  const app = createServer({ auth: signedIn, store });
  const response = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: { "x-dialed-account-id": "user-1" },
    payload: {
      operations: [
        {
          operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4f82",
          entity: "taste",
          entityId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4f83",
          action: "upsert",
          payload: { enjoyment: 4 },
        },
      ],
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "invalid_request");
  assert.equal(store.pushCalls, 0);
  await app.close();
});

test("sync rejects non-v7 operation and entity identifiers", async () => {
  const store = new MemoryStore();
  const app = createServer({ auth: signedIn, store });
  const validOperation = {
    operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4f84",
    entity: "bean",
    entityId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4f85",
    action: "upsert",
    payload: { name: "Kona" },
  };

  for (const field of ["operationId", "entityId"] as const) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers: { "x-dialed-account-id": "user-1" },
      payload: {
        operations: [
          {
            ...validOperation,
            [field]: "550e8400-e29b-41d4-a716-446655440000",
          },
        ],
      },
    });

    assert.equal(response.statusCode, 400, field);
    assert.equal(response.json().error.code, "invalid_request", field);
  }
  assert.equal(store.pushCalls, 0);
  await app.close();
});

test("sync rejects an account binding mismatch before store access", async () => {
  const store = new MemoryStore();
  const app = createServer({ auth: signedIn, store });
  const operation = {
    operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4f80",
    entity: "bean",
    entityId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4f81",
    action: "upsert",
    payload: { name: "Kona" },
  };

  const push = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: { "x-dialed-account-id": "user-2" },
    payload: { operations: [operation] },
  });
  const pull = await app.inject({
    method: "GET",
    url: "/v1/sync/pull?cursor=0",
    headers: { "x-dialed-account-id": "user-2" },
  });

  for (const response of [push, pull]) {
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "account_mismatch");
    assert.equal(response.json().error.actualAccount.id, "user-1");
  }
  assert.equal(store.pushCalls, 0);
  assert.equal(store.pullCalls, 0);
  assert.deepEqual(store.operations, []);
  await app.close();
});

test("account deletion requires explicit confirmation", async () => {
  const store = new MemoryStore();
  const app = createServer({ auth: signedIn, store });
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: "/v1/account",
        headers: { "x-dialed-account-id": "user-1" },
        payload: {},
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: "/v1/account",
        headers: { "x-dialed-account-id": "user-1" },
        payload: { confirmation: "DELETE" },
      })
    ).statusCode,
    204,
  );
  assert.deepEqual(store.deletedUsers, ["user-1"]);
  await app.close();
});

test("account deletion rejects an account mismatch before store access", async () => {
  const store = new MemoryStore();
  const app = createServer({ auth: signedIn, store });
  const response = await app.inject({
    method: "DELETE",
    url: "/v1/account",
    headers: { "x-dialed-account-id": "user-2" },
    payload: { confirmation: "DELETE" },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "account_mismatch");
  assert.equal(response.json().error.actualAccount.id, "user-1");
  assert.deepEqual(store.deletedUsers, []);
  await app.close();
});
