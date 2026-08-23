import { describe, expect, it } from "vitest";
import { requiresOnboarding } from "./onboarding-state";

describe("onboarding readiness", () => {
  it("uses restored setup records for an authenticated account without a local marker", () => {
    expect(
      requiresOnboarding({
        authenticated: true,
        onboarded: undefined,
        beanCount: 1,
        machineCount: 1,
        grinderCount: 1,
      }),
    ).toBe(false);
  });

  it("still requires the local onboarding marker for anonymous data", () => {
    expect(
      requiresOnboarding({
        authenticated: false,
        onboarded: undefined,
        beanCount: 1,
        machineCount: 1,
        grinderCount: 1,
      }),
    ).toBe(true);
  });
});
