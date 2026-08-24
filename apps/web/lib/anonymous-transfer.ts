import Dexie from "dexie";
import {
  ANONYMOUS_OWNER_ID,
  db,
  getOwnerPreference,
  makeId,
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
const activeJournalKey = "anonymous-transfer-journal";
const dismissedKey = "anonymous-transfer-dismissed";
const transferablePreferenceKeys = new Set(["onboarded"]);

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
    getOwnerPreference(destinationOwnerId, dismissedKey),
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
        ownerPreferenceKey(
          ANONYMOUS_OWNER_ID,
          [...transferablePreferenceKeys][0]!,
        ),
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

type TransferRecord =
  | Owned<Coffee>
  | Owned<CoffeeBag>
  | Owned<Machine>
  | Owned<Grinder>
  | Owned<Brew>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function semanticRecord(record: TransferRecord, entity: SyncEntity): string {
  const { ownerId: _ownerId, ...ownedContent } = record;
  const content = { ...ownedContent } as Record<string, unknown>;
  if (entity === "brew") delete content.syncState;
  return JSON.stringify(stableValue(content));
}

function parseJournal(value: string): AnonymousTransferJournal {
  const journal = JSON.parse(value) as AnonymousTransferJournal;
  if (
    journal.version !== 1 ||
    journal.phase !== "staged" ||
    typeof journal.destinationOwnerId !== "string" ||
    !Array.isArray(journal.operationIds) ||
    !Array.isArray(journal.acknowledgedOperationIds) ||
    typeof journal.startedAt !== "string"
  ) {
    throw new Error("Anonymous transfer journal is malformed");
  }
  return journal;
}

async function readJournal(
  destinationOwnerId: string,
): Promise<AnonymousTransferJournal | undefined> {
  const value = await getOwnerPreference(destinationOwnerId, activeJournalKey);
  return value === undefined ? undefined : parseJournal(value);
}

function pendingCopies<T extends TransferRecord>(
  entity: SyncEntity,
  sourceRecords: readonly T[],
  destinationRecords: readonly (T | undefined)[],
): T[] {
  const copies: T[] = [];
  for (let index = 0; index < sourceRecords.length; index += 1) {
    const source = sourceRecords[index]!;
    const destination = destinationRecords[index];
    if (!destination) {
      copies.push(source);
      continue;
    }
    if (
      semanticRecord(source, entity) !== semanticRecord(destination, entity)
    ) {
      throw new AnonymousTransferConflictError(entity, source.id);
    }
  }
  return copies;
}

function operationFor(
  destinationOwnerId: string,
  entity: SyncEntity,
  record: TransferRecord,
  createdAt: string,
): Owned<SyncOperation> {
  const { ownerId: _ownerId, ...payload } = record;
  return {
    ownerId: destinationOwnerId,
    operationId: makeId(),
    entity,
    entityId: record.id,
    action: "upsert",
    payload,
    createdAt,
  };
}

export async function stageAnonymousTransfer(
  destinationOwnerId: string,
): Promise<AnonymousTransferJournal> {
  if (destinationOwnerId === ANONYMOUS_OWNER_ID) {
    throw new Error("Anonymous data cannot be transferred to anonymous");
  }

  return db.transaction(
    "rw",
    [
      db.coffees,
      db.bags,
      db.machines,
      db.grinders,
      db.brews,
      db.preferences,
      db.operations,
    ],
    async () => {
      const existingJournal = await readJournal(destinationOwnerId);
      if (existingJournal) return existingJournal;

      const sourceDestinationOwnerId = await getOwnerPreference(
        ANONYMOUS_OWNER_ID,
        ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
      );
      if (
        sourceDestinationOwnerId !== undefined &&
        sourceDestinationOwnerId !== destinationOwnerId
      ) {
        throw new Error(
          `Anonymous transfer is already staged for ${sourceDestinationOwnerId}`,
        );
      }

      const snapshot = await validateAnonymousTransferGraph();
      const [coffees, bags, machines, grinders, brews] = await Promise.all([
        db.coffees.bulkGet(
          snapshot.coffees.map(({ id }) => [destinationOwnerId, id]),
        ),
        db.bags.bulkGet(
          snapshot.bags.map(({ id }) => [destinationOwnerId, id]),
        ),
        db.machines.bulkGet(
          snapshot.machines.map(({ id }) => [destinationOwnerId, id]),
        ),
        db.grinders.bulkGet(
          snapshot.grinders.map(({ id }) => [destinationOwnerId, id]),
        ),
        db.brews.bulkGet(
          snapshot.brews.map(({ id }) => [destinationOwnerId, id]),
        ),
      ]);

      const newCoffees = pendingCopies("coffee", snapshot.coffees, coffees);
      const newBags = pendingCopies("bean", snapshot.bags, bags);
      const newMachines = pendingCopies("machine", snapshot.machines, machines);
      const newGrinders = pendingCopies("grinder", snapshot.grinders, grinders);
      const newBrews = pendingCopies("brew", snapshot.brews, brews);

      const startedAt = new Date().toISOString();
      const copies: Array<readonly [SyncEntity, TransferRecord]> = [
        ...newCoffees.map((record) => ["coffee", record] as const),
        ...newBags.map((record) => ["bean", record] as const),
        ...newMachines.map((record) => ["machine", record] as const),
        ...newGrinders.map((record) => ["grinder", record] as const),
        ...newBrews.map(
          (record) =>
            ["brew", { ...record, syncState: "pending" as const }] as const,
        ),
      ];
      const operations = copies.map(([entity, record], index) =>
        operationFor(
          destinationOwnerId,
          entity,
          record,
          new Date(Date.parse(startedAt) + index).toISOString(),
        ),
      );
      const journal: AnonymousTransferJournal = {
        version: 1,
        destinationOwnerId,
        phase: "staged",
        operationIds: operations.map(({ operationId }) => operationId),
        acknowledgedOperationIds: [],
        startedAt,
      };

      await db.preferences.put({
        key: ownerPreferenceKey(
          ANONYMOUS_OWNER_ID,
          ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
        ),
        value: destinationOwnerId,
      });
      if (newCoffees.length) {
        await db.coffees.bulkPut(
          newCoffees.map((record) => ({
            ...record,
            ownerId: destinationOwnerId,
          })),
        );
      }
      if (newBags.length) {
        await db.bags.bulkPut(
          newBags.map((record) => ({ ...record, ownerId: destinationOwnerId })),
        );
      }
      if (newMachines.length) {
        await db.machines.bulkPut(
          newMachines.map((record) => ({
            ...record,
            ownerId: destinationOwnerId,
          })),
        );
      }
      if (newGrinders.length) {
        await db.grinders.bulkPut(
          newGrinders.map((record) => ({
            ...record,
            ownerId: destinationOwnerId,
          })),
        );
      }
      if (newBrews.length) {
        await db.brews.bulkPut(
          newBrews.map((record) => ({
            ...record,
            ownerId: destinationOwnerId,
            syncState: "pending" as const,
          })),
        );
      }
      for (const operation of operations) await db.operations.add(operation);
      if (snapshot.onboardedPreference !== undefined) {
        await db.preferences.put({
          key: ownerPreferenceKey(destinationOwnerId, "onboarded"),
          value: snapshot.onboardedPreference,
        });
      }
      await db.preferences.put({
        key: ownerPreferenceKey(destinationOwnerId, activeJournalKey),
        value: JSON.stringify(journal),
      });

      return journal;
    },
  );
}

function ownerPreferencePrefix(ownerId: string): string {
  return `${ownerId.length}:${ownerId}:`;
}

export async function completeAnonymousTransfer(
  destinationOwnerId: string,
): Promise<{ completed: boolean; pendingCount: number }> {
  return db.transaction(
    "rw",
    [
      db.coffees,
      db.bags,
      db.machines,
      db.grinders,
      db.brews,
      db.preferences,
      db.operations,
    ],
    async () => {
      const journal = await readJournal(destinationOwnerId);
      if (!journal) {
        const sourceDestinationOwnerId = await getOwnerPreference(
          ANONYMOUS_OWNER_ID,
          ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
        );
        if (sourceDestinationOwnerId === undefined) {
          return { completed: true as const, pendingCount: 0 };
        }
        throw new Error("Anonymous transfer journal is missing");
      }
      const acknowledged = new Set(journal.acknowledgedOperationIds);
      const pendingCount = journal.operationIds.filter(
        (operationId) => !acknowledged.has(operationId),
      ).length;
      if (pendingCount > 0) {
        return { completed: false as const, pendingCount };
      }

      await Promise.all([
        db.coffees.where("ownerId").equals(ANONYMOUS_OWNER_ID).delete(),
        db.bags.where("ownerId").equals(ANONYMOUS_OWNER_ID).delete(),
        db.machines.where("ownerId").equals(ANONYMOUS_OWNER_ID).delete(),
        db.grinders.where("ownerId").equals(ANONYMOUS_OWNER_ID).delete(),
        db.brews.where("ownerId").equals(ANONYMOUS_OWNER_ID).delete(),
        db.operations.where("ownerId").equals(ANONYMOUS_OWNER_ID).delete(),
        db.preferences
          .where("key")
          .startsWith(ownerPreferencePrefix(ANONYMOUS_OWNER_ID))
          .delete(),
        db.preferences.bulkDelete([
          ownerPreferenceKey(destinationOwnerId, activeJournalKey),
          ownerPreferenceKey(destinationOwnerId, dismissedKey),
        ]),
      ]);
      return { completed: true as const, pendingCount: 0 };
    },
  );
}

export async function deferAnonymousTransfer(
  destinationOwnerId: string,
): Promise<void> {
  await db.transaction("rw", db.preferences, async () => {
    if (await readJournal(destinationOwnerId)) {
      throw new Error(
        `Anonymous transfer is already active for ${destinationOwnerId}`,
      );
    }
    await db.preferences.put({
      key: ownerPreferenceKey(destinationOwnerId, dismissedKey),
      value: "true",
    });
  });
}
