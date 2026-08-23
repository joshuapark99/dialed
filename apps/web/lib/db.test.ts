import "fake-indexeddb/auto";

import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANONYMOUS_OWNER_ID,
  acknowledgeOperations,
  applyRemotePage,
  applyRemoteOperation,
  clearDeletedAccountData,
  clearOwnerData,
  db,
  deleteBrew,
  DeletedOwnerWriteError,
  discardAnonymousData,
  getBeans,
  getBrews,
  getGrinders,
  getMachines,
  getOperations,
  getOwnerPreference,
  ownerPreferenceKey,
  removeOperations,
  saveBean,
  saveBrew,
  saveGrinder,
  saveMachine,
  setOwnerPreference,
  updateBrew,
} from "./db";
import type { Bean, Brew, Grinder, Machine } from "./models";

const alice = "account:alice";
const bob = "account:bob";

function bean(id: string, name: string): Bean {
  return {
    id,
    name,
    roaster: "Test Roaster",
    roastLevel: "medium",
    createdAt: "2026-08-22T12:00:00.000Z",
  };
}

function brew(id: string, beanId: string): Brew {
  return {
    id,
    beanId,
    machineId: "0198d3a4-1111-7000-8000-000000000001",
    grinderId: "0198d3a4-1111-7000-8000-000000000002",
    dose: 18,
    yield: 36,
    duration: 28,
    grind: "4.0",
    taste: { acidity: 3, bitterness: 2, strength: 3, body: 3, enjoyment: 4 },
    ratio: 2,
    flow: 36 / 28,
    recommendation: {
      variable: "hold",
      direction: "hold",
      headline: "Hold this recipe",
      rationale: "Balanced result",
      expectedEffect: "Confirm consistency",
      confidence: "high",
      ruleVersion: "espresso-v1",
    },
    createdAt: "2026-08-22T12:00:00.000Z",
    updatedAt: "2026-08-22T12:00:00.000Z",
    syncState: "local",
  };
}

function machine(id: string): Machine {
  return {
    id,
    name: "Legacy machine",
    temperatureControl: "none",
    hasPressureControl: false,
    hasPreinfusion: false,
    createdAt: "2026-08-22T12:00:00.000Z",
  };
}

function grinder(id: string): Grinder {
  return {
    id,
    name: "Legacy grinder",
    finerDirection: "lower",
    createdAt: "2026-08-22T12:00:00.000Z",
  };
}

beforeEach(async () => {
  db.close();
  await Dexie.delete("dialed-local");
  await db.open();
});

