import "fake-indexeddb/auto";

import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeOperations as acknowledgeStoredOperations,
  applyRemotePage as applyStoredRemotePage,
  db,
  getBrews,
  getOperations as getStoredOperations,
  getOwnerPreference,
  saveBrew,
} from "./db";
import type { Brew, Owned, SyncOperation } from "./models";
import {
  AccountMismatchError,
  AuthenticationExpiredError,
  createSyncCoordinator,
  createSynchronizer,
  deleteCloudAccount,
  getCurrentUser,
  isCloudIdentityStorageEvent,
  OwnerCacheRebuildError,
  ownerIdForAccount,
  type SyncDependencies,
  type OwnerLock,
} from "./sync";

const aliceAccount = { id: "alice", email: "alice@example.com", name: "Alice" };
const bobAccount = { id: "bob", email: "bob@example.com", name: "Bob" };
const alice = ownerIdForAccount(aliceAccount.id);
const bob = ownerIdForAccount(bobAccount.id);
const beanId = "0198d3a4-1111-7000-8000-000000000210";
const operationId = "0198d3a4-1111-7000-8000-000000000211";
const brewId = "0198d3a4-1111-7000-8000-000000000212";
const createdAt = "2026-08-22T12:00:00.000Z";

afterEach(() => {
  vi.unstubAllGlobals();
});

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function beanPayload(id = beanId): Record<string, unknown> {
  return {
    id,
    name: "Hualalai Kona",
    roaster: "Coffee Purveyors",
    roastLevel: "medium",
    createdAt,
  };
}

function queuedOperation(
  ownerId = alice,
  entity: "bean" | "brew" = "bean",
): Owned<SyncOperation> {
  return {
    ownerId,
    operationId,
    entity,
    entityId: beanId,
    action: "upsert",
    payload: beanPayload(),
    createdAt,
  };
}

function brewPayload(yieldGrams: number, updatedAt = createdAt): Brew {
  return {
    id: brewId,
    beanId,
    machineId: "0198d3a4-1111-7000-8000-000000000213",
    grinderId: "0198d3a4-1111-7000-8000-000000000214",
    dose: 18,
    yield: yieldGrams,
    duration: 28,
    grind: "4.0",
    taste: { acidity: 3, bitterness: 2, strength: 3, body: 3, enjoyment: 4 },
    ratio: yieldGrams / 18,
    flow: yieldGrams / 28,
    recommendation: {
      variable: "hold",
      direction: "hold",
      headline: "Hold this recipe",
      rationale: "Balanced result",
      expectedEffect: "Confirm consistency",
      confidence: "high",
      ruleVersion: "espresso-v1",
    },
    createdAt,
    updatedAt,
    syncState: "pending",
  };
}

function dependencies(
  overrides: Partial<SyncDependencies> = {},
): SyncDependencies {
  return {
    isOnline: () => true,
    fetch: vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/v1/me") return response(200, { user: aliceAccount });
      if (url.startsWith("/api/v1/sync/pull")) {
        return response(200, { operations: [], cursor: 0, hasMore: false });
      }
      return response(200, { results: [] });
    }),
    getOperations: vi.fn(async () => []),
    acknowledgeOperations: vi.fn(async () => undefined),
    getPreference: vi.fn(async () => undefined),
    applyRemotePage: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeOwnerLock(): OwnerLock {
  const tails = new Map<string, Promise<void>>();
  return {
    runExclusive<T>(ownerId: string, callback: () => Promise<T>): Promise<T> {
      const preceding = tails.get(ownerId) ?? Promise.resolve();
      const result = preceding.then(callback, callback);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(ownerId, tail);
      void tail.finally(() => {
        if (tails.get(ownerId) === tail) tails.delete(ownerId);
      });
      return result;
    },
  };
}

