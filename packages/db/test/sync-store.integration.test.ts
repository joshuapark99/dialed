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

test("rejects a partially full batch atomically when its new operations exceed the quota", async () => {
  await withUser(async (userId) => {
    const store = new PostgresSyncStore(database.db, { maxOperations: 2 });
    const original = operation();
    const firstOverflow = operation();
    const secondOverflow = operation();

    await store.push(userId, [original]);

    await assert.rejects(
      store.push(userId, [firstOverflow, secondOverflow]),
      (error: unknown) => {
        assert.ok(error instanceof SyncOperationQuotaExceededError);
        assert.deepEqual(
          {
            limit: error.limit,
            current: error.current,
            attemptedNew: error.attemptedNew,
          },
          { limit: 2, current: 1, attemptedNew: 2 },
        );
        return true;
      },
    );

    assert.deepEqual(
      (await store.exportUser(userId)).map(({ operationId }) => operationId),
      [original.operationId],
    );
  });
});

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
