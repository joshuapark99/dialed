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

class MemoryStore implements SyncStore {
  operations: StoredSyncOperation[] = [];
  deletedUsers: string[] = [];
  unavailable = false;

  async health() {
    if (this.unavailable) throw new Error("unavailable");
  }
  async push(
    _userId: string,
    incoming: IncomingSyncOperation[],
  ): Promise<PushResult[]> {
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

test("sync push is idempotent and pull advances its cursor", async () => {
  const app = createServer({ auth: signedIn, store: new MemoryStore() });
  const operation = {
    operationId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4f78",
    entity: "bean",
    entityId: "0198d4a4-3ad8-7fa1-b653-9a51a55d4f79",
    action: "upsert",
    payload: { name: "Kona" },
  };
  const first = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    payload: { operations: [operation] },
  });
  const retry = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    payload: { operations: [operation] },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().results[0].duplicate, false);
  assert.equal(retry.json().results[0].duplicate, true);

  const pull = await app.inject({
    method: "GET",
    url: "/v1/sync/pull?cursor=0",
  });
  assert.equal(pull.json().operations.length, 1);
  assert.equal(pull.json().cursor, 1);
  await app.close();
});

test("account deletion requires explicit confirmation", async () => {
  const store = new MemoryStore();
  const app = createServer({ auth: signedIn, store });
  assert.equal(
    (await app.inject({ method: "DELETE", url: "/v1/account", payload: {} }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: "/v1/account",
        payload: { confirmation: "DELETE" },
      })
    ).statusCode,
    204,
  );
  assert.deepEqual(store.deletedUsers, ["user-1"]);
  await app.close();
});
