import Dexie from "dexie";
import {
  ANONYMOUS_OWNER_ID,
  db,
  getOwnerPreference,
  ownerPreferenceKey,
} from "./db";
import type {
  Brew,
  Coffee,
  CoffeeBag,
  Grinder,
  Machine,
  Owned,
  SyncEntity,
  SyncOperation,
} from "./models";
import { parseRemotePayload } from "./sync-payloads";

export const ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY = "anonymous-transfer-source";
const dismissedPreferenceKey = "anonymous-transfer-dismissed";
const transferablePreferenceKey = "onboarded";

export interface AnonymousTransferSummary {
  coffees: number;
  bags: number;
  machines: number;
  grinders: number;
  brews: number;
  hasData: boolean;
}

export interface AnonymousTransferJournal {
  version: 1;
  destinationOwnerId: string;
  phase: "staged";
  operationIds: string[];
  acknowledgedOperationIds: string[];
  startedAt: string;
}

type DeepReadonly<T> = T extends object
  ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
  : T;

export interface AnonymousTransferSnapshot {
  coffees: ReadonlyArray<DeepReadonly<Owned<Coffee>>>;
  bags: ReadonlyArray<DeepReadonly<Owned<CoffeeBag>>>;
  machines: ReadonlyArray<DeepReadonly<Owned<Machine>>>;
  grinders: ReadonlyArray<DeepReadonly<Owned<Grinder>>>;
  brews: ReadonlyArray<DeepReadonly<Owned<Brew>>>;
  operations: ReadonlyArray<DeepReadonly<Owned<SyncOperation>>>;
  onboardedPreference?: string;
}

export class AnonymousTransferConflictError extends Error {
  constructor(
    public readonly entity: SyncEntity,
    public readonly entityId: string,
  ) {
    super(`Anonymous ${entity} ${entityId} conflicts with destination data`);
    this.name = "AnonymousTransferConflictError";
  }
}

export class AnonymousTransferValidationError extends Error {
  constructor(
    public readonly entity: string,
    public readonly entityId: string,
  ) {
    super(`Anonymous transfer references missing ${entity} ${entityId}`);
    this.name = "AnonymousTransferValidationError";
  }
}

function cloneAndFreeze<T>(value: T): Readonly<T> {
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((item) => cloneAndFreeze(item)),
    ) as unknown as Readonly<T>;
  }
  if (value !== null && typeof value === "object") {
    const copy = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneAndFreeze(item)]),
    );
    return Object.freeze(copy) as Readonly<T>;
  }
  return value;
}

function freezeRecords<T>(
  records: readonly T[],
): ReadonlyArray<DeepReadonly<T>> {
  return cloneAndFreeze(records) as ReadonlyArray<DeepReadonly<T>>;
}

function freezeSnapshot(snapshot: {
  coffees: Array<Owned<Coffee>>;
  bags: Array<Owned<CoffeeBag>>;
  machines: Array<Owned<Machine>>;
  grinders: Array<Owned<Grinder>>;
  brews: Array<Owned<Brew>>;
  operations: Array<Owned<SyncOperation>>;
  onboardedPreference?: string;
}): AnonymousTransferSnapshot {
  return Object.freeze({
    coffees: freezeRecords(snapshot.coffees),
    bags: freezeRecords(snapshot.bags),
    machines: freezeRecords(snapshot.machines),
    grinders: freezeRecords(snapshot.grinders),
    brews: freezeRecords(snapshot.brews),
    operations: freezeRecords(snapshot.operations),
    onboardedPreference: snapshot.onboardedPreference,
  });
}

export async function getAnonymousTransferSummary(): Promise<AnonymousTransferSummary> {
  const [coffees, bags, machines, grinders, brews] = await Promise.all([
    db.coffees.where("ownerId").equals(ANONYMOUS_OWNER_ID).count(),
    db.bags.where("ownerId").equals(ANONYMOUS_OWNER_ID).count(),
    db.machines.where("ownerId").equals(ANONYMOUS_OWNER_ID).count(),
    db.grinders.where("ownerId").equals(ANONYMOUS_OWNER_ID).count(),
    db.brews.where("ownerId").equals(ANONYMOUS_OWNER_ID).count(),
  ]);
  return {
    coffees,
    bags,
    machines,
    grinders,
    brews,
    hasData: coffees + bags + machines + grinders + brews > 0,
  };
}

