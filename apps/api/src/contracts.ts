import { z } from "zod";

export const syncEntitySchema = z.enum([
  "bean",
  "machine",
  "grinder",
  "brew",
  "taste",
  "recommendation",
]);

export const syncOperationSchema = z
  .object({
    operationId: z.uuid(),
    entity: syncEntitySchema,
    entityId: z.uuid(),
    action: z.enum(["upsert", "delete"]),
    payload: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .superRefine((operation, context) => {
    if (operation.action === "upsert" && !operation.payload) {
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message: "payload is required for upsert",
      });
    }
  });

export const pushBodySchema = z.object({
  operations: z.array(syncOperationSchema).min(1).max(100),
});

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
