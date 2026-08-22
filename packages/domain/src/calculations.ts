import { z } from "zod";

import { BrewMetricsSchema, type BrewMetrics } from "./schemas.js";

export const BrewMetricInputSchema = z
  .object({
    doseGrams: z.number().finite().positive(),
    yieldGrams: z.number().finite().positive(),
    durationSeconds: z.number().finite().positive(),
  })
  .strict();

export type BrewMetricInput = z.infer<typeof BrewMetricInputSchema>;

export function calculateBrewMetrics(input: BrewMetricInput): BrewMetrics {
  const parsed = BrewMetricInputSchema.parse({
    doseGrams: input.doseGrams,
    yieldGrams: input.yieldGrams,
    durationSeconds: input.durationSeconds,
  });

  return BrewMetricsSchema.parse({
    ratio: parsed.yieldGrams / parsed.doseGrams,
    averageFlowGramsPerSecond: parsed.yieldGrams / parsed.durationSeconds,
  });
}
