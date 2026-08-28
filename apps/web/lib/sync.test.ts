import "fake-indexeddb/auto";

import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeOperations as acknowledgeStoredOperations,
  acquireOwnerMutationFence,
  ANONYMOUS_OWNER_ID,
  applyRemotePage as applyStoredRemotePage,
  clearDeletedAccountData,
  clearOwnerData,
  db,
  deleteBrew,
  DeletedOwnerWriteError,
  finishOwnerMutationFence,
  getBrews,
  getCoffeeBags,
  getCoffees,
  getOperations as getStoredOperations,
  getOperationsByIds as getStoredOperationsByIds,
  getOwnerMutationState,
  getOwnerPreference,
  ownerPreferenceKey,
  OwnerMutationConflictError,
  OwnerMutationFenceLostError,
  saveBrew,
  saveCoffeeWithBag,
  saveGrinder,
  saveMachine,
  verifyOwnerMutationFence,
} from "./db";
import type {
  ClearOwnerDataResult,
  OwnerMutationFence,
  OwnerMutationKind,
} from "./db";
import type { Brew, Coffee, CoffeeBag, Owned, SyncOperation } from "./models";
import {
  AnonymousTransferSummaryChangedError,
  completeAnonymousTransfer,
  stageAnonymousTransfer,
  type AnonymousTransferSummary,
  type AnonymousTransferJournal,
} from "./anonymous-transfer";
import {
  ANONYMOUS_TRANSFER_JOURNAL_KEY,
  ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
  AnonymousTransferStateError,
} from "./anonymous-transfer-state";
import {
  AccountMismatchError,
  AuthenticationExpiredError,
  createSyncCoordinator,
  createSynchronizer,
  CrossContextOwnerLockUnavailableError,
  deleteCloudAccount,
  getCurrentUser,
  isCloudIdentityStorageEvent,
  moveAnonymousDataToAccount,
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

function transferJournal(
  ownerId = alice,
  operationIds: string[] = [],
): AnonymousTransferJournal {
  return {
    version: 1,
    destinationOwnerId: ownerId,
    phase: "staged",
    operationIds,
    acknowledgedOperationIds: [],
    startedAt: createdAt,
  };
}

function transferPreferenceReader(
  readJournal: () => AnonymousTransferJournal | undefined,
): SyncDependencies["getPreference"] {
  return async (ownerId, key) => {
    const journal = readJournal();
    if (
      journal &&
      ownerId === ANONYMOUS_OWNER_ID &&
      key === ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY
    ) {
      return journal.destinationOwnerId;
    }
    if (
      journal &&
      ownerId === journal.destinationOwnerId &&
      key === ANONYMOUS_TRANSFER_JOURNAL_KEY
    ) {
      return JSON.stringify(journal);
    }
    return undefined;
  };
}

function coffeeAndBag(
  coffeeId = "0198d3a4-1111-7000-8000-000000000216",
  bagId = "0198d3a4-1111-7000-8000-000000000217",
): { coffee: Coffee; bag: CoffeeBag } {
  return {
    coffee: {
      id: coffeeId,
      name: "Hualalai Kona",
      roaster: "Coffee Purveyors",
      roastLevel: "medium-light",
      createdAt,
    },
    bag: {
      id: bagId,
      coffeeId,
      roastedOn: "2026-08-15",
      createdAt,
    },
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
  const getOperations =
    overrides.getOperations ?? vi.fn(async () => [] as Owned<SyncOperation>[]);
  let generation = 0;
  let mutationKind: OwnerMutationKind | undefined;
  let activeToken: string | undefined;
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
    getOperations,
    getOperationsByIds: vi.fn(
      async (ownerId: string, operationIds: readonly string[], limit = 100) =>
        (await getOperations(ownerId))
          .filter((operation) => operationIds.includes(operation.operationId))
          .sort(
            (left, right) =>
              operationIds.indexOf(left.operationId) -
              operationIds.indexOf(right.operationId),
          )
          .slice(0, limit),
    ),
    acknowledgeOperations: vi.fn(async () => undefined),
    getPreference: vi.fn(async () => undefined),
    applyRemotePage: vi.fn(async () => undefined),
    getOwnerMutationState: vi.fn(async () => ({
      generation,
      ...(mutationKind === undefined ? {} : { kind: mutationKind }),
      ...(activeToken === undefined ? {} : { activeToken }),
      deleted: false,
    })),
    acquireOwnerMutationFence: vi.fn(
      async (_ownerId: string, kind: OwnerMutationKind) => {
        if (
          activeToken !== undefined &&
          mutationKind !== undefined &&
          mutationKind !== kind
        ) {
          throw new OwnerMutationConflictError(alice, mutationKind, kind);
        }
        generation += 1;
        mutationKind = kind;
        activeToken = `mutation-${generation}`;
        return { generation, kind, token: activeToken };
      },
    ),
    verifyOwnerMutationFence: vi.fn(
      async (_ownerId: string, fence: OwnerMutationFence) => {
        if (
          generation !== fence.generation ||
          mutationKind !== fence.kind ||
          activeToken !== fence.token
        ) {
          throw new OwnerMutationFenceLostError(alice, fence.kind);
        }
      },
    ),
    finishOwnerMutationFence: vi.fn(
      async (_ownerId: string, fence: OwnerMutationFence) => {
        if (
          generation !== fence.generation ||
          mutationKind !== fence.kind ||
          activeToken !== fence.token
        ) {
          throw new OwnerMutationFenceLostError(alice, fence.kind);
        }
        activeToken = undefined;
      },
    ),
    ...overrides,
  };
}

function fakeOwnerLock(): OwnerLock {
  const tails = new Map<string, Promise<void>>();
  return {
    crossContextSafe: true,
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

function storedDependencies(
  fetch: SyncDependencies["fetch"] = async (input: string | URL | Request) =>
    String(input) === "/api/v1/me"
      ? response(200, { user: aliceAccount })
      : response(200, { operations: [], cursor: 0, hasMore: false }),
  overrides: Partial<SyncDependencies> = {},
): SyncDependencies {
  return dependencies({
    fetch,
    getOperations: getStoredOperations,
    getOperationsByIds: getStoredOperationsByIds,
    acknowledgeOperations: acknowledgeStoredOperations,
    getPreference: getOwnerPreference,
    applyRemotePage: applyStoredRemotePage,
    getOwnerMutationState,
    acquireOwnerMutationFence,
    verifyOwnerMutationFence,
    finishOwnerMutationFence,
    ...overrides,
  });
}

describe("owner-aware synchronization", () => {
  it("allows fallback synchronization but rejects mutations before callbacks when cross-context locking is unavailable", async () => {
    vi.stubGlobal("navigator", { onLine: true, locks: null });
    const stage = vi.fn(async () => transferJournal());
    const complete = vi.fn(async () => ({
      completed: true,
      pendingCount: 0,
    }));
    const resetOwner = vi.fn(async () => ({ cleared: true as const }));
    const deleteCloud = vi.fn(async () => undefined);
    const clearLocal = vi.fn(async () => undefined);
    const coordinator = createSyncCoordinator(dependencies());

    await expect(coordinator.synchronize(alice)).resolves.toBeUndefined();
    await expect(
      coordinator.transferAnonymous(alice, stage, complete),
    ).rejects.toBeInstanceOf(CrossContextOwnerLockUnavailableError);
    await expect(
      coordinator.resetAndSynchronize(alice, resetOwner),
    ).rejects.toBeInstanceOf(CrossContextOwnerLockUnavailableError);
    await expect(
      coordinator.deleteAccount(alice, deleteCloud, clearLocal),
    ).rejects.toBeInstanceOf(CrossContextOwnerLockUnavailableError);

    expect(stage).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(resetOwner).not.toHaveBeenCalled();
    expect(deleteCloud).not.toHaveBeenCalled();
    expect(clearLocal).not.toHaveBeenCalled();
  });

  it("handles a queued transfer snapshot rejection immediately and still propagates it", async () => {
    let markSyncStarted!: () => void;
    let releaseSync!: () => void;
    const syncStarted = new Promise<void>((resolve) => {
      markSyncStarted = resolve;
    });
    const syncBlocked = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const snapshotFailure = new Error("owner mutation snapshot failed");
    const rejectedSnapshot = Promise.reject(snapshotFailure);
    const originalThen = rejectedSnapshot.then.bind(rejectedSnapshot);
    let rejectionHandlerAttached = false;
    rejectedSnapshot.then = ((
      onFulfilled?: (value: never) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => {
      if (onRejected) rejectionHandlerAttached = true;
      return originalThen(onFulfilled, onRejected);
    }) as typeof rejectedSnapshot.then;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/v1/me") {
        markSyncStarted();
        await syncBlocked;
        return response(200, { user: aliceAccount });
      }
      return response(200, { operations: [], cursor: 0, hasMore: false });
    });
    const coordinator = createSyncCoordinator(
      dependencies({
        fetch,
        getOwnerMutationState: () => rejectedSnapshot,
      }),
      fakeOwnerLock(),
    );
    const synchronization = coordinator.synchronize(alice);
    await syncStarted;

    const transfer = coordinator.transferAnonymous(
      alice,
      async () => transferJournal(),
      async () => ({ completed: true, pendingCount: 0 }),
    );
    const handledBeforeLockAcquisition = rejectionHandlerAttached;
    void rejectedSnapshot.catch(() => undefined);
    releaseSync();
    await synchronization;
    const transferError = await transfer.catch((error: unknown) => error);

    expect(handledBeforeLockAcquisition).toBe(true);
    expect(transferError).toBe(snapshotFailure);
  });

  it("publishes a durable transfer fence before the initial destination drain", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      let markInitialDrainStarted!: () => void;
      let releaseInitialDrain!: () => void;
      const initialDrainStarted = new Promise<void>((resolve) => {
        markInitialDrainStarted = resolve;
      });
      const initialDrainBlocked = new Promise<void>((resolve) => {
        releaseInitialDrain = resolve;
      });
      const stage = vi.fn(() => stageAnonymousTransfer(alice));
      const coordinator = createSyncCoordinator(
        storedDependencies(async (input: string | URL | Request) => {
          if (String(input) === "/api/v1/me") {
            markInitialDrainStarted();
            await initialDrainBlocked;
            return response(200, { user: aliceAccount });
          }
          return response(200, {
            operations: [],
            cursor: 0,
            hasMore: false,
          });
        }),
        fakeOwnerLock(),
      );

      const transfer = coordinator.transferAnonymous(alice, stage, () =>
        completeAnonymousTransfer(alice),
      );
      await initialDrainStarted;

      expect(stage).not.toHaveBeenCalled();
      const stateDuringInitialDrain = await getOwnerMutationState(alice);
      releaseInitialDrain();
      const result = await transfer.catch((error: unknown) => error);
      expect(stateDuringInitialDrain).toMatchObject({
        generation: 1,
        kind: "transfer",
        activeToken: expect.any(String),
        deleted: false,
      });
      expect(result).toEqual({ completed: true, pendingCount: 0 });

      expect(await getOwnerMutationState(alice)).toEqual({
        generation: 1,
        kind: "transfer",
        deleted: false,
      });
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("fences a suspended transfer after same-kind crash recovery and preserves the recovered intent", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      let markInitialDrainStarted!: () => void;
      let releaseInitialDrain!: () => void;
      const initialDrainStarted = new Promise<void>((resolve) => {
        markInitialDrainStarted = resolve;
      });
      const initialDrainBlocked = new Promise<void>((resolve) => {
        releaseInitialDrain = resolve;
      });
      const stage = vi.fn(() => stageAnonymousTransfer(alice));
      const coordinator = createSyncCoordinator(
        storedDependencies(async (input: string | URL | Request) => {
          if (String(input) === "/api/v1/me") {
            markInitialDrainStarted();
            await initialDrainBlocked;
            return response(200, { user: aliceAccount });
          }
          return response(200, {
            operations: [],
            cursor: 0,
            hasMore: false,
          });
        }),
        fakeOwnerLock(),
      );

      const staleTransfer = coordinator.transferAnonymous(alice, stage, () =>
        completeAnonymousTransfer(alice),
      );
      await initialDrainStarted;
      const recovered = await acquireOwnerMutationFence(alice, "transfer");
      releaseInitialDrain();

      await expect(staleTransfer).rejects.toBeInstanceOf(
        OwnerMutationFenceLostError,
      );
      expect(stage).not.toHaveBeenCalled();
      expect(await getOwnerMutationState(alice)).toEqual({
        generation: recovered.generation,
        kind: "transfer",
        activeToken: recovered.token,
        deleted: false,
      });
      await finishOwnerMutationFence(alice, recovered);
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("reclaims a crash-stale transfer fence through a coordinator retry", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const stale = await acquireOwnerMutationFence(alice, "transfer");
      const coordinator = createSyncCoordinator(
        storedDependencies(),
        fakeOwnerLock(),
      );

      await expect(
        coordinator.transferAnonymous(
          alice,
          () => stageAnonymousTransfer(alice),
          () => completeAnonymousTransfer(alice),
        ),
      ).resolves.toEqual({ completed: true, pendingCount: 0 });
      expect(await getOwnerMutationState(alice)).toEqual({
        generation: stale.generation + 1,
        kind: "transfer",
        deleted: false,
      });
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("does not complete a staged transfer after its fence is recovered", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      let verifyCalls = 0;
      let recovered!: OwnerMutationFence;
      const complete = vi.fn(() => completeAnonymousTransfer(alice));
      const coordinator = createSyncCoordinator(
        storedDependencies(undefined, {
          verifyOwnerMutationFence: async (ownerId, fence) => {
            verifyCalls += 1;
            if (verifyCalls === 3) {
              recovered = await acquireOwnerMutationFence(ownerId, "transfer");
            }
            await verifyOwnerMutationFence(ownerId, fence);
          },
        }),
        fakeOwnerLock(),
      );

      await expect(
        coordinator.transferAnonymous(
          alice,
          () => stageAnonymousTransfer(alice),
          complete,
        ),
      ).rejects.toBeInstanceOf(OwnerMutationFenceLostError);

      expect(complete).not.toHaveBeenCalled();
      expect(
        await getOwnerPreference(alice, ANONYMOUS_TRANSFER_JOURNAL_KEY),
      ).toBeDefined();
      expect(await getOwnerMutationState(alice)).toEqual({
        generation: recovered.generation,
        kind: "transfer",
        activeToken: recovered.token,
        deleted: false,
      });
      await finishOwnerMutationFence(alice, recovered);
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("preserves a crash-stale transfer fence when a reset coordinator requests the owner", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const transferFence = await acquireOwnerMutationFence(alice, "transfer");
      const resetOwner = vi.fn(async () => ({ cleared: true as const }));
      const coordinator = createSyncCoordinator(
        storedDependencies(),
        fakeOwnerLock(),
      );

      await expect(
        coordinator.resetAndSynchronize(alice, resetOwner),
      ).rejects.toBeInstanceOf(OwnerMutationConflictError);
      expect(resetOwner).not.toHaveBeenCalled();
      expect(await getOwnerMutationState(alice)).toEqual({
        generation: transferFence.generation,
        kind: "transfer",
        activeToken: transferFence.token,
        deleted: false,
      });
      await finishOwnerMutationFence(alice, transferFence);
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("reclaims a crash-stale deletion fence but preserves local data when cloud retry fails", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const stale = await acquireOwnerMutationFence(alice, "delete");
      const retryFailure = new Error(
        "Cloud account may already be deleted; retry outcome is unknown",
      );
      const clearLocal = vi.fn(async () => clearDeletedAccountData(alice));
      const coordinator = createSyncCoordinator(
        storedDependencies(),
        fakeOwnerLock(),
      );

      await expect(
        coordinator.deleteAccount(
          alice,
          async () => {
            throw retryFailure;
          },
          () => clearLocal().then(() => undefined),
        ),
      ).rejects.toBe(retryFailure);

      expect(clearLocal).not.toHaveBeenCalled();
      expect(await getOwnerMutationState(alice)).toEqual({
        generation: stale.generation + 1,
        kind: "delete",
        deleted: false,
      });
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it.each(["reset", "delete"] as const)(
    "does not invoke a %s callback after its fence is recovered",
    async (kind) => {
      db.close();
      await Dexie.delete("dialed-local");
      await db.open();
      try {
        let recovered!: OwnerMutationFence;
        const callback = vi.fn(async () =>
          kind === "reset" ? { cleared: true as const } : undefined,
        );
        const coordinator = createSyncCoordinator(
          storedDependencies(undefined, {
            verifyOwnerMutationFence: async (ownerId, fence) => {
              recovered = await acquireOwnerMutationFence(ownerId, kind);
              await verifyOwnerMutationFence(ownerId, fence);
            },
          }),
          fakeOwnerLock(),
        );

        const mutation =
          kind === "reset"
            ? coordinator.resetAndSynchronize(
                alice,
                callback as () => Promise<ClearOwnerDataResult>,
              )
            : coordinator.deleteAccount(
                alice,
                callback as () => Promise<void>,
                vi.fn(async () => undefined),
              );
        await expect(mutation).rejects.toBeInstanceOf(
          OwnerMutationFenceLostError,
        );

        expect(callback).not.toHaveBeenCalled();
        expect(await getOwnerMutationState(alice)).toEqual({
          generation: recovered.generation,
          kind,
          activeToken: recovered.token,
          deleted: false,
        });
        await finishOwnerMutationFence(alice, recovered);
      } finally {
        db.close();
        await Dexie.delete("dialed-local");
      }
    },
  );

  it("does not clear local data when deletion loses its fence after the cloud call", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      let recovered!: OwnerMutationFence;
      const clearLocal = vi.fn(async () => clearDeletedAccountData(alice));
      const coordinator = createSyncCoordinator(
        storedDependencies(),
        fakeOwnerLock(),
      );

      await expect(
        coordinator.deleteAccount(
          alice,
          async () => {
            recovered = await acquireOwnerMutationFence(alice, "delete");
          },
          () => clearLocal().then(() => undefined),
        ),
      ).rejects.toBeInstanceOf(OwnerMutationFenceLostError);

      expect(clearLocal).not.toHaveBeenCalled();
      expect(await getOwnerMutationState(alice)).toEqual({
        generation: recovered.generation,
        kind: "delete",
        activeToken: recovered.token,
        deleted: false,
      });
      await finishOwnerMutationFence(alice, recovered);
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("fails closed without retrying cloud deletion after a local deletion tombstone", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      await clearDeletedAccountData(alice);
      const deleteCloud = vi.fn(async () => undefined);
      const clearLocal = vi.fn(async () => undefined);
      const coordinator = createSyncCoordinator(
        storedDependencies(),
        fakeOwnerLock(),
      );

      await expect(
        coordinator.deleteAccount(alice, deleteCloud, clearLocal),
      ).rejects.toBeInstanceOf(DeletedOwnerWriteError);

      expect(deleteCloud).not.toHaveBeenCalled();
      expect(clearLocal).not.toHaveBeenCalled();
      expect(await getOwnerMutationState(alice)).toEqual({
        generation: 1,
        kind: "delete",
        deleted: true,
      });
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

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

  it("synchronizes the destination before staging and again before completing", async () => {
    const events: string[] = [];
    let staged = false;
    const journal = transferJournal(alice, [operationId]);
    let storedJournal: AnonymousTransferJournal | undefined;
    let pending: Array<Owned<SyncOperation>> = [];
    const transferredOperation = queuedOperation();
    const getOperations = vi.fn(async (_ownerId: string, limit?: number) => {
      return limit === undefined ? pending : pending.slice(0, limit);
    });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "/api/v1/me") {
        events.push(
          staged
            ? "destination-sync-after-stage"
            : "destination-sync-before-stage",
        );
        return response(200, { user: aliceAccount });
      }
      return response(200, { operations: [], cursor: 0, hasMore: false });
    });
    const acknowledgeOperations = vi.fn(
      async (_ownerId: string, operationIds: string[]) => {
        storedJournal = {
          ...journal,
          acknowledgedOperationIds: [...operationIds],
        };
        pending = pending.filter(
          (operation) => !operationIds.includes(operation.operationId),
        );
      },
    );
    const coordinator = createSyncCoordinator(
      dependencies({
        fetch,
        getOperations,
        acknowledgeOperations,
        getPreference: transferPreferenceReader(() => storedJournal),
      }),
      fakeOwnerLock(),
    );

    const result = await coordinator.transferAnonymous(
      alice,
      async () => {
        events.push("stage");
        staged = true;
        storedJournal = journal;
        pending = [transferredOperation];
        return journal;
      },
      async () => {
        events.push("complete");
        storedJournal = undefined;
        return { completed: true, pendingCount: 0 };
      },
    );

    expect(events).toEqual([
      "destination-sync-before-stage",
      "stage",
      "destination-sync-after-stage",
      "complete",
    ]);
    expect(result).toEqual({ completed: true, pendingCount: 0 });
    expect(pending).toEqual([]);
  });

  it("does not stage when the initial destination synchronization fails", async () => {
    const syncFailure = new Error("initial sync failed");
    const stage = vi.fn(async () => transferJournal());
    const complete = vi.fn(async () => ({
      completed: true,
      pendingCount: 0,
    }));
    const coordinator = createSyncCoordinator(
      dependencies({
        fetch: vi.fn(async () => {
          throw syncFailure;
        }),
      }),
      fakeOwnerLock(),
    );

    const error = await coordinator
      .transferAnonymous(alice, stage, complete)
      .catch((caught: unknown) => caught);

    expect(error).toBe(syncFailure);
    expect(stage).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("retains staged source data when post-stage synchronization fails", async () => {
    let accountChecks = 0;
    let sourcePresent = true;
    let journalPresent = false;
    let storedJournal: AnonymousTransferJournal | undefined;
    let pending: Array<Owned<SyncOperation>> = [];
    const postStageFailure = new Error("post-stage sync failed");
    const stage = vi.fn(async () => {
      journalPresent = true;
      storedJournal = transferJournal(alice, [operationId]);
      pending = [queuedOperation()];
      return storedJournal;
    });
    const complete = vi.fn(async () => {
      sourcePresent = false;
      journalPresent = false;
      return { completed: true, pendingCount: 0 };
    });
    const coordinator = createSyncCoordinator(
      dependencies({
        getOperations: vi.fn(async (_ownerId: string, limit?: number) =>
          limit === undefined ? pending : pending.slice(0, limit),
        ),
        getPreference: transferPreferenceReader(() => storedJournal),
        fetch: vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          if (url === "/api/v1/me") {
            accountChecks += 1;
            if (accountChecks === 2) throw postStageFailure;
            return response(200, { user: aliceAccount });
          }
          return response(200, { operations: [], cursor: 0, hasMore: false });
        }),
      }),
      fakeOwnerLock(),
    );

    const error = await coordinator
      .transferAnonymous(alice, stage, complete)
      .catch((caught: unknown) => caught);

    expect(error).toBe(postStageFailure);
    expect(stage).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(sourcePresent).toBe(true);
    expect(journalPresent).toBe(true);
  });

  it("cancels queued account deletion when a storage-backed transfer rejects", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const { coffee, bag } = coffeeAndBag();
      await saveCoffeeWithBag(ANONYMOUS_OWNER_ID, coffee, bag);
      let accountChecks = 0;
      let markPostStageSyncStarted!: () => void;
      let rejectPostStageSync!: () => void;
      const postStageSyncStarted = new Promise<void>((resolve) => {
        markPostStageSyncStarted = resolve;
      });
      const postStageSyncBlocked = new Promise<void>((resolve) => {
        rejectPostStageSync = resolve;
      });
      const transferFailure = new Error("post-stage sync failed");
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/v1/me") {
          accountChecks += 1;
          if (accountChecks === 2) {
            markPostStageSyncStarted();
            await postStageSyncBlocked;
            throw transferFailure;
          }
          return response(200, { user: aliceAccount });
        }
        if (url === "/api/v1/sync/push") {
          return response(200, { results: [] });
        }
        return response(200, { operations: [], cursor: 0, hasMore: false });
      });
      const coordinator = createSyncCoordinator(
        dependencies({
          fetch,
          getOperations: getStoredOperations,
          acknowledgeOperations: acknowledgeStoredOperations,
          getPreference: getOwnerPreference,
          applyRemotePage: applyStoredRemotePage,
        }),
        fakeOwnerLock(),
      );
      const transfer = coordinator.transferAnonymous(
        alice,
        () => stageAnonymousTransfer(alice),
        () => completeAnonymousTransfer(alice),
      );
      await postStageSyncStarted;

      let cloudDeleteCalls = 0;
      const deletion = coordinator.deleteAccount(
        alice,
        async () => {
          cloudDeleteCalls += 1;
        },
        () => clearDeletedAccountData(alice).then(() => undefined),
      );
      const joinedSync = coordinator.synchronize(alice);
      expect(cloudDeleteCalls).toBe(0);

      rejectPostStageSync();
      const [transferError, deletionError, joinedError] = await Promise.all([
        transfer.catch((error: unknown) => error),
        deletion.catch((error: unknown) => error),
        joinedSync.catch((error: unknown) => error),
      ]);

      expect(transferError).toBe(transferFailure);
      expect(deletionError).toBe(transferFailure);
      expect(joinedError).toBe(transferFailure);
      expect(cloudDeleteCalls).toBe(0);
      expect(
        await getOwnerPreference(alice, ANONYMOUS_TRANSFER_JOURNAL_KEY),
      ).toBeDefined();
      expect(
        await getOwnerPreference(
          ANONYMOUS_OWNER_ID,
          ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
        ),
      ).toBe(alice);
      expect(await getCoffees(ANONYMOUS_OWNER_ID)).toHaveLength(1);
      expect(await getStoredOperations(alice)).toHaveLength(2);
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("cancels a queued cache reset when transfer completion is incomplete", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const { coffee, bag } = coffeeAndBag();
      await saveCoffeeWithBag(ANONYMOUS_OWNER_ID, coffee, bag);
      let markCompletionStarted!: () => void;
      let releaseCompletion!: () => void;
      const completionStarted = new Promise<void>((resolve) => {
        markCompletionStarted = resolve;
      });
      const completionBlocked = new Promise<void>((resolve) => {
        releaseCompletion = resolve;
      });
      const fetch = vi.fn(async (input: string | URL | Request) =>
        String(input) === "/api/v1/me"
          ? response(200, { user: aliceAccount })
          : String(input) === "/api/v1/sync/push"
            ? response(200, { results: [] })
            : response(200, { operations: [], cursor: 0, hasMore: false }),
      );
      const coordinator = createSyncCoordinator(
        dependencies({
          fetch,
          getOperations: getStoredOperations,
          acknowledgeOperations: acknowledgeStoredOperations,
          getPreference: getOwnerPreference,
          applyRemotePage: applyStoredRemotePage,
        }),
        fakeOwnerLock(),
      );
      const transfer = coordinator.transferAnonymous(
        alice,
        () => stageAnonymousTransfer(alice),
        async () => {
          markCompletionStarted();
          await completionBlocked;
          return { completed: false, pendingCount: 1 };
        },
      );
      await completionStarted;

      const joinedSync = coordinator.synchronize(alice);
      let resetCalls = 0;
      const reset = coordinator.resetAndSynchronize(alice, async () => {
        resetCalls += 1;
        return clearOwnerData(alice);
      });
      releaseCompletion();
      await expect(transfer).resolves.toEqual({
        completed: false,
        pendingCount: 1,
      });
      const resetError = await reset.catch((error: unknown) => error);
      const joinedError = await joinedSync.catch((error: unknown) => error);

      expect(resetError).toBeInstanceOf(Error);
      expect(joinedError).toBeInstanceOf(Error);
      expect(resetCalls).toBe(0);
      expect(
        await getOwnerPreference(alice, ANONYMOUS_TRANSFER_JOURNAL_KEY),
      ).toBeDefined();
      expect(
        await getOwnerPreference(
          ANONYMOUS_OWNER_ID,
          ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
        ),
      ).toBe(alice);
      expect(await getCoffees(ANONYMOUS_OWNER_ID)).toHaveLength(1);
      expect(await getCoffees(alice)).toHaveLength(1);
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("rejects a post-settlement reset from another coordinator while transfer state persists", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const { coffee, bag } = coffeeAndBag();
      await saveCoffeeWithBag(ANONYMOUS_OWNER_ID, coffee, bag);
      const lock = fakeOwnerLock();
      const transferCoordinator = createSyncCoordinator(
        storedDependencies(),
        lock,
      );
      const destructiveCoordinator = createSyncCoordinator(
        storedDependencies(),
        lock,
      );

      await expect(
        transferCoordinator.transferAnonymous(
          alice,
          () => stageAnonymousTransfer(alice),
          async () => ({ completed: false, pendingCount: 1 }),
        ),
      ).resolves.toEqual({ completed: false, pendingCount: 1 });

      let resetCalls = 0;
      await expect(
        destructiveCoordinator.resetAndSynchronize(alice, async () => {
          resetCalls += 1;
          return clearOwnerData(alice);
        }),
      ).rejects.toBeInstanceOf(Error);

      expect(resetCalls).toBe(0);
      expect(
        await getOwnerPreference(alice, ANONYMOUS_TRANSFER_JOURNAL_KEY),
      ).toBeDefined();
      expect(
        await getOwnerPreference(
          ANONYMOUS_OWNER_ID,
          ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
        ),
      ).toBe(alice);
      expect(await getCoffees(ANONYMOUS_OWNER_ID)).toHaveLength(1);
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("rejects a post-settlement deletion from another coordinator after transfer failure", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const { coffee, bag } = coffeeAndBag();
      await saveCoffeeWithBag(ANONYMOUS_OWNER_ID, coffee, bag);
      let accountChecks = 0;
      const transferFailure = new Error("post-stage sync failed");
      const transferFetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/v1/me") {
          accountChecks += 1;
          if (accountChecks === 2) throw transferFailure;
          return response(200, { user: aliceAccount });
        }
        return response(200, { operations: [], cursor: 0, hasMore: false });
      });
      const lock = fakeOwnerLock();
      const transferCoordinator = createSyncCoordinator(
        storedDependencies(transferFetch),
        lock,
      );
      const destructiveCoordinator = createSyncCoordinator(
        storedDependencies(),
        lock,
      );

      await expect(
        transferCoordinator.transferAnonymous(
          alice,
          () => stageAnonymousTransfer(alice),
          () => completeAnonymousTransfer(alice),
        ),
      ).rejects.toBe(transferFailure);

      let cloudDeleteCalls = 0;
      let localDeleteCalls = 0;
      await expect(
        destructiveCoordinator.deleteAccount(
          alice,
          async () => {
            cloudDeleteCalls += 1;
          },
          async () => {
            localDeleteCalls += 1;
            await clearDeletedAccountData(alice);
          },
        ),
      ).rejects.toBeInstanceOf(Error);

      expect(cloudDeleteCalls).toBe(0);
      expect(localDeleteCalls).toBe(0);
      expect(
        await getOwnerPreference(alice, ANONYMOUS_TRANSFER_JOURNAL_KEY),
      ).toBeDefined();
      expect(
        await getOwnerPreference(
          ANONYMOUS_OWNER_ID,
          ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
        ),
      ).toBe(alice);
      expect(await getStoredOperations(alice)).toHaveLength(2);
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("rejects a cross-coordinator transfer requested behind a queued reset", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const { coffee, bag } = coffeeAndBag();
      await saveCoffeeWithBag(ANONYMOUS_OWNER_ID, coffee, bag);
      const lock = fakeOwnerLock();
      const resetCoordinator = createSyncCoordinator(
        storedDependencies(),
        lock,
      );
      const transferCoordinator = createSyncCoordinator(
        storedDependencies(),
        lock,
      );
      let markResetStarted!: () => void;
      let releaseReset!: () => void;
      const resetStarted = new Promise<void>((resolve) => {
        markResetStarted = resolve;
      });
      const resetBlocked = new Promise<void>((resolve) => {
        releaseReset = resolve;
      });
      const reset = resetCoordinator.resetAndSynchronize(alice, async () => {
        markResetStarted();
        await resetBlocked;
        return {
          cleared: false as const,
          reason: "pending-operations" as const,
          pendingCount: 1,
        };
      });
      await resetStarted;

      let stageCalls = 0;
      const transfer = transferCoordinator.transferAnonymous(
        alice,
        async () => {
          stageCalls += 1;
          return stageAnonymousTransfer(alice);
        },
        () => completeAnonymousTransfer(alice),
      );
      releaseReset();
      await reset;
      await expect(transfer).rejects.toBeInstanceOf(Error);

      expect(stageCalls).toBe(0);
      expect(await getCoffees(ANONYMOUS_OWNER_ID)).toHaveLength(1);
      expect(
        await getOwnerPreference(alice, ANONYMOUS_TRANSFER_JOURNAL_KEY),
      ).toBeUndefined();
      expect(await getOwnerMutationState(alice)).toEqual({
        generation: 1,
        kind: "reset",
        deleted: false,
      });
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("rejects a cross-coordinator transfer requested behind account deletion", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const { coffee, bag } = coffeeAndBag();
      await saveCoffeeWithBag(ANONYMOUS_OWNER_ID, coffee, bag);
      const lock = fakeOwnerLock();
      const deletionCoordinator = createSyncCoordinator(
        storedDependencies(),
        lock,
      );
      const transferCoordinator = createSyncCoordinator(
        storedDependencies(),
        lock,
      );
      let markDeletionStarted!: () => void;
      let releaseDeletion!: () => void;
      const deletionStarted = new Promise<void>((resolve) => {
        markDeletionStarted = resolve;
      });
      const deletionBlocked = new Promise<void>((resolve) => {
        releaseDeletion = resolve;
      });
      const deletion = deletionCoordinator.deleteAccount(
        alice,
        async () => {
          markDeletionStarted();
          await deletionBlocked;
        },
        () => clearDeletedAccountData(alice).then(() => undefined),
      );
      await deletionStarted;

      let stageCalls = 0;
      const transfer = transferCoordinator.transferAnonymous(
        alice,
        async () => {
          stageCalls += 1;
          return stageAnonymousTransfer(alice);
        },
        () => completeAnonymousTransfer(alice),
      );
      releaseDeletion();
      await deletion;
      await expect(transfer).rejects.toBeInstanceOf(Error);

      expect(stageCalls).toBe(0);
      expect(await getOwnerMutationState(alice)).toEqual({
        generation: 1,
        kind: "delete",
        deleted: true,
      });
      expect(await getCoffees(ANONYMOUS_OWNER_ID)).toHaveLength(1);
      expect(
        await getOwnerPreference(alice, ANONYMOUS_TRANSFER_JOURNAL_KEY),
      ).toBeUndefined();
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("clears failed deletion intent so a later transfer can retry", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const { coffee, bag } = coffeeAndBag();
      await saveCoffeeWithBag(ANONYMOUS_OWNER_ID, coffee, bag);
      const lock = fakeOwnerLock();
      const deletionCoordinator = createSyncCoordinator(
        storedDependencies(),
        lock,
      );
      const transferCoordinator = createSyncCoordinator(
        storedDependencies(),
        lock,
      );
      const deletionFailure = new Error("cloud deletion failed");

      await expect(
        deletionCoordinator.deleteAccount(
          alice,
          async () => {
            throw deletionFailure;
          },
          () => clearDeletedAccountData(alice).then(() => undefined),
        ),
      ).rejects.toBe(deletionFailure);
      expect(await getOwnerMutationState(alice)).toEqual({
        generation: 1,
        kind: "delete",
        deleted: false,
      });

      await expect(
        transferCoordinator.transferAnonymous(
          alice,
          () => stageAnonymousTransfer(alice),
          () => completeAnonymousTransfer(alice),
        ),
      ).resolves.toEqual({ completed: true, pendingCount: 0 });
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("rejects a transfer requested after a cache reset is queued", async () => {
    let markResetStarted!: () => void;
    let releaseReset!: () => void;
    const resetStarted = new Promise<void>((resolve) => {
      markResetStarted = resolve;
    });
    const resetBlocked = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    const coordinator = createSyncCoordinator(dependencies(), fakeOwnerLock());
    const reset = coordinator.resetAndSynchronize(alice, async () => {
      markResetStarted();
      await resetBlocked;
      return {
        cleared: false as const,
        reason: "pending-operations" as const,
        pendingCount: 1,
      };
    });
    await resetStarted;

    let stageWrites = 0;
    const transfer = coordinator.transferAnonymous(
      alice,
      async () => {
        stageWrites += 1;
        return transferJournal();
      },
      async () => ({ completed: true, pendingCount: 0 }),
    );
    releaseReset();
    await reset;
    const transferError = await transfer.catch((error: unknown) => error);

    expect(transferError).toBeInstanceOf(Error);
    expect(stageWrites).toBe(0);
  });

  it("rejects a transfer requested after account deletion is queued", async () => {
    let markDeletionStarted!: () => void;
    let releaseDeletion!: () => void;
    const deletionStarted = new Promise<void>((resolve) => {
      markDeletionStarted = resolve;
    });
    const deletionBlocked = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    const coordinator = createSyncCoordinator(dependencies(), fakeOwnerLock());
    const deletion = coordinator.deleteAccount(
      alice,
      async () => {
        markDeletionStarted();
        await deletionBlocked;
      },
      async () => undefined,
    );
    await deletionStarted;

    let stageWrites = 0;
    const transfer = coordinator.transferAnonymous(
      alice,
      async () => {
        stageWrites += 1;
        return transferJournal();
      },
      async () => ({ completed: true, pendingCount: 0 }),
    );
    releaseDeletion();
    await deletion;
    const transferError = await transfer.catch((error: unknown) => error);

    expect(transferError).toBeInstanceOf(Error);
    expect(stageWrites).toBe(0);
  });

  it("persists initial destination acknowledgement before staging", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const destination = coffeeAndBag(
        "0198d3a4-1111-7000-8000-000000000221",
        "0198d3a4-1111-7000-8000-000000000222",
      );
      const source = coffeeAndBag(
        "0198d3a4-1111-7000-8000-000000000223",
        "0198d3a4-1111-7000-8000-000000000224",
      );
      await saveCoffeeWithBag(alice, destination.coffee, destination.bag);
      const initialOperationIds = (await getStoredOperations(alice)).map(
        ({ operationId: pendingId }) => pendingId,
      );
      await saveCoffeeWithBag(ANONYMOUS_OWNER_ID, source.coffee, source.bag);
      let markInitialAcknowledgement!: () => void;
      let releaseInitialAcknowledgement!: () => void;
      const initialAcknowledgementStarted = new Promise<void>((resolve) => {
        markInitialAcknowledgement = resolve;
      });
      const initialAcknowledgementBlocked = new Promise<void>((resolve) => {
        releaseInitialAcknowledgement = resolve;
      });
      let firstAcknowledgement = true;
      const acknowledgeOperations = async (
        ownerId: string,
        operationIds: string[],
      ): Promise<void> => {
        if (firstAcknowledgement) {
          firstAcknowledgement = false;
          markInitialAcknowledgement();
          await initialAcknowledgementBlocked;
        }
        await acknowledgeStoredOperations(ownerId, operationIds);
      };
      const coordinator = createSyncCoordinator(
        storedDependencies(undefined, { acknowledgeOperations }),
        fakeOwnerLock(),
      );
      let stageCalls = 0;
      let stagedJournal!: AnonymousTransferJournal;

      const transfer = coordinator.transferAnonymous(
        alice,
        async () => {
          stageCalls += 1;
          expect(await getStoredOperations(alice)).toEqual([]);
          stagedJournal = await stageAnonymousTransfer(alice);
          return stagedJournal;
        },
        () => completeAnonymousTransfer(alice),
      );
      await initialAcknowledgementStarted;

      expect(stageCalls).toBe(0);
      expect(
        await getOwnerPreference(alice, ANONYMOUS_TRANSFER_JOURNAL_KEY),
      ).toBeUndefined();
      expect(
        (await getStoredOperations(alice)).map(
          ({ operationId: pendingId }) => pendingId,
        ),
      ).toEqual(initialOperationIds);

      releaseInitialAcknowledgement();
      await expect(transfer).resolves.toEqual({
        completed: true,
        pendingCount: 0,
      });
      expect(stageCalls).toBe(1);
      expect(stagedJournal.operationIds).toHaveLength(2);
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("completes from persisted acknowledgement without another post-stage network pass", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const { coffee, bag } = coffeeAndBag();
      await saveCoffeeWithBag(ANONYMOUS_OWNER_ID, coffee, bag);
      const fetch = vi.fn(async (input: string | URL | Request) =>
        String(input) === "/api/v1/me"
          ? response(200, { user: aliceAccount })
          : response(200, { operations: [], cursor: 0, hasMore: false }),
      );
      const coordinator = createSyncCoordinator(
        storedDependencies(fetch),
        fakeOwnerLock(),
      );

      await expect(
        coordinator.transferAnonymous(
          alice,
          async () => {
            const journal = await stageAnonymousTransfer(alice);
            await acknowledgeStoredOperations(alice, journal.operationIds);
            return JSON.parse(
              (await getOwnerPreference(
                alice,
                ANONYMOUS_TRANSFER_JOURNAL_KEY,
              ))!,
            ) as AnonymousTransferJournal;
          },
          () => completeAnonymousTransfer(alice),
        ),
      ).resolves.toEqual({ completed: true, pendingCount: 0 });

      expect(
        fetch.mock.calls.filter(([input]) => String(input) === "/api/v1/me"),
      ).toHaveLength(1);
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("completes a persisted fully acknowledged journal while offline without staging again", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const { coffee, bag } = coffeeAndBag();
      await saveCoffeeWithBag(ANONYMOUS_OWNER_ID, coffee, bag);
      const journal = await stageAnonymousTransfer(alice);
      await acknowledgeStoredOperations(alice, journal.operationIds);
      db.close();
      await db.open();

      const fetch = vi.fn(async () => {
        throw new Error(
          "network must not be required for acknowledged cleanup",
        );
      });
      const stage = vi.fn(() => stageAnonymousTransfer(alice));
      const coordinator = createSyncCoordinator(
        storedDependencies(fetch, { isOnline: () => false }),
        fakeOwnerLock(),
      );

      await expect(
        coordinator.transferAnonymous(alice, stage, () =>
          completeAnonymousTransfer(alice),
        ),
      ).resolves.toEqual({ completed: true, pendingCount: 0 });

      expect(stage).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(await getCoffees(ANONYMOUS_OWNER_ID)).toEqual([]);
      expect(await getCoffees(alice)).toHaveLength(1);
      expect(await getCoffeeBags(alice)).toHaveLength(1);
      expect(await getStoredOperations(alice)).toEqual([]);
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("resumes a persisted staged journal before failing unrelated pending work", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const { coffee, bag } = coffeeAndBag();
      await saveCoffeeWithBag(ANONYMOUS_OWNER_ID, coffee, bag);
      const journal = await stageAnonymousTransfer(alice);
      const unrelatedOperationId = "0198d3a4-1111-7000-8000-000000000225";
      await db.operations.add({
        ownerId: alice,
        operationId: unrelatedOperationId,
        entity: "machine",
        entityId: unrelatedOperationId,
        action: "delete",
        createdAt: "2020-01-01T00:00:00.000Z",
      });
      db.close();
      await db.open();

      const pushedBatches: string[][] = [];
      const fetch = vi.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url === "/api/v1/me") {
            return response(200, { user: aliceAccount });
          }
          if (url === "/api/v1/sync/push") {
            const body = JSON.parse(String(init?.body)) as {
              operations: Array<{ operationId: string }>;
            };
            const pushedIds = body.operations.map(
              ({ operationId: pushedId }) => pushedId,
            );
            pushedBatches.push(pushedIds);
            return pushedIds.includes(unrelatedOperationId)
              ? response(503, { error: "unrelated operation failed" })
              : response(200, { results: [] });
          }
          return response(200, {
            operations: [],
            cursor: 0,
            hasMore: false,
          });
        },
      );
      const stage = vi.fn(() => stageAnonymousTransfer(alice));
      const coordinator = createSyncCoordinator(
        storedDependencies(fetch),
        fakeOwnerLock(),
      );

      await expect(
        coordinator.transferAnonymous(alice, stage, () =>
          completeAnonymousTransfer(alice),
        ),
      ).resolves.toEqual({ completed: true, pendingCount: 0 });

      expect(stage).not.toHaveBeenCalled();
      expect(pushedBatches).toEqual([journal.operationIds]);
      expect(new Set(pushedBatches.flat()).size).toBe(
        journal.operationIds.length,
      );
      expect(
        (await getStoredOperations(alice)).map(
          ({ operationId: pendingId }) => pendingId,
        ),
      ).toEqual([unrelatedOperationId]);
      expect(await getCoffees(ANONYMOUS_OWNER_ID)).toEqual([]);
      expect(await getCoffees(alice)).toHaveLength(1);
      expect(await getCoffeeBags(alice)).toHaveLength(1);
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("completes without duplicate operations after a cross-context staged brew deletion", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const { coffee, bag } = coffeeAndBag(
        "0198d3a4-1111-7000-8000-000000000226",
        beanId,
      );
      await saveCoffeeWithBag(ANONYMOUS_OWNER_ID, coffee, bag);
      await saveMachine(ANONYMOUS_OWNER_ID, {
        id: "0198d3a4-1111-7000-8000-000000000213",
        name: "Linea Mini",
        temperatureControl: "precise",
        hasPressureControl: false,
        hasPreinfusion: true,
        createdAt,
      });
      await saveGrinder(ANONYMOUS_OWNER_ID, {
        id: "0198d3a4-1111-7000-8000-000000000214",
        name: "P64",
        finerDirection: "lower",
        createdAt,
      });
      await saveBrew(ANONYMOUS_OWNER_ID, brewPayload(36));

      let markStaged!: () => void;
      let releaseStage!: () => void;
      const staged = new Promise<void>((resolve) => {
        markStaged = resolve;
      });
      const stageBlocked = new Promise<void>((resolve) => {
        releaseStage = resolve;
      });
      const pushedBatches: string[][] = [];
      const fetch = vi.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url === "/api/v1/me") {
            return response(200, { user: aliceAccount });
          }
          if (url === "/api/v1/sync/push") {
            const body = JSON.parse(String(init?.body)) as {
              operations: Array<{ operationId: string }>;
            };
            pushedBatches.push(
              body.operations.map(({ operationId: pushedId }) => pushedId),
            );
            return response(200, { results: [] });
          }
          return response(200, {
            operations: [],
            cursor: 0,
            hasMore: false,
          });
        },
      );
      const coordinator = createSyncCoordinator(
        storedDependencies(fetch),
        fakeOwnerLock(),
      );
      let journal!: AnonymousTransferJournal;
      const transfer = coordinator.transferAnonymous(
        alice,
        async () => {
          journal = await stageAnonymousTransfer(alice);
          markStaged();
          await stageBlocked;
          return journal;
        },
        () => completeAnonymousTransfer(alice),
      );
      await staged;

      expect(await deleteBrew(alice, brewId)).toBe(true);
      const afterDeletionOperationIds = (await getStoredOperations(alice)).map(
        ({ operationId: pendingId }) => pendingId,
      );
      releaseStage();

      await expect(transfer).resolves.toEqual({
        completed: true,
        pendingCount: 0,
      });
      expect(afterDeletionOperationIds).toHaveLength(
        journal.operationIds.length + 1,
      );
      expect(afterDeletionOperationIds).toEqual(
        expect.arrayContaining(journal.operationIds),
      );
      expect(
        afterDeletionOperationIds.filter(
          (pendingId) => !journal.operationIds.includes(pendingId),
        ),
      ).toHaveLength(1);
      expect(pushedBatches).toEqual([journal.operationIds]);
      expect(new Set(pushedBatches.flat()).size).toBe(
        journal.operationIds.length,
      );
      expect(await getBrews(alice)).toEqual([]);
      expect(await getCoffees(alice)).toHaveLength(1);
      expect(await getCoffeeBags(alice)).toHaveLength(1);
      expect(await getCoffees(ANONYMOUS_OWNER_ID)).toEqual([]);
      expect(await getStoredOperations(alice)).toEqual([
        expect.objectContaining({
          entity: "brew",
          entityId: brewId,
          action: "delete",
        }),
      ]);
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("pushes only transfer journal operations when unrelated work sorts ahead", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const { coffee, bag } = coffeeAndBag();
      await saveCoffeeWithBag(ANONYMOUS_OWNER_ID, coffee, bag);
      const unrelatedOperationId = "0198d3a4-1111-7000-8000-000000000220";
      const pushedBatches: string[][] = [];
      const fetch = vi.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url === "/api/v1/me") {
            return response(200, { user: aliceAccount });
          }
          if (url === "/api/v1/sync/push") {
            const body = JSON.parse(String(init?.body)) as {
              operations: Array<{ operationId: string }>;
            };
            pushedBatches.push(
              body.operations.map(({ operationId: pushedId }) => pushedId),
            );
            return response(200, { results: [] });
          }
          return response(200, { operations: [], cursor: 0, hasMore: false });
        },
      );
      const coordinator = createSyncCoordinator(
        storedDependencies(fetch),
        fakeOwnerLock(),
      );
      let stagedJournal!: AnonymousTransferJournal;

      await expect(
        coordinator.transferAnonymous(
          alice,
          async () => {
            stagedJournal = await stageAnonymousTransfer(alice);
            await db.operations.add({
              ownerId: alice,
              operationId: unrelatedOperationId,
              entity: "machine",
              entityId: unrelatedOperationId,
              action: "delete",
              createdAt: "2020-01-01T00:00:00.000Z",
            });
            return stagedJournal;
          },
          () => completeAnonymousTransfer(alice),
        ),
      ).resolves.toEqual({ completed: true, pendingCount: 0 });

      expect(pushedBatches).toEqual([stagedJournal.operationIds]);
      expect(
        (await getStoredOperations(alice)).map(
          ({ operationId: pendingId }) => pendingId,
        ),
      ).toEqual([unrelatedOperationId]);
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("fails before post-stage network work on a returned and persisted journal mismatch and retries", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const { coffee, bag } = coffeeAndBag();
      await saveCoffeeWithBag(ANONYMOUS_OWNER_ID, coffee, bag);
      const pushedBatches: string[][] = [];
      const fetch = vi.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url === "/api/v1/me") {
            return response(200, { user: aliceAccount });
          }
          if (url === "/api/v1/sync/push") {
            const body = JSON.parse(String(init?.body)) as {
              operations: Array<{ operationId: string }>;
            };
            pushedBatches.push(
              body.operations.map(({ operationId: pushedId }) => pushedId),
            );
            return response(200, { results: [] });
          }
          return response(200, { operations: [], cursor: 0, hasMore: false });
        },
      );
      const coordinator = createSyncCoordinator(
        storedDependencies(fetch),
        fakeOwnerLock(),
      );
      let persistedJournal!: AnonymousTransferJournal;

      await expect(
        coordinator.transferAnonymous(
          alice,
          async () => {
            persistedJournal = await stageAnonymousTransfer(alice);
            return {
              ...persistedJournal,
              startedAt: "2020-01-01T00:00:00.000Z",
            };
          },
          () => completeAnonymousTransfer(alice),
        ),
      ).rejects.toBeInstanceOf(AnonymousTransferStateError);

      expect(pushedBatches).toEqual([]);
      expect(
        (await getStoredOperations(alice)).map(
          ({ operationId: pendingId }) => pendingId,
        ),
      ).toEqual(persistedJournal.operationIds);

      await expect(
        coordinator.transferAnonymous(
          alice,
          () => stageAnonymousTransfer(alice),
          () => completeAnonymousTransfer(alice),
        ),
      ).resolves.toEqual({ completed: true, pendingCount: 0 });
      expect(pushedBatches).toEqual([persistedJournal.operationIds]);
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("fails closed when persisted acknowledgement loses an earlier transfer ID", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const { coffee, bag } = coffeeAndBag();
      await saveCoffeeWithBag(ANONYMOUS_OWNER_ID, coffee, bag);
      let returnedJournal!: AnonymousTransferJournal;
      const acknowledgeOperations = async (
        ownerId: string,
        operationIds: string[],
      ): Promise<void> => {
        const persisted = JSON.parse(
          (await getOwnerPreference(ownerId, ANONYMOUS_TRANSFER_JOURNAL_KEY))!,
        ) as AnonymousTransferJournal;
        await db.preferences.put({
          key: ownerPreferenceKey(ownerId, ANONYMOUS_TRANSFER_JOURNAL_KEY),
          value: JSON.stringify({
            ...persisted,
            acknowledgedOperationIds: [],
          }),
        });
        await acknowledgeStoredOperations(ownerId, operationIds);
      };
      const coordinator = createSyncCoordinator(
        storedDependencies(undefined, { acknowledgeOperations }),
        fakeOwnerLock(),
      );

      await expect(
        coordinator.transferAnonymous(
          alice,
          async () => {
            const journal = await stageAnonymousTransfer(alice);
            await acknowledgeStoredOperations(alice, [
              journal.operationIds[0]!,
            ]);
            returnedJournal = JSON.parse(
              (await getOwnerPreference(
                alice,
                ANONYMOUS_TRANSFER_JOURNAL_KEY,
              ))!,
            ) as AnonymousTransferJournal;
            return returnedJournal;
          },
          () => completeAnonymousTransfer(alice),
        ),
      ).rejects.toBeInstanceOf(AnonymousTransferStateError);

      const corruptedJournal = JSON.parse(
        (await getOwnerPreference(alice, ANONYMOUS_TRANSFER_JOURNAL_KEY))!,
      ) as AnonymousTransferJournal;
      expect(returnedJournal.acknowledgedOperationIds).toEqual([
        returnedJournal.operationIds[0],
      ]);
      expect(corruptedJournal.acknowledgedOperationIds).toEqual([
        returnedJournal.operationIds[1],
      ]);
      expect(await getCoffees(ANONYMOUS_OWNER_ID)).toHaveLength(1);
      expect(
        await getOwnerPreference(
          ANONYMOUS_OWNER_ID,
          ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
        ),
      ).toBe(alice);
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("completes after storage acknowledges transfer operations without draining later writes", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const source = coffeeAndBag();
      const unrelated = coffeeAndBag(
        "0198d3a4-1111-7000-8000-000000000218",
        "0198d3a4-1111-7000-8000-000000000219",
      );
      await saveCoffeeWithBag(ANONYMOUS_OWNER_ID, source.coffee, source.bag);
      let markAcknowledgementStarted!: () => void;
      let releaseAcknowledgement!: () => void;
      const acknowledgementStarted = new Promise<void>((resolve) => {
        markAcknowledgementStarted = resolve;
      });
      const acknowledgementBlocked = new Promise<void>((resolve) => {
        releaseAcknowledgement = resolve;
      });
      let addedUnrelatedWrite = false;
      const acknowledgeOperations = async (
        ownerId: string,
        operationIds: string[],
      ): Promise<void> => {
        markAcknowledgementStarted();
        await acknowledgementBlocked;
        await acknowledgeStoredOperations(ownerId, operationIds);
        if (!addedUnrelatedWrite) {
          addedUnrelatedWrite = true;
          await saveCoffeeWithBag(alice, unrelated.coffee, unrelated.bag);
        }
      };
      const fetch = vi.fn(async (input: string | URL | Request) =>
        String(input) === "/api/v1/me"
          ? response(200, { user: aliceAccount })
          : String(input) === "/api/v1/sync/push"
            ? response(200, { results: [] })
            : response(200, { operations: [], cursor: 0, hasMore: false }),
      );
      const coordinator = createSyncCoordinator(
        dependencies({
          fetch,
          getOperations: getStoredOperations,
          acknowledgeOperations,
          getPreference: getOwnerPreference,
          applyRemotePage: applyStoredRemotePage,
        }),
        fakeOwnerLock(),
      );
      const transfer = coordinator.transferAnonymous(
        alice,
        () => stageAnonymousTransfer(alice),
        () => completeAnonymousTransfer(alice),
      );
      await acknowledgementStarted;

      let transferSettled = false;
      let joinedSyncSettled = false;
      void transfer.then(
        () => {
          transferSettled = true;
        },
        () => {
          transferSettled = true;
        },
      );
      const joinedSync = coordinator.synchronize(alice);
      void joinedSync.then(
        () => {
          joinedSyncSettled = true;
        },
        () => {
          joinedSyncSettled = true;
        },
      );
      const storedJournal = JSON.parse(
        (await getOwnerPreference(alice, ANONYMOUS_TRANSFER_JOURNAL_KEY))!,
      ) as AnonymousTransferJournal;
      expect(storedJournal.acknowledgedOperationIds).toEqual([]);
      expect(await getCoffees(ANONYMOUS_OWNER_ID)).toHaveLength(1);
      await Promise.resolve();
      expect(transferSettled).toBe(false);
      expect(joinedSyncSettled).toBe(false);

      releaseAcknowledgement();
      await expect(transfer).resolves.toEqual({
        completed: true,
        pendingCount: 0,
      });
      await expect(joinedSync).resolves.toBeUndefined();

      expect(transferSettled).toBe(true);
      expect(joinedSyncSettled).toBe(true);
      expect(await getCoffees(ANONYMOUS_OWNER_ID)).toEqual([]);
      expect(
        await getOwnerPreference(alice, ANONYMOUS_TRANSFER_JOURNAL_KEY),
      ).toBeUndefined();
      expect(
        (await getStoredOperations(alice)).map(({ entity }) => entity),
      ).toEqual(["coffee", "bean"]);
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it("fails closed when a pushed transfer operation has no acknowledgement evidence", async () => {
    const journal = transferJournal(alice, [operationId]);
    let storedJournal: AnonymousTransferJournal | undefined;
    let pending: Array<Owned<SyncOperation>> = [];
    let sourcePresent = true;
    const getOperations = vi.fn(async (_ownerId: string, limit?: number) =>
      limit === undefined ? pending : pending.slice(0, limit),
    );
    const coordinator = createSyncCoordinator(
      dependencies({
        getOperations,
        getPreference: transferPreferenceReader(() => storedJournal),
        acknowledgeOperations: vi.fn(
          async (_ownerId: string, operationIds: string[]) => {
            pending = pending.filter(
              (operation) => !operationIds.includes(operation.operationId),
            );
          },
        ),
      }),
      fakeOwnerLock(),
    );

    const error = await coordinator
      .transferAnonymous(
        alice,
        async () => {
          storedJournal = journal;
          pending = [queuedOperation()];
          return journal;
        },
        async () => {
          sourcePresent = false;
          return { completed: false, pendingCount: 1 };
        },
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AnonymousTransferStateError);
    expect(sourcePresent).toBe(true);
  });

  it("continues across transfer operation batches and stops with unrelated work pending", async () => {
    const transferOperationIds = Array.from(
      { length: 201 },
      (_, index) => `transfer-operation-${index + 1}`,
    );
    const journal = transferJournal(alice, transferOperationIds);
    let storedJournal: AnonymousTransferJournal | undefined;
    let pending: Array<Owned<SyncOperation>> = [];
    let acknowledgementBatches = 0;
    const pushedBatches: string[][] = [];
    const getOperations = vi.fn(async (_ownerId: string, limit?: number) =>
      limit === undefined ? pending : pending.slice(0, limit),
    );
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/v1/me") {
          return response(200, { user: aliceAccount });
        }
        if (url === "/api/v1/sync/push") {
          const body = JSON.parse(String(init?.body)) as {
            operations: Array<{ operationId: string }>;
          };
          pushedBatches.push(
            body.operations.map(({ operationId: pushedId }) => pushedId),
          );
          return response(200, { results: [] });
        }
        return response(200, { operations: [], cursor: 0, hasMore: false });
      },
    );
    const coordinator = createSyncCoordinator(
      dependencies({
        fetch,
        getOperations,
        getPreference: transferPreferenceReader(() => storedJournal),
        acknowledgeOperations: vi.fn(
          async (_ownerId: string, operationIds: string[]) => {
            const acknowledged = new Set([
              ...(storedJournal?.acknowledgedOperationIds ?? []),
              ...operationIds.filter((acknowledgedId) =>
                transferOperationIds.includes(acknowledgedId),
              ),
            ]);
            storedJournal = {
              ...journal,
              acknowledgedOperationIds: transferOperationIds.filter(
                (transferOperationId) => acknowledged.has(transferOperationId),
              ),
            };
            pending = pending.filter(
              (operation) => !operationIds.includes(operation.operationId),
            );
            acknowledgementBatches += 1;
            pending.push({
              ...queuedOperation(),
              operationId: `unrelated-operation-${acknowledgementBatches}`,
            });
          },
        ),
      }),
      fakeOwnerLock(),
    );

    await expect(
      coordinator.transferAnonymous(
        alice,
        async () => {
          storedJournal = journal;
          pending = transferOperationIds.map((transferOperationId) => ({
            ...queuedOperation(),
            operationId: transferOperationId,
          }));
          return journal;
        },
        async () => ({ completed: true, pendingCount: 0 }),
      ),
    ).resolves.toEqual({ completed: true, pendingCount: 0 });

    expect(pushedBatches).toHaveLength(3);
    expect(storedJournal?.acknowledgedOperationIds).toEqual(
      transferOperationIds,
    );
    expect(pending.map(({ operationId: pendingId }) => pendingId)).toEqual([
      "unrelated-operation-1",
      "unrelated-operation-2",
      "unrelated-operation-3",
    ]);
  });

  it("reuses a staged journal on retry and completes after acknowledgement", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const { coffee, bag } = coffeeAndBag();
      await saveCoffeeWithBag(ANONYMOUS_OWNER_ID, coffee, bag);
      let accountChecks = 0;
      let failPostStage = true;
      const pushedBatches: string[][] = [];
      const fetch = vi.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url === "/api/v1/me") {
            accountChecks += 1;
            if (failPostStage && accountChecks === 2) {
              throw new Error("post-stage sync failed");
            }
            return response(200, { user: aliceAccount });
          }
          if (url === "/api/v1/sync/push") {
            const body = JSON.parse(String(init?.body)) as {
              operations: Array<{ operationId: string }>;
            };
            pushedBatches.push(
              body.operations.map(({ operationId: pushedId }) => pushedId),
            );
            return response(200, { results: [] });
          }
          return response(200, { operations: [], cursor: 0, hasMore: false });
        },
      );
      const coordinator = createSyncCoordinator(
        dependencies({
          fetch,
          getOperations: getStoredOperations,
          acknowledgeOperations: acknowledgeStoredOperations,
          getPreference: getOwnerPreference,
          applyRemotePage: applyStoredRemotePage,
        }),
        fakeOwnerLock(),
      );

      await expect(
        coordinator.transferAnonymous(
          alice,
          () => stageAnonymousTransfer(alice),
          () => completeAnonymousTransfer(alice),
        ),
      ).rejects.toThrow("post-stage sync failed");
      const stagedJournal = JSON.parse(
        (await getOwnerPreference(alice, ANONYMOUS_TRANSFER_JOURNAL_KEY))!,
      ) as AnonymousTransferJournal;
      expect(stagedJournal.acknowledgedOperationIds).toEqual([]);
      expect(await getCoffees(ANONYMOUS_OWNER_ID)).toHaveLength(1);
      expect(await getStoredOperations(alice)).toHaveLength(2);

      failPostStage = false;
      await expect(
        coordinator.transferAnonymous(
          alice,
          () => stageAnonymousTransfer(alice),
          () => completeAnonymousTransfer(alice),
        ),
      ).resolves.toEqual({ completed: true, pendingCount: 0 });

      expect(pushedBatches).toEqual([stagedJournal.operationIds]);
      expect(await getStoredOperations(alice)).toEqual([]);
      expect(await getCoffees(ANONYMOUS_OWNER_ID)).toEqual([]);
      expect(
        await getOwnerPreference(alice, ANONYMOUS_TRANSFER_JOURNAL_KEY),
      ).toBeUndefined();
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
  });

  it.each([
    new AuthenticationExpiredError("me"),
    new AccountMismatchError(alice, bobAccount),
  ])(
    "propagates %s unchanged from destination synchronization",
    async (error) => {
      const coordinator = createSyncCoordinator(
        dependencies({
          fetch: vi.fn(async () => {
            throw error;
          }),
        }),
        fakeOwnerLock(),
      );

      const caught = await coordinator
        .transferAnonymous(
          alice,
          async () => transferJournal(),
          async () => ({ completed: true, pendingCount: 0 }),
        )
        .catch((failure: unknown) => failure);

      expect(caught).toBe(error);
    },
  );

  it("keeps a queued cache reset outside the stage-to-completion window", async () => {
    let releasePostStageSync!: () => void;
    let markPostStageSyncStarted!: () => void;
    const postStageSyncBlocked = new Promise<void>((resolve) => {
      releasePostStageSync = resolve;
    });
    const postStageSyncStarted = new Promise<void>((resolve) => {
      markPostStageSyncStarted = resolve;
    });
    const events: string[] = [];
    let storedJournal: AnonymousTransferJournal | undefined;
    let pending: Array<Owned<SyncOperation>> = [];
    let accountChecks = 0;
    const coordinator = createSyncCoordinator(
      dependencies({
        getPreference: transferPreferenceReader(() => storedJournal),
        getOperations: vi.fn(async (_ownerId: string, limit?: number) =>
          limit === undefined ? pending : pending.slice(0, limit),
        ),
        acknowledgeOperations: vi.fn(
          async (_ownerId: string, operationIds: string[]) => {
            storedJournal = {
              ...storedJournal!,
              acknowledgedOperationIds: operationIds,
            };
            pending = pending.filter(
              ({ operationId: pendingId }) => !operationIds.includes(pendingId),
            );
          },
        ),
        fetch: vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          if (url === "/api/v1/me") {
            accountChecks += 1;
            if (accountChecks === 2) {
              events.push("post-stage-sync");
              markPostStageSyncStarted();
              await postStageSyncBlocked;
            }
            return response(200, { user: aliceAccount });
          }
          return response(200, { operations: [], cursor: 0, hasMore: false });
        }),
      }),
      fakeOwnerLock(),
    );
    const transfer = coordinator.transferAnonymous(
      alice,
      async () => {
        events.push("stage");
        storedJournal = transferJournal(alice, [operationId]);
        pending = [queuedOperation()];
        return storedJournal;
      },
      async () => {
        events.push("complete");
        storedJournal = undefined;
        return { completed: true, pendingCount: 0 };
      },
    );
    await postStageSyncStarted;

    const reset = coordinator.resetAndSynchronize(alice, async () => {
      events.push("reset");
      return {
        cleared: false as const,
        reason: "pending-operations" as const,
        pendingCount: 1,
      };
    });
    await Promise.resolve();
    expect(events).toEqual(["stage", "post-stage-sync"]);

    releasePostStageSync();
    await Promise.all([transfer, reset]);
    expect(events).toEqual(["stage", "post-stage-sync", "complete", "reset"]);
  });

  it("keeps queued account deletion outside the stage-to-completion window", async () => {
    let releasePostStageSync!: () => void;
    let markPostStageSyncStarted!: () => void;
    const postStageSyncBlocked = new Promise<void>((resolve) => {
      releasePostStageSync = resolve;
    });
    const postStageSyncStarted = new Promise<void>((resolve) => {
      markPostStageSyncStarted = resolve;
    });
    const events: string[] = [];
    let storedJournal: AnonymousTransferJournal | undefined;
    let pending: Array<Owned<SyncOperation>> = [];
    let accountChecks = 0;
    const coordinator = createSyncCoordinator(
      dependencies({
        getPreference: transferPreferenceReader(() => storedJournal),
        getOperations: vi.fn(async (_ownerId: string, limit?: number) =>
          limit === undefined ? pending : pending.slice(0, limit),
        ),
        acknowledgeOperations: vi.fn(
          async (_ownerId: string, operationIds: string[]) => {
            storedJournal = {
              ...storedJournal!,
              acknowledgedOperationIds: operationIds,
            };
            pending = pending.filter(
              ({ operationId: pendingId }) => !operationIds.includes(pendingId),
            );
          },
        ),
        fetch: vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          if (url === "/api/v1/me") {
            accountChecks += 1;
            if (accountChecks === 2) {
              events.push("post-stage-sync");
              markPostStageSyncStarted();
              await postStageSyncBlocked;
            }
            return response(200, { user: aliceAccount });
          }
          return response(200, { operations: [], cursor: 0, hasMore: false });
        }),
      }),
      fakeOwnerLock(),
    );
    const transfer = coordinator.transferAnonymous(
      alice,
      async () => {
        events.push("stage");
        storedJournal = transferJournal(alice, [operationId]);
        pending = [queuedOperation()];
        return storedJournal;
      },
      async () => {
        events.push("complete");
        storedJournal = undefined;
        return { completed: true, pendingCount: 0 };
      },
    );
    await postStageSyncStarted;

    const deletion = coordinator.deleteAccount(
      alice,
      async () => {
        events.push("cloud-deleted");
      },
      async () => {
        events.push("local-cleared");
      },
    );
    await Promise.resolve();
    expect(events).toEqual(["stage", "post-stage-sync"]);

    releasePostStageSync();
    await Promise.all([transfer, deletion]);
    expect(events).toEqual([
      "stage",
      "post-stage-sync",
      "complete",
      "cloud-deleted",
      "local-cleared",
    ]);
  });

  it("coalesces concurrent same-owner transfer callers", async () => {
    let releaseStage!: () => void;
    let markStageStarted!: () => void;
    const stageBlocked = new Promise<void>((resolve) => {
      releaseStage = resolve;
    });
    const stageStarted = new Promise<void>((resolve) => {
      markStageStarted = resolve;
    });
    let storedJournal: AnonymousTransferJournal | undefined;
    const stage = vi.fn(async () => {
      markStageStarted();
      await stageBlocked;
      storedJournal = transferJournal();
      return storedJournal;
    });
    const complete = vi.fn(async () => ({
      completed: true,
      pendingCount: 0,
    }));
    const coordinator = createSyncCoordinator(
      dependencies({
        getPreference: transferPreferenceReader(() => storedJournal),
      }),
      fakeOwnerLock(),
    );

    const first = coordinator.transferAnonymous(alice, stage, complete);
    const second = coordinator.transferAnonymous(alice, stage, complete);

    expect(second).toBe(first);
    await stageStarted;
    releaseStage();
    await Promise.all([first, second]);
    expect(stage).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
  });

  it("makes a normal sync join an active transfer", async () => {
    let releaseStage!: () => void;
    let markStageStarted!: () => void;
    const stageBlocked = new Promise<void>((resolve) => {
      releaseStage = resolve;
    });
    const stageStarted = new Promise<void>((resolve) => {
      markStageStarted = resolve;
    });
    let storedJournal: AnonymousTransferJournal | undefined;
    let fullQueueReads = 0;
    const coordinator = createSyncCoordinator(
      dependencies({
        getPreference: transferPreferenceReader(() => storedJournal),
        getOperations: vi.fn(async (_ownerId: string, limit?: number) => {
          if (limit === 100) fullQueueReads += 1;
          return [];
        }),
      }),
      fakeOwnerLock(),
    );
    const transfer = coordinator.transferAnonymous(
      alice,
      async () => {
        markStageStarted();
        await stageBlocked;
        storedJournal = transferJournal();
        return storedJournal;
      },
      async () => ({ completed: true, pendingCount: 0 }),
    );
    await stageStarted;

    let joinedSettled = false;
    const joinedSync = coordinator.synchronize(alice);
    void joinedSync.finally(() => {
      joinedSettled = true;
    });
    await Promise.resolve();
    expect(joinedSettled).toBe(false);
    releaseStage();
    await Promise.all([transfer, joinedSync]);

    expect(joinedSettled).toBe(true);
    expect(fullQueueReads).toBe(1);
  });

  it("rejects an anonymous transfer destination", async () => {
    await expect(
      moveAnonymousDataToAccount(ANONYMOUS_OWNER_ID),
    ).rejects.toThrow("Transfer destination must be an account");
  });

  it("propagates the consented summary through the production move entry point", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const { coffee, bag } = coffeeAndBag();
      await saveCoffeeWithBag(ANONYMOUS_OWNER_ID, coffee, bag);
      const request = vi.fn(
        async <T>(
          _name: string,
          _options: { mode: "exclusive" },
          callback: () => Promise<T>,
        ) => callback(),
      );
      vi.stubGlobal("navigator", { onLine: true, locks: { request } });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          if (url === "/api/v1/me") {
            return response(200, { user: aliceAccount });
          }
          if (url.startsWith("/api/v1/sync/pull")) {
            return response(200, {
              operations: [],
              cursor: 0,
              hasMore: false,
            });
          }
          throw new Error(`Unexpected transfer request: ${url}`);
        }),
      );
      const expectedSummary = {
        coffees: 0,
        bags: 0,
        machines: 0,
        grinders: 0,
        brews: 0,
        hasData: false,
      } satisfies AnonymousTransferSummary;

      const error = await moveAnonymousDataToAccount(
        alice,
        expectedSummary,
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AnonymousTransferSummaryChangedError);
      expect(error).toMatchObject({
        currentSummary: {
          coffees: 1,
          bags: 1,
          machines: 0,
          grinders: 0,
          brews: 0,
          hasData: true,
        },
      });
      expect(await getCoffees(alice)).toEqual([]);
      expect(await getStoredOperations(alice)).toEqual([]);
      expect(
        await getOwnerPreference(alice, ANONYMOUS_TRANSFER_JOURNAL_KEY),
      ).toBeUndefined();
      expect(request).toHaveBeenCalledOnce();
    } finally {
      db.close();
      await Dexie.delete("dialed-local");
    }
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
        getPreference: vi.fn(async (_ownerId: string, key: string) =>
          key === "sync-cursor" && !cleared ? "17" : undefined,
        ),
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

  it("round-trips a Coffee and marked bag through the real sync coordinator and storage", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    await db.open();
    try {
      const coffee: Coffee = {
        id: "0198d3a4-1111-7000-8000-000000000216",
        name: "Hualalai Kona",
        roaster: "Coffee Purveyors",
        roastLevel: "medium-light",
        createdAt,
      };
      const bag: CoffeeBag = {
        id: "0198d3a4-1111-7000-8000-000000000217",
        coffeeId: coffee.id,
        roastedOn: "2026-08-15",
        legacyPairedCoffee: true,
        createdAt,
      };
      const remoteLedger: Array<
        Record<string, unknown> & { revision: number }
      > = [];
      const fetch = vi.fn(
        async (
          input: string | URL | Request,
          init?: RequestInit,
        ): Promise<Response> => {
          const url = String(input);
          if (url === "/api/v1/me")
            return response(200, { user: aliceAccount });
          if (url === "/api/v1/sync/push") {
            const body = JSON.parse(String(init?.body)) as {
              operations: Array<Record<string, unknown>>;
            };
            const results = body.operations.map((operation) => {
              const revision = remoteLedger.length + 1;
              remoteLedger.push({ ...operation, revision });
              return {
                operationId: operation.operationId,
                revision,
                duplicate: false,
              };
            });
            return response(200, { results });
          }

          const cursor = Number(
            new URL(url, "http://dialed.test").searchParams.get("cursor"),
          );
          const operations = remoteLedger.filter(
            (operation) => operation.revision > cursor,
          );
          return response(200, {
            operations,
            cursor: operations.at(-1)?.revision ?? cursor,
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

      await saveCoffeeWithBag(alice, coffee, bag);
      await sync(alice);
      expect(remoteLedger.map((operation) => operation.entity)).toEqual([
        "coffee",
        "bean",
      ]);
      expect(remoteLedger[1]?.payload).toMatchObject({
        coffeeId: coffee.id,
        legacyPairedCoffee: true,
      });

      await expect(clearOwnerData(alice)).resolves.toEqual({ cleared: true });
      expect(await getCoffees(alice)).toEqual([]);
      expect(await getCoffeeBags(alice)).toEqual([]);

      await sync(alice);

      expect(await getCoffees(alice)).toEqual([
        expect.objectContaining({ id: coffee.id, name: coffee.name }),
      ]);
      expect(await getCoffeeBags(alice)).toEqual([
        expect.objectContaining({
          id: bag.id,
          coffeeId: coffee.id,
          legacyPairedCoffee: true,
        }),
      ]);
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
