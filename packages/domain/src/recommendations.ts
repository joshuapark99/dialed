import { calculateBrewMetrics } from "./calculations.js";
import {
  RecommendationSchema,
  type EspressoBrew,
  type GrinderCalibration,
  type GrinderProfile,
  type MachineProfile,
  type Recommendation,
} from "./schemas.js";

export const RECOMMENDATION_RULE_VERSION = "espresso-v1";

export interface RecommendationInput {
  brew: EspressoBrew;
  machine: MachineProfile;
  grinder: GrinderProfile;
  referenceBrew?: EspressoBrew;
}

type Adjustment = Extract<Recommendation, { kind: "adjustment" }>;

function withComparison<T extends object>(
  input: RecommendationInput,
  value: T,
): T & {
  comparisonBrewId?: string;
} {
  return input.referenceBrew === undefined
    ? value
    : { ...value, comparisonBrewId: input.referenceBrew.id };
}

function adjustment(
  input: RecommendationInput,
  value: Omit<Adjustment, "kind" | "ruleVersion" | "comparisonBrewId">,
): Recommendation {
  return RecommendationSchema.parse(
    withComparison(input, {
      kind: "adjustment",
      ruleVersion: RECOMMENDATION_RULE_VERSION,
      ...value,
    }),
  );
}

function special(
  input: RecommendationInput,
  kind: "hold" | "collect-more-data",
  confidence: "low" | "medium" | "high",
  rationale: string,
  expectedEffect: string,
): Recommendation {
  return RecommendationSchema.parse(
    withComparison(input, {
      kind,
      ruleVersion: RECOMMENDATION_RULE_VERSION,
      confidence,
      rationale,
      expectedEffect,
    }),
  );
}

function calibratedGrindTarget(
  current: number | undefined,
  calibration: GrinderCalibration | undefined,
  direction: "finer" | "coarser",
): number | undefined {
  if (current === undefined || calibration === undefined) return undefined;

  const finerSign = calibration.direction === "higher-is-finer" ? 1 : -1;
  const directionSign = direction === "finer" ? finerSign : -finerSign;
  const unbounded =
    Math.round((current + directionSign * calibration.stepSize) * 1_000_000) /
    1_000_000;
  const aboveMinimum = Math.max(
    unbounded,
    calibration.minimum ?? Number.NEGATIVE_INFINITY,
  );
  return Math.min(
    aboveMinimum,
    calibration.maximum ?? Number.POSITIVE_INFINITY,
  );
}

function grindAdjustment(
  input: RecommendationInput,
  direction: "finer" | "coarser",
  confidence: "medium" | "high",
  rationale: string,
): Recommendation {
  const target = calibratedGrindTarget(
    input.brew.espresso.grindSetting.numericValue,
    input.grinder.calibration,
    direction,
  );

  return adjustment(input, {
    confidence,
    rationale,
    expectedEffect:
      direction === "finer"
        ? "Slower flow should increase extraction."
        : "Faster flow should reduce extraction.",
    adjustment: {
      variable: "grind",
      direction,
      ...(target === undefined
        ? {}
        : { targetValue: target, targetDisplay: String(target) }),
    },
  });
}

function previousChangeHurtEnjoyment(input: RecommendationInput): boolean {
  const current = input.brew;
  const reference = input.referenceBrew;
  return (
    reference?.taste !== undefined &&
    current.taste !== undefined &&
    current.taste.enjoyment < reference.taste.enjoyment
  );
}

function onlyYieldChanged(
  input: RecommendationInput,
): "increased" | "decreased" | undefined {
  const current = input.brew;
  const reference = input.referenceBrew;
  if (reference === undefined) return undefined;

  const sameDose =
    Math.abs(current.espresso.doseGrams - reference.espresso.doseGrams) < 0.05;
  const sameGrind =
    current.espresso.grindSetting.display ===
      reference.espresso.grindSetting.display &&
    current.espresso.grindSetting.numericValue ===
      reference.espresso.grindSetting.numericValue;
  const yieldDelta =
    current.espresso.yieldGrams - reference.espresso.yieldGrams;

  if (!sameDose || !sameGrind || Math.abs(yieldDelta) < 0.5) return undefined;
  return yieldDelta > 0 ? "increased" : "decreased";
}

