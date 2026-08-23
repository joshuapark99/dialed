import "fake-indexeddb/auto";

import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyRemoteOperation, db, saveBean } from "./db";
import type { Bean, Brew, Grinder, Machine } from "./models";
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
} as const;

const createdAt = "2026-08-22T12:00:00.000Z";

function bean(id = ids.bean): Bean {
  return {
    id,
    name: "Hualalai Kona",
    roaster: "Coffee Purveyors",
    origin: "Kona, Hawaii",
    roastLevel: "medium",
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
      expect(parseRemotePayload(entity, payload)).toMatchObject({
        id: payload.id,
      });
    },
  );

  it.each([
    ["bean", bean()],
    ["machine", machine()],
    ["grinder", grinder()],
    ["brew", brew()],
  ] as const)("parses a valid %s payload", (entity, payload) => {
    expect(parseRemotePayload(entity, payload)).toMatchObject({
      id: payload.id,
    });
  });

  it("rejects missing and malformed required fields", () => {
    const { name: _name, ...missingName } = bean();
    expect(() => parseRemotePayload("bean", missingName)).toThrow();
    expect(() =>
      parseRemotePayload("bean", { ...bean(), id: "not-a-valid-id" }),
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
        payload: bean(ids.bean),
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
        payload: { ...bean(), roastLevel: "charcoal" },
      }),
    ).rejects.toThrow();

    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not delete another owner's entity with the same ID", async () => {
    await saveBean(bob, bean());

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