describe("owner-aware synchronization", () => {
  it("binds account deletion to the account resolved by the UI", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        response(204),
    );
    const removeItem = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("localStorage", { removeItem });

    try {
      await deleteCloudAccount(aliceAccount.id);

      expect(fetch).toHaveBeenCalledOnce();
      const [input, init] = fetch.mock.calls[0]!;
      expect(input).toBe("/api/v1/account");
      expect(init).toMatchObject({
        method: "DELETE",
        credentials: "include",
        body: JSON.stringify({ confirmation: "DELETE" }),
      });
      expect(new Headers(init?.headers).get("x-dialed-account-id")).toBe(
        aliceAccount.id,
      );
      expect(removeItem).toHaveBeenCalledWith("dialed-cloud-enabled");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps a rejected account deletion to the identity refresh error", async () => {
    const fetch = vi.fn(async () =>
      response(409, {
        error: { code: "account_mismatch", actualAccount: bobAccount },
      }),
    );
    const removeItem = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("localStorage", { removeItem });

    try {
      const error = await deleteCloudAccount(aliceAccount.id).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(AccountMismatchError);
      expect(error).toMatchObject({
        actualAccount: bobAccount,
        requestedOwnerId: alice,
      });
      expect(removeItem).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("coalesces concurrent same-owner callers into one request sequence", async () => {
    let releaseMe!: () => void;
    const meBlocked = new Promise<void>((resolve) => {
      releaseMe = resolve;
    });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/v1/me") {
        await meBlocked;
        return response(200, { user: aliceAccount });
      }
      return response(200, { operations: [], cursor: 0, hasMore: false });
    });
    const sync = createSynchronizer(dependencies({ fetch }));

    const first = sync(alice);
    const second = sync(alice);

    releaseMe();
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/me",
      "/api/v1/sync/pull?cursor=0",
    ]);
  });

  it("drains a tombstone that replaces the snapshotted upsert during sync", async () => {
    let releasePull!: () => void;
    let markPullStarted!: () => void;
    const pullBlocked = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const pullStarted = new Promise<void>((resolve) => {
      markPullStarted = resolve;
    });
    const initial = queuedOperation(alice, "brew");
    const tombstoneOperationId = `${operationId.slice(0, -1)}2`;
    const tombstone: Owned<SyncOperation> = {
      ownerId: alice,
      operationId: tombstoneOperationId,
      entity: "brew",
      entityId: brewId,
      action: "delete",
      createdAt,
    };
    let pending: Array<Owned<SyncOperation>> = [initial];
    let pullCount = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/v1/me") return response(200, { user: aliceAccount });
      if (url === "/api/v1/sync/push") return response(200, { results: [] });
      pullCount += 1;
      if (pullCount === 1) {
        markPullStarted();
        await pullBlocked;
      }
      return response(200, { operations: [], cursor: 0, hasMore: false });
    });
    const getOperations = vi.fn(async (_ownerId: string, limit?: number) =>
      limit === undefined ? pending : pending.slice(0, limit),
    );
    const acknowledgeOperations = vi.fn(
      async (_ownerId: string, operationIds: string[]) => {
        pending = pending.filter(
          (operation) => !operationIds.includes(operation.operationId),
        );
      },
    );
    const coordinator = createSyncCoordinator(
      dependencies({ fetch, getOperations, acknowledgeOperations }),
    );

    const sync = coordinator.synchronize(alice);
    await pullStarted;
    pending = [tombstone];
    releasePull();
    await sync;

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/me",
      "/api/v1/sync/push",
      "/api/v1/sync/pull?cursor=0",
      "/api/v1/me",
      "/api/v1/sync/push",
      "/api/v1/sync/pull?cursor=0",
    ]);
    expect(acknowledgeOperations.mock.calls).toEqual([
      [alice, [operationId]],
      [alice, [tombstoneOperationId]],
    ]);
    expect(pending).toEqual([]);
  });

  it("waits for an in-flight sync before clearing and starts a fresh pull at cursor zero", async () => {
    let releaseFirstPull!: () => void;
    let markFirstPullStarted!: () => void;
    const firstPullBlocked = new Promise<void>((resolve) => {
      releaseFirstPull = resolve;
    });
    const firstPullStarted = new Promise<void>((resolve) => {
      markFirstPullStarted = resolve;
    });
    let cleared = false;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/v1/me") {
        return response(200, { user: aliceAccount });
      }
      if (url === "/api/v1/sync/pull?cursor=17") {
        markFirstPullStarted();
        await firstPullBlocked;
        return response(200, { operations: [], cursor: 17, hasMore: false });
      }
      return response(200, { operations: [], cursor: 0, hasMore: false });
    });
    const clearOwner = vi.fn(async () => {
      cleared = true;
      return { cleared: true as const };
    });
    const coordinator = createSyncCoordinator(
      dependencies({
        fetch,
        getPreference: vi.fn(async () => (cleared ? undefined : "17")),
      }),
    );

    const inFlight = coordinator.synchronize(alice);
    await firstPullStarted;
    const reset = coordinator.resetAndSynchronize(alice, clearOwner);

    expect(clearOwner).not.toHaveBeenCalled();
    releaseFirstPull();
    await Promise.all([inFlight, reset]);

    expect(clearOwner).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/me",
      "/api/v1/sync/pull?cursor=17",
      "/api/v1/me",
      "/api/v1/sync/pull?cursor=0",
    ]);
  });

  it("serializes two coordinator instances through a shared owner lock", async () => {
    let releaseFirstPull!: () => void;
    let markFirstPullStarted!: () => void;
    const firstPullBlocked = new Promise<void>((resolve) => {
      releaseFirstPull = resolve;
    });
    const firstPullStarted = new Promise<void>((resolve) => {
      markFirstPullStarted = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/v1/me") return response(200, { user: aliceAccount });
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (
        fetch.mock.calls.filter(([candidate]) =>
          String(candidate).includes("/pull"),
        ).length === 1
      ) {
        markFirstPullStarted();
        await firstPullBlocked;
      }
      active -= 1;
      return response(200, { operations: [], cursor: 0, hasMore: false });
    });
    const lock = fakeOwnerLock();
    const firstCoordinator = createSyncCoordinator(
      dependencies({ fetch }),
      lock,
    );
    const secondCoordinator = createSyncCoordinator(
      dependencies({ fetch }),
      lock,
    );

    const first = firstCoordinator.synchronize(alice);
    await firstPullStarted;
    const second = secondCoordinator.synchronize(alice);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);

    releaseFirstPull();
    await Promise.all([first, second]);

    expect(maximumActive).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("waits for a delayed pull before deleting cloud data and clearing local data", async () => {
    let releasePull!: () => void;
    let markPullStarted!: () => void;
    const pullBlocked = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const pullStarted = new Promise<void>((resolve) => {
      markPullStarted = resolve;
    });
    const events: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "/api/v1/me")
        return response(200, { user: aliceAccount });
      events.push("pull-started");
      markPullStarted();
      await pullBlocked;
      events.push("pull-applied");
      return response(200, { operations: [], cursor: 0, hasMore: false });
    });
    const coordinator = createSyncCoordinator(
      dependencies({ fetch }),
      fakeOwnerLock(),
    );
    const sync = coordinator.synchronize(alice);
    await pullStarted;
    const deletion = coordinator.deleteAccount(
      alice,
      async () => {
        events.push("cloud-deleted");
      },
      async () => {
        events.push("local-cleared");
      },
    );
    const joinedSync = coordinator.synchronize(alice);

    await Promise.resolve();
    expect(events).toEqual(["pull-started"]);
    releasePull();
    await Promise.all([sync, deletion, joinedSync]);

    expect(events).toEqual([
      "pull-started",
      "pull-applied",
      "cloud-deleted",
      "local-cleared",
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not start another sync when account deletion is queued during the queue probe", async () => {
    let releaseProbe!: () => void;
    let markProbeStarted!: () => void;
    const probeBlocked = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
    let fullReads = 0;
    let probeReads = 0;
    const getOperations = vi.fn(async (_ownerId: string, limit?: number) => {
      if (limit === 100) {
        fullReads += 1;
        return fullReads === 1 ? [queuedOperation()] : [];
      }
      probeReads += 1;
      if (probeReads === 1) {
        markProbeStarted();
        await probeBlocked;
        return [
          {
            ...queuedOperation(alice, "brew"),
            operationId: `${operationId.slice(0, -1)}2`,
            action: "delete" as const,
            payload: undefined,
          },
        ];
      }
      return [];
    });
    const fetch = vi.fn(async (input: string | URL | Request) =>
      String(input) === "/api/v1/me"
        ? response(200, { user: aliceAccount })
        : String(input) === "/api/v1/sync/push"
          ? response(200, { results: [] })
          : response(200, { operations: [], cursor: 0, hasMore: false }),
    );
    const events: string[] = [];
    const coordinator = createSyncCoordinator(
      dependencies({ fetch, getOperations }),
      fakeOwnerLock(),
    );

    const sync = coordinator.synchronize(alice);
    await probeStarted;
    const deletion = coordinator.deleteAccount(
      alice,
      async () => {
        events.push("cloud-deleted");
      },
      async () => {
        events.push("local-cleared");
      },
    );
    releaseProbe();
    await Promise.all([sync, deletion]);

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/me",
      "/api/v1/sync/push",
      "/api/v1/sync/pull?cursor=0",
    ]);
    expect(events).toEqual(["cloud-deleted", "local-cleared"]);
  });

  it("does not clear local account data when cloud deletion detects an account mismatch", async () => {
    const clearLocal = vi.fn(async () => undefined);
    const coordinator = createSyncCoordinator(dependencies(), fakeOwnerLock());

    await expect(
      coordinator.deleteAccount(
        alice,
        async () => {
          throw new AccountMismatchError(alice, bobAccount);
        },
        clearLocal,
      ),
    ).rejects.toBeInstanceOf(AccountMismatchError);

    expect(clearLocal).not.toHaveBeenCalled();
  });

  it("reports that the cache was cleared when the fresh pull fails", async () => {
    const coordinator = createSyncCoordinator(
      dependencies({
        fetch: vi.fn(async (input: string | URL | Request) =>
          String(input) === "/api/v1/me"
            ? response(200, { user: aliceAccount })
            : response(503),
        ),
      }),
    );

    const error = await coordinator
      .resetAndSynchronize(alice, async () => ({ cleared: true }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OwnerCacheRebuildError);
    expect(error).toMatchObject({ cacheCleared: true });
  });

  it("runs a normal sync for a joiner when reset refuses pending operations", async () => {
    let releaseReset!: () => void;
    const resetBlocked = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    const fetch = vi.fn(async (input: string | URL | Request) =>
      String(input) === "/api/v1/me"
        ? response(200, { user: aliceAccount })
        : response(200, { operations: [], cursor: 0, hasMore: false }),
    );
    const coordinator = createSyncCoordinator(dependencies({ fetch }));
    const reset = coordinator.resetAndSynchronize(alice, async () => {
      await resetBlocked;
      return {
        cleared: false as const,
        reason: "pending-operations" as const,
        pendingCount: 1,
      };
    });

    const joinedSync = coordinator.synchronize(alice);
    releaseReset();
    await expect(reset).resolves.toMatchObject({ cleared: false });
    await expect(joinedSync).resolves.toBeUndefined();

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/me",
      "/api/v1/sync/pull?cursor=0",
    ]);
  });

  it("uploads only the requested owner's first 100 operations without local fields", async () => {
    const aliceBrew = queuedOperation(alice, "brew");
    const bobBean = {
      ...queuedOperation(bob),
      operationId: `${operationId.slice(0, -1)}2`,
    };
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/v1/me") return response(200, { user: aliceAccount });
        if (url === "/api/v1/sync/push") {
          expect(new Headers(init?.headers).get("x-dialed-account-id")).toBe(
            aliceAccount.id,
          );
          const body = JSON.parse(String(init?.body)) as {
            operations: Array<Record<string, unknown>>;
          };
          expect(body.operations).toHaveLength(1);
          expect(body.operations[0]).toMatchObject({
            operationId: aliceBrew.operationId,
            entity: "brew",
          });
          expect(body.operations[0]).not.toHaveProperty("ownerId");
          expect(body.operations[0]).not.toHaveProperty("createdAt");
          return response(200, { results: [] });
        }
        expect(new Headers(init?.headers).get("x-dialed-account-id")).toBe(
          aliceAccount.id,
        );
        return response(200, { operations: [], cursor: 0, hasMore: false });
      },
    );
    const getOperations = vi.fn(async (ownerId: string, limit?: number) =>
      [aliceBrew, bobBean]
        .filter((item) => item.ownerId === ownerId)
        .slice(0, limit),
    );
    const acknowledgeOperations = vi.fn(async () => undefined);
    const sync = createSynchronizer(
      dependencies({ fetch, getOperations, acknowledgeOperations }),
    );

    await sync(alice);

    expect(getOperations.mock.calls[0]).toEqual([alice, 100]);
    expect(acknowledgeOperations).toHaveBeenCalledWith(alice, [
      aliceBrew.operationId,
    ]);
  });

  it("uploads a newer local brew operation created after the push snapshot", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const initial = brewPayload(36);
      await saveBrew(alice, initial);
      const pushed = (await getStoredOperations(alice))[0]!;
      let pushCount = 0;
      const fetch = vi.fn(
        async (input: string | URL | Request): Promise<Response> => {
          const url = String(input);
          if (url === "/api/v1/me")
            return response(200, { user: aliceAccount });
          if (url === "/api/v1/sync/push") {
            pushCount += 1;
            if (pushCount === 1) {
              await saveBrew(
                alice,
                brewPayload(42, "2026-08-22T12:01:00.000Z"),
              );
            }
            return response(200, { results: [] });
          }
          if (url === "/api/v1/sync/pull?cursor=1") {
            return response(200, {
              operations: [],
              cursor: 1,
              hasMore: false,
            });
          }
          return response(200, {
            operations: [
              {
                operationId: pushed.operationId,
                entity: "brew",
                entityId: brewId,
                action: "upsert",
                payload: initial,
                revision: 1,
              },
            ],
            cursor: 1,
            hasMore: false,
          });
        },
      );
      const sync = createSynchronizer(
        dependencies({
          fetch,
          getOperations: getStoredOperations,
          acknowledgeOperations: acknowledgeStoredOperations,
          getPreference: getOwnerPreference,
          applyRemotePage: applyStoredRemotePage,
        }),
      );

      await sync(alice);

      expect((await getBrews(alice))[0]).toMatchObject({
        yield: 42,
        syncState: "synced",
      });
      expect(await getStoredOperations(alice)).toEqual([]);
      expect(pushCount).toBe(2);
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("applies a remote revision newer than the pushed snapshot and acknowledges the snapshot", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const initial = brewPayload(36);
      const remote = brewPayload(40, "2026-08-22T12:02:00.000Z");
      await saveBrew(alice, initial);
      const pushed = (await getStoredOperations(alice))[0]!;
      const remoteOperationId = "0198d3a4-1111-7000-8000-000000000215";
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/v1/me") return response(200, { user: aliceAccount });
        if (url === "/api/v1/sync/push") return response(200, { results: [] });
        return response(200, {
          operations: [
            {
              operationId: pushed.operationId,
              entity: "brew",
              entityId: brewId,
              action: "upsert",
              payload: initial,
              revision: 1,
            },
            {
              operationId: remoteOperationId,
              entity: "brew",
              entityId: brewId,
              action: "upsert",
              payload: remote,
              revision: 2,
            },
          ],
          cursor: 2,
          hasMore: false,
        });
      });
      const sync = createSynchronizer(
        dependencies({
          fetch,
          getOperations: getStoredOperations,
          acknowledgeOperations: acknowledgeStoredOperations,
          getPreference: getOwnerPreference,
          applyRemotePage: applyStoredRemotePage,
        }),
      );

      await sync(alice);

      expect((await getBrews(alice))[0]).toMatchObject({
        yield: 40,
        syncState: "synced",
      });
      expect(await getStoredOperations(alice)).toEqual([]);
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("reads and preserves independent cursors for two empty owner pages", async () => {
    let authenticated = aliceAccount;
    const cursors = new Map([
      [alice, "4"],
      [bob, "11"],
    ]);
    const pullUrls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/v1/me") return response(200, { user: authenticated });
      pullUrls.push(url);
      const cursor = Number(
        new URL(url, "http://dialed.test").searchParams.get("cursor"),
      );
      return response(200, {
        operations: [],
        cursor,
        hasMore: false,
      });
    });
    const getPreference = vi.fn(async (ownerId: string) =>
      cursors.get(ownerId),
    );
    const applyRemotePage = vi.fn(
      async (
        ownerId: string,
        _operations: readonly unknown[],
        _key: string,
        cursor: number,
      ) => {
        cursors.set(ownerId, String(cursor));
      },
    );
    const sync = createSynchronizer(
      dependencies({ fetch, getPreference, applyRemotePage }),
    );

    await sync(alice);
    authenticated = bobAccount;
    await sync(bob);

    expect(pullUrls).toEqual([
      "/api/v1/sync/pull?cursor=4",
      "/api/v1/sync/pull?cursor=11",
    ]);
    expect(cursors).toEqual(
      new Map([
        [alice, "4"],
        [bob, "11"],
      ]),
    );
  });

  it.each(["me", "push", "pull"] as const)(
    "maps a 401 from %s to AuthenticationExpiredError",
    async (failurePoint) => {
      const pending = [queuedOperation()];
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/v1/me") {
          return failurePoint === "me"
            ? response(401)
            : response(200, { user: aliceAccount });
        }
        if (url === "/api/v1/sync/push") {
          return failurePoint === "push"
            ? response(401)
            : response(200, { results: [] });
        }
        return failurePoint === "pull"
          ? response(401)
          : response(200, { operations: [], cursor: 0, hasMore: false });
      });
      const acknowledgeOperations = vi.fn(async () => undefined);
      const sync = createSynchronizer(
        dependencies({
          fetch,
          getOperations: vi.fn(async () =>
            failurePoint === "me" ? [] : pending,
          ),
          acknowledgeOperations,
        }),
      );

      await expect(sync(alice)).rejects.toBeInstanceOf(
        AuthenticationExpiredError,
      );
      expect(acknowledgeOperations).not.toHaveBeenCalled();
    },
  );

  it("rejects an authenticated account mismatch before reading pending data", async () => {
    const getOperations = vi.fn(async () => [queuedOperation()]);
    const sync = createSynchronizer(
      dependencies({
        fetch: vi.fn(async () => response(200, { user: bobAccount })),
        getOperations,
      }),
    );

    const error = await sync(alice).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AccountMismatchError);
    expect(error).toMatchObject({
      actualAccount: bobAccount,
      requestedOwnerId: alice,
    });
    expect(getOperations).not.toHaveBeenCalled();
  });

  it.each(["push", "pull"] as const)(
    "maps a session binding mismatch from %s and preserves queue and cursor",
    async (failurePoint) => {
      const pending = [queuedOperation()];
      const acknowledgeOperations = vi.fn(async () => undefined);
      const applyRemotePage = vi.fn(async () => undefined);
      const fetch = vi.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url === "/api/v1/me") {
            return response(200, { user: aliceAccount });
          }
          expect(new Headers(init?.headers).get("x-dialed-account-id")).toBe(
            aliceAccount.id,
          );
          if (url === "/api/v1/sync/push") {
            return failurePoint === "push"
              ? response(409, {
                  error: {
                    code: "account_mismatch",
                    actualAccount: bobAccount,
                  },
                })
              : response(200, { results: [] });
          }
          return response(409, {
            error: { code: "account_mismatch", actualAccount: bobAccount },
          });
        },
      );
      const sync = createSynchronizer(
        dependencies({
          fetch,
          getOperations: vi.fn(async () => pending),
          acknowledgeOperations,
          applyRemotePage,
        }),
      );

      const error = await sync(alice).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AccountMismatchError);
      expect(error).toMatchObject({
        actualAccount: bobAccount,
        requestedOwnerId: alice,
      });
      expect(acknowledgeOperations).not.toHaveBeenCalled();
      expect(applyRemotePage).not.toHaveBeenCalled();
    },
  );

  it.each(["push", "pull"] as const)(
    "maps a malformed 409 from %s to an account binding error",
    async (failurePoint) => {
      const pending = [queuedOperation()];
      const acknowledgeOperations = vi.fn(async () => undefined);
      const applyRemotePage = vi.fn(async () => undefined);
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/v1/me") {
          return response(200, { user: aliceAccount });
        }
        if (url === "/api/v1/sync/push") {
          return failurePoint === "push"
            ? new Response("upstream conflict", { status: 409 })
            : response(200, { results: [] });
        }
        return new Response("upstream conflict", { status: 409 });
      });
      const sync = createSynchronizer(
        dependencies({
          fetch,
          getOperations: vi.fn(async () => pending),
          acknowledgeOperations,
          applyRemotePage,
        }),
      );

      const error = await sync(alice).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AccountMismatchError);
      expect(error).toMatchObject({ requestedOwnerId: alice });
      expect(acknowledgeOperations).not.toHaveBeenCalled();
      expect(applyRemotePage).not.toHaveBeenCalled();
    },
  );

  it("keeps a non-409 push failure out of the identity refresh path", async () => {
    const acknowledgeOperations = vi.fn(async () => undefined);
    const sync = createSynchronizer(
      dependencies({
        fetch: vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          if (url === "/api/v1/me") {
            return response(200, { user: aliceAccount });
          }
          return response(503);
        }),
        getOperations: vi.fn(async () => [queuedOperation()]),
        acknowledgeOperations,
      }),
    );

    const error = await sync(alice).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(AccountMismatchError);
    expect(error).toMatchObject({ message: "Sync push failed" });
    expect(acknowledgeOperations).not.toHaveBeenCalled();
  });

  it("retains pending operations when a push fails and allows a retry", async () => {
    const pending = [queuedOperation()];
    let pushAttempts = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/v1/me") return response(200, { user: aliceAccount });
      if (url === "/api/v1/sync/push") {
        pushAttempts += 1;
        return pushAttempts === 1
          ? response(503)
          : response(200, { results: [] });
      }
      return response(200, { operations: [], cursor: 0, hasMore: false });
    });
    const acknowledgeOperations = vi.fn(async () => undefined);
    const sync = createSynchronizer(
      dependencies({
        fetch,
        getOperations: vi.fn(async () => pending),
        acknowledgeOperations,
      }),
    );

    await expect(sync(alice)).rejects.toThrow("Sync push failed");
    expect(acknowledgeOperations).not.toHaveBeenCalled();
    await expect(sync(alice)).resolves.toBeUndefined();
    expect(acknowledgeOperations).toHaveBeenCalledTimes(1);
    expect(pushAttempts).toBe(2);
  });

  it("rejects a malformed pull page before applying data or advancing its cursor", async () => {
    const valid = {
      operationId,
      entity: "bean",
      entityId: beanId,
      action: "upsert",
      payload: beanPayload(),
      revision: 1,
    };
    const invalid = {
      ...valid,
      operationId: `${operationId.slice(0, -1)}2`,
      entityId: `${beanId.slice(0, -1)}2`,
      payload: {
        ...beanPayload(`${beanId.slice(0, -1)}2`),
        roastLevel: "charcoal",
      },
      revision: 2,
    };
    const applyRemotePage = vi.fn(async () => undefined);
    const acknowledgeOperations = vi.fn(async () => undefined);
    const sync = createSynchronizer(
      dependencies({
        fetch: vi.fn(async (input: string | URL | Request) =>
          String(input) === "/api/v1/me"
            ? response(200, { user: aliceAccount })
            : response(200, {
                operations: [valid, invalid],
                cursor: 2,
                hasMore: false,
              }),
        ),
        getOperations: vi.fn(async () => [queuedOperation()]),
        applyRemotePage,
        acknowledgeOperations,
      }),
    );

    await expect(sync(alice)).rejects.toThrow();
    expect(applyRemotePage).not.toHaveBeenCalled();
    expect(acknowledgeOperations).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "stale revision",
      currentCursor: "5",
      operations: [
        {
          operationId,
          entity: "bean",
          entityId: beanId,
          action: "upsert",
          payload: beanPayload(),
          revision: 5,
        },
      ],
      responseCursor: 5,
    },
    {
      name: "out-of-order revisions",
      currentCursor: "5",
      operations: [
        {
          operationId,
          entity: "bean",
          entityId: beanId,
          action: "upsert",
          payload: beanPayload(),
          revision: 7,
        },
        {
          operationId: `${operationId.slice(0, -1)}2`,
          entity: "bean",
          entityId: beanId,
          action: "upsert",
          payload: beanPayload(),
          revision: 6,
        },
      ],
      responseCursor: 6,
    },
    {
      name: "cursor beyond final revision",
      currentCursor: "5",
      operations: [
        {
          operationId,
          entity: "bean",
          entityId: beanId,
          action: "upsert",
          payload: beanPayload(),
          revision: 6,
        },
      ],
      responseCursor: 7,
    },
    {
      name: "empty-page cursor jump",
      currentCursor: "5",
      operations: [],
      responseCursor: 6,
    },
  ])(
    "rejects $name before any page write",
    async ({ currentCursor, operations, responseCursor }) => {
      const applyRemotePage = vi.fn(async () => undefined);
      const sync = createSynchronizer(
        dependencies({
          fetch: vi.fn(async (input: string | URL | Request) =>
            String(input) === "/api/v1/me"
              ? response(200, { user: aliceAccount })
              : response(200, {
                  operations,
                  cursor: responseCursor,
                  hasMore: false,
                }),
          ),
          getPreference: vi.fn(async () => currentCursor),
          applyRemotePage,
        }),
      );

      await expect(sync(alice)).rejects.toThrow();
      expect(applyRemotePage).not.toHaveBeenCalled();
    },
  );
});

describe("current account lookup", () => {
  it("refreshes identity only for cloud-enabled storage changes", () => {
    expect(isCloudIdentityStorageEvent({ key: "dialed-cloud-enabled" })).toBe(
      true,
    );
    expect(isCloudIdentityStorageEvent({ key: "unrelated" })).toBe(false);
    expect(isCloudIdentityStorageEvent({ key: null })).toBe(false);
  });

  function enableCloud(fetch: ReturnType<typeof vi.fn>) {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "true"),
    });
    vi.stubGlobal("fetch", fetch);
  }

  it("resolves anonymous only after a confirmed unauthenticated response", async () => {
    enableCloud(vi.fn(async () => response(401)));

    await expect(getCurrentUser()).resolves.toBeNull();
  });

  it.each([
    ["server failure", vi.fn(async () => response(503))],
    [
      "network failure",
      vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
    ],
    [
      "malformed account",
      vi.fn(async () => response(200, { user: { id: "alice" } })),
    ],
  ])("rejects %s instead of selecting anonymous", async (_label, fetch) => {
    enableCloud(fetch);

    await expect(getCurrentUser()).rejects.toThrow();
  });
});
