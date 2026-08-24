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
  getBrews,
  getCoffeeBags,
  getCoffees,
  getGrinders,
  getMachines,
  getOperations,
  getOwnerPreference,
  markBrewSynced,
  OwnerTransferInProgressError,
  ownerPreferenceKey,
  removeOperations,
  saveBrew,
  saveCoffeeBag,
  saveCoffeeWithBag,
  saveGrinder,
  saveMachine,
  setOwnerPreference,
  updateBrew,
} from "./db";
import type { Bean, Brew, Coffee, CoffeeBag, Grinder, Machine } from "./models";

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

function coffee(id: string, name: string): Coffee {
  return {
    id,
    name,
    roaster: "Test Roaster",
    originCountry: "Colombia",
    roastLevel: "medium-light",
    createdAt: "2026-08-22T12:00:00.000Z",
  };
}

function coffeeBag(id: string, coffeeId: string): CoffeeBag {
  return {
    id,
    coffeeId,
    roastedOn: "2026-08-20",
    createdAt: "2026-08-22T12:00:00.000Z",
  };
}

async function saveCoffeeFixture(ownerId: string, legacyBean: Bean) {
  await saveCoffeeWithBag(
    ownerId,
    {
      id: legacyBean.id,
      name: legacyBean.name,
      roaster: legacyBean.roaster,
      originCountry: legacyBean.origin,
      roastLevel: legacyBean.roastLevel,
      createdAt: legacyBean.createdAt,
    },
    {
      id: legacyBean.id,
      coffeeId: legacyBean.id,
      createdAt: legacyBean.createdAt,
    },
  );
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

    await saveCoffeeFixture(alice, bean(sharedId, "Alice bean"));
    await saveCoffeeFixture(bob, bean(sharedId, "Bob bean"));
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

    expect((await getCoffees(alice))[0]?.name).toBe("Alice bean");
    expect((await getCoffees(bob))[0]?.name).toBe("Bob bean");
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
    expect((await getCoffees(alice))[0]?.name).toBe("Alice bean");
    expect((await getCoffees(bob))[0]?.name).toBe("Bob bean");

    await applyRemoteOperation(alice, {
      entity: "bean",
      entityId: sharedId,
      action: "upsert",
      payload: bean(sharedId, "Alice replay"),
    });
    expect((await getCoffees(alice))[0]?.name).toBe("Alice replay");
    expect((await getCoffees(bob))[0]?.name).toBe("Bob bean");
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
    await saveCoffeeFixture(bob, bean(sharedId, "Bob after migration"));
    await db.operations.add({
      ownerId: bob,
      operationId,
      entity: "bean",
      entityId: sharedId,
      action: "upsert",
      payload: { ...bean(sharedId, "Bob after migration") },
      createdAt: "2026-08-22T12:04:00.000Z",
    });

    expect((await getCoffees(alice))[0]?.name).toBe("Alice v3");
    expect((await getCoffees(bob))[0]?.name).toBe("Bob after migration");
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

describe("coffee and bag persistence", () => {
  it("returns a Coffee operation before its paired bag when the clock is fixed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-22T12:00:00.000Z"));
    let randomCall = 0;
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (array) {
          new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(
            randomCall++ === 0 ? 0xff : 0,
          );
        }
        return array;
      },
    );
    const coffeeRecord = coffee(
      "0198d3a4-1111-7000-8000-000000000089",
      "Ordered coffee",
    );

    await saveCoffeeWithBag(
      alice,
      coffeeRecord,
      coffeeBag(coffeeRecord.id, coffeeRecord.id),
    );

    expect((await getOperations(alice)).map(({ entity }) => entity)).toEqual([
      "coffee",
      "bean",
    ]);
  });

  it("migrates version-5 beans into paired Coffees and bags without changing brew references", async () => {
    db.close();
    await Dexie.delete("dialed-local");
    const legacy = new Dexie("dialed-local");
    legacy.version(5).stores({
      preferences: "key",
      ownedBeans:
        "[ownerId+id], ownerId, [ownerId+createdAt], id, name, roaster, createdAt",
      ownedMachines:
        "[ownerId+id], ownerId, [ownerId+createdAt], id, name, createdAt",
      ownedGrinders:
        "[ownerId+id], ownerId, [ownerId+createdAt], id, name, createdAt",
      ownedBrews:
        "[ownerId+id], ownerId, [ownerId+createdAt], [ownerId+beanId], id, beanId, machineId, grinderId, createdAt, dialedAt, syncState",
      ownedOperations:
        "[ownerId+operationId], ownerId, [ownerId+createdAt], operationId, entity, entityId, createdAt",
    });
    await legacy.open();
    const legacyBean = {
      ...bean("0198d3a4-1111-7000-8000-000000000090", "Legacy Colombian"),
      origin: "Colombia",
      ownerId: alice,
    };
    const legacyBrew = {
      ...brew("0198d3a4-1111-7000-8000-000000000091", legacyBean.id),
      ownerId: alice,
    };
    await legacy.table("ownedBeans").put(legacyBean);
    await legacy.table("ownedBrews").put(legacyBrew);
    legacy.close();

    await db.open();

    expect(await getCoffees(alice)).toEqual([
      expect.objectContaining({
        id: legacyBean.id,
        name: legacyBean.name,
        roaster: legacyBean.roaster,
        originCountry: legacyBean.origin,
        roastLevel: legacyBean.roastLevel,
      }),
    ]);
    expect(await getCoffeeBags(alice)).toEqual([
      expect.objectContaining({
        id: legacyBean.id,
        coffeeId: legacyBean.id,
        legacyPairedCoffee: true,
      }),
    ]);
    expect((await getBrews(alice))[0]?.beanId).toBe(legacyBean.id);
  });

  it("rolls back both records when queueing a Coffee and first bag fails", async () => {
    const coffeeRecord = coffee(
      "0198d3a4-1111-7000-8000-000000000092",
      "Atomic coffee",
    );
    const bagRecord = coffeeBag(coffeeRecord.id, coffeeRecord.id);
    vi.spyOn(db.operations, "add").mockRejectedValueOnce(
      new Error("queue unavailable"),
    );

    await expect(
      saveCoffeeWithBag(alice, coffeeRecord, bagRecord),
    ).rejects.toThrow("queue unavailable");

    expect(await getCoffees(alice)).toEqual([]);
    expect(await getCoffeeBags(alice)).toEqual([]);
  });

  it("rejects a first bag whose Coffee ID does not match its Coffee", async () => {
    const coffeeRecord = coffee(
      "0198d3a4-1111-7000-8000-000000000093",
      "Mismatched coffee",
    );
    const bagRecord = coffeeBag(
      "0198d3a4-1111-7000-8000-000000000094",
      "0198d3a4-1111-7000-8000-000000000095",
    );

    await expect(
      saveCoffeeWithBag(alice, coffeeRecord, bagRecord),
    ).rejects.toThrow("Coffee bag must reference its Coffee");
    expect(await getCoffees(alice)).toEqual([]);
    expect(await getCoffeeBags(alice)).toEqual([]);
  });

  it("rejects a bag when its Coffee is absent or belongs to another owner", async () => {
    const coffeeId = "0198d3a4-1111-7000-8000-000000000096";
    const bagRecord = coffeeBag(
      "0198d3a4-1111-7000-8000-000000000097",
      coffeeId,
    );

    await expect(saveCoffeeBag(alice, bagRecord)).rejects.toThrow(
      "Coffee does not exist for owner",
    );

    await saveCoffeeWithBag(
      bob,
      coffee(coffeeId, "Bob's coffee"),
      coffeeBag(coffeeId, coffeeId),
    );
    await expect(saveCoffeeBag(alice, bagRecord)).rejects.toThrow(
      "Coffee does not exist for owner",
    );
    expect(await getCoffeeBags(alice)).toEqual([]);
  });
});

