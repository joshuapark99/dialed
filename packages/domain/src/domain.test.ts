import { describe, expect, it } from "vitest";

import {
  BeanSchema,
  CoffeeBagSchema,
  CoffeeSchema,
  EspressoBrewSchema,
  GrinderProfileSchema,
  MachineProfileSchema,
  calculateBrewMetrics,
  compareBrews,
  recommendNextAdjustment,
  selectComparisonBrew,
  type EspressoBrew,
} from "./index.js";

const ids = {
  user: "018f0c7a-83f7-7def-8f74-4f31aa767099",
  bean: "018f0c7a-83f7-7def-8f74-4f31aa767100",
  bag: "018f0c7a-83f7-7def-8f74-4f31aa767106",
  machine: "018f0c7a-83f7-7def-8f74-4f31aa767101",
  grinder: "018f0c7a-83f7-7def-8f74-4f31aa767102",
  brew: "018f0c7a-83f7-7def-8f74-4f31aa767103",
  reference: "018f0c7a-83f7-7def-8f74-4f31aa767104",
  other: "018f0c7a-83f7-7def-8f74-4f31aa767105",
} as const;

const timestamp = "2026-08-22T12:00:00.000Z";

const validCoffee = {
  id: ids.bean,
  userId: null,
  name: "Hualalai Kona",
  roaster: "Coffee Purveyors",
  originCountry: "United States",
  originRegion: "Kona",
  producer: "Hualalai Estate",
  process: "Washed",
  varietal: "Typica",
  elevationMeters: 700,
  roastLevel: "medium-light",
  notes: "Seasonal release",
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: null,
};

const validBag = {
  id: ids.bag,
  userId: null,
  coffeeId: ids.bean,
  roastedOn: "2026-08-12",
  purchasedOn: "2026-08-14",
  openedOn: "2026-08-18",
  startingWeightGrams: 340,
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: null,
};

const machine = MachineProfileSchema.parse({
  id: ids.machine,
  userId: ids.user,
  createdAt: timestamp,
  updatedAt: timestamp,
  name: "Gaggia Classic Pro E24",
  capabilities: {
    temperatureControl: "none",
    adjustablePressure: false,
    preInfusion: false,
  },
});

const grinder = GrinderProfileSchema.parse({
  id: ids.grinder,
  userId: ids.user,
  createdAt: timestamp,
  updatedAt: timestamp,
  name: "Opus",
  calibration: { stepSize: 0.1, direction: "lower-is-finer", minimum: 0 },
});

function brew(
  overrides: Partial<EspressoBrew["espresso"]> = {},
  taste = true,
): EspressoBrew {
  return EspressoBrewSchema.parse({
    id: ids.brew,
    userId: ids.user,
    createdAt: timestamp,
    updatedAt: timestamp,
    method: "espresso",
    beanId: ids.bean,
    machineId: ids.machine,
    grinderId: ids.grinder,
    brewedAt: timestamp,
    espresso: {
      doseGrams: 18,
      yieldGrams: 37,
      durationSeconds: 25,
      grindSetting: { display: "0.8", numericValue: 0.8 },
      observations: [],
      ...overrides,
    },
    ...(taste
      ? {
          taste: {
            acidity: 4,
            bitterness: 2,
            strength: 3,
            body: 3,
            enjoyment: 3,
          },
        }
      : {}),
  });
}

describe("schemas", () => {
  it("defaults sync fields and validates entities strictly", () => {
    const bean = BeanSchema.parse({
      id: ids.bean,
      userId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      name: "Kona Hualalai",
    });

    expect(bean.deletedAt).toBeNull();
    expect(bean.roastLevel).toBe("unknown");
    expect(() => BeanSchema.parse({ ...bean, unexpected: true })).toThrow();
    expect(() =>
      BeanSchema.parse({ ...bean, id: "018f0c7a-83f7-4def-8f74-4f31aa767100" }),
    ).toThrow("UUIDv7");
  });

  it("validates reusable coffee details and a physical bag", () => {
    expect(CoffeeSchema.parse(validCoffee)).toMatchObject({
      name: "Hualalai Kona",
      elevationMeters: 700,
    });

    expect(CoffeeBagSchema.parse(validBag)).toMatchObject({
      coffeeId: ids.bean,
      startingWeightGrams: 340,
    });
  });

  it.each([0, -1, 9001])("rejects invalid coffee elevation %s", (value) => {
    expect(() =>
      CoffeeSchema.parse({ ...validCoffee, elevationMeters: value }),
    ).toThrow();
  });

  it.each([0, -1])("rejects invalid starting bag weight %s", (value) => {
    expect(() =>
      CoffeeBagSchema.parse({ ...validBag, startingWeightGrams: value }),
    ).toThrow();
  });
});

describe("calculateBrewMetrics", () => {
  it("calculates ratio and average flow without rounding", () => {
    expect(
      calculateBrewMetrics({
        doseGrams: 18,
        yieldGrams: 37,
        durationSeconds: 25,
      }),
    ).toEqual({
      ratio: 37 / 18,
      averageFlowGramsPerSecond: 37 / 25,
    });
  });

  it("accepts a complete espresso details object", () => {
    expect(calculateBrewMetrics(brew().espresso).ratio).toBe(37 / 18);
  });

  it("rejects zero measurements", () => {
    expect(() =>
      calculateBrewMetrics({
        doseGrams: 0,
        yieldGrams: 37,
        durationSeconds: 25,
      }),
    ).toThrow();
  });
});

