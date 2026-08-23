import { z } from "zod";

export const syncEntitySchema = z.enum([
  "coffee",
  "bean",
  "machine",
  "grinder",
  "brew",
]);

const remoteEntityIdSchema = z.uuidv7();
const timestampSchema = z.string().datetime({ offset: true });
const requiredTextSchema = z.string().trim().min(1);
const optionalTextSchema = requiredTextSchema.optional();
const finitePositiveSchema = z.number().finite().positive();
const roastLevelPayloadSchema = z.enum([
  "light",
  "medium-light",
  "medium",
  "medium-dark",
  "dark",
  "unknown",
]);

const legacyBeanPayloadSchema = z
  .object({
    id: remoteEntityIdSchema,
    name: requiredTextSchema,
    roaster: requiredTextSchema,
    origin: requiredTextSchema.optional(),
    roastLevel: z.enum(["light", "medium", "dark"]),
    createdAt: timestampSchema,
  })
  .strict();

const coffeePayloadSchema = z
  .object({
    id: remoteEntityIdSchema,
    name: requiredTextSchema,
    roaster: requiredTextSchema,
    originCountry: requiredTextSchema.optional(),
    originRegion: requiredTextSchema.optional(),
    producer: requiredTextSchema.optional(),
    process: requiredTextSchema.optional(),
    varietal: requiredTextSchema.optional(),
    elevationMeters: z.number().int().min(1).max(9000).optional(),
    roastLevel: roastLevelPayloadSchema,
    notes: optionalTextSchema,
    createdAt: timestampSchema,
  })
  .strict();

const coffeeBagPayloadSchema = z
  .object({
    id: remoteEntityIdSchema,
    coffeeId: remoteEntityIdSchema,
    roastedOn: z.string().date().optional(),
    purchasedOn: z.string().date().optional(),
    openedOn: z.string().date().optional(),
    startingWeightGrams: z
      .number()
      .finite()
      .positive()
      .max(100_000)
      .optional(),
    notes: optionalTextSchema,
    createdAt: timestampSchema,
  })
  .strict();

const beanPayloadSchema = z.union([
  coffeeBagPayloadSchema,
  legacyBeanPayloadSchema,
]);

const machinePayloadSchema = z
  .object({
    id: remoteEntityIdSchema,
    name: requiredTextSchema,
    temperatureControl: z.enum(["none", "relative", "precise"]),
    hasPressureControl: z.boolean(),
    hasPreinfusion: z.boolean(),
    createdAt: timestampSchema,
  })
  .strict();

const grinderPayloadSchema = z
  .object({
    id: remoteEntityIdSchema,
    name: requiredTextSchema,
    finerDirection: z.enum(["lower", "higher"]),
    createdAt: timestampSchema,
  })
  .strict();

const tastePayloadSchema = z
  .object({
    acidity: z.number().int().min(1).max(5),
    bitterness: z.number().int().min(1).max(5),
    strength: z.number().int().min(1).max(5),
    body: z.number().int().min(1).max(5),
    enjoyment: z.number().int().min(1).max(5),
  })
  .strict();

const recommendationPayloadSchema = z
  .object({
    variable: z.enum([
      "grind",
      "yield",
      "dose",
      "temperature",
      "pressure",
      "pre-infusion",
      "puck-prep",
      "hold",
    ]),
    direction: z.enum([
      "increase",
      "decrease",
      "finer",
      "coarser",
      "improve",
      "hold",
    ]),
    target: z.number().finite().optional(),
    headline: requiredTextSchema,
    rationale: requiredTextSchema,
    expectedEffect: requiredTextSchema,
    confidence: z.enum(["low", "medium", "high"]),
    ruleVersion: requiredTextSchema,
  })
  .strict();

const brewPayloadSchema = z
  .object({
    id: remoteEntityIdSchema,
    beanId: remoteEntityIdSchema,
    machineId: remoteEntityIdSchema,
    grinderId: remoteEntityIdSchema,
    dose: finitePositiveSchema,
    yield: finitePositiveSchema,
    duration: finitePositiveSchema,
    grind: requiredTextSchema,
    temperature: z.number().finite().optional(),
    pressure: finitePositiveSchema.optional(),
    preinfusion: z.number().finite().nonnegative().optional(),
    basket: requiredTextSchema.optional(),
    puckPrep: requiredTextSchema.optional(),
    observation: z.enum(["even", "channeling", "gushing", "choked"]).optional(),
    notes: requiredTextSchema.optional(),
    taste: tastePayloadSchema,
    ratio: finitePositiveSchema,
    flow: finitePositiveSchema,
    comparisonBrewId: remoteEntityIdSchema.optional(),
    recommendation: recommendationPayloadSchema,
    dialedAt: timestampSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    syncState: z.enum(["local", "synced", "pending"]),
  })
  .strict();

const payloadSchemas = {
  coffee: coffeePayloadSchema,
  bean: beanPayloadSchema,
  machine: machinePayloadSchema,
  grinder: grinderPayloadSchema,
  brew: brewPayloadSchema,
} as const;

export const syncOperationSchema = z
  .object({
    operationId: remoteEntityIdSchema,
    entity: syncEntitySchema,
    entityId: remoteEntityIdSchema,
    action: z.enum(["upsert", "delete"]),
    payload: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict()
  .superRefine((operation, context) => {
    if (operation.action === "upsert" && !operation.payload) {
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message: "payload is required for upsert",
      });
      return;
    }
    if (operation.action === "delete") return;

    const parsedPayload = payloadSchemas[operation.entity].safeParse(
      operation.payload,
    );
    if (!parsedPayload.success) {
      for (const issue of parsedPayload.error.issues) {
        context.addIssue({
          code: "custom",
          path: ["payload", ...issue.path],
          message: issue.message,
        });
      }
      return;
    }
    if (parsedPayload.data.id !== operation.entityId) {
      context.addIssue({
        code: "custom",
        path: ["payload", "id"],
        message: "payload ID must match entityId",
      });
    }
  });

export const pushBodySchema = z
  .object({
    operations: z.array(syncOperationSchema).min(1).max(100),
  })
  .strict();

export const pullQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const exportQuerySchema = z.object({
  format: z.enum(["json", "csv"]).default("json"),
});

export const deleteAccountBodySchema = z.object({
  confirmation: z.literal("DELETE"),
});
