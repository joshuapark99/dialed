import { describe, expect, it } from "vitest";
import {
  parseOptionalFiniteMeasurement,
  parseRequiredPositiveMeasurement,
} from "./brew-form";

describe("brew form measurements", () => {
  it("rejects zero pressure instead of producing a queued value", () => {
    expect(
      parseOptionalFiniteMeasurement("0", { minimum: 0, exclusive: true }),
    ).toEqual({ valid: false });
  });

  it("accepts zero pre-infusion but rejects negative values", () => {
    expect(parseOptionalFiniteMeasurement("0", { minimum: 0 })).toEqual({
      valid: true,
      value: 0,
    });
    expect(parseOptionalFiniteMeasurement("-1", { minimum: 0 })).toEqual({
      valid: false,
    });
  });

  it("rejects non-finite required and optional measurements", () => {
    expect(parseRequiredPositiveMeasurement("1e999")).toEqual({
      valid: false,
    });
    expect(parseOptionalFiniteMeasurement("1e999")).toEqual({ valid: false });
  });

  it("treats a blank optional measurement as valid and absent", () => {
    expect(parseOptionalFiniteMeasurement("  ")).toEqual({ valid: true });
  });
});
