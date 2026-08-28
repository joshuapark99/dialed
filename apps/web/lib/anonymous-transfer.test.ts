import "fake-indexeddb/auto";

import Dexie from "dexie";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANONYMOUS_OWNER_ID,
  acknowledgeOperations,
  db,
  discardAnonymousData,
  getBrews,
  getCoffeeBags,
  getCoffees,
  getGrinders,
  getMachines,
  getOperations,
  getOwnerPreference,
  ownerPreferenceKey,
  removeOperations,
  setOwnerPreference,
} from "./db";
import type { Brew, Coffee, CoffeeBag, Grinder, Machine } from "./models";
import {
  ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
  AnonymousTransferConflictError,
  type AnonymousTransferJournal,
  AnonymousTransferValidationError,
  completeAnonymousTransfer,
  deferAnonymousTransfer,
  getAnonymousTransferOffer,
  getAnonymousTransferSummary,
  stageAnonymousTransfer,
  validateAnonymousTransferGraph,
} from "./anonymous-transfer";

const createdAt = "2026-08-23T12:00:00.000Z";
const coffeeId = "0198d3a4-1111-7000-8000-000000000001";
const bagId = "0198d3a4-1111-7000-8000-000000000002";
const machineId = "0198d3a4-1111-7000-8000-000000000003";
const grinderId = "0198d3a4-1111-7000-8000-000000000004";
const inconsistentStateMessage =
  "Anonymous transfer state is inconsistent; local data was preserved";

function coffee(): Coffee {
  return {
    id: coffeeId,
    name: "Hualalai Kona",
    roaster: "Coffee Purveyors",
    roastLevel: "medium",
    createdAt,
  };
}

function bag(referencedCoffeeId = coffeeId): CoffeeBag {
  return { id: bagId, coffeeId: referencedCoffeeId, createdAt };
}

function machine(): Machine {
  return {
    id: machineId,
    name: "Linea Mini",
    temperatureControl: "precise",
    hasPressureControl: false,
    hasPreinfusion: true,
    createdAt,
  };
}

function grinder(): Grinder {
  return {
    id: grinderId,
    name: "P64",
    finerDirection: "lower",
    createdAt,
  };
}

function brew(
  id: string,
  dependencies: Partial<Pick<Brew, "beanId" | "machineId" | "grinderId">> = {},
): Brew {
  return {
    id,
    beanId: bagId,
    machineId,
    grinderId,
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
      headline: "Hold steady",
      rationale: "Balanced shot",
      expectedEffect: "Confirm consistency",
      confidence: "high",
      ruleVersion: "espresso-v1",
    },
    createdAt,
    updatedAt: createdAt,
    syncState: "local",
    ...dependencies,
  };
}

async function addValidAnonymousGraph(): Promise<void> {
  await db.coffees.add({ ...coffee(), ownerId: ANONYMOUS_OWNER_ID });
  await db.bags.add({ ...bag(), ownerId: ANONYMOUS_OWNER_ID });
  await db.machines.add({ ...machine(), ownerId: ANONYMOUS_OWNER_ID });
  await db.grinders.add({ ...grinder(), ownerId: ANONYMOUS_OWNER_ID });
  await db.brews.bulkAdd([
    {
      ...brew("0198d3a4-1111-7000-8000-000000000005"),
      ownerId: ANONYMOUS_OWNER_ID,
    },
    {
      ...brew("0198d3a4-1111-7000-8000-000000000006"),
      ownerId: ANONYMOUS_OWNER_ID,
    },
  ]);
}

async function getJournal(
  ownerId: string,
): Promise<AnonymousTransferJournal | undefined> {
  const value = await getOwnerPreference(ownerId, "anonymous-transfer-journal");
  return value === undefined
    ? undefined
    : (JSON.parse(value) as AnonymousTransferJournal);
}

function validJournal(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    destinationOwnerId: "account:alice",
    phase: "staged",
    operationIds: ["operation-1"],
    acknowledgedOperationIds: ["operation-1"],
    startedAt: "2026-08-23T12:00:00.000Z",
    ...overrides,
  };
}

