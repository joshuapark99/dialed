import "fake-indexeddb/auto";

import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRemoteOperation,
  db,
  saveBean,
  saveCoffeeWithBag,
} from "./db";
import type { Bean, Brew, Coffee, CoffeeBag, Grinder, Machine } from "./models";
import { parseRemotePayload } from "./sync-payloads";
import { syncEntityFixtures } from "../../../test-fixtures/sync-entities";

const alice = "account:alice";
const bob = "account:bob";

const ids = {
  bean: "0198d3a4-1111-7000-8000-000000000110",
  machine: "0198d3a4-1111-7000-8000-000000000111",
  grinder: "0198d3a4-1111-7000-8000-000000000112",
  brew: "0198d3a4-1111-7000-8000-000000000113",
  envelope: "0198d3a4-1111-7000-8000-000000000114",
  coffee: "0198d3a4-1111-7000-8000-000000000116",
  bag: "0198d3a4-1111-7000-8000-000000000117",
  secondBag: "0198d3a4-1111-7000-8000-000000000118",
} as const;

const createdAt = "2026-08-22T12:00:00.000Z";

function legacyBean(id: string = ids.bean): Bean {
  return {
    id,
    name: "Hualalai Kona",
    roaster: "Coffee Purveyors",
    origin: "Kona, Hawaii",
    roastLevel: "medium",
    createdAt,
  };
}

function coffee(id: string = ids.coffee): Coffee {
  return {
    id,
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
    createdAt,
  };
}

function bag(
  id: string = ids.bag,
  coffeeId: string = ids.coffee,
): CoffeeBag {
  return {
    id,
    coffeeId,
    roastedOn: "2026-08-15",
    purchasedOn: "2026-08-18",
    openedOn: "2026-08-22",
    startingWeightGrams: 340,
    notes: "First bag",
    createdAt,
  };
}

function machine(): Machine {
  return {
    id: ids.machine,
    name: "Gaggia Classic Pro E24",
    temperatureControl: "none",
    hasPressureControl: false,
    hasPreinfusion: false,
    createdAt,
  };
}

function grinder(): Grinder {
  return {
    id: ids.grinder,
    name: "Opus 2",
    finerDirection: "lower",
    createdAt,
  };
}

function brew(): Brew {
  return {
    id: ids.brew,
    beanId: ids.bean,
    machineId: ids.machine,
    grinderId: ids.grinder,
    dose: 18,
    yield: 37,
    duration: 25,
    grind: "0.8",
    temperature: 93,
    pressure: 9,
    preinfusion: 0,
    basket: "18 g IMS",
    puckPrep: "WDT and level tamp",
    observation: "even",
    notes: "Slightly bright",
    taste: {
      acidity: 4,
      bitterness: 2,
      strength: 3,
      body: 3,
      enjoyment: 4,
    },
    ratio: 37 / 18,
    flow: 37 / 25,
    comparisonBrewId: "0198d3a4-1111-7000-8000-000000000115",
    recommendation: {
      variable: "yield",
      direction: "increase",
      target: 41,
      headline: "Pull a little longer",
      rationale: "The shot is sour at a short ratio.",
      expectedEffect: "Increase extraction and soften acidity.",
      confidence: "medium",
      ruleVersion: "espresso-v1",
    },
    dialedAt: "2026-08-22T12:01:00.000Z",
    createdAt,
    updatedAt: "2026-08-22T12:01:00.000Z",
    syncState: "pending",
  };
}

beforeEach(async () => {
  db.close();
  await Dexie.delete("dialed-local");
  await db.open();
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await Dexie.delete("dialed-local");
});

