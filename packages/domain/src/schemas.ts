import { z } from "zod";

const positiveMeasurement = z.number().finite().positive();
const optionalText = z.string().trim().min(1).max(2_000).optional();

export const EntityIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "Expected a UUIDv7 identifier",
  );
export const TimestampSchema = z.string().datetime({ offset: true });

const entityFields = {
  id: EntityIdSchema,
  userId: EntityIdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deletedAt: TimestampSchema.nullable().default(null),
} as const;

export const RoastLevelSchema = z.enum([
  "light",
  "medium-light",
  "medium",
  "medium-dark",
  "dark",
  "unknown",
]);

export const BeanSchema = z
  .object({
    ...entityFields,
    name: z.string().trim().min(1).max(120),
    roaster: z.string().trim().min(1).max(120).optional(),
    origin: z.string().trim().min(1).max(240).optional(),
    roastLevel: RoastLevelSchema.default("unknown"),
    roastedOn: z.string().date().optional(),
    notes: optionalText,
  })
  .strict();

export const CoffeeSchema = z
  .object({
    ...entityFields,
    name: z.string().trim().min(1).max(120),
    roaster: z.string().trim().min(1).max(120),
    originCountry: z.string().trim().min(1).max(120).optional(),
    originRegion: z.string().trim().min(1).max(120).optional(),
    producer: z.string().trim().min(1).max(240).optional(),
    process: z.string().trim().min(1).max(120).optional(),
    varietal: z.string().trim().min(1).max(240).optional(),
    elevationMeters: z.number().finite().int().min(1).max(9000).optional(),
    roastLevel: RoastLevelSchema.default("unknown"),
    notes: optionalText,
  })
  .strict();

export const CoffeeBagSchema = z
  .object({
    ...entityFields,
    coffeeId: EntityIdSchema,
    roastedOn: z.string().date().optional(),
    purchasedOn: z.string().date().optional(),
    openedOn: z.string().date().optional(),
    startingWeightGrams: positiveMeasurement.max(100_000).optional(),
    notes: optionalText,
  })
  .strict();

export const TemperatureControlSchema = z.enum(["none", "relative", "precise"]);

export const MachineCapabilitiesSchema = z
  .object({
    temperatureControl: TemperatureControlSchema.default("none"),
    adjustablePressure: z.boolean().default(false),
    preInfusion: z.boolean().default(false),
  })
  .strict();

export const MachineProfileSchema = z
  .object({
    ...entityFields,
    name: z.string().trim().min(1).max(120),
    manufacturer: z.string().trim().min(1).max(120).optional(),
    model: z.string().trim().min(1).max(120).optional(),
    capabilities: MachineCapabilitiesSchema,
    notes: optionalText,
  })
  .strict();

export const GrinderDirectionSchema = z.enum([
  "lower-is-finer",
  "higher-is-finer",
]);

export const GrinderCalibrationSchema = z
  .object({
    stepSize: positiveMeasurement,
    direction: GrinderDirectionSchema,
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
  })
  .strict()
  .refine(
    ({ minimum, maximum }) =>
      minimum === undefined || maximum === undefined || minimum <= maximum,
    { message: "minimum must not exceed maximum", path: ["minimum"] },
  );

export const GrinderProfileSchema = z
  .object({
    ...entityFields,
    name: z.string().trim().min(1).max(120),
    manufacturer: z.string().trim().min(1).max(120).optional(),
    model: z.string().trim().min(1).max(120).optional(),
    calibration: GrinderCalibrationSchema.optional(),
    notes: optionalText,
  })
  .strict();

export const GrindSettingSchema = z
  .object({
    display: z.string().trim().min(1).max(40),
    numericValue: z.number().finite().optional(),
  })
  .strict();

export const TasteScoreSchema = z.number().int().min(1).max(5);

export const TasteAssessmentSchema = z
  .object({
    acidity: TasteScoreSchema,
    bitterness: TasteScoreSchema,
    strength: TasteScoreSchema,
    body: TasteScoreSchema,
    enjoyment: TasteScoreSchema,
    notes: optionalText,
  })
  .strict();

export const ShotObservationSchema = z.enum([
  "channeling",
  "spraying",
  "gushing",
  "early-blonding",
  "fast-finish",
]);

export const EspressoDetailsSchema = z
  .object({
    doseGrams: positiveMeasurement.max(100),
    yieldGrams: positiveMeasurement.max(300),
    durationSeconds: positiveMeasurement.max(300),
    grindSetting: GrindSettingSchema,
    temperatureCelsius: z.number().finite().min(50).max(110).optional(),
    pressureBar: z.number().finite().positive().max(20).optional(),
    preInfusionSeconds: z.number().finite().min(0).max(120).optional(),
    basket: z.string().trim().min(1).max(120).optional(),
    puckPreparation: z.string().trim().min(1).max(500).optional(),
    observations: z.array(ShotObservationSchema).max(5).default([]),
  })
  .strict();