describe("owner-inclusive primary keys", () => {
  it("allows every entity and operation ID to coexist across owners", async () => {
    const sharedId = "0198d3a4-1111-7000-8000-000000000080";
    const sharedOperationId = "0198d3a4-1111-7000-8000-000000000081";

    await saveBean(alice, bean(sharedId, "Alice bean"));
    await saveBean(bob, bean(sharedId, "Bob bean"));
    await saveMachine(alice, machine(sharedId));
    await saveMachine(bob, { ...machine(sharedId), name: "Bob machine" });
    await saveGrinder(alice, grinder(sharedId));
    await saveGrinder(bob, { ...grinder(sharedId), name: "Bob grinder" });
    await saveBrew(alice, brew(sharedId, sharedId));
    await saveBrew(bob, { ...brew(sharedId, sharedId), yield: 40 });
    await db.operations.add({
      ownerId: alice,
      operationId: sharedOperationId,
      entity: "bean",
      entityId: sharedId,
      action: "upsert",
      payload: { ...bean(sharedId, "Alice bean") },
      createdAt: "2026-08-22T12:02:00.000Z",
    });
    await db.operations.add({
      ownerId: bob,
      operationId: sharedOperationId,
      entity: "bean",
      entityId: sharedId,
      action: "upsert",
      payload: { ...bean(sharedId, "Bob bean") },
      createdAt: "2026-08-22T12:02:00.000Z",
    });

    expect((await getBeans(alice))[0]?.name).toBe("Alice bean");
    expect((await getBeans(bob))[0]?.name).toBe("Bob bean");
    expect((await getMachines(alice))[0]?.name).toBe("Legacy machine");
    expect((await getMachines(bob))[0]?.name).toBe("Bob machine");
    expect((await getGrinders(alice))[0]?.name).toBe("Legacy grinder");
    expect((await getGrinders(bob))[0]?.name).toBe("Bob grinder");

    await updateBrew(alice, sharedId, { yield: 42 });
    expect((await getBrews(alice))[0]?.yield).toBe(42);
    expect((await getBrews(bob))[0]?.yield).toBe(40);

    await acknowledgeOperations(alice, [sharedOperationId]);
    expect(
      (await getOperations(bob)).some(
        (operation) => operation.operationId === sharedOperationId,
      ),
    ).toBe(true);

    await acknowledgeOperations(
      alice,
      (await getOperations(alice)).map((operation) => operation.operationId),
    );
    await applyRemoteOperation(alice, {
      entity: "bean",
      entityId: sharedId,
      action: "delete",
    });
    expect(await getBeans(alice)).toEqual([]);
    expect((await getBeans(bob))[0]?.name).toBe("Bob bean");

    await applyRemoteOperation(alice, {
      entity: "bean",
      entityId: sharedId,
      action: "upsert",
      payload: bean(sharedId, "Alice replay"),
    });
    expect((await getBeans(alice))[0]?.name).toBe("Alice replay");
    expect((await getBeans(bob))[0]?.name).toBe("Bob bean");
  });

  it("preserves owner-stamped version-3 data while changing primary keys", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    const legacy = new Dexie("dialed-local");
    legacy.version(1).stores({
      beans: "id, name, roaster, createdAt",
      machines: "id, name, createdAt",
      grinders: "id, name, createdAt",
      brews: "id, beanId, machineId, grinderId, createdAt, dialedAt, syncState",
      preferences: "key",
    });
    legacy.version(2).stores({
      beans: "id, name, roaster, createdAt",
      machines: "id, name, createdAt",
      grinders: "id, name, createdAt",
      brews: "id, beanId, machineId, grinderId, createdAt, dialedAt, syncState",
      preferences: "key",
      operations: "operationId, entity, entityId, createdAt",
    });
    legacy.version(3).stores({
      beans: "id, ownerId, [ownerId+createdAt], name, roaster, createdAt",
      machines: "id, ownerId, [ownerId+createdAt], name, createdAt",
      grinders: "id, ownerId, [ownerId+createdAt], name, createdAt",
      brews:
        "id, ownerId, [ownerId+createdAt], [ownerId+beanId], beanId, machineId, grinderId, createdAt, dialedAt, syncState",
      preferences: "key",
      operations:
        "operationId, ownerId, [ownerId+createdAt], entity, entityId, createdAt",
    });
    await legacy.open();
    const sharedId = "0198d3a4-1111-7000-8000-000000000082";
    const operationId = "0198d3a4-1111-7000-8000-000000000083";
    await legacy
      .table("beans")
      .put({ ...bean(sharedId, "Alice v3"), ownerId: alice });
    await legacy
      .table("machines")
      .put({ ...machine(sharedId), ownerId: alice });
    await legacy
      .table("grinders")
      .put({ ...grinder(sharedId), ownerId: alice });
    await legacy
      .table("brews")
      .put({ ...brew(sharedId, sharedId), ownerId: alice });
    await legacy.table("operations").put({
      ownerId: alice,
      operationId,
      entity: "bean",
      entityId: sharedId,
      action: "upsert",
      payload: bean(sharedId, "Alice v3"),
      createdAt: "2026-08-22T12:03:00.000Z",
    });
    legacy.close();

    await db.open();
    expect(db.tables.map((table) => table.name)).not.toEqual(
      expect.arrayContaining([
        "beans",
        "machines",
        "grinders",
        "brews",
        "operations",
      ]),
    );
    await saveBean(bob, bean(sharedId, "Bob after migration"));
    await db.operations.add({
      ownerId: bob,
      operationId,
      entity: "bean",
      entityId: sharedId,
      action: "upsert",
      payload: { ...bean(sharedId, "Bob after migration") },
      createdAt: "2026-08-22T12:04:00.000Z",
    });

    expect((await getBeans(alice))[0]?.name).toBe("Alice v3");
    expect((await getBeans(bob))[0]?.name).toBe("Bob after migration");
    expect(await getMachines(alice)).toHaveLength(1);
    expect(await getGrinders(alice)).toHaveLength(1);
    expect(await getBrews(alice)).toHaveLength(1);
    expect(
      (await getOperations(alice)).some(
        (operation) => operation.operationId === operationId,
      ),
    ).toBe(true);
    expect(
      (await getOperations(bob)).some(
        (operation) => operation.operationId === operationId,
      ),
    ).toBe(true);
  });
});

