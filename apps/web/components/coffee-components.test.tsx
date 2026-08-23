import "fake-indexeddb/auto";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import {
  db,
  getCoffeeBags,
  getCoffees,
  getGrinders,
  getMachines,
  getOwnerPreference,
} from "../lib/db";
import type { Coffee, CoffeeBag } from "../lib/models";
import { CoffeeDialog } from "./coffee-dialog";
import { CoffeeLibrary } from "./coffee-library";
import { Onboarding, saveOnboardingSetup } from "./onboarding";

const coffees: Coffee[] = [
  {
    id: "0198d3a4-1111-7000-8000-000000000040",
    name: "Hualalai Kona",
    roaster: "Coffee Purveyors",
    roastLevel: "medium",
    createdAt: "2026-08-10T12:00:00.000Z",
  },
  {
    id: "0198d3a4-1111-7000-8000-000000000050",
    name: "Suke Quto",
    roaster: "Tim Wendelboe",
    roastLevel: "light",
    createdAt: "2026-08-11T12:00:00.000Z",
  },
];

const bags: CoffeeBag[] = [
  {
    id: "0198d3a4-1111-7000-8000-000000000041",
    coffeeId: coffees[0].id,
    roastedOn: "2026-08-01",
    createdAt: "2026-08-12T12:00:00.000Z",
  },
  {
    id: "0198d3a4-1111-7000-8000-000000000042",
    coffeeId: coffees[0].id,
    roastedOn: "2026-08-12",
    createdAt: "2026-08-20T12:00:00.000Z",
  },
  {
    id: "0198d3a4-1111-7000-8000-000000000051",
    coffeeId: coffees[1].id,
    createdAt: "2026-08-13T12:00:00.000Z",
  },
];

describe("CoffeeDialog", () => {
  it("renders coffee details and first-bag fields with invalid submission disabled", () => {
    const markup = renderToStaticMarkup(
      <CoffeeDialog mode="coffee" ownerId="anonymous" onClose={() => {}} />,
    );

    expect(markup).toContain("Coffee details");
    expect(markup).toContain("First bag");
    expect(markup).toContain('name="originCountry"');
    expect(markup).toContain('name="startingWeightGrams"');
    expect(markup).toContain('role="alert"');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Save coffee/);
  });

  it("renders only bag fields and the selected coffee in bag mode", () => {
    const markup = renderToStaticMarkup(
      <CoffeeDialog
        mode="bag"
        ownerId="anonymous"
        coffee={coffees[0]}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain("Add Another Bag");
    expect(markup).toContain("Hualalai Kona");
    expect(markup).toContain('name="roastedOn"');
    expect(markup).not.toContain('name="originCountry"');
  });
});

describe("CoffeeLibrary", () => {
  it("groups bags under coffees and orders each group newest-created first", () => {
    const markup = renderToStaticMarkup(
      <CoffeeLibrary ownerId="anonymous" coffees={coffees} bags={bags} />,
    );

    expect(markup).toContain("Add Coffee");
    expect(markup.match(/Add Another Bag/g)).toHaveLength(2);
    expect(markup.indexOf("Hualalai Kona")).toBeLessThan(
      markup.indexOf("Suke Quto"),
    );
    expect(markup.indexOf("Roasted Aug 12, 2026")).toBeLessThan(
      markup.indexOf("Roasted Aug 1, 2026"),
    );
    expect(markup).toContain("Roast date not set");
  });
});

describe("Onboarding", () => {
  beforeEach(async () => {
    db.close();
    await db.delete();
    await db.open();
  });

  it("offers an optional roast date in the compact coffee step", () => {
    Object.assign(globalThis, { React });
    const markup = renderToStaticMarkup(<Onboarding ownerId="anonymous" />);

    expect(markup).toContain('name="roastedOn"');
    expect(markup).toContain('type="date"');
  });

  it("creates the Coffee and first bag atomically during setup", async () => {
    const ownerId = "onboarding-test";

    await saveOnboardingSetup(ownerId, {
      coffeeName: "  Hualalai Kona  ",
      roaster: "  Coffee Purveyors  ",
      roast: "medium",
      roastedOn: "2026-08-12",
      machine: "  Gaggia Classic Pro  ",
      temperatureControl: "none",
      grinder: "  Fellow Opus  ",
      finerDirection: "lower",
    });

    const [coffee] = await getCoffees(ownerId);
    expect(coffee).toMatchObject({
      name: "Hualalai Kona",
      roaster: "Coffee Purveyors",
      roastLevel: "medium",
    });
    expect(await getCoffeeBags(ownerId)).toEqual([
      expect.objectContaining({
        coffeeId: coffee?.id,
        roastedOn: "2026-08-12",
      }),
    ]);
    expect((await getMachines(ownerId))[0]?.name).toBe("Gaggia Classic Pro");
    expect((await getGrinders(ownerId))[0]?.name).toBe("Fellow Opus");
    expect(await getOwnerPreference(ownerId, "onboarded")).toBe("true");
  });
});
