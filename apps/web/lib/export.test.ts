import { describe, expect, it } from "vitest";
import type { Brew, Coffee, CoffeeBag, Grinder, Machine } from "./models";
import { buildBrewCsv, buildJsonExport } from "./export";

const coffees: Coffee[] = [
  {
    id: "coffee-1",
    name: 'Halo "Red"',
    roaster: 'North, "Star"',
    roastLevel: "light",
    createdAt: "2026-08-01T10:00:00.000Z",
  },
];

const bags: CoffeeBag[] = [
  {
    id: "bag-1",
    coffeeId: "coffee-1",
    roastedOn: "2026-07-29",
    createdAt: "2026-08-01T10:00:00.000Z",
  },
  {
    id: "bag-2",
    coffeeId: "coffee-1",
    createdAt: "2026-08-10T10:00:00.000Z",
  },
];

const machines: Machine[] = [
  {
    id: "machine-1",
    name: "Linea Mini",
    temperatureControl: "precise",
    hasPressureControl: false,
    hasPreinfusion: true,
    createdAt: "2026-08-01T10:00:00.000Z",
  },
];

const grinders: Grinder[] = [
  {
    id: "grinder-1",
    name: "P64",
    finerDirection: "lower",
    createdAt: "2026-08-01T10:00:00.000Z",
  },
];

function brew(id: string, beanId: string, grind: string): Brew {
  return {
    id,
    beanId,
    machineId: "machine-1",
    grinderId: "grinder-1",
    dose: 18,
    yield: 36,
    duration: 28,
    grind,
    taste: {
      acidity: 3,
      bitterness: 3,
      strength: 3,
      body: 3,
      enjoyment: 4,
    },
    ratio: 2,
    flow: 36 / 28,
    recommendation: {
      variable: "hold",
      direction: "hold",
      headline: "Hold steady",
      rationale: "The shot is balanced.",
      expectedEffect: "Keep the current balance.",
      confidence: "high",
      ruleVersion: "web-1",
    },
    dialedAt: "2026-08-14T10:01:00.000Z",
    createdAt: "2026-08-14T10:00:00.000Z",
    updatedAt: "2026-08-14T10:01:00.000Z",
    syncState: "synced",
  };
}

const brews = [brew("brew-1", "bag-1", '4, "fine"')];

describe("buildJsonExport", () => {
  it("serializes the owner-scoped Coffee and bag collections separately", () => {
    expect(
      JSON.parse(buildJsonExport({ coffees, bags, machines, grinders, brews })),
    ).toEqual({ coffees, bags, machines, grinders, brews });
  });
});

describe("buildBrewCsv", () => {
  it("emits stable Coffee and bag-aware columns with CSV escaping", () => {
    const lines = buildBrewCsv({ coffees, bags, brews }).split("\n");

    expect(lines[0]).toBe(
      '"date","coffee","roaster","roast_date","dose_g","yield_g","duration_s","grind","ratio","enjoyment","dialed"',
    );
    expect(lines[1]).toBe(
      '"2026-08-14T10:00:00.000Z","Halo ""Red""","North, ""Star""","2026-07-29","18","36","28","4, ""fine""","2","4","true"',
    );
  });

  it("exports an empty roast date when the selected bag has none", () => {
    const missingRoastDate = brew("brew-2", "bag-2", "5");

    expect(
      buildBrewCsv({ coffees, bags, brews: [missingRoastDate] }).split("\n")[1],
    ).toBe(
      '"2026-08-14T10:00:00.000Z","Halo ""Red""","North, ""Star""","","18","36","28","5","2","4","true"',
    );
  });
});
