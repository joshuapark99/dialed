import "fake-indexeddb/auto";

import Dexie from "dexie";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ANONYMOUS_OWNER_ID,
  db,
  ownerPreferenceKey,
  setOwnerPreference,
} from "./db";
import type { Brew, Coffee, CoffeeBag, Grinder, Machine } from "./models";
import {
  ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
  AnonymousTransferValidationError,
  getAnonymousTransferOffer,
  getAnonymousTransferSummary,
  validateAnonymousTransferGraph,
} from "./anonymous-transfer";

const createdAt = "2026-08-23T12:00:00.000Z";
const coffeeId = "0198d3a4-1111-7000-8000-000000000001";
const bagId = "0198d3a4-1111-7000-8000-000000000002";
const machineId = "0198d3a4-1111-7000-8000-000000000003";
const grinderId = "0198d3a4-1111-7000-8000-000000000004";

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