export function recommendNextAdjustment(
  input: RecommendationInput,
): Recommendation {
  const { brew, machine } = input;
  const { espresso, taste } = brew;
  const metrics = calculateBrewMetrics(espresso);
  const severeObservation = espresso.observations.some((observation) =>
    ["channeling", "spraying", "gushing"].includes(observation),
  );

  if (severeObservation) {
    return adjustment(input, {
      confidence: "high",
      rationale:
        "The shot showed uneven or unstable flow, which makes other variables unreliable.",
      expectedEffect:
        "A level, evenly prepared puck should produce more uniform extraction.",
      adjustment: {
        variable: "puck-preparation",
        direction: "improve",
        targetDisplay: "Distribute evenly and tamp level",
      },
    });
  }

  if (
    espresso.durationSeconds < 20 ||
    metrics.averageFlowGramsPerSecond > 2.25
  ) {
    return grindAdjustment(
      input,
      "finer",
      "high",
      "The shot flowed much faster than a useful baseline.",
    );
  }

  if (
    espresso.durationSeconds > 45 ||
    metrics.averageFlowGramsPerSecond < 0.65
  ) {
    return grindAdjustment(
      input,
      "coarser",
      "high",
      "The shot flowed much slower than a useful baseline.",
    );
  }

  if (taste === undefined) {
    return special(
      input,
      "collect-more-data",
      "high",
      "Taste feedback is required to choose a useful next adjustment.",
      "Recording taste will distinguish extraction and strength problems.",
    );
  }

  if (taste.enjoyment >= 4 && taste.acidity <= 3 && taste.bitterness <= 3) {
    return special(
      input,
      "hold",
      "high",
      "This brew was enjoyable without strong sourness or bitterness.",
      "Repeating the recipe will confirm that it is dialed in.",
    );
  }

  const underExtracted = taste.acidity >= 4 && taste.bitterness <= 3;
  const overExtracted = taste.bitterness >= 4 && taste.acidity <= 3;
  const changedYield = onlyYieldChanged(input);

  if (underExtracted) {
    if (changedYield === "increased" && previousChangeHurtEnjoyment(input)) {
      const referenceYield = input.referenceBrew!.espresso.yieldGrams;
      return adjustment(input, {
        confidence: "medium",
        rationale: "Increasing yield made the previous recipe less enjoyable.",
        expectedEffect:
          "Returning toward the prior yield should restore balance.",
        adjustment: {
          variable: "yield",
          direction: "decrease",
          targetValue: referenceYield,
          targetDisplay: `${referenceYield} g`,
        },
      });
    }

    if (metrics.ratio < 2.25) {
      const target =
        Math.round(
          espresso.doseGrams * Math.min(2.3, metrics.ratio + 0.2) * 10,
        ) / 10;
      return adjustment(input, {
        confidence: "high",
        rationale:
          "The shot tastes sour while its yield remains relatively short.",
        expectedEffect:
          "A longer yield should increase extraction and soften sourness.",
        adjustment: {
          variable: "yield",
          direction: "increase",
          targetValue: target,
          targetDisplay: `${target} g`,
        },
      });
    }

    if (
      machine.capabilities.temperatureControl !== "none" &&
      espresso.temperatureCelsius !== undefined
    ) {
      const increment =
        machine.capabilities.temperatureControl === "precise" ? 1 : 2;
      const target = Math.min(100, espresso.temperatureCelsius + increment);
      return adjustment(input, {
        confidence: "medium",
        rationale:
          "The shot remains sour at a sufficiently long ratio and controllable temperature.",
        expectedEffect: "A higher temperature should increase extraction.",
        adjustment: {
          variable: "temperature",
          direction: "increase",
          targetValue: target,
          targetDisplay: `${target} C`,
        },
      });
    }

    return grindAdjustment(
      input,
      "finer",
      "medium",
      "The shot remains sour despite a sufficiently long ratio.",
    );
  }

  if (overExtracted) {
    if (metrics.ratio > 1.8) {
      const target =
        Math.round(
          espresso.doseGrams * Math.max(1.8, metrics.ratio - 0.2) * 10,
        ) / 10;
      return adjustment(input, {
        confidence: "high",
        rationale: "The shot tastes bitter and its yield can be shortened.",
        expectedEffect:
          "A shorter yield should reduce extraction and bitterness.",
        adjustment: {
          variable: "yield",
          direction: "decrease",
          targetValue: target,
          targetDisplay: `${target} g`,
        },
      });
    }

    return grindAdjustment(
      input,
      "coarser",
      "medium",
      "The shot tastes bitter at a short ratio.",
    );
  }

  if (taste.strength <= 2 && metrics.ratio > 1.6) {
    const target = Math.round(espresso.yieldGrams * 0.9 * 10) / 10;
    return adjustment(input, {
      confidence: "medium",
      rationale: "The shot tastes weak without a clear extraction defect.",
      expectedEffect:
        "A shorter yield should make the drink more concentrated.",
      adjustment: {
        variable: "yield",
        direction: "decrease",
        targetValue: target,
        targetDisplay: `${target} g`,
      },
    });
  }

  if (taste.strength >= 4) {
    const target = Math.round(espresso.yieldGrams * 1.1 * 10) / 10;
    return adjustment(input, {
      confidence: "medium",
      rationale:
        "The shot tastes too strong without a clear extraction defect.",
      expectedEffect: "A longer yield should make the drink less concentrated.",
      adjustment: {
        variable: "yield",
        direction: "increase",
        targetValue: target,
        targetDisplay: `${target} g`,
      },
    });
  }

  return special(
    input,
    "collect-more-data",
    "low",
    "The taste scores do not point to one reliable adjustment.",
    "Repeating the recipe will show whether the result is consistent.",
  );
}