async function putRawTransferState(
  journal: string | Record<string, unknown>,
  sourceDestinationOwnerId: string | null = "account:alice",
): Promise<void> {
  await db.preferences.put({
    key: ownerPreferenceKey("account:alice", "anonymous-transfer-journal"),
    value: typeof journal === "string" ? journal : JSON.stringify(journal),
  });
  if (sourceDestinationOwnerId !== null) {
    await db.preferences.put({
      key: ownerPreferenceKey(
        ANONYMOUS_OWNER_ID,
        ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
      ),
      value: sourceDestinationOwnerId,
    });
  }
}

beforeEach(async () => {
  db.close();
  await Dexie.delete("dialed-local");
  await db.open();
});

describe("anonymous transfer discovery", () => {
  it("summarizes a complete anonymous graph", async () => {
    await addValidAnonymousGraph();

    expect(await getAnonymousTransferSummary()).toEqual({
      coffees: 1,
      bags: 1,
      machines: 1,
      grinders: 1,
      brews: 2,
      hasData: true,
    });
  });

  it("reports no transferable data for an empty anonymous partition", async () => {
    expect(await getAnonymousTransferSummary()).toEqual({
      coffees: 0,
      bags: 0,
      machines: 0,
      grinders: 0,
      brews: 0,
      hasData: false,
    });
  });

  it("rejects a bag whose Coffee is missing", async () => {
    await db.bags.add({
      ...bag("0198d3a4-1111-7000-8000-000000000007"),
      ownerId: ANONYMOUS_OWNER_ID,
    });

    await expect(validateAnonymousTransferGraph()).rejects.toMatchObject({
      entity: "coffee",
      entityId: "0198d3a4-1111-7000-8000-000000000007",
    } satisfies Partial<AnonymousTransferValidationError>);
  });

  it.each([
    ["bag", { beanId: "0198d3a4-1111-7000-8000-000000000008" }],
    ["machine", { machineId: "0198d3a4-1111-7000-8000-000000000009" }],
    ["grinder", { grinderId: "0198d3a4-1111-7000-8000-000000000010" }],
  ] as const)(
    "rejects a brew whose %s is missing",
    async (entity, dependencies) => {
      await addValidAnonymousGraph();
      await db.brews.delete([
        ANONYMOUS_OWNER_ID,
        "0198d3a4-1111-7000-8000-000000000006",
      ]);
      await db.brews.put({
        ...brew("0198d3a4-1111-7000-8000-000000000006", dependencies),
        ownerId: ANONYMOUS_OWNER_ID,
      });

      const error = await validateAnonymousTransferGraph().catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(AnonymousTransferValidationError);
      expect(error).toMatchObject({
        entity,
        entityId: Object.values(dependencies)[0],
      });
    },
  );

  it("returns a frozen validated snapshot for staging", async () => {
    await addValidAnonymousGraph();

    const snapshot = await validateAnonymousTransferGraph();

    expect(snapshot.coffees).toHaveLength(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.coffees)).toBe(true);
    expect(Object.isFrozen(snapshot.coffees[0])).toBe(true);
    expect(Object.isFrozen(snapshot.brews[0]?.taste)).toBe(true);
  });

  it("captures only the transferable onboarding preference in the snapshot", async () => {
    await addValidAnonymousGraph();
    await setOwnerPreference(ANONYMOUS_OWNER_ID, "onboarded", "true");
    await setOwnerPreference(ANONYMOUS_OWNER_ID, "unrelated", "keep-local");

    const snapshot = await validateAnonymousTransferGraph();

    expect(snapshot.onboardedPreference).toBe("true");
    expect(snapshot).not.toHaveProperty("preferences");
  });

  it("can hand a coherent validated snapshot to a destination staging transaction", async () => {
    await addValidAnonymousGraph();
    let snapshot: Awaited<ReturnType<typeof validateAnonymousTransferGraph>>;

    await db.transaction(
      "rw",
      [
        db.coffees,
        db.bags,
        db.machines,
        db.grinders,
        db.brews,
        db.preferences,
        db.operations,
      ],
      async () => {
        snapshot = await validateAnonymousTransferGraph();
      },
    );

    expect(snapshot!).toMatchObject({
      coffees: [{ id: coffeeId }],
      bags: [{ id: bagId }],
      machines: [{ id: machineId }],
      grinders: [{ id: grinderId }],
    });
  });

  it.each([
    [
      "coffee",
      () => db.coffees.update([ANONYMOUS_OWNER_ID, coffeeId], { name: "" }),
      coffeeId,
    ],
    [
      "bag",
      () =>
        db.bags.update([ANONYMOUS_OWNER_ID, bagId], {
          roastedOn: "not-a-date",
        }),
      bagId,
    ],
    [
      "machine",
      () =>
        db.machines.update([ANONYMOUS_OWNER_ID, machineId], {
          temperatureControl: "broken" as never,
        }),
      machineId,
    ],
    [
      "grinder",
      () =>
        db.grinders.update([ANONYMOUS_OWNER_ID, grinderId], {
          finerDirection: "sideways" as never,
        }),
      grinderId,
    ],
    [
      "brew",
      () =>
        db.brews.update(
          [ANONYMOUS_OWNER_ID, "0198d3a4-1111-7000-8000-000000000005"],
          { dose: 0 },
        ),
      "0198d3a4-1111-7000-8000-000000000005",
    ],
  ] as const)(
    "rejects a malformed %s before graph validation",
    async (entity, corrupt, entityId) => {
      await addValidAnonymousGraph();
      await corrupt();

      await expect(validateAnonymousTransferGraph()).rejects.toMatchObject({
        entity,
        entityId,
      } satisfies Partial<AnonymousTransferValidationError>);
    },
  );

  it("does not offer an empty, dismissed, or differently journaled source", async () => {
    expect(await getAnonymousTransferOffer("account:alice")).toBeNull();

    await addValidAnonymousGraph();
    await db.preferences.put({
      key: ownerPreferenceKey("account:alice", "anonymous-transfer-dismissed"),
      value: "true",
    });
    expect(await getAnonymousTransferOffer("account:alice")).toBeNull();

    await db.preferences.delete(
      ownerPreferenceKey("account:alice", "anonymous-transfer-dismissed"),
    );

    await db.preferences.put({
      key: ownerPreferenceKey(
        ANONYMOUS_OWNER_ID,
        ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
      ),
      value: "account:bob",
    });
    expect(await getAnonymousTransferOffer("account:alice")).toBeNull();
  });

  it("offers the entity-data summary without mutating either owner", async () => {
    await addValidAnonymousGraph();

    await expect(getAnonymousTransferOffer("account:alice")).resolves.toEqual({
      coffees: 1,
      bags: 1,
      machines: 1,
      grinders: 1,
      brews: 2,
      hasData: true,
    });
    expect(await db.preferences.toArray()).toEqual([]);
  });
});