describe("parseRemotePayload", () => {
  it.each(Object.entries(syncEntityFixtures))(
    "accepts the shared valid %s contract fixture",
    (entity, payload) => {
      const parsed = parseRemotePayload(entity, payload);
      expect(parsed).toMatchObject(
        entity === "bean"
          ? {
              kind: "legacy-bean",
              coffee: { id: payload.id },
              bag: { id: payload.id, coffeeId: payload.id },
            }
          : { id: payload.id },
      );
    },
  );

  it.each([
    ["machine", machine()],
    ["grinder", grinder()],
    ["brew", brew()],
  ] as const)("parses a valid %s payload", (entity, payload) => {
    expect(parseRemotePayload(entity, payload)).toMatchObject({
      id: payload.id,
    });
  });

  it("parses current Coffee and bag payloads and normalizes a legacy bean", () => {
    expect(parseRemotePayload("coffee", coffee())).toEqual(coffee());
    expect(parseRemotePayload("bean", bag())).toEqual(bag());
    expect(parseRemotePayload("bean", legacyBean())).toMatchObject({
      kind: "legacy-bean",
      coffee: expect.objectContaining({ id: ids.bean }),
      bag: expect.objectContaining({ id: ids.bean, coffeeId: ids.bean }),
    });
  });

  it("rejects missing and malformed required fields", () => {
    const { name: _name, ...missingName } = legacyBean();
    expect(() => parseRemotePayload("bean", missingName)).toThrow();
    expect(() =>
      parseRemotePayload("bean", {
        ...legacyBean(),
        id: "not-a-valid-id",
      }),
    ).toThrow("UUIDv7");
    expect(() =>
      parseRemotePayload("machine", {
        ...machine(),
        temperatureControl: "thermostat",
      }),
    ).toThrow();
    expect(() =>
      parseRemotePayload("brew", {
        ...brew(),
        dose: Number.NaN,
      }),
    ).toThrow();
    expect(() =>
      parseRemotePayload("brew", {
        ...brew(),
        taste: { ...brew().taste, enjoyment: 6 },
      }),
    ).toThrow();
    expect(() =>
      parseRemotePayload("brew", {
        ...brew(),
        recommendation: { ...brew().recommendation, confidence: "certain" },
      }),
    ).toThrow();
    expect(() =>
      parseRemotePayload("grinder", {
        ...grinder(),
        createdAt: "yesterday",
      }),
    ).toThrow();
  });

  it.each(["taste", "recommendation", "unknown"])(
    "rejects unsupported entity kind %s",
    (entity) => {
      expect(() => parseRemotePayload(entity, brew())).toThrow(
        "Unsupported sync entity",
      );
    },
  );
});