describe("atomic remote pages", () => {
  it("accepts a current bag when its Coffee appears earlier in the page", async () => {
    const coffeeId = "0198d3a4-1111-7000-8000-000000000098";
    const bagId = "0198d3a4-1111-7000-8000-000000000099";

    await applyRemotePage(
      alice,
      [
        {
          entity: "coffee",
          entityId: coffeeId,
          action: "upsert",
          payload: coffee(coffeeId, "Page-ordered coffee"),
        },
        {
          entity: "bean",
          entityId: bagId,
          action: "upsert",
          payload: coffeeBag(bagId, coffeeId),
        },
      ],
      "sync-cursor",
      2,
      [],
    );

    expect(await getCoffees(alice)).toEqual([
      expect.objectContaining({ id: coffeeId }),
    ]);
    expect(await getCoffeeBags(alice)).toEqual([
      expect.objectContaining({ id: bagId, coffeeId }),
    ]);
    expect(await getOwnerPreference(alice, "sync-cursor")).toBe("2");
  });

  it("rolls back a page and cursor when a current bag has no Coffee", async () => {
    const missingCoffeeId = "0198d3a4-1111-7000-8000-00000000009a";
    const bagId = "0198d3a4-1111-7000-8000-00000000009b";
    const machineId = "0198d3a4-1111-7000-8000-00000000009c";
    await setOwnerPreference(alice, "sync-cursor", "4");

    await expect(
      applyRemotePage(
        alice,
        [
          {
            entity: "machine",
            entityId: machineId,
            action: "upsert",
            payload: machine(machineId),
          },
          {
            entity: "bean",
            entityId: bagId,
            action: "upsert",
            payload: coffeeBag(bagId, missingCoffeeId),
          },
        ],
        "sync-cursor",
        6,
        [],
      ),
    ).rejects.toThrow("Coffee does not exist for owner");

    expect(await getMachines(alice)).toEqual([]);
    expect(await getCoffeeBags(alice)).toEqual([]);
    expect(await getOwnerPreference(alice, "sync-cursor")).toBe("4");
  });

  it("rolls back a page and cursor when Coffee deletion would orphan an active bag", async () => {
    const coffeeId = "0198d3a4-1111-7000-8000-00000000009f";
    const bagId = "0198d3a4-1111-7000-8000-0000000000a0";
    const machineId = "0198d3a4-1111-7000-8000-0000000000a1";
    await applyRemotePage(
      alice,
      [
        {
          entity: "coffee",
          entityId: coffeeId,
          action: "upsert",
          payload: coffee(coffeeId, "Referenced Coffee"),
        },
        {
          entity: "bean",
          entityId: bagId,
          action: "upsert",
          payload: coffeeBag(bagId, coffeeId),
        },
      ],
      "sync-cursor",
      2,
      [],
    );

    await expect(
      applyRemotePage(
        alice,
        [
          {
            entity: "machine",
            entityId: machineId,
            action: "upsert",
            payload: machine(machineId),
          },
          {
            entity: "coffee",
            entityId: coffeeId,
            action: "delete",
          },
        ],
        "sync-cursor",
        4,
        [],
      ),
    ).rejects.toThrow();

    expect(await getCoffees(alice)).toEqual([
      expect.objectContaining({ id: coffeeId }),
    ]);
    expect(await getCoffeeBags(alice)).toEqual([
      expect.objectContaining({ id: bagId, coffeeId }),
    ]);
    expect(await getMachines(alice)).toEqual([]);
    expect(await getOwnerPreference(alice, "sync-cursor")).toBe("2");
  });

  it.each([
    ["current bag", false],
    ["marked legacy pair", true],
  ] as const)(
    "accepts ordered bag-first removal for a %s",
    async (_label, legacyPairedCoffee) => {
      const coffeeId = "0198d3a4-1111-7000-8000-0000000000a2";
      const bagId = "0198d3a4-1111-7000-8000-0000000000a3";
      const bagPayload = legacyPairedCoffee
        ? { ...coffeeBag(bagId, coffeeId), legacyPairedCoffee: true as const }
        : coffeeBag(bagId, coffeeId);

      await applyRemotePage(
        alice,
        [
          {
            entity: "coffee",
            entityId: coffeeId,
            action: "upsert",
            payload: coffee(coffeeId, "Removable Coffee"),
          },
          {
            entity: "bean",
            entityId: bagId,
            action: "upsert",
            payload: bagPayload,
          },
          { entity: "bean", entityId: bagId, action: "delete" },
          { entity: "coffee", entityId: coffeeId, action: "delete" },
        ],
        "sync-cursor",
        4,
        [],
      );

      expect(await getCoffees(alice)).toEqual([]);
      expect(await getCoffeeBags(alice)).toEqual([]);
      expect(await getOwnerPreference(alice, "sync-cursor")).toBe("4");
    },
  );

  it("allows bag-first removal through single-operation replay", async () => {
    const coffeeId = "0198d3a4-1111-7000-8000-0000000000a6";
    const bagId = "0198d3a4-1111-7000-8000-0000000000a7";
    await applyRemoteOperation(alice, {
      entity: "coffee",
      entityId: coffeeId,
      action: "upsert",
      payload: coffee(coffeeId, "Single-operation Coffee"),
    });
    await applyRemoteOperation(alice, {
      entity: "bean",
      entityId: bagId,
      action: "upsert",
      payload: coffeeBag(bagId, coffeeId),
    });
    await applyRemoteOperation(alice, {
      entity: "bean",
      entityId: bagId,
      action: "delete",
    });
    await applyRemoteOperation(alice, {
      entity: "coffee",
      entityId: coffeeId,
      action: "delete",
    });

    expect(await getCoffees(alice)).toEqual([]);
    expect(await getCoffeeBags(alice)).toEqual([]);
  });

  it("scopes Coffee-delete dependencies to the replay owner", async () => {
    const coffeeId = "0198d3a4-1111-7000-8000-0000000000a4";
    const bagId = "0198d3a4-1111-7000-8000-0000000000a5";
    await applyRemotePage(
      bob,
      [
        {
          entity: "coffee",
          entityId: coffeeId,
          action: "upsert",
          payload: coffee(coffeeId, "Bob's Coffee"),
        },
        {
          entity: "bean",
          entityId: bagId,
          action: "upsert",
          payload: coffeeBag(bagId, coffeeId),
        },
      ],
      "sync-cursor",
      2,
      [],
    );
    await applyRemotePage(
      alice,
      [
        {
          entity: "coffee",
          entityId: coffeeId,
          action: "upsert",
          payload: coffee(coffeeId, "Alice's Coffee"),
        },
        { entity: "coffee", entityId: coffeeId, action: "delete" },
      ],
      "sync-cursor",
      2,
      [],
    );

    expect(await getCoffees(alice)).toEqual([]);
    expect(await getCoffeeBags(alice)).toEqual([]);
    expect(await getCoffees(bob)).toEqual([
      expect.objectContaining({ id: coffeeId, name: "Bob's Coffee" }),
    ]);
    expect(await getCoffeeBags(bob)).toEqual([
      expect.objectContaining({ id: bagId, coffeeId }),
    ]);
    expect(await getOwnerPreference(alice, "sync-cursor")).toBe("2");
    expect(await getOwnerPreference(bob, "sync-cursor")).toBe("2");
  });

  it("rejects a current bag whose Coffee belongs to another owner", async () => {
    const coffeeId = "0198d3a4-1111-7000-8000-00000000009d";
    const bagId = "0198d3a4-1111-7000-8000-00000000009e";
    await saveCoffeeWithBag(
      bob,
      coffee(coffeeId, "Bob's remote Coffee"),
      coffeeBag(coffeeId, coffeeId),
    );
    await setOwnerPreference(alice, "sync-cursor", "7");

    await expect(
      applyRemotePage(
        alice,
        [
          {
            entity: "bean",
            entityId: bagId,
            action: "upsert",
            payload: coffeeBag(bagId, coffeeId),
          },
        ],
        "sync-cursor",
        8,
        [],
      ),
    ).rejects.toThrow("Coffee does not exist for owner");

    expect(await getCoffeeBags(alice)).toEqual([]);
    expect(await getOwnerPreference(alice, "sync-cursor")).toBe("7");
  });

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

    expect((await getCoffees(alice))[0]?.name).toBe("Remote");
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

    expect(await getCoffees(alice)).toEqual([]);
    expect(await getMachines(alice)).toEqual([]);
    expect(await getOwnerPreference(alice, "sync-cursor")).toBe("4");
  });

  it("ignores a stale page without changing records or regressing the cursor", async () => {
    const beanId = "0198d3a4-1111-7000-8000-000000000088";
    await setOwnerPreference(alice, "sync-cursor", "8");
    await saveCoffeeFixture(alice, bean(beanId, "Local newer state"));
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

    expect((await getCoffees(alice))[0]?.name).toBe("Local newer state");
    expect(await getOwnerPreference(alice, "sync-cursor")).toBe("8");
  });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
  await Dexie.delete("dialed-local");
});