describe("brew comparisons", () => {
  it("selects the newest brew with matching bean and equipment", () => {
    const older = {
      ...brew(),
      id: ids.reference,
      brewedAt: "2026-08-20T12:00:00.000Z",
    };
    const newer = {
      ...brew(),
      id: ids.other,
      brewedAt: "2026-08-21T12:00:00.000Z",
    };
    const wrongBean = {
      ...newer,
      id: "018f0c7a-83f7-7def-8f74-4f31aa767106",
      beanId: ids.other,
    };

    expect(selectComparisonBrew(brew(), [older, wrongBean, newer])?.id).toBe(
      ids.other,
    );
  });

  it("honors an explicit valid reference override", () => {
    const selected = selectComparisonBrew(
      brew(),
      [
        { ...brew(), id: ids.reference, brewedAt: "2026-08-20T12:00:00.000Z" },
        { ...brew(), id: ids.other, brewedAt: "2026-08-21T12:00:00.000Z" },
      ],
      { referenceBrewId: ids.reference },
    );

    expect(selected?.id).toBe(ids.reference);
  });

  it("returns metric and taste deltas", () => {
    const reference = {
      ...brew({ yieldGrams: 36, durationSeconds: 24 }),
      id: ids.reference,
      taste: { acidity: 4, bitterness: 2, strength: 3, body: 3, enjoyment: 2 },
    };
    const comparison = compareBrews(brew(), reference);

    expect(comparison.yieldGrams.delta).toBe(1);
    expect(comparison.durationSeconds.delta).toBe(1);
    expect(comparison.enjoyment?.delta).toBe(1);
    expect(comparison.grind.numericDelta).toBe(0);
  });
});

describe("recommendNextAdjustment", () => {
  it("gives puck preparation precedence over taste and flow", () => {
    const recommendation = recommendNextAdjustment({
      brew: brew({ durationSeconds: 15, observations: ["channeling"] }),
      machine,
      grinder,
    });

    expect(recommendation.kind).toBe("adjustment");
    if (recommendation.kind === "adjustment") {
      expect(recommendation.adjustment.variable).toBe("puck-preparation");
    }
  });

  it("recommends a calibrated finer grind for a very fast shot", () => {
    const recommendation = recommendNextAdjustment({
      brew: brew({ durationSeconds: 16 }),
      machine,
      grinder,
    });

    expect(recommendation.kind).toBe("adjustment");
    if (recommendation.kind === "adjustment") {
      expect(recommendation.adjustment).toMatchObject({
        variable: "grind",
        direction: "finer",
        targetValue: 0.7,
      });
    }
  });

  it("extends yield for a sour shot with a short ratio", () => {
    const recommendation = recommendNextAdjustment({
      brew: brew(),
      machine,
      grinder,
    });

    expect(recommendation.kind).toBe("adjustment");
    if (recommendation.kind === "adjustment") {
      expect(recommendation.adjustment).toMatchObject({
        variable: "yield",
        direction: "increase",
        targetValue: 40.6,
      });
    }
  });

  it("does not recommend unsupported temperature control", () => {
    const recommendation = recommendNextAdjustment({
      brew: brew({ yieldGrams: 45, temperatureCelsius: 93 }),
      machine,
      grinder,
    });

    expect(recommendation.kind).toBe("adjustment");
    if (recommendation.kind === "adjustment") {
      expect(recommendation.adjustment.variable).toBe("grind");
      expect(recommendation.adjustment.variable).not.toBe("temperature");
    }
  });

  it("uses temperature when it is controllable and a sour shot already has a long ratio", () => {
    const controllableMachine = {
      ...machine,
      capabilities: {
        ...machine.capabilities,
        temperatureControl: "precise" as const,
      },
    };
    const recommendation = recommendNextAdjustment({
      brew: brew({ yieldGrams: 45, temperatureCelsius: 93 }),
      machine: controllableMachine,
      grinder,
    });

    expect(recommendation.kind).toBe("adjustment");
    if (recommendation.kind === "adjustment") {
      expect(recommendation.adjustment).toMatchObject({
        variable: "temperature",
        direction: "increase",
        targetValue: 94,
      });
    }
  });

  it("reverses a yield change that reduced enjoyment", () => {
    const reference = {
      ...brew({ yieldGrams: 37 }),
      id: ids.reference,
      taste: { acidity: 4, bitterness: 2, strength: 3, body: 3, enjoyment: 4 },
    };
    const current = brew({ yieldGrams: 41 });
    const recommendation = recommendNextAdjustment({
      brew: current,
      machine,
      grinder,
      referenceBrew: reference,
    });

    expect(recommendation.kind).toBe("adjustment");
    if (recommendation.kind === "adjustment") {
      expect(recommendation.adjustment).toMatchObject({
        variable: "yield",
        direction: "decrease",
        targetValue: 37,
      });
      expect(recommendation.comparisonBrewId).toBe(ids.reference);
    }
  });

  it("holds an enjoyable balanced recipe", () => {
    const balanced = {
      ...brew(),
      taste: { acidity: 2, bitterness: 2, strength: 3, body: 4, enjoyment: 5 },
    };
    expect(
      recommendNextAdjustment({ brew: balanced, machine, grinder }).kind,
    ).toBe("hold");
  });

  it("requests taste data instead of inventing advice", () => {
    expect(
      recommendNextAdjustment({ brew: brew({}, false), machine, grinder }).kind,
    ).toBe("collect-more-data");
  });

  it("is deterministic and always returns at most one adjustment", () => {
    const input = { brew: brew(), machine, grinder };
    const first = recommendNextAdjustment(input);
    const second = recommendNextAdjustment(input);

    expect(first).toEqual(second);
    if (first.kind === "adjustment") {
      expect(Object.keys(first.adjustment)).not.toContain("adjustments");
    }
  });
});