describe("atomic remote pages", () => {
  it("applies a validated page and advances only that owner's cursor", async () => {
    const beanId = "0198d3a4-1111-7000-8000-000000000084";
    const machineId = "0198d3a4-1111-7000-8000-000000000085";
    await setOwnerPreference(bob, "sync-cursor", "9");

    await applyRemotePage(
      alice,
      [
        {
          entity: "bean",
          entityId: beanId,
          action: "upsert",
          payload: bean(beanId, "Remote"),
        },
        {
          entity: "machine",
          entityId: machineId,
          action: "upsert",
          payload: machine(machineId),
        },
      ],
      "sync-cursor",
      2,
      [],
    );

    expect((await getBeans(alice))[0]?.name).toBe("Remote");
    expect(await getMachines(alice)).toHaveLength(1);
    expect(await getOwnerPreference(alice, "sync-cursor")).toBe("2");
    expect(await getOwnerPreference(bob, "sync-cursor")).toBe("9");
  });

  it("rolls back every operation and the cursor when one page write fails", async () => {
    const beanId = "0198d3a4-1111-7000-8000-000000000086";
    const machineId = "0198d3a4-1111-7000-8000-000000000087";
    await setOwnerPreference(alice, "sync-cursor", "4");
    vi.spyOn(db.machines, "put").mockRejectedValueOnce(
      new Error("machine write failed"),
    );

    await expect(
      applyRemotePage(
        alice,
        [
          {
            entity: "bean",
            entityId: beanId,
            action: "upsert",
            payload: bean(beanId, "Rolled back"),
          },
          {
            entity: "machine",
            entityId: machineId,
            action: "upsert",
            payload: machine(machineId),
          },
        ],
        "sync-cursor",
        6,
        [],
      ),
    ).rejects.toThrow("machine write failed");

    expect(await getBeans(alice)).toEqual([]);
    expect(await getMachines(alice)).toEqual([]);
    expect(await getOwnerPreference(alice, "sync-cursor")).toBe("4");
  });

  it("ignores a stale page without changing records or regressing the cursor", async () => {
    const beanId = "0198d3a4-1111-7000-8000-000000000088";
    await setOwnerPreference(alice, "sync-cursor", "8");
    await saveBean(alice, bean(beanId, "Local newer state"));
    await removeOperations(
      alice,
      (await getOperations(alice)).map(({ operationId }) => operationId),
    );

    await applyRemotePage(
      alice,
      [
        {
          entity: "bean",
          entityId: beanId,
          action: "upsert",
          payload: bean(beanId, "Stale remote state"),
        },
      ],
      "sync-cursor",
      7,
      [],
    );

    expect((await getBeans(alice))[0]?.name).toBe("Local newer state");
    expect(await getOwnerPreference(alice, "sync-cursor")).toBe("8");
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await Dexie.delete("dialed-local");
});

describe("owner-scoped persistence", () => {
  it("queries records only for the requested owner", async () => {
    await saveBean(
      alice,
      bean("0198d3a4-1111-7000-8000-000000000010", "Alice's coffee"),
    );
    await saveBean(
      bob,
      bean("0198d3a4-1111-7000-8000-000000000011", "Bob's coffee"),
    );

    expect((await getBeans(alice)).map(({ name }) => name)).toEqual([
      "Alice's coffee",
    ]);
    expect((await getBeans(bob)).map(({ name }) => name)).toEqual([
      "Bob's coffee",
    ]);
  });

  it("retains the originating owner on queued operations", async () => {
    await saveBrew(
      alice,
      brew(
        "0198d3a4-1111-7000-8000-000000000020",
        "0198d3a4-1111-7000-8000-000000000010",
      ),
    );

    const operations = await getOperations(alice);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ ownerId: alice, entity: "brew" });
    expect(await getOperations(bob)).toEqual([]);
  });

  it("deletes only the requested owner's brew and queues a tombstone", async () => {
    const sharedId = "0198d3a4-1111-7000-8000-000000000021";
    await saveBrew(alice, brew(sharedId, sharedId));
    await saveBrew(bob, { ...brew(sharedId, sharedId), yield: 40 });

    expect(await deleteBrew(alice, sharedId)).toBe(true);

    expect(await getBrews(alice)).toEqual([]);
    expect((await getBrews(bob))[0]?.yield).toBe(40);
    expect(await getOperations(alice)).toHaveLength(1);
    expect((await getOperations(alice)).at(-1)).toMatchObject({
      ownerId: alice,
      entity: "brew",
      entityId: sharedId,
      action: "delete",
    });
    expect((await getOperations(alice)).at(-1)?.payload).toBeUndefined();
    expect((await getOperations(bob)).at(-1)?.action).toBe("upsert");
  });

  it("does not queue a tombstone when the owner's brew is already missing", async () => {
    const missingId = "0198d3a4-1111-7000-8000-000000000022";

    expect(await deleteBrew(alice, missingId)).toBe(false);
    expect(await getOperations(alice)).toEqual([]);
  });

  it("clears one owner while preserving every other owner", async () => {
    const aliceBean = bean(
      "0198d3a4-1111-7000-8000-000000000030",
      "Alice's coffee",
    );
    const aliceMachine = machine("0198d3a4-1111-7000-8000-000000000032");
    const aliceGrinder = grinder("0198d3a4-1111-7000-8000-000000000033");
    const aliceBrew = brew(
      "0198d3a4-1111-7000-8000-000000000034",
      aliceBean.id,
    );
    aliceBrew.machineId = aliceMachine.id;
    aliceBrew.grinderId = aliceGrinder.id;
    const bobBean = bean(
      "0198d3a4-1111-7000-8000-000000000035",
      "Bob's coffee",
    );
    const bobMachine = machine("0198d3a4-1111-7000-8000-000000000036");
    const bobGrinder = grinder("0198d3a4-1111-7000-8000-000000000037");
    const bobBrew = brew("0198d3a4-1111-7000-8000-000000000038", bobBean.id);
    bobBrew.machineId = bobMachine.id;
    bobBrew.grinderId = bobGrinder.id;

    await saveBean(alice, aliceBean);
    await saveMachine(alice, aliceMachine);
    await saveGrinder(alice, aliceGrinder);
    await saveBrew(alice, aliceBrew);
    await saveBean(bob, bobBean);
    await saveMachine(bob, bobMachine);
    await saveGrinder(bob, bobGrinder);
    await saveBrew(bob, bobBrew);
    await setOwnerPreference(alice, "onboarded", "true");
    await setOwnerPreference(bob, "onboarded", "true");
    await removeOperations(
      alice,
      (await getOperations(alice)).map(({ operationId }) => operationId),
    );

    expect(await clearOwnerData(alice)).toEqual({ cleared: true });
    expect(await getBeans(alice)).toEqual([]);
    expect(await getMachines(alice)).toEqual([]);
    expect(await getGrinders(alice)).toEqual([]);
    expect(await getBrews(alice)).toEqual([]);
    expect(await getOperations(alice)).toEqual([]);
    expect(await getOwnerPreference(alice, "onboarded")).toBeUndefined();
    expect((await getBeans(bob)).map(({ name }) => name)).toEqual([
      "Bob's coffee",
    ]);
    expect(await getMachines(bob)).toHaveLength(1);
    expect(await getGrinders(bob)).toHaveLength(1);
    expect(await getBrews(bob)).toHaveLength(1);
    expect(await getOperations(bob)).toHaveLength(4);
    expect(await getOwnerPreference(bob, "onboarded")).toBe("true");
  });

  it("can refuse to clear an owner with pending operations", async () => {
    await saveBean(
      alice,
      bean("0198d3a4-1111-7000-8000-000000000040", "Unsynced coffee"),
    );

    expect(await clearOwnerData(alice)).toEqual({
      cleared: false,
      reason: "pending-operations",
      pendingCount: 1,
    });
    expect(await getBeans(alice)).toHaveLength(1);
    expect(await getOperations(alice)).toHaveLength(1);
  });

  it("uses explicitly destructive paths only for anonymous reset and deleted accounts", async () => {
    await saveBean(
      ANONYMOUS_OWNER_ID,
      bean("0198d3a4-1111-7000-8000-000000000041", "Anonymous coffee"),
    );
    await saveBean(
      alice,
      bean("0198d3a4-1111-7000-8000-000000000042", "Deleted account coffee"),
    );
    await saveBean(
      bob,
      bean("0198d3a4-1111-7000-8000-000000000043", "Preserved coffee"),
    );

    expect(await discardAnonymousData()).toEqual({ cleared: true });
    expect(await getBeans(ANONYMOUS_OWNER_ID)).toEqual([]);
    expect(await clearDeletedAccountData(alice)).toEqual({ cleared: true });
    expect(await getBeans(alice)).toEqual([]);
    expect(await getOperations(alice)).toEqual([]);
    expect(await getBeans(bob)).toHaveLength(1);
  });

  it("rejects every local write after an account is tombstoned", async () => {
    const beanId = "0198d3a4-1111-7000-8000-000000000044";
    const machineId = "0198d3a4-1111-7000-8000-000000000045";
    const grinderId = "0198d3a4-1111-7000-8000-000000000046";
    const brewId = "0198d3a4-1111-7000-8000-000000000047";
    await clearDeletedAccountData(alice);

    const writes = [
      () => saveBean(alice, bean(beanId, "Late bean")),
      () => saveMachine(alice, machine(machineId)),
      () => saveGrinder(alice, grinder(grinderId)),
      () => saveBrew(alice, brew(brewId, beanId)),
      () => updateBrew(alice, brewId, { yield: 40 }),
    ];
    for (const write of writes) {
      await expect(write()).rejects.toBeInstanceOf(DeletedOwnerWriteError);
    }

    expect(await getBeans(alice)).toEqual([]);
    expect(await getMachines(alice)).toEqual([]);
    expect(await getGrinders(alice)).toEqual([]);
    expect(await getBrews(alice)).toEqual([]);
    expect(await getOperations(alice)).toEqual([]);
  });

  it("keeps anonymous data and a different account writable after deletion", async () => {
    await clearDeletedAccountData(alice);

    await saveBean(
      ANONYMOUS_OWNER_ID,
      bean("0198d3a4-1111-7000-8000-000000000048", "Anonymous after delete"),
    );
    await saveBean(
      bob,
      bean("0198d3a4-1111-7000-8000-000000000049", "New account"),
    );

    expect(await getBeans(ANONYMOUS_OWNER_ID)).toHaveLength(1);
    expect(await getBeans(bob)).toHaveLength(1);
    expect(await getOperations(ANONYMOUS_OWNER_ID)).toHaveLength(1);
    expect(await getOperations(bob)).toHaveLength(1);
  });

  it("does not let a stale cache reset remove a deleted-owner tombstone", async () => {
    await clearDeletedAccountData(alice);

    await expect(clearOwnerData(alice)).rejects.toBeInstanceOf(
      DeletedOwnerWriteError,
    );
    await expect(
      saveBean(
        alice,
        bean("0198d3a4-1111-7000-8000-000000000051", "Still blocked"),
      ),
    ).rejects.toBeInstanceOf(DeletedOwnerWriteError);
  });

  it("rejects delayed remote writes after deleted-account cleanup", async () => {
    const remoteBeanId = "0198d3a4-1111-7000-8000-000000000050";
    await clearDeletedAccountData(alice);

    await expect(
      applyRemoteOperation(alice, {
        entity: "bean",
        entityId: remoteBeanId,
        action: "upsert",
        payload: bean(remoteBeanId, "Delayed operation"),
      }),
    ).rejects.toBeInstanceOf(DeletedOwnerWriteError);
    await expect(
      applyRemotePage(
        alice,
        [
          {
            entity: "bean",
            entityId: remoteBeanId,
            action: "upsert",
            payload: bean(remoteBeanId, "Delayed page"),
          },
        ],
        "sync-cursor",
        1,
        [],
      ),
    ).rejects.toBeInstanceOf(DeletedOwnerWriteError);

    expect(await getBeans(alice)).toEqual([]);
    expect(await getOwnerPreference(alice, "sync-cursor")).toBeUndefined();
  });

  it("rolls back a brew save when queue insertion fails", async () => {
    const record = brew(
      "0198d3a4-1111-7000-8000-000000000062",
      "0198d3a4-1111-7000-8000-000000000063",
    );
    vi.spyOn(db.operations, "add").mockRejectedValueOnce(
      new Error("queue unavailable"),
    );

    await expect(saveBrew(alice, record)).rejects.toThrow("queue unavailable");
    expect(await getBrews(alice)).toEqual([]);
    expect(await getOperations(alice)).toEqual([]);
  });

  it("acknowledges exact operations without marking a newer brew edit synced", async () => {
    const brewId = "0198d3a4-1111-7000-8000-000000000070";
    await saveBrew(alice, brew(brewId, "0198d3a4-1111-7000-8000-000000000071"));
    const firstOperation = (await getOperations(alice))[0]!;
    await updateBrew(alice, brewId, {
      yield: 42,
      updatedAt: "2026-08-22T12:01:00.000Z",
    });
    const secondOperation = (await getOperations(alice))[1]!;

    await acknowledgeOperations(alice, [firstOperation.operationId]);

    expect(
      (await getOperations(alice)).map((item) => item.operationId),
    ).toEqual([secondOperation.operationId]);
    expect((await getBrews(alice))[0]).toMatchObject({
      yield: 42,
      syncState: "pending",
    });

    await acknowledgeOperations(alice, [secondOperation.operationId]);
    expect(await getOperations(alice)).toEqual([]);
    expect((await getBrews(alice))[0]?.syncState).toBe("synced");
  });

  it("rolls back acknowledgement when marking its final brew fails", async () => {
    const brewId = "0198d3a4-1111-7000-8000-000000000072";
    await saveBrew(alice, brew(brewId, "0198d3a4-1111-7000-8000-000000000073"));
    const pushed = (await getOperations(alice))[0]!;
    vi.spyOn(db.brews, "update").mockRejectedValueOnce(
      new Error("brew update failed"),
    );

    await expect(
      acknowledgeOperations(alice, [pushed.operationId]),
    ).rejects.toThrow("brew update failed");

    expect(
      (await getOperations(alice)).map((item) => item.operationId),
    ).toEqual([pushed.operationId]);
    expect((await getBrews(alice))[0]?.syncState).toBe("pending");
  });

  it("does not replay remote upserts or deletes over an entity with pending local work", async () => {
    const beanId = "0198d3a4-1111-7000-8000-000000000074";
    await saveBean(alice, bean(beanId, "Local edit"));

    await applyRemoteOperation(alice, {
      entity: "bean",
      entityId: beanId,
      action: "upsert",
      payload: bean(beanId, "Older remote value"),
    });
    expect((await getBeans(alice))[0]?.name).toBe("Local edit");

    await applyRemoteOperation(alice, {
      entity: "bean",
      entityId: beanId,
      action: "delete",
    });
    expect((await getBeans(alice))[0]?.name).toBe("Local edit");
  });

  it("replays a newer remote value and delete when only the pushed snapshot is pending", async () => {
    const beanId = "0198d3a4-1111-7000-8000-000000000075";
    await saveBean(alice, bean(beanId, "Pushed local value"));
    const pushedOperationId = (await getOperations(alice))[0]!.operationId;

    await applyRemoteOperation(
      alice,
      {
        entity: "bean",
        entityId: beanId,
        action: "upsert",
        payload: bean(beanId, "Newer remote value"),
      },
      [pushedOperationId],
    );
    expect((await getBeans(alice))[0]?.name).toBe("Newer remote value");

    await applyRemoteOperation(
      alice,
      { entity: "bean", entityId: beanId, action: "delete" },
      [pushedOperationId],
    );
    expect(await getBeans(alice)).toEqual([]);
  });

  it("migrates version-2 records and preferences to anonymous ownership", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    const legacy = new Dexie("dialed-local");
    legacy.version(1).stores({
      beans: "id, name, roaster, createdAt",
      machines: "id, name, createdAt",
      grinders: "id, name, createdAt",
      brews: "id, beanId, machineId, grinderId, createdAt, dialedAt, syncState",
      preferences: "key",
    });
    legacy.version(2).stores({
      beans: "id, name, roaster, createdAt",
      machines: "id, name, createdAt",
      grinders: "id, name, createdAt",
      brews: "id, beanId, machineId, grinderId, createdAt, dialedAt, syncState",
      preferences: "key",
      operations: "operationId, entity, entityId, createdAt",
    });
    await legacy.open();
    const migratedBean = bean(
      "0198d3a4-1111-7000-8000-000000000050",
      "Legacy coffee",
    );
    const migratedMachine = machine("0198d3a4-1111-7000-8000-000000000052");
    const migratedGrinder = grinder("0198d3a4-1111-7000-8000-000000000053");
    const migratedBrew = brew(
      "0198d3a4-1111-7000-8000-000000000054",
      migratedBean.id,
    );
    migratedBrew.machineId = migratedMachine.id;
    migratedBrew.grinderId = migratedGrinder.id;
    await legacy.table("beans").put(migratedBean);
    await legacy.table("machines").put(migratedMachine);
    await legacy.table("grinders").put(migratedGrinder);
    await legacy.table("brews").put(migratedBrew);
    await legacy.table("preferences").put({ key: "onboarded", value: "true" });
    await legacy.table("operations").put({
      operationId: "0198d3a4-1111-7000-8000-000000000051",
      entity: "bean",
      entityId: migratedBean.id,
      action: "upsert",
      payload: migratedBean,
      createdAt: "2026-08-22T12:00:00.000Z",
    });
    legacy.close();

    await db.open();

    expect(await getBeans(ANONYMOUS_OWNER_ID)).toEqual([
      expect.objectContaining({ name: "Legacy coffee" }),
    ]);
    expect(await getMachines(ANONYMOUS_OWNER_ID)).toEqual([
      expect.objectContaining({ name: "Legacy machine" }),
    ]);
    expect(await getGrinders(ANONYMOUS_OWNER_ID)).toEqual([
      expect.objectContaining({ name: "Legacy grinder" }),
    ]);
    expect(await getBrews(ANONYMOUS_OWNER_ID)).toEqual([
      expect.objectContaining({ id: migratedBrew.id }),
    ]);
    expect(await getOperations(ANONYMOUS_OWNER_ID)).toEqual([
      expect.objectContaining({ ownerId: ANONYMOUS_OWNER_ID }),
    ]);
    expect(
      await db.preferences.get(
        ownerPreferenceKey(ANONYMOUS_OWNER_ID, "onboarded"),
      ),
    ).toEqual({
      key: ownerPreferenceKey(ANONYMOUS_OWNER_ID, "onboarded"),
      value: "true",
    });
  });
});