describe("anonymous transfer staging", () => {
  it("rejects a changed source summary before conflict checks or any staging write", async () => {
    await addValidAnonymousGraph();
    const conflictingCoffee = {
      ...coffee(),
      ownerId: "account:alice",
      name: "Conflicting destination coffee",
    };
    await db.coffees.add(conflictingCoffee);
    const expectedSummary = {
      coffees: 1,
      bags: 1,
      machines: 1,
      grinders: 1,
      brews: 1,
      hasData: true,
    };
    const destinationBefore = {
      coffees: await getCoffees("account:alice"),
      bags: await getCoffeeBags("account:alice"),
      machines: await getMachines("account:alice"),
      grinders: await getGrinders("account:alice"),
      brews: await getBrews("account:alice"),
      operations: await getOperations("account:alice"),
      preferences: await db.preferences.toArray(),
    };

    const error = await stageAnonymousTransfer(
      "account:alice",
      expectedSummary,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "AnonymousTransferSummaryChangedError",
      currentSummary: {
        coffees: 1,
        bags: 1,
        machines: 1,
        grinders: 1,
        brews: 2,
        hasData: true,
      },
    });
    expect(await getCoffees("account:alice")).toEqual(
      destinationBefore.coffees,
    );
    expect(await getCoffeeBags("account:alice")).toEqual(
      destinationBefore.bags,
    );
    expect(await getMachines("account:alice")).toEqual(
      destinationBefore.machines,
    );
    expect(await getGrinders("account:alice")).toEqual(
      destinationBefore.grinders,
    );
    expect(await getBrews("account:alice")).toEqual(destinationBefore.brews);
    expect(await getOperations("account:alice")).toEqual(
      destinationBefore.operations,
    );
    expect(await db.preferences.toArray()).toEqual(
      destinationBefore.preferences,
    );
    expect(await getJournal("account:alice")).toBeUndefined();
  });

  it("atomically stages the complete graph in dependency order and preserves unrelated destination data", async () => {
    await addValidAnonymousGraph();
    await setOwnerPreference(ANONYMOUS_OWNER_ID, "onboarded", "true");
    const unrelatedMachine = {
      ...machine(),
      id: "0198d3a4-1111-7000-8000-000000000020",
      name: "Alice's existing machine",
      ownerId: "account:alice",
    };
    await db.machines.add(unrelatedMachine);

    const journal = await stageAnonymousTransfer("account:alice");

    expect((await getCoffees("account:alice"))[0]?.id).toBe(coffeeId);
    expect((await getCoffeeBags("account:alice"))[0]).toMatchObject({
      id: bagId,
      coffeeId,
    });
    expect((await getBrews("account:alice"))[0]?.beanId).toBe(bagId);
    expect(await getMachines("account:alice")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: machineId }),
        expect.objectContaining({ id: unrelatedMachine.id }),
      ]),
    );
    expect((await getGrinders("account:alice"))[0]?.id).toBe(grinderId);
    expect(journal.operationIds).toHaveLength(6);
    expect(journal.acknowledgedOperationIds).toEqual([]);
    const operations = await getOperations("account:alice");
    expect(operations.map(({ operationId }) => operationId)).toEqual(
      journal.operationIds,
    );
    expect(operations.map(({ entity }) => entity)).toEqual([
      "coffee",
      "bean",
      "machine",
      "grinder",
      "brew",
      "brew",
    ]);
    expect(operations.every(({ payload }) => !("ownerId" in payload!))).toBe(
      true,
    );
    expect(
      operations
        .filter(({ entity }) => entity === "brew")
        .every(({ payload }) => payload?.syncState === "pending"),
    ).toBe(true);
    expect(
      (await getBrews("account:alice")).every(
        ({ syncState }) => syncState === "pending",
      ),
    ).toBe(true);
    expect(await getOwnerPreference("account:alice", "onboarded")).toBe("true");
    expect(
      await getOwnerPreference(
        ANONYMOUS_OWNER_ID,
        ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
      ),
    ).toBe("account:alice");
    expect(await getAnonymousTransferSummary()).toMatchObject({
      hasData: true,
    });
  });

  it("uses the validated transaction snapshot to copy the onboarding preference", async () => {
    await addValidAnonymousGraph();
    await setOwnerPreference(ANONYMOUS_OWNER_ID, "onboarded", "true");
    const onboardedKey = ownerPreferenceKey(ANONYMOUS_OWNER_ID, "onboarded");
    const preferenceGet = vi.spyOn(db.preferences, "get");

    await stageAnonymousTransfer("account:alice");

    expect(
      preferenceGet.mock.calls.filter(([key]) => String(key) === onboardedKey),
    ).toHaveLength(1);
    expect(await getOwnerPreference("account:alice", "onboarded")).toBe("true");
  });

  it("skips same-ID semantically identical records including synced brews", async () => {
    await addValidAnonymousGraph();
    await db.coffees.add({ ...coffee(), ownerId: "account:alice" });
    await db.bags.update([ANONYMOUS_OWNER_ID, bagId], {
      legacyPairedCoffee: true,
    });
    await db.bags.add({
      ...bag(),
      legacyPairedCoffee: true,
      ownerId: "account:alice",
    });
    await db.machines.add({ ...machine(), ownerId: "account:alice" });
    await db.grinders.add({ ...grinder(), ownerId: "account:alice" });
    const sourceBrews = await getBrews(ANONYMOUS_OWNER_ID);
    await db.brews.bulkAdd(
      sourceBrews.map(({ ownerId: _ownerId, ...record }) => ({
        ...record,
        ownerId: "account:alice",
        syncState: "synced" as const,
      })),
    );

    const journal = await stageAnonymousTransfer("account:alice");

    expect(journal.operationIds).toEqual([]);
    expect(await getOperations("account:alice")).toEqual([]);
    expect(await getCoffeeBags("account:alice")).toEqual([
      expect.objectContaining({ legacyPairedCoffee: true }),
    ]);
  });

  it("treats legacyPairedCoffee as semantic content and writes nothing on conflict", async () => {
    await addValidAnonymousGraph();
    await db.bags.update([ANONYMOUS_OWNER_ID, bagId], {
      legacyPairedCoffee: true,
    });
    await db.bags.add({ ...bag(), ownerId: "account:alice" });

    await expect(stageAnonymousTransfer("account:alice")).rejects.toMatchObject(
      {
        entity: "bean",
        entityId: bagId,
      } satisfies Partial<AnonymousTransferConflictError>,
    );

    expect(await getCoffees("account:alice")).toEqual([]);
    expect(await getOperations("account:alice")).toEqual([]);
    expect(await getJournal("account:alice")).toBeUndefined();
    expect(
      await getOwnerPreference(
        ANONYMOUS_OWNER_ID,
        ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
      ),
    ).toBeUndefined();
  });

  it("preserves legacyPairedCoffee in the copied bag and queued payload", async () => {
    await addValidAnonymousGraph();
    await db.bags.update([ANONYMOUS_OWNER_ID, bagId], {
      legacyPairedCoffee: true,
    });

    await stageAnonymousTransfer("account:alice");

    expect((await getCoffeeBags("account:alice"))[0]).toMatchObject({
      id: bagId,
      legacyPairedCoffee: true,
    });
    expect(
      (await getOperations("account:alice")).find(
        ({ entity, entityId }) => entity === "bean" && entityId === bagId,
      )?.payload,
    ).toMatchObject({ legacyPairedCoffee: true });
  });

  it("rolls back every destination write and marker when operation insertion fails", async () => {
    await addValidAnonymousGraph();
    vi.spyOn(db.operations, "add").mockRejectedValueOnce(
      new Error("queue unavailable"),
    );

    await expect(stageAnonymousTransfer("account:alice")).rejects.toThrow(
      "queue unavailable",
    );

    expect(await getCoffees("account:alice")).toEqual([]);
    expect(await getCoffeeBags("account:alice")).toEqual([]);
    expect(await getMachines("account:alice")).toEqual([]);
    expect(await getGrinders("account:alice")).toEqual([]);
    expect(await getBrews("account:alice")).toEqual([]);
    expect(await getOperations("account:alice")).toEqual([]);
    expect(await getJournal("account:alice")).toBeUndefined();
    expect(
      await getOwnerPreference(
        ANONYMOUS_OWNER_ID,
        ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
      ),
    ).toBeUndefined();
  });

  it("reuses one journal and operation set across retries and concurrent calls", async () => {
    await addValidAnonymousGraph();

    const [first, concurrent] = await Promise.all([
      stageAnonymousTransfer("account:alice"),
      stageAnonymousTransfer("account:alice"),
    ]);
    const retry = await stageAnonymousTransfer("account:alice");

    expect(concurrent).toEqual(first);
    expect(retry).toEqual(first);
    expect(await getOperations("account:alice")).toHaveLength(6);
  });

  it("reuses a valid existing journal even when a retry expectation is stale", async () => {
    await addValidAnonymousGraph();
    const journal = await stageAnonymousTransfer("account:alice", {
      coffees: 1,
      bags: 1,
      machines: 1,
      grinders: 1,
      brews: 2,
      hasData: true,
    });
    const operations = await getOperations("account:alice");

    const retry = await stageAnonymousTransfer("account:alice", {
      coffees: 0,
      bags: 0,
      machines: 0,
      grinders: 0,
      brews: 0,
      hasData: false,
    });

    expect(retry).toEqual(journal);
    expect(await getOperations("account:alice")).toEqual(operations);
    expect(await getJournal("account:alice")).toEqual(journal);
  });

  it("rejects anonymous as a destination and isolates an active transfer to its owner", async () => {
    await addValidAnonymousGraph();

    await expect(stageAnonymousTransfer(ANONYMOUS_OWNER_ID)).rejects.toThrow(
      "Anonymous data cannot be transferred to anonymous",
    );
    await stageAnonymousTransfer("account:alice");
    await expect(stageAnonymousTransfer("account:bob")).rejects.toThrow(
      "Anonymous transfer is already staged for account:alice",
    );

    expect(await getCoffees("account:bob")).toEqual([]);
    expect(await getOperations("account:bob")).toEqual([]);
    expect(await getJournal("account:bob")).toBeUndefined();
  });
});

