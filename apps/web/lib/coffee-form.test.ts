import { describe, expect, it } from "vitest";
import type { CoffeeBag } from "./models";
import {
  formatBagLabel,
  parseBagForm,
  parseCoffeeForm,
  type BagFormDraft,
  type CoffeeFormDraft,
} from "./coffee-form";

const validCoffeeDraft: CoffeeFormDraft = {
  name: "  Hualalai Kona  ",
  roaster: "  Coffee Purveyors  ",
  originCountry: "",
  originRegion: "",
  producer: "",
  process: "",
  varietal: "",
  elevationMeters: "",
  roastLevel: "medium",
  notes: "",
};

const blankBagDraft: BagFormDraft = {
  roastedOn: "",
  purchasedOn: "",
  openedOn: "",
  startingWeightGrams: "",
  notes: "",
};

const bag: CoffeeBag = {
  id: "0198d3a4-1111-7000-8000-000000000041",
  coffeeId: "0198d3a4-1111-7000-8000-000000000040",
  createdAt: "2026-08-12T07:00:00.000Z",
};

describe("coffee form parsing", () => {
  it("trims required fields and parses bounded elevation", () => {
    expect(
      parseCoffeeForm({ ...validCoffeeDraft, elevationMeters: "700" }),
    ).toEqual({
      valid: true,
      value: {
        name: "Hualalai Kona",
        roaster: "Coffee Purveyors",
        elevationMeters: 700,
        roastLevel: "medium",
      },
    });
  });

  it("rejects a blank required coffee name", () => {
    expect(parseCoffeeForm({ ...validCoffeeDraft, name: "" })).toEqual({
      valid: false,
      field: "name",
      message: "Coffee name is required",
    });
  });

  it("normalizes blank optional coffee text", () => {
    expect(parseCoffeeForm(validCoffeeDraft)).toEqual({
      valid: true,
      value: {
        name: "Hualalai Kona",
        roaster: "Coffee Purveyors",
        roastLevel: "medium",
      },
    });
  });

  it.each(["0", "9001", "1.5", "1e999"])(
    "rejects invalid elevation %s",
    (elevationMeters) => {
      expect(
        parseCoffeeForm({ ...validCoffeeDraft, elevationMeters }),
      ).toMatchObject({ valid: false, field: "elevationMeters" });
    },
  );
});

describe("bag form parsing", () => {
  it("normalizes a completely blank optional bag", () => {
    expect(parseBagForm(blankBagDraft)).toEqual({ valid: true, value: {} });
  });

  it("normalizes whitespace-only optional bag dates", () => {
    expect(parseBagForm({ ...blankBagDraft, roastedOn: "   " })).toEqual({
      valid: true,
      value: {},
    });
  });

  it.each(["0", "-1", "100001", "1e999"])(
    "rejects invalid starting weight %s",
    (startingWeightGrams) => {
      expect(
        parseBagForm({ ...blankBagDraft, startingWeightGrams }),
      ).toMatchObject({ valid: false, field: "startingWeightGrams" });
    },
  );

  it("accepts a positive finite starting weight", () => {
    expect(
      parseBagForm({ ...blankBagDraft, startingWeightGrams: "340.5" }),
    ).toEqual({ valid: true, value: { startingWeightGrams: 340.5 } });
  });

  it("rejects malformed calendar dates", () => {
    expect(
      parseBagForm({ ...blankBagDraft, roastedOn: "2026-02-30" }),
    ).toMatchObject({ valid: false, field: "roastedOn" });
  });
});

describe("bag labels", () => {
  it("formats a calendar date without shifting its day", () => {
    expect(formatBagLabel({ ...bag, roastedOn: "2026-08-12" }, "en-US")).toBe(
      "Roasted Aug 12, 2026",
    );
  });

  it("uses a clear fallback when no roast date is set", () => {
    expect(formatBagLabel(bag, "en-US")).toBe("Roast date not set");
  });
});