describe("applyRemoteOperation", () => {
  it("replays current Coffee and bag upserts into their own tables", async () => {
    await applyRemoteOperation(alice, {
      entity: "coffee",
      entityId: ids.coffee,
      action: "upsert",
      payload: coffee(),
    });
    await applyRemoteOperation(alice, {
      entity: "bean",
      entityId: ids.bag,
      action: "upsert",
      payload: bag(),
    });

    expect(await db.coffees.get([alice, ids.coffee])).toEqual({
      ...coffee(),
      ownerId: alice,
    });
    expect(await db.bags.get([alice, ids.bag])).toEqual({
      ...bag(),
      ownerId: alice,
    });
  });

  it("replays a legacy bean upsert into one Coffee and one bag idempotently", async () => {
    const remote = {
      entity: "bean",
      entityId: ids.bean,
      action: "upsert" as const,
      payload: legacyBean(),
    };

    await applyRemoteOperation(alice, remote);
    await applyRemoteOperation(alice, remote);

    expect(await db.coffees.where("ownerId").equals(alice).toArray()).toEqual([
      expect.objectContaining({ id: ids.bean, name: legacyBean().name }),
    ]);
    expect(await db.bags.where("ownerId").equals(alice).toArray()).toEqual([
      expect.objectContaining({ id: ids.bean, coffeeId: ids.bean }),
    ]);
  });

  it("replays an already normalized legacy pull payload", async () => {
    const normalized = parseRemotePayload("bean", legacyBean());

    await applyRemoteOperation(alice, {
      entity: "bean",
      entityId: ids.bean,
      action: "upsert",
      payload: normalized,
    });

    expect(await db.coffees.get([alice, ids.bean])).toMatchObject({
      id: ids.bean,
    });
    expect(await db.bags.get([alice, ids.bean])).toMatchObject({
      id: ids.bean,
      coffeeId: ids.bean,
    });
  });

  it("rejects a normalized legacy payload under a non-bean entity envelope", async () => {
    const normalized = parseRemotePayload("bean", legacyBean());

    await expect(
      applyRemoteOperation(alice, {
        entity: "coffee",
        entityId: ids.bean,
        action: "upsert",
        payload: normalized,
      }),
    ).rejects.toThrow();

    expect(await db.coffees.get([alice, ids.bean])).toBeUndefined();
    expect(await db.bags.get([alice, ids.bean])).toBeUndefined();
  });

  it("applies only the Coffee from a legacy bean when the bag has pending work", async () => {
    const localCoffee = { ...coffee(ids.bean), name: "Local current Coffee" };
    const localBag = {
      ...bag(ids.bean, ids.bean),
      notes: "Local current bag",
    };
    await saveCoffeeWithBag(alice, localCoffee, localBag);
    const coffeeOperation = await db.operations
      .where("ownerId")
      .equals(alice)
      .filter((pending) => pending.entity === "coffee")
      .first();

    await applyRemoteOperation(
      alice,
      {
        entity: "bean",
        entityId: ids.bean,
        action: "upsert",
        payload: legacyBean(),
      },
      [coffeeOperation!.operationId],
    );

    expect(await db.coffees.get([alice, ids.bean])).toMatchObject({
      name: legacyBean().name,
      originCountry: legacyBean().origin,
    });
    expect(await db.bags.get([alice, ids.bean])).toMatchObject({
      notes: "Local current bag",
    });
  });

  it("applies only the bag from a legacy bean when the Coffee has pending work", async () => {
    const localCoffee = { ...coffee(ids.bean), name: "Local current Coffee" };
    const localBag = {
      ...bag(ids.bean, ids.bean),
      notes: "Local current bag",
    };
    await saveCoffeeWithBag(alice, localCoffee, localBag);
    const bagOperation = await db.operations
      .where("ownerId")
      .equals(alice)
      .filter((pending) => pending.entity === "bean")
      .first();

    await applyRemoteOperation(
      alice,
      {
        entity: "bean",
        entityId: ids.bean,
        action: "upsert",
        payload: legacyBean(),
      },
      [bagOperation!.operationId],
    );

    expect(await db.coffees.get([alice, ids.bean])).toMatchObject({
      name: "Local current Coffee",
    });
    expect(await db.bags.get([alice, ids.bean])).toEqual({
      id: ids.bean,
      coffeeId: ids.bean,
      createdAt,
      ownerId: alice,
    });
  });

  it.each([
    ["current bag", { ...bag(), startingWeightGrams: 0 }],
    ["legacy bean", { ...legacyBean(), name: "" }],
  ] as const)("does not write a malformed %s payload", async (_label, payload) => {
    await expect(
      applyRemoteOperation(alice, {
        entity: "bean",
        entityId: payload.id,
        action: "upsert",
        payload,
      }),
    ).rejects.toThrow();

    expect(await db.coffees.where("ownerId").equals(alice).count()).toBe(0);
    expect(await db.bags.where("ownerId").equals(alice).count()).toBe(0);
  });

  it("deletes a legacy pair when no other bag references its Coffee", async () => {
    await applyRemoteOperation(alice, {
      entity: "bean",
      entityId: ids.bean,
      action: "upsert",
      payload: legacyBean(),
    });

    await applyRemoteOperation(alice, {
      entity: "bean",
      entityId: ids.bean,
      action: "delete",
    });

    expect(await db.coffees.get([alice, ids.bean])).toBeUndefined();
    expect(await db.bags.get([alice, ids.bean])).toBeUndefined();
  });

  it("keeps a legacy Coffee on delete while another bag references it", async () => {
    await applyRemoteOperation(alice, {
      entity: "bean",
      entityId: ids.bean,
      action: "upsert",
      payload: legacyBean(),
    });
    await applyRemoteOperation(alice, {
      entity: "bean",
      entityId: ids.secondBag,
      action: "upsert",
      payload: bag(ids.secondBag, ids.bean),
    });

    await applyRemoteOperation(alice, {
      entity: "bean",
      entityId: ids.bean,
      action: "delete",
    });

    expect(await db.coffees.get([alice, ids.bean])).toMatchObject({
      id: ids.bean,
    });
    expect(await db.bags.get([alice, ids.bean])).toBeUndefined();
    expect(await db.bags.get([alice, ids.secondBag])).toMatchObject({
      coffeeId: ids.bean,
    });
  });

  it("ignores supplied owner and stamps remote brews as synced", async () => {
    await applyRemoteOperation(alice, {
      entity: "brew",
      entityId: ids.brew,
      action: "upsert",
      payload: {
        ...brew(),
        ownerId: bob,
        syncState: "pending",
      },
    });

    expect(await db.brews.get([alice, ids.brew])).toMatchObject({
      ownerId: alice,
      syncState: "synced",
    });
  });

  it("rejects an envelope and payload ID mismatch before writing either ID", async () => {
    await expect(
      applyRemoteOperation(alice, {
        entity: "bean",
        entityId: ids.envelope,
        action: "upsert",
        payload: legacyBean(ids.bean),
      }),
    ).rejects.toThrow("does not match envelope");

    expect(await db.beans.get([alice, ids.envelope])).toBeUndefined();
    expect(await db.beans.get([alice, ids.bean])).toBeUndefined();
  });

  it("rejects malformed upserts before opening a write transaction", async () => {
    const transaction = vi.spyOn(db, "transaction");

    await expect(
      applyRemoteOperation(alice, {
        entity: "bean",
        entityId: ids.bean,
        action: "upsert",
        payload: { ...legacyBean(), roastLevel: "charcoal" },
      }),
    ).rejects.toThrow();

    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not delete another owner's entity with the same ID", async () => {
    await saveBean(bob, legacyBean());

    await applyRemoteOperation(alice, {
      entity: "bean",
      entityId: ids.bean,
      action: "delete",
    });

    expect(await db.beans.get([bob, ids.bean])).toMatchObject({
      id: ids.bean,
      ownerId: bob,
    });
  });

  it("rejects unsupported remote entities instead of routing them to brews", async () => {
    await expect(
      applyRemoteOperation(alice, {
        entity: "taste",
        entityId: ids.brew,
        action: "upsert",
        payload: brew(),
      }),
    ).rejects.toThrow("Unsupported sync entity");

    expect(await db.brews.get([alice, ids.brew])).toBeUndefined();
  });
});