describe("anonymous transfer acknowledgement and cleanup", () => {
  it("records acknowledgement evidence before removing a transfer operation", async () => {
    await addValidAnonymousGraph();
    const journal = await stageAnonymousTransfer("account:alice");
    const operationId = journal.operationIds[0]!;
    const realBulkDelete = db.operations.bulkDelete.bind(db.operations);
    let journalAtDeletion: AnonymousTransferJournal | undefined;
    vi.spyOn(db.operations, "bulkDelete").mockImplementationOnce(((
      keys: Parameters<typeof realBulkDelete>[0],
    ) =>
      getJournal("account:alice").then((storedJournal) => {
        journalAtDeletion = storedJournal;
        return realBulkDelete(keys);
      })) as never);

    await acknowledgeOperations("account:alice", [operationId]);

    expect(journalAtDeletion?.acknowledgedOperationIds).toContain(operationId);
    expect(
      (await getJournal("account:alice"))?.acknowledgedOperationIds,
    ).toEqual([operationId]);
    expect(
      (await getOperations("account:alice")).some(
        (operation) => operation.operationId === operationId,
      ),
    ).toBe(false);
  });

  it("rolls back acknowledgement evidence when operation removal fails", async () => {
    await addValidAnonymousGraph();
    const journal = await stageAnonymousTransfer("account:alice");
    const operationId = journal.operationIds[0]!;
    vi.spyOn(db.operations, "bulkDelete").mockRejectedValueOnce(
      new Error("operation removal failed"),
    );

    await expect(
      acknowledgeOperations("account:alice", [operationId]),
    ).rejects.toThrow("operation removal failed");

    expect(
      (await getJournal("account:alice"))?.acknowledgedOperationIds,
    ).toEqual([]);
    expect(
      (await getOperations("account:alice")).map(
        (operation) => operation.operationId,
      ),
    ).toContain(operationId);
  });

  it("keeps ordinary destination acknowledgement writable during another account's transfer", async () => {
    await addValidAnonymousGraph();
    await stageAnonymousTransfer("account:alice");
    const bobOperationId = "0198d3a4-1111-7000-8000-000000000040";
    await db.operations.add({
      ownerId: "account:bob",
      operationId: bobOperationId,
      entity: "machine",
      entityId: machineId,
      action: "upsert",
      payload: { ...machine() },
      createdAt,
    });

    await acknowledgeOperations("account:bob", [bobOperationId]);

    expect(await getOperations("account:bob")).toEqual([]);
    expect(await getAnonymousTransferSummary()).toMatchObject({
      hasData: true,
    });
  });

  it("refuses cleanup without explicit acknowledgement evidence even if operations were removed", async () => {
    await addValidAnonymousGraph();
    const journal = await stageAnonymousTransfer("account:alice");
    await removeOperations("account:alice", journal.operationIds);

    await expect(completeAnonymousTransfer("account:alice")).resolves.toEqual({
      completed: false,
      pendingCount: journal.operationIds.length,
    });
    expect(await getAnonymousTransferSummary()).toMatchObject({
      hasData: true,
    });
    expect(await getJournal("account:alice")).toEqual(journal);
  });

  it("preserves persisted journal operations across generic removal and still completes cleanup", async () => {
    await addValidAnonymousGraph();
    const journal = await stageAnonymousTransfer("account:alice");
    const unrelatedOperationId = "0198d3a4-1111-7000-8000-000000000041";
    await db.operations.add({
      ownerId: "account:alice",
      operationId: unrelatedOperationId,
      entity: "machine",
      entityId: unrelatedOperationId,
      action: "delete",
      createdAt: new Date(Date.parse(journal.startedAt) + 100).toISOString(),
    });
    db.close();
    await db.open();

    await removeOperations("account:alice", [
      ...journal.operationIds,
      unrelatedOperationId,
    ]);
    db.close();
    await db.open();

    expect(
      (await getOperations("account:alice")).map(
        ({ operationId }) => operationId,
      ),
    ).toEqual(journal.operationIds);
    expect(await getJournal("account:alice")).toEqual(journal);

    await acknowledgeOperations("account:alice", journal.operationIds);
    await expect(completeAnonymousTransfer("account:alice")).resolves.toEqual({
      completed: true,
      pendingCount: 0,
    });

    expect(await getOperations("account:alice")).toEqual([]);
    expect(await getJournal("account:alice")).toBeUndefined();
    expect(await getAnonymousTransferSummary()).toMatchObject({
      hasData: false,
    });
    expect(await getCoffees("account:alice")).toHaveLength(1);
    expect(await getCoffeeBags("account:alice")).toHaveLength(1);
    expect(await getMachines("account:alice")).toHaveLength(1);
    expect(await getGrinders("account:alice")).toHaveLength(1);
    expect(await getBrews("account:alice")).toHaveLength(2);
  });

  it("cleans only anonymous data and transfer markers after every operation is acknowledged", async () => {
    await addValidAnonymousGraph();
    await setOwnerPreference(ANONYMOUS_OWNER_ID, "onboarded", "true");
    await setOwnerPreference(ANONYMOUS_OWNER_ID, "unrelated", "local-only");
    await setOwnerPreference(
      "account:alice",
      "anonymous-transfer-dismissed",
      "true",
    );
    await setOwnerPreference("account:alice", "keep", "destination-only");
    await db.machines.add({
      ...machine(),
      id: "0198d3a4-1111-7000-8000-000000000030",
      ownerId: "account:bob",
    });
    const journal = await stageAnonymousTransfer("account:alice");

    await acknowledgeOperations("account:alice", journal.operationIds);
    await expect(completeAnonymousTransfer("account:alice")).resolves.toEqual({
      completed: true,
      pendingCount: 0,
    });

    expect(await getAnonymousTransferSummary()).toEqual({
      coffees: 0,
      bags: 0,
      machines: 0,
      grinders: 0,
      brews: 0,
      hasData: false,
    });
    expect(await getOperations(ANONYMOUS_OWNER_ID)).toEqual([]);
    expect(await getJournal("account:alice")).toBeUndefined();
    expect(
      await getOwnerPreference("account:alice", "anonymous-transfer-dismissed"),
    ).toBeUndefined();
    expect(await getOwnerPreference("account:alice", "keep")).toBe(
      "destination-only",
    );
    expect(await getCoffees("account:alice")).toHaveLength(1);
    expect(await getMachines("account:bob")).toHaveLength(1);
  });

  it("fails closed when an acknowledged journal loses its source binding before new anonymous data appears", async () => {
    await addValidAnonymousGraph();
    const journal = await stageAnonymousTransfer("account:alice");
    await acknowledgeOperations("account:alice", journal.operationIds);
    await db.preferences.delete(
      ownerPreferenceKey(
        ANONYMOUS_OWNER_ID,
        ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
      ),
    );
    await Promise.all([
      db.coffees.where("ownerId").equals(ANONYMOUS_OWNER_ID).delete(),
      db.bags.where("ownerId").equals(ANONYMOUS_OWNER_ID).delete(),
      db.machines.where("ownerId").equals(ANONYMOUS_OWNER_ID).delete(),
      db.grinders.where("ownerId").equals(ANONYMOUS_OWNER_ID).delete(),
      db.brews.where("ownerId").equals(ANONYMOUS_OWNER_ID).delete(),
    ]);
    const newAnonymousMachine = {
      ...machine(),
      id: "0198d3a4-1111-7000-8000-000000000041",
      name: "Created after stale transfer",
      ownerId: ANONYMOUS_OWNER_ID,
    };
    await db.machines.add(newAnonymousMachine);

    await expect(completeAnonymousTransfer("account:alice")).rejects.toThrow(
      inconsistentStateMessage,
    );

    expect(await getMachines(ANONYMOUS_OWNER_ID)).toEqual([
      newAnonymousMachine,
    ]);
    expect(await getJournal("account:alice")).toMatchObject({
      acknowledgedOperationIds: journal.operationIds,
    });
  });

  it("prevents destructive anonymous discard during an acknowledged transfer", async () => {
    await addValidAnonymousGraph();
    const journal = await stageAnonymousTransfer("account:alice");
    await acknowledgeOperations("account:alice", journal.operationIds);

    await expect(discardAnonymousData()).rejects.toThrow(
      "Anonymous data is being transferred to account:alice",
    );

    expect(await getAnonymousTransferSummary()).toMatchObject({
      hasData: true,
    });
    expect(
      await getOwnerPreference(
        ANONYMOUS_OWNER_ID,
        ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
      ),
    ).toBe("account:alice");
  });

  it.each([
    ["invalid JSON", "{"],
    ["wrong version", validJournal({ version: 2 })],
    ["wrong phase", validJournal({ phase: "completed" })],
    [
      "destination namespace mismatch",
      validJournal({ destinationOwnerId: "account:bob" }),
    ],
    ["empty operation ID", validJournal({ operationIds: [""] })],
    [
      "non-string operation ID",
      validJournal({ operationIds: [1], acknowledgedOperationIds: [1] }),
    ],
    [
      "duplicate operation IDs",
      validJournal({
        operationIds: ["operation-1", "operation-1"],
        acknowledgedOperationIds: ["operation-1"],
      }),
    ],
    [
      "duplicate acknowledgements",
      validJournal({
        acknowledgedOperationIds: ["operation-1", "operation-1"],
      }),
    ],
    [
      "acknowledgement outside the operation set",
      validJournal({ acknowledgedOperationIds: ["operation-2"] }),
    ],
    ["invalid start time", validJournal({ startedAt: "not-a-time" })],
    ["unexpected journal fields", { ...validJournal(), extra: true }],
  ])("fails closed for a journal with %s", async (_case, rawJournal) => {
    await addValidAnonymousGraph();
    await putRawTransferState(rawJournal);

    await expect(completeAnonymousTransfer("account:alice")).rejects.toThrow(
      inconsistentStateMessage,
    );

    expect(await getAnonymousTransferSummary()).toMatchObject({
      hasData: true,
    });
    expect(
      await getOwnerPreference("account:alice", "anonymous-transfer-journal"),
    ).toBeDefined();
  });

  it.each([
    ["missing", null],
    ["bound to another destination", "account:bob"],
  ])("fails closed when the source marker is %s", async (_case, marker) => {
    await addValidAnonymousGraph();
    await putRawTransferState(validJournal(), marker);

    await expect(completeAnonymousTransfer("account:alice")).rejects.toThrow(
      inconsistentStateMessage,
    );

    expect(await getAnonymousTransferSummary()).toMatchObject({
      hasData: true,
    });
  });

  it("uses the strict journal boundary before staging reuses existing state", async () => {
    await addValidAnonymousGraph();
    await putRawTransferState(validJournal({ operationIds: [""] }));

    await expect(stageAnonymousTransfer("account:alice")).rejects.toThrow(
      inconsistentStateMessage,
    );

    expect(await getOperations("account:alice")).toEqual([]);
  });

  it("uses the strict journal boundary before acknowledgement removes operations", async () => {
    await addValidAnonymousGraph();
    const journal = await stageAnonymousTransfer("account:alice");
    await db.preferences.put({
      key: ownerPreferenceKey("account:alice", "anonymous-transfer-journal"),
      value: "{",
    });

    await expect(
      acknowledgeOperations("account:alice", [journal.operationIds[0]!]),
    ).rejects.toThrow(inconsistentStateMessage);

    expect(
      (await getOperations("account:alice")).map(
        ({ operationId }) => operationId,
      ),
    ).toContain(journal.operationIds[0]);
  });

  it("defers only before staging and leaves transfer data unchanged", async () => {
    await addValidAnonymousGraph();

    await deferAnonymousTransfer("account:alice");
    expect(
      await getOwnerPreference("account:alice", "anonymous-transfer-dismissed"),
    ).toBe("true");
    expect(await getAnonymousTransferSummary()).toMatchObject({
      hasData: true,
    });

    await stageAnonymousTransfer("account:alice");
    await expect(deferAnonymousTransfer("account:alice")).rejects.toThrow(
      "Anonymous transfer is already active for account:alice",
    );
  });

  it("rejects anonymous and cross-destination defer while the global source marker is active", async () => {
    await addValidAnonymousGraph();

    await expect(completeAnonymousTransfer(ANONYMOUS_OWNER_ID)).rejects.toThrow(
      "Anonymous data cannot be transferred to anonymous",
    );
    await expect(deferAnonymousTransfer(ANONYMOUS_OWNER_ID)).rejects.toThrow(
      "Anonymous data cannot be transferred to anonymous",
    );
    const stage = stageAnonymousTransfer("account:alice");
    const defer = deferAnonymousTransfer("account:bob");
    await expect(stage).resolves.toMatchObject({
      destinationOwnerId: "account:alice",
    });
    await expect(defer).rejects.toThrow(
      "Anonymous transfer is already active for account:alice",
    );
    expect(
      await getOwnerPreference("account:bob", "anonymous-transfer-dismissed"),
    ).toBeUndefined();
  });

  it("uses the strict journal boundary before defer accepts orphaned state", async () => {
    await addValidAnonymousGraph();
    await putRawTransferState(validJournal(), null);

    await expect(deferAnonymousTransfer("account:alice")).rejects.toThrow(
      inconsistentStateMessage,
    );

    expect(
      await getOwnerPreference("account:alice", "anonymous-transfer-dismissed"),
    ).toBeUndefined();
  });
});
