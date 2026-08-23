import assert from "node:assert/strict";
import test from "node:test";
import type {
  IncomingSyncOperation,
  PushResult,
  StoredSyncOperation,
  SyncStore,
} from "@dialed/db";
import type { AuthService } from "../src/auth.js";
import { createServer } from "../src/server.js";
import { syncEntityFixtures } from "../../../test-fixtures/sync-entities.js";

class MemoryStore implements SyncStore {
  operations: StoredSyncOperation[] = [];
  deletedUsers: string[] = [];
  pushCalls = 0;
  pullCalls = 0;
  unavailable = false;

  async health() {
    if (this.unavailable) throw new Error("unavailable");
  }
  async push(
    _userId: string,
    incoming: IncomingSyncOperation[],
  ): Promise<PushResult[]> {
    this.pushCalls += 1;
    return incoming.map((operation) => {
      const duplicate = this.operations.find(
        (item) => item.operationId === operation.operationId,
      );
      if (duplicate)
        return {
          operationId: operation.operationId,
          revision: duplicate.revision,
          duplicate: true,
        };
      const stored = {
        ...operation,
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
  async pull(_userId: string, cursor: number, limit: number) {
    this.pullCalls += 1;
    return this.operations
      .filter((operation) => operation.revision > cursor)
      .slice(0, limit);
  }
  async exportUser(_userId: string) {
    return this.operations;
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

test("health and readiness expose different concerns", async () => {
  const store = new MemoryStore();
  const app = createServer({ auth: signedOut, store });
  assert.equal(
    (await app.inject({ method: "GET", url: "/healthz" })).statusCode,
    200,
  );
  store.unavailable = true;
  assert.equal(
    (await app.inject({ method: "GET", url: "/readyz" })).statusCode,
    503,
  );
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
