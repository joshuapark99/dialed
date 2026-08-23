import { describe, expect, it } from "vitest";

import type { CoffeeRoastLevel } from "./models";

const canonicalCoffeeRoastLevels: CoffeeRoastLevel[] = [
  "light",
  "medium-light",
  "medium",
  "medium-dark",
  "dark",
  "unknown",
];

describe("CoffeeRoastLevel", () => {
  it("includes every canonical roast level", () => {
    expect(canonicalCoffeeRoastLevels).toHaveLength(6);
  });
});