export async function getAnonymousTransferOffer(
  destinationOwnerId: string,
): Promise<AnonymousTransferSummary | null> {
  const [summary, sourceDestinationOwnerId, dismissed] = await Promise.all([
    getAnonymousTransferSummary(),
    getOwnerPreference(
      ANONYMOUS_OWNER_ID,
      ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
    ),
    getOwnerPreference(destinationOwnerId, dismissedPreferenceKey),
  ]);
  if (
    !summary.hasData ||
    (sourceDestinationOwnerId !== undefined &&
      sourceDestinationOwnerId !== destinationOwnerId) ||
    dismissed === "true"
  ) {
    return null;
  }
  return summary;
}

function validateEntity(
  entity: string,
  syncEntity: SyncEntity,
  record: { id: string },
): void {
  try {
    parseRemotePayload(syncEntity, record);
  } catch {
    throw new AnonymousTransferValidationError(entity, record.id);
  }
}

async function readValidatedAnonymousTransferSnapshot(): Promise<AnonymousTransferSnapshot> {
  const [coffees, bags, machines, grinders, brews, operations, onboarded] =
    await Promise.all([
      db.coffees.where("ownerId").equals(ANONYMOUS_OWNER_ID).toArray(),
      db.bags.where("ownerId").equals(ANONYMOUS_OWNER_ID).toArray(),
      db.machines.where("ownerId").equals(ANONYMOUS_OWNER_ID).toArray(),
      db.grinders.where("ownerId").equals(ANONYMOUS_OWNER_ID).toArray(),
      db.brews.where("ownerId").equals(ANONYMOUS_OWNER_ID).toArray(),
      db.operations.where("ownerId").equals(ANONYMOUS_OWNER_ID).toArray(),
      db.preferences.get(
        ownerPreferenceKey(ANONYMOUS_OWNER_ID, transferablePreferenceKey),
      ),
    ]);

  for (const coffee of coffees) validateEntity("coffee", "coffee", coffee);
  for (const bag of bags) validateEntity("bag", "bean", bag);
  for (const machine of machines) validateEntity("machine", "machine", machine);
  for (const grinder of grinders) validateEntity("grinder", "grinder", grinder);
  for (const brew of brews) validateEntity("brew", "brew", brew);

  const coffeeIds = new Set(coffees.map(({ id }) => id));
  const bagIds = new Set(bags.map(({ id }) => id));
  const machineIds = new Set(machines.map(({ id }) => id));
  const grinderIds = new Set(grinders.map(({ id }) => id));

  for (const bag of bags) {
    if (!coffeeIds.has(bag.coffeeId)) {
      throw new AnonymousTransferValidationError("coffee", bag.coffeeId);
    }
  }
  for (const brew of brews) {
    if (!bagIds.has(brew.beanId)) {
      throw new AnonymousTransferValidationError("bag", brew.beanId);
    }
    if (!machineIds.has(brew.machineId)) {
      throw new AnonymousTransferValidationError("machine", brew.machineId);
    }
    if (!grinderIds.has(brew.grinderId)) {
      throw new AnonymousTransferValidationError("grinder", brew.grinderId);
    }
  }

  return freezeSnapshot({
    coffees,
    bags,
    machines,
    grinders,
    brews,
    operations,
    onboardedPreference: onboarded?.value,
  });
}

export async function validateAnonymousTransferGraph(): Promise<AnonymousTransferSnapshot> {
  if (Dexie.currentTransaction) {
    return readValidatedAnonymousTransferSnapshot();
  }
  return db.transaction(
    "r",
    [
      db.coffees,
      db.bags,
      db.machines,
      db.grinders,
      db.brews,
      db.preferences,
      db.operations,
    ],
    readValidatedAnonymousTransferSnapshot,
  );
}
