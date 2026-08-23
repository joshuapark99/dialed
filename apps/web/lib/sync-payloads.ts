import { z } from "zod";
import type { Bean, Brew, Grinder, Machine, SyncEntity } from "./models";

export const RemoteEntityIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "Expected a UUIDv7 identifier",
  );

const TimestampSchema = z.string().datetime({ offset: true });
const RequiredTextSchema = z.string().trim().min(1);
const FinitePositiveSchema = z.number().finite().positive();

const BeanPayloadSchema = z
  .object({
    id: RemoteEntityIdSchema,
    name: RequiredTextSchema,
    roaster: RequiredTextSchema,
    origin: RequiredTextSchema.optional(),
    roastLevel: z.enum(["light", "medium", "dark"]),
    createdAt: TimestampSchema,
  })
  .strict();

const MachinePayloadSchema = z
  .object({
    id: RemoteEntityIdSchema,
    name: RequiredTextSchema,
    temperatureControl: z.enum(["none", "relative", "precise"]),
    hasPressureControl: z.boolean(),
    hasPreinfusion: z.boolean(),
    createdAt: TimestampSchema,
  })
  .strict();

const GrinderPayloadSchema = z
  .object({
    id: RemoteEntityIdSchema,
    name: RequiredTextSchema,
    finerDirection: z.enum(["lower", "higher"]),
    createdAt: TimestampSchema,
  })
  .strict();

const TastePayloadSchema = z
  .object({
    acidity: z.number().int().min(1).max(5),
    bitterness: z.number().int().min(1).max(5),
    strength: z.number().int().min(1).max(5),
    body: z.number().int().min(1).max(5),
    enjoyment: z.number().int().min(1).max(5),
  })
  .strict();

const RecommendationPayloadSchema = z
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
    headline: RequiredTextSchema,
    rationale: RequiredTextSchema,
    expectedEffect: RequiredTextSchema,
    confidence: z.enum(["low", "medium", "high"]),
    ruleVersion: RequiredTextSchema,
  })
  .strict();

const BrewPayloadSchema = z
  .object({
    id: RemoteEntityIdSchema,
    beanId: RemoteEntityIdSchema,
    machineId: RemoteEntityIdSchema,
    grinderId: RemoteEntityIdSchema,
    dose: FinitePositiveSchema,
    yield: FinitePositiveSchema,
    duration: FinitePositiveSchema,
    grind: RequiredTextSchema,
    temperature: z.number().finite().optional(),
    pressure: FinitePositiveSchema.optional(),
    preinfusion: z.number().finite().nonnegative().optional(),
    basket: RequiredTextSchema.optional(),
    puckPrep: RequiredTextSchema.optional(),
    observation: z.enum(["even", "channeling", "gushing", "choked"]).optional(),
    notes: RequiredTextSchema.optional(),
    taste: TastePayloadSchema,
    ratio: FinitePositiveSchema,
    flow: FinitePositiveSchema,
    comparisonBrewId: RemoteEntityIdSchema.optional(),
    recommendation: RecommendationPayloadSchema,
    dialedAt: TimestampSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    syncState: z.enum(["local", "synced", "pending"]),
  })
  .strict()
  .transform((value) => ({ ...value, syncState: "synced" as const }));

const payloadSchemas = {
  bean: BeanPayloadSchema,
  machine: MachinePayloadSchema,
  grinder: GrinderPayloadSchema,
  brew: BrewPayloadSchema,
} as const;

type RemoteSyncEntity = Exclude<SyncEntity, "coffee">;

export type RemotePayload = Bean | Machine | Grinder | Brew;

function withoutRemoteOwner(payload: unknown): unknown {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return payload;
  }
  const { ownerId: _untrustedOwnerId, ...entity } = payload as Record<
    string,
    unknown
  >;
  return entity;
}

export function parseRemoteEntity(entity: string): RemoteSyncEntity {
  if (Object.prototype.hasOwnProperty.call(payloadSchemas, entity)) {
    return entity as RemoteSyncEntity;
  }
  throw new Error(`Unsupported sync entity: ${entity}`);
}

export function parseRemotePayload(
  entity: string,
  payload: unknown,
): RemotePayload {
  const supportedEntity = parseRemoteEntity(entity);
  return payloadSchemas[supportedEntity].parse(
    withoutRemoteOwner(payload),
  ) as RemotePayload;
}