export const EspressoBrewSchema = z
  .object({
    ...entityFields,
    method: z.literal("espresso"),
    beanId: EntityIdSchema,
    machineId: EntityIdSchema,
    grinderId: EntityIdSchema,
    brewedAt: TimestampSchema,
    espresso: EspressoDetailsSchema,
    taste: TasteAssessmentSchema.optional(),
    notes: optionalText,
    dialedAt: TimestampSchema.nullable().default(null),
  })
  .strict();

export const BrewMetricsSchema = z
  .object({
    ratio: positiveMeasurement,
    averageFlowGramsPerSecond: positiveMeasurement,
  })
  .strict();

export const NumericDeltaSchema = z
  .object({
    reference: z.number().finite(),
    current: z.number().finite(),
    delta: z.number().finite(),
  })
  .strict();

export const BrewComparisonSchema = z
  .object({
    referenceBrewId: EntityIdSchema,
    currentBrewId: EntityIdSchema,
    doseGrams: NumericDeltaSchema,
    yieldGrams: NumericDeltaSchema,
    durationSeconds: NumericDeltaSchema,
    ratio: NumericDeltaSchema,
    averageFlowGramsPerSecond: NumericDeltaSchema,
    enjoyment: NumericDeltaSchema.optional(),
    grind: z
      .object({
        reference: z.string(),
        current: z.string(),
        numericDelta: z.number().finite().optional(),
      })
      .strict(),
  })
  .strict();

export const AdjustmentVariableSchema = z.enum([
  "grind",
  "yield",
  "dose",
  "temperature",
  "pressure",
  "pre-infusion",
  "puck-preparation",
]);

export const AdjustmentDirectionSchema = z.enum([
  "finer",
  "coarser",
  "increase",
  "decrease",
  "improve",
]);

export const RecommendationConfidenceSchema = z.enum(["low", "medium", "high"]);

const recommendationBase = {
  ruleVersion: z.string().trim().min(1),
  confidence: RecommendationConfidenceSchema,
  rationale: z.string().trim().min(1),
  expectedEffect: z.string().trim().min(1),
  comparisonBrewId: EntityIdSchema.optional(),
} as const;

export const AdjustmentRecommendationSchema = z
  .object({
    ...recommendationBase,
    kind: z.literal("adjustment"),
    adjustment: z
      .object({
        variable: AdjustmentVariableSchema,
        direction: AdjustmentDirectionSchema,
        targetValue: z.number().finite().optional(),
        targetDisplay: z.string().trim().min(1).optional(),
      })
      .strict(),
  })
  .strict();

export const HoldRecommendationSchema = z
  .object({
    ...recommendationBase,
    kind: z.literal("hold"),
  })
  .strict();

export const CollectDataRecommendationSchema = z
  .object({
    ...recommendationBase,
    kind: z.literal("collect-more-data"),
  })
  .strict();

export const RecommendationSchema = z.discriminatedUnion("kind", [
  AdjustmentRecommendationSchema,
  HoldRecommendationSchema,
  CollectDataRecommendationSchema,
]);

export type RoastLevel = z.infer<typeof RoastLevelSchema>;
export type Bean = z.infer<typeof BeanSchema>;
export type Coffee = z.infer<typeof CoffeeSchema>;
export type CoffeeBag = z.infer<typeof CoffeeBagSchema>;
export type TemperatureControl = z.infer<typeof TemperatureControlSchema>;
export type MachineCapabilities = z.infer<typeof MachineCapabilitiesSchema>;
export type MachineProfile = z.infer<typeof MachineProfileSchema>;
export type GrinderDirection = z.infer<typeof GrinderDirectionSchema>;
export type GrinderCalibration = z.infer<typeof GrinderCalibrationSchema>;
export type GrinderProfile = z.infer<typeof GrinderProfileSchema>;
export type GrindSetting = z.infer<typeof GrindSettingSchema>;
export type TasteAssessment = z.infer<typeof TasteAssessmentSchema>;
export type ShotObservation = z.infer<typeof ShotObservationSchema>;
export type EspressoDetails = z.infer<typeof EspressoDetailsSchema>;
export type EspressoBrew = z.infer<typeof EspressoBrewSchema>;
export type BrewMetrics = z.infer<typeof BrewMetricsSchema>;
export type NumericDelta = z.infer<typeof NumericDeltaSchema>;
export type BrewComparison = z.infer<typeof BrewComparisonSchema>;
export type AdjustmentVariable = z.infer<typeof AdjustmentVariableSchema>;
export type AdjustmentDirection = z.infer<typeof AdjustmentDirectionSchema>;
export type RecommendationConfidence = z.infer<
  typeof RecommendationConfidenceSchema
>;
export type AdjustmentRecommendation = z.infer<
  typeof AdjustmentRecommendationSchema
>;
export type HoldRecommendation = z.infer<typeof HoldRecommendationSchema>;
export type CollectDataRecommendation = z.infer<
  typeof CollectDataRecommendationSchema
>;
export type Recommendation = z.infer<typeof RecommendationSchema>;