describe("owner-scoped persistence", () => {
  it("queries records only for the requested owner", async () => {
    await saveCoffeeFixture(
      alice,
      bean("0198d3a4-1111-7000-8000-000000000010", "Alice's coffee"),
    );
    await saveCoffeeFixture(
      bob,
      bean("0198d3a4-1111-7000-8000-000000000011", "Bob's coffee"),
    );

    expect((await getCoffees(alice)).map(({ name }) => name)).toEqual([
      "Alice's coffee",
    ]);
    expect((await getCoffees(bob)).map(({ name }) => name)).toEqual([
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

    await saveCoffeeFixture(alice, aliceBean);
    await saveMachine(alice, aliceMachine);
    await saveGrinder(alice, aliceGrinder);
    await saveBrew(alice, aliceBrew);
    await saveCoffeeFixture(bob, bobBean);
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
    expect(await getCoffees(alice)).toEqual([]);
    expect(await getCoffeeBags(alice)).toEqual([]);
    expect(await getMachines(alice)).toEqual([]);
    expect(await getGrinders(alice)).toEqual([]);
    expect(await getBrews(alice)).toEqual([]);
    expect(await getOperations(alice)).toEqual([]);
    expect(await getOwnerPreference(alice, "onboarded")).toBeUndefined();
    expect((await getCoffees(bob)).map(({ name }) => name)).toEqual([
      "Bob's coffee",
    ]);
    expect(await getMachines(bob)).toHaveLength(1);
    expect(await getGrinders(bob)).toHaveLength(1);
    expect(await getBrews(bob)).toHaveLength(1);
    expect(await getCoffees(bob)).toHaveLength(1);
    expect(await getCoffeeBags(bob)).toHaveLength(1);
    expect(await getOperations(bob)).toHaveLength(5);
    expect(await getOwnerPreference(bob, "onboarded")).toBe("true");
  });

  it("can refuse to clear an owner with pending operations", async () => {
    await saveCoffeeFixture(
      alice,
      bean("0198d3a4-1111-7000-8000-000000000040", "Unsynced coffee"),
    );

    expect(await clearOwnerData(alice)).toEqual({
      cleared: false,
      reason: "pending-operations",
      pendingCount: 2,
    });
    expect(await getCoffees(alice)).toHaveLength(1);
    expect(await getOperations(alice)).toHaveLength(2);
  });

  it("uses explicitly destructive paths only for anonymous reset and deleted accounts", async () => {
    await saveCoffeeFixture(
      ANONYMOUS_OWNER_ID,
      bean("0198d3a4-1111-7000-8000-000000000041", "Anonymous coffee"),
    );
    await saveCoffeeFixture(
      alice,
      bean("0198d3a4-1111-7000-8000-000000000042", "Deleted account coffee"),
    );
    await saveCoffeeFixture(
      bob,
      bean("0198d3a4-1111-7000-8000-000000000043", "Preserved coffee"),
    );

    expect(await discardAnonymousData()).toEqual({ cleared: true });
    expect(await getCoffees(ANONYMOUS_OWNER_ID)).toEqual([]);
    expect(await getCoffeeBags(ANONYMOUS_OWNER_ID)).toEqual([]);
    expect(await clearDeletedAccountData(alice)).toEqual({ cleared: true });
    expect(await getCoffees(alice)).toEqual([]);
    expect(await getCoffeeBags(alice)).toEqual([]);
    expect(await getOperations(alice)).toEqual([]);
    expect(await getCoffees(bob)).toHaveLength(1);
  });

  it("rejects every local write after an account is tombstoned", async () => {
    const beanId = "0198d3a4-1111-7000-8000-000000000044";
    const machineId = "0198d3a4-1111-7000-8000-000000000045";
    const grinderId = "0198d3a4-1111-7000-8000-000000000046";
    const brewId = "0198d3a4-1111-7000-8000-000000000047";
    await clearDeletedAccountData(alice);

    const writes = [
      () => saveCoffeeFixture(alice, bean(beanId, "Late bean")),
      () => saveMachine(alice, machine(machineId)),
      () => saveGrinder(alice, grinder(grinderId)),
      () => saveBrew(alice, brew(brewId, beanId)),
      () => updateBrew(alice, brewId, { yield: 40 }),
    ];
    for (const write of writes) {
      await expect(write()).rejects.toBeInstanceOf(DeletedOwnerWriteError);
    }

    expect(await getCoffees(alice)).toEqual([]);
    expect(await getMachines(alice)).toEqual([]);
    expect(await getGrinders(alice)).toEqual([]);
    expect(await getBrews(alice)).toEqual([]);
    expect(await getOperations(alice)).toEqual([]);
  });

  it("keeps anonymous data and a different account writable after deletion", async () => {
    await clearDeletedAccountData(alice);

    await saveCoffeeFixture(
      ANONYMOUS_OWNER_ID,
      bean("0198d3a4-1111-7000-8000-000000000048", "Anonymous after delete"),
    );
    await saveCoffeeFixture(
      bob,
      bean("0198d3a4-1111-7000-8000-000000000049", "New account"),
    );

    expect(await getCoffees(ANONYMOUS_OWNER_ID)).toHaveLength(1);
    expect(await getCoffees(bob)).toHaveLength(1);
    expect(await getOperations(ANONYMOUS_OWNER_ID)).toHaveLength(2);
    expect(await getOperations(bob)).toHaveLength(2);
  });

  it("freezes every anonymous write path during an active account transfer", async () => {
    const coffeeRecord = coffee(
      "0198d3a4-1111-7000-8000-000000000110",
      "Frozen coffee",
    );
    const bagRecord = coffeeBag(
      "0198d3a4-1111-7000-8000-000000000111",
      coffeeRecord.id,
    );
    const machineRecord = machine("0198d3a4-1111-7000-8000-000000000112");
    const grinderRecord = grinder("0198d3a4-1111-7000-8000-000000000113");
    const brewRecord = brew(
      "0198d3a4-1111-7000-8000-000000000114",
      bagRecord.id,
    );
    await db.coffees.add({ ...coffeeRecord, ownerId: ANONYMOUS_OWNER_ID });
    await db.bags.add({ ...bagRecord, ownerId: ANONYMOUS_OWNER_ID });
    await db.brews.add({ ...brewRecord, ownerId: ANONYMOUS_OWNER_ID });
    await setOwnerPreference(
      ANONYMOUS_OWNER_ID,
      "anonymous-transfer-source",
      alice,
    );

    const writes = [
      () => saveCoffeeWithBag(ANONYMOUS_OWNER_ID, coffeeRecord, bagRecord),
      () => saveCoffeeBag(ANONYMOUS_OWNER_ID, bagRecord),
      () => saveMachine(ANONYMOUS_OWNER_ID, machineRecord),
      () => saveGrinder(ANONYMOUS_OWNER_ID, grinderRecord),
      () => saveBrew(ANONYMOUS_OWNER_ID, brewRecord),
      () => updateBrew(ANONYMOUS_OWNER_ID, brewRecord.id, { yield: 40 }),
      () => deleteBrew(ANONYMOUS_OWNER_ID, brewRecord.id),
    ];

    for (const write of writes) {
      await expect(write()).rejects.toBeInstanceOf(
        OwnerTransferInProgressError,
      );
    }

    await saveMachine(bob, machineRecord);
    expect(await getMachines(bob)).toEqual([
      expect.objectContaining({ id: machineRecord.id }),
    ]);
  });

  it.each([
    [
      "destructive discard",
      async (_brewId: string, _operationId: string) => discardAnonymousData(),
    ],
    [
      "owner preference writes",
      async (_brewId: string, _operationId: string) =>
        setOwnerPreference(ANONYMOUS_OWNER_ID, "late-preference", "blocked"),
    ],
    [
      "operation removal",
      async (_brewId: string, operationId: string) =>
        removeOperations(ANONYMOUS_OWNER_ID, [operationId]),
    ],
    [
      "brew sync-state mutation",
      async (brewId: string, _operationId: string) =>
        markBrewSynced(ANONYMOUS_OWNER_ID, brewId),
    ],
    [
      "operation acknowledgement",
      async (_brewId: string, operationId: string) =>
        acknowledgeOperations(ANONYMOUS_OWNER_ID, [operationId]),
    ],
  ])(
    "freezes anonymous %s through the source-marker guard",
    async (_name, mutate) => {
      const brewId = "0198d3a4-1111-7000-8000-000000000115";
      const operationId = "0198d3a4-1111-7000-8000-000000000116";
      await db.brews.add({
        ...brew(brewId, "0198d3a4-1111-7000-8000-000000000117"),
        ownerId: ANONYMOUS_OWNER_ID,
      });
      await db.operations.add({
        ownerId: ANONYMOUS_OWNER_ID,
        operationId,
        entity: "brew",
        entityId: brewId,
        action: "upsert",
        payload: {
          ...brew(brewId, "0198d3a4-1111-7000-8000-000000000117"),
        },
        createdAt: "2026-08-23T12:00:00.000Z",
      });
      await db.preferences.put({
        key: ownerPreferenceKey(
          ANONYMOUS_OWNER_ID,
          "anonymous-transfer-source",
        ),
        value: alice,
      });

      await expect(mutate(brewId, operationId)).rejects.toBeInstanceOf(
        OwnerTransferInProgressError,
      );

      expect(await getBrews(ANONYMOUS_OWNER_ID)).toEqual([
        expect.objectContaining({ id: brewId, syncState: "local" }),
      ]);
      expect(
        (await getOperations(ANONYMOUS_OWNER_ID)).map(
          (operation) => operation.operationId,
        ),
      ).toEqual([operationId]);
      expect(
        await getOwnerPreference(
          ANONYMOUS_OWNER_ID,
          "anonymous-transfer-source",
        ),
      ).toBe(alice);
      expect(
        await getOwnerPreference(ANONYMOUS_OWNER_ID, "late-preference"),
      ).toBeUndefined();
    },
  );

  it("does not let a stale cache reset remove a deleted-owner tombstone", async () => {
    await clearDeletedAccountData(alice);

    await expect(clearOwnerData(alice)).rejects.toBeInstanceOf(
      DeletedOwnerWriteError,
    );
    await expect(
      saveCoffeeFixture(
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

    expect(await getCoffees(alice)).toEqual([]);
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
    const secondOperation = (await getOperations(alice)).find(
      (candidate) => candidate.operationId !== firstOperation.operationId,
    )!;

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
    await saveCoffeeFixture(alice, bean(beanId, "Local edit"));

    await applyRemoteOperation(alice, {
      entity: "bean",
      entityId: beanId,
      action: "upsert",
      payload: bean(beanId, "Older remote value"),
    });
    expect((await getCoffees(alice))[0]?.name).toBe("Local edit");

    await applyRemoteOperation(alice, {
      entity: "bean",
      entityId: beanId,
      action: "delete",
    });
    expect((await getCoffees(alice))[0]?.name).toBe("Local edit");
  });

  it("replays a newer remote value and delete when only the pushed snapshot is pending", async () => {
    const beanId = "0198d3a4-1111-7000-8000-000000000075";
    await saveCoffeeFixture(alice, bean(beanId, "Pushed local value"));
    const pushedOperationIds = (await getOperations(alice)).map(
      ({ operationId }) => operationId,
    );

    await applyRemoteOperation(
      alice,
      {
        entity: "bean",
        entityId: beanId,
        action: "upsert",
        payload: bean(beanId, "Newer remote value"),
      },
      pushedOperationIds,
    );
    expect((await getCoffees(alice))[0]?.name).toBe("Newer remote value");

    await applyRemoteOperation(
      alice,
      { entity: "bean", entityId: beanId, action: "delete" },
      pushedOperationIds,
    );
    expect(await getCoffees(alice)).toEqual([]);
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

    expect(await getCoffees(ANONYMOUS_OWNER_ID)).toEqual([
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
