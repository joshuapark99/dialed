import type { BrewComparison, EspressoBrew, NumericDelta } from "./schemas.js";
import { BrewComparisonSchema } from "./schemas.js";
import { calculateBrewMetrics } from "./calculations.js";

export interface ComparisonSelectionOptions {
  referenceBrewId?: string;
}

function isAvailableReference(
  current: EspressoBrew,
  candidate: EspressoBrew,
): boolean {
  return (
    candidate.id !== current.id &&
    candidate.deletedAt === null &&
    candidate.userId === current.userId
  );
}

function compareNumber(reference: number, current: number): NumericDelta {
  return { reference, current, delta: current - reference };
}

export function selectComparisonBrew(
  current: EspressoBrew,
  candidates: readonly EspressoBrew[],
  options: ComparisonSelectionOptions = {},
): EspressoBrew | undefined {
  const available = candidates.filter((candidate) =>
    isAvailableReference(current, candidate),
  );

  if (options.referenceBrewId !== undefined) {
    return available.find(
      (candidate) => candidate.id === options.referenceBrewId,
    );
  }

  return available
    .filter(
      (candidate) =>
        candidate.beanId === current.beanId &&
        candidate.machineId === current.machineId &&
        candidate.grinderId === current.grinderId,
    )
    .sort((left, right) => {
      const timeDifference =
        Date.parse(right.brewedAt) - Date.parse(left.brewedAt);
      return timeDifference === 0
        ? right.id.localeCompare(left.id)
        : timeDifference;
    })[0];
}

export function compareBrews(
  current: EspressoBrew,
  reference: EspressoBrew,
): BrewComparison {
  const currentMetrics = calculateBrewMetrics(current.espresso);
  const referenceMetrics = calculateBrewMetrics(reference.espresso);
  const currentGrind = current.espresso.grindSetting;
  const referenceGrind = reference.espresso.grindSetting;
  const numericDelta =
    currentGrind.numericValue !== undefined &&
    referenceGrind.numericValue !== undefined
      ? currentGrind.numericValue - referenceGrind.numericValue
      : undefined;

  return BrewComparisonSchema.parse({
    referenceBrewId: reference.id,
    currentBrewId: current.id,
    doseGrams: compareNumber(
      reference.espresso.doseGrams,
      current.espresso.doseGrams,
    ),
    yieldGrams: compareNumber(
      reference.espresso.yieldGrams,
      current.espresso.yieldGrams,
    ),
    durationSeconds: compareNumber(
      reference.espresso.durationSeconds,
      current.espresso.durationSeconds,
    ),
    ratio: compareNumber(referenceMetrics.ratio, currentMetrics.ratio),
    averageFlowGramsPerSecond: compareNumber(
      referenceMetrics.averageFlowGramsPerSecond,
      currentMetrics.averageFlowGramsPerSecond,
    ),
    ...(current.taste !== undefined && reference.taste !== undefined
      ? {
          enjoyment: compareNumber(
            reference.taste.enjoyment,
            current.taste.enjoyment,
          ),
        }
      : {}),
    grind: {
      reference: referenceGrind.display,
      current: currentGrind.display,
      ...(numericDelta === undefined ? {} : { numericDelta }),
    },
  });
}
