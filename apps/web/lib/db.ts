import Dexie, { type EntityTable, type Table, type Transaction } from "dexie";
import type {
  Bean,
  Brew,
  Coffee,
  CoffeeBag,
  Grinder,
  Machine,
  Owned,
  Preference,
  SyncEntity,
  SyncOperation,
} from "./models";
import { ANONYMOUS_OWNER_ID } from "./models";
import {
  parseLegacyBeanRemotePayload,
  parseRemoteEntity,
  parseRemotePayload,
  RemoteEntityIdSchema,
  type LegacyBeanRemotePayload,
  type RemotePayload,
} from "./sync-payloads";
import {
  ANONYMOUS_TRANSFER_JOURNAL_KEY,
  ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
  AnonymousTransferStateError,
  parseBoundAnonymousTransferJournal,
} from "./anonymous-transfer-state";

export { ANONYMOUS_OWNER_ID } from "./models";

export type ClearOwnerDataResult =
  | { cleared: true }
  | {
      cleared: false;
      reason: "pending-operations";
      pendingCount: number;
    };

export class DeletedOwnerWriteError extends Error {
  constructor(public readonly ownerId: string) {
    super(`Cannot write data for deleted owner ${ownerId}`);
    this.name = "DeletedOwnerWriteError";
  }
}

export class OwnerTransferInProgressError extends Error {
  constructor(public readonly destinationOwnerId: string) {
    super(
      `Anonymous data is being transferred to ${destinationOwnerId}; anonymous writes are frozen`,
    );
    this.name = "OwnerTransferInProgressError";
  }
}

type OwnerScopedKey = [ownerId: string, localId: string];
const deletedOwnerMarkerKey = "deleted-owner";
const ownerMutationStatePrefix = "owner-mutation-state";

interface StoredOwnerMutationState {
  version: 1;
  generation: number;
  activeToken?: string;
}

export interface OwnerMutationState {
  generation: number;
  activeToken?: string;
  deleted: boolean;
}

export class OwnerMutationStateError extends Error {
  constructor() {
    super("Owner mutation state is inconsistent; local data was preserved");
    this.name = "OwnerMutationStateError";
  }
}

const legacyStores = {
  beans: "id, ownerId, [ownerId+createdAt], name, roaster, createdAt",
  machines: "id, ownerId, [ownerId+createdAt], name, createdAt",
  grinders: "id, ownerId, [ownerId+createdAt], name, createdAt",
  brews:
    "id, ownerId, [ownerId+createdAt], [ownerId+beanId], beanId, machineId, grinderId, createdAt, dialedAt, syncState",
  preferences: "key",
  operations:
    "operationId, ownerId, [ownerId+createdAt], entity, entityId, createdAt",
} as const;

const ownerScopedStores = {
  ownedBeans:
    "[ownerId+id], ownerId, [ownerId+createdAt], id, name, roaster, createdAt",
  ownedMachines:
    "[ownerId+id], ownerId, [ownerId+createdAt], id, name, createdAt",
  ownedGrinders:
    "[ownerId+id], ownerId, [ownerId+createdAt], id, name, createdAt",
  ownedBrews:
    "[ownerId+id], ownerId, [ownerId+createdAt], [ownerId+beanId], id, beanId, machineId, grinderId, createdAt, dialedAt, syncState",
  ownedOperations:
    "[ownerId+operationId], ownerId, [ownerId+createdAt], operationId, entity, entityId, createdAt",
} as const;

const coffeeAndBagStores = {
  ownedCoffees:
    "[ownerId+id], ownerId, [ownerId+createdAt], id, name, roaster, createdAt",
  ownedBeans:
    "[ownerId+id], ownerId, [ownerId+createdAt], [ownerId+coffeeId], id, coffeeId, createdAt",
} as const;

const migratedTablePairs = [
  ["beans", "ownedBeans"],
  ["machines", "ownedMachines"],
  ["grinders", "ownedGrinders"],
  ["brews", "ownedBrews"],
  ["operations", "ownedOperations"],
] as const;

async function copyTables(
  transaction: Transaction,
  pairs: ReadonlyArray<readonly [source: string, destination: string]>,
): Promise<void> {
  for (const [source, destination] of pairs) {
    const records = await transaction.table(source).toArray();
    if (records.length) await transaction.table(destination).bulkPut(records);
  }
}

function ownerKey(ownerId: string, localId: string): OwnerScopedKey {
  return [ownerId, localId];
}

function coffeeFromLegacyBean(bean: Bean): Coffee {
  const { id, name, roaster, origin, roastLevel, createdAt } = bean;
  return {
    id,
    name,
    roaster,
    originCountry: origin,
    roastLevel,
    createdAt,
  };
}

function bagFromLegacyBean(bean: Bean): CoffeeBag {
  return {
    id: bean.id,
    coffeeId: bean.id,
    legacyPairedCoffee: true,
    createdAt: bean.createdAt,
  };
}

export class DialedDatabase extends Dexie {
  coffees!: Table<Owned<Coffee>, OwnerScopedKey>;
  bags!: Table<Owned<CoffeeBag>, OwnerScopedKey>;
  machines!: Table<Owned<Machine>, OwnerScopedKey>;
  grinders!: Table<Owned<Grinder>, OwnerScopedKey>;
  brews!: Table<Owned<Brew>, OwnerScopedKey>;
  preferences!: EntityTable<Preference, "key">;
  operations!: Table<Owned<SyncOperation>, OwnerScopedKey>;

  constructor() {
    super("dialed-local");
    this.version(1).stores({
      beans: "id, name, roaster, createdAt",
      machines: "id, name, createdAt",
      grinders: "id, name, createdAt",
      brews: "id, beanId, machineId, grinderId, createdAt, dialedAt, syncState",
      preferences: "key",
    });
    this.version(2).stores({
      beans: "id, name, roaster, createdAt",
      machines: "id, name, createdAt",
      grinders: "id, name, createdAt",
      brews: "id, beanId, machineId, grinderId, createdAt, dialedAt, syncState",
      preferences: "key",
      operations: "operationId, entity, entityId, createdAt",
    });
    this.version(3)
      .stores(legacyStores)
      .upgrade(async (transaction) => {
        await Promise.all(
          ["beans", "machines", "grinders", "brews", "operations"].map(
            (tableName) =>
              transaction
                .table(tableName)
                .toCollection()
                .modify((record: Record<string, unknown>) => {
                  record.ownerId = ANONYMOUS_OWNER_ID;
                }),
          ),
        );

        const preferences = await transaction.table("preferences").toArray();
        if (preferences.length) {
          await transaction.table("preferences").clear();
          await transaction.table("preferences").bulkPut(
            preferences.map((preference: Preference) => ({
              ...preference,
              key: ownerPreferenceKey(ANONYMOUS_OWNER_ID, preference.key),
            })),
          );
        }
      });
    // IndexedDB cannot alter a store's primary key. Migrate into permanently
    // owner-keyed stores, then expose them through the existing table API.
    this.version(4)
      .stores({ ...legacyStores, ...ownerScopedStores })
      .upgrade((transaction) => copyTables(transaction, migratedTablePairs));
    this.version(5).stores({
      beans: null,
      machines: null,
      grinders: null,
      brews: null,
      operations: null,
      preferences: "key",
      ...ownerScopedStores,
    });
    this.version(6)
      .stores({
        preferences: "key",
        ...ownerScopedStores,
        ...coffeeAndBagStores,
      })
      .upgrade(async (transaction) => {
        const legacyBeans = (await transaction
          .table("ownedBeans")
          .toArray()) as Array<Owned<Bean>>;
        if (!legacyBeans.length) return;

        await transaction.table("ownedCoffees").bulkPut(
          legacyBeans.map(({ ownerId, ...legacyBean }) => ({
            ...coffeeFromLegacyBean(legacyBean),
            ownerId,
          })),
        );
        await transaction.table("ownedBeans").bulkPut(
          legacyBeans.map(({ ownerId, id, createdAt }) => ({
            ownerId,
            id,
            coffeeId: id,
            legacyPairedCoffee: true,
            createdAt,
          })),
        );
      });

    this.coffees = this.table("ownedCoffees");
    this.bags = this.table("ownedBeans");
    this.machines = this.table("ownedMachines");
    this.grinders = this.table("ownedGrinders");
    this.brews = this.table("ownedBrews");
    this.operations = this.table("ownedOperations");
  }
}

export const db = new DialedDatabase();

export function makeId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function ownerPreferencePrefix(ownerId: string): string {
  return `${ownerId.length}:${ownerId}:`;
}

export function ownerPreferenceKey(ownerId: string, key: string): string {
  return `${ownerPreferencePrefix(ownerId)}${key}`;
}

function ownerMutationStateKey(ownerId: string): string {
  return `${ownerMutationStatePrefix}:${ownerId.length}:${ownerId}`;
}

function parseOwnerMutationState(
  value: string | undefined,
): StoredOwnerMutationState {
  if (value === undefined) return { version: 1, generation: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new OwnerMutationStateError();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OwnerMutationStateError();
  }
  const state = parsed as Record<string, unknown>;
  const keys = Object.keys(state);
  if (
    (keys.length !== 2 && keys.length !== 3) ||
    keys.some(
      (key) =>
        key !== "version" && key !== "generation" && key !== "activeToken",
    ) ||
    state.version !== 1 ||
    !Number.isSafeInteger(state.generation) ||
    Number(state.generation) < 0 ||
    (state.activeToken !== undefined &&
      (typeof state.activeToken !== "string" || state.activeToken.length === 0))
  ) {
    throw new OwnerMutationStateError();
  }
  return state as unknown as StoredOwnerMutationState;
}

export async function getOwnerMutationState(
  ownerId: string,
): Promise<OwnerMutationState> {
  return db.transaction("r", db.preferences, async () => {
    const [stored, deleted] = await Promise.all([
      db.preferences.get(ownerMutationStateKey(ownerId)),
      db.preferences.get(ownerPreferenceKey(ownerId, deletedOwnerMarkerKey)),
    ]);
    const state = parseOwnerMutationState(stored?.value);
    return {
      generation: state.generation,
      ...(state.activeToken === undefined
        ? {}
        : { activeToken: state.activeToken }),
      deleted: deleted !== undefined,
    };
  });
}

export async function beginOwnerMutation(
  ownerId: string,
): Promise<{ generation: number; token: string }> {
  const token = makeId();
  return db.transaction("rw", db.preferences, async () => {
    const key = ownerMutationStateKey(ownerId);
    const current = parseOwnerMutationState(
      (await db.preferences.get(key))?.value,
    );
    if (current.activeToken !== undefined) {
      throw new OwnerMutationStateError();
    }
    const generation = current.generation + 1;
    if (!Number.isSafeInteger(generation)) {
      throw new OwnerMutationStateError();
    }
    await db.preferences.put({
      key,
      value: JSON.stringify({
        version: 1,
        generation,
        activeToken: token,
      }),
    });
    return { generation, token };
  });
}

export async function finishOwnerMutation(
  ownerId: string,
  token: string,
): Promise<void> {
  await db.transaction("rw", db.preferences, async () => {
    const key = ownerMutationStateKey(ownerId);
    const current = parseOwnerMutationState(
      (await db.preferences.get(key))?.value,
    );
    if (current.activeToken !== token) {
      throw new OwnerMutationStateError();
    }
    await db.preferences.put({
      key,
      value: JSON.stringify({
        version: 1,
        generation: current.generation,
      }),
    });
  });
}

export async function getOwnerPreference(
  ownerId: string,
  key: string,
): Promise<string | undefined> {
  return (await db.preferences.get(ownerPreferenceKey(ownerId, key)))?.value;
}

export async function setOwnerPreference(
  ownerId: string,
  key: string,
  value: string,
): Promise<void> {
  await db.transaction("rw", db.preferences, async () => {
    await assertOwnerWritable(ownerId);
    await db.preferences.put({ key: ownerPreferenceKey(ownerId, key), value });
  });
}

export async function getCoffees(
  ownerId: string,
): Promise<Array<Owned<Coffee>>> {
  return db.coffees.where("ownerId").equals(ownerId).sortBy("createdAt");
}

export async function getCoffeeBags(
  ownerId: string,
): Promise<Array<Owned<CoffeeBag>>> {
  return db.bags.where("ownerId").equals(ownerId).sortBy("createdAt");
}

export async function getMachines(
  ownerId: string,
): Promise<Array<Owned<Machine>>> {
  return db.machines.where("ownerId").equals(ownerId).sortBy("createdAt");
}

export async function getGrinders(
  ownerId: string,
): Promise<Array<Owned<Grinder>>> {
  return db.grinders.where("ownerId").equals(ownerId).sortBy("createdAt");
}

export async function getBrews(ownerId: string): Promise<Array<Owned<Brew>>> {
  return db.brews.where("ownerId").equals(ownerId).sortBy("createdAt");
}

export async function getOperations(
  ownerId: string,
  limit?: number,
): Promise<Array<Owned<SyncOperation>>> {
  const operations = await db.operations
    .where("ownerId")
    .equals(ownerId)
    .sortBy("createdAt");
  return limit === undefined ? operations : operations.slice(0, limit);
}

export async function getOperationsByIds(
  ownerId: string,
  operationIds: readonly string[],
  limit?: number,
): Promise<Array<Owned<SyncOperation>>> {
  const selectedIds =
    limit === undefined ? operationIds : operationIds.slice(0, limit);
  const operations = await db.operations.bulkGet(
    selectedIds.map((operationId) => ownerKey(ownerId, operationId)),
  );
  return operations.filter(
    (operation): operation is Owned<SyncOperation> => operation !== undefined,
  );
}

export async function clearOwnerData(
  ownerId: string,
): Promise<ClearOwnerDataResult> {
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
      await assertOwnerWritable(ownerId);
      const pendingCount = await db.operations
        .where("ownerId")
        .equals(ownerId)
        .count();
      if (pendingCount > 0) {
        return {
          cleared: false as const,
          reason: "pending-operations" as const,
          pendingCount,
        };
      }

      await deleteOwnerRecords(ownerId);

      return { cleared: true as const };
    },
  );
}

async function deleteOwnerRecords(ownerId: string): Promise<void> {
  await Promise.all([
    db.coffees.where("ownerId").equals(ownerId).delete(),
    db.bags.where("ownerId").equals(ownerId).delete(),
    db.machines.where("ownerId").equals(ownerId).delete(),
    db.grinders.where("ownerId").equals(ownerId).delete(),
    db.brews.where("ownerId").equals(ownerId).delete(),
    db.preferences
      .where("key")
      .startsWith(ownerPreferencePrefix(ownerId))
      .delete(),
    db.operations.where("ownerId").equals(ownerId).delete(),
  ]);
}

async function destructivelyClearOwnerData(
  ownerId: string,
  markDeleted: boolean,
  requireWritableOwner = false,
): Promise<{ cleared: true }> {
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
      if (requireWritableOwner) await assertOwnerWritable(ownerId);
      await deleteOwnerRecords(ownerId);
      if (markDeleted) {
        await db.preferences.put({
          key: ownerPreferenceKey(ownerId, deletedOwnerMarkerKey),
          value: new Date().toISOString(),
        });
      }
      return { cleared: true as const };
    },
  );
}

export async function discardAnonymousData(): Promise<{ cleared: true }> {
  return destructivelyClearOwnerData(ANONYMOUS_OWNER_ID, false, true);
}

export async function clearDeletedAccountData(
  ownerId: string,
): Promise<{ cleared: true }> {
  if (ownerId === ANONYMOUS_OWNER_ID) {
    throw new Error("Deleted-account cleanup cannot target anonymous data");
  }
  return destructivelyClearOwnerData(ownerId, true);
}

async function assertOwnerWritable(ownerId: string): Promise<void> {
  if (ownerId === ANONYMOUS_OWNER_ID) {
    const transfer = await db.preferences.get(
      ownerPreferenceKey(ownerId, ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY),
    );
    if (transfer) throw new OwnerTransferInProgressError(transfer.value);
  }
  const deleted = await db.preferences.get(
    ownerPreferenceKey(ownerId, deletedOwnerMarkerKey),
  );
  if (deleted) throw new DeletedOwnerWriteError(ownerId);
}

function operation(
  ownerId: string,
  entity: SyncEntity,
  entityId: string,
  payload: Record<string, unknown>,
  createdAt = new Date().toISOString(),
): Owned<SyncOperation> {
  return {
    ownerId,
    operationId: makeId(),
    entity,
    entityId,
    action: "upsert",
    payload,
    createdAt,
  };
}

function deletionOperation(
  ownerId: string,
  entity: SyncEntity,
  entityId: string,
): Owned<SyncOperation> {
  return {
    ownerId,
    operationId: makeId(),
    entity,
    entityId,
    action: "delete",
    createdAt: new Date().toISOString(),
  };
}

export async function saveCoffeeWithBag(
  ownerId: string,
  coffee: Coffee,
  bag: CoffeeBag,
): Promise<void> {
  if (bag.coffeeId !== coffee.id) {
    throw new Error("Coffee bag must reference its Coffee");
  }

  await db.transaction(
    "rw",
    [db.coffees, db.bags, db.operations, db.preferences],
    async () => {
      await assertOwnerWritable(ownerId);
      await db.coffees.put({ ...coffee, ownerId });
      await db.bags.put({ ...bag, ownerId });
      const coffeeOperationAt = Date.now();
      await db.operations.add(
        operation(
          ownerId,
          "coffee",
          coffee.id,
          { ...coffee },
          new Date(coffeeOperationAt).toISOString(),
        ),
      );
      await db.operations.add(
        operation(
          ownerId,
          "bean",
          bag.id,
          { ...bag },
          new Date(coffeeOperationAt + 1).toISOString(),
        ),
      );
    },
  );
}

export async function saveCoffeeBag(
  ownerId: string,
  bag: CoffeeBag,
): Promise<void> {
  await db.transaction(
    "rw",
    [db.coffees, db.bags, db.operations, db.preferences],
    async () => {
      await assertOwnerWritable(ownerId);
      const coffee = await db.coffees.get(ownerKey(ownerId, bag.coffeeId));
      if (!coffee) throw new Error("Coffee does not exist for owner");
      await db.bags.put({ ...bag, ownerId });
      await db.operations.add(operation(ownerId, "bean", bag.id, { ...bag }));
    },
  );
}

export async function saveMachine(ownerId: string, machine: Machine) {
  await db.transaction(
    "rw",
    [db.machines, db.operations, db.preferences],
    async () => {
      await assertOwnerWritable(ownerId);
      await db.machines.put({ ...machine, ownerId });
      await db.operations.add(
        operation(ownerId, "machine", machine.id, { ...machine }),
      );
    },
  );
}

export async function saveGrinder(ownerId: string, grinder: Grinder) {
  await db.transaction(
    "rw",
    [db.grinders, db.operations, db.preferences],
    async () => {
      await assertOwnerWritable(ownerId);
      await db.grinders.put({ ...grinder, ownerId });
      await db.operations.add(
        operation(ownerId, "grinder", grinder.id, { ...grinder }),
      );
    },
  );
}

export async function saveBrew(ownerId: string, brew: Brew) {
  const pending = { ...brew, syncState: "pending" as const };
  await db.transaction(
    "rw",
    [db.brews, db.operations, db.preferences],
    async () => {
      await assertOwnerWritable(ownerId);
      await db.brews.put({ ...pending, ownerId });
      await db.operations.add(operation(ownerId, "brew", brew.id, pending));
    },
  );
}

export async function deleteBrew(
  ownerId: string,
  id: string,
): Promise<boolean> {
  return db.transaction(
    "rw",
    [db.brews, db.operations, db.preferences],
    async () => {
      await assertOwnerWritable(ownerId);
      const key = ownerKey(ownerId, id);
      const current = await db.brews.get(key);
      if (!current) return false;
      const supersededOperationIds = (
        await db.operations.where("ownerId").equals(ownerId).toArray()
      )
        .filter(
          (pending) => pending.entity === "brew" && pending.entityId === id,
        )
        .map((pending) => pending.operationId);
      await db.operations.bulkDelete(
        supersededOperationIds.map((operationId) =>
          ownerKey(ownerId, operationId),
        ),
      );
      await db.brews.delete(key);
      await db.operations.add(deletionOperation(ownerId, "brew", id));
      return true;
    },
  );
}

export async function updateBrew(
  ownerId: string,
  id: string,
  changes: Partial<Brew>,
): Promise<boolean> {
  return db.transaction(
    "rw",
    [db.brews, db.operations, db.preferences],
    async () => {
      await assertOwnerWritable(ownerId);
      const current = await db.brews.get(ownerKey(ownerId, id));
      if (!current) return false;
      const { ownerId: _storedOwnerId, ...brew } = current;
      const pending = {
        ...brew,
        ...changes,
        id,
        syncState: "pending" as const,
      };
      await db.brews.put({ ...pending, ownerId });
      await db.operations.add(operation(ownerId, "brew", id, pending));
      return true;
    },
  );
}

export async function removeOperations(
  ownerId: string,
  operationIds: string[],
): Promise<void> {
  await db.transaction("rw", [db.operations, db.preferences], async () => {
    await assertOwnerWritable(ownerId);
    const ownedIds = (
      await db.operations.where("ownerId").equals(ownerId).toArray()
    )
      .filter(({ operationId }) => operationIds.includes(operationId))
      .map(({ operationId }) => operationId);
    await db.operations.bulkDelete(
      ownedIds.map((operationId) => ownerKey(ownerId, operationId)),
    );
  });
}

export async function markBrewSynced(
  ownerId: string,
  brewId: string,
): Promise<boolean> {
  return db.transaction("rw", [db.brews, db.preferences], async () => {
    await assertOwnerWritable(ownerId);
    const key = ownerKey(ownerId, brewId);
    const brew = await db.brews.get(key);
    if (!brew) return false;
    await db.brews.update(key, { syncState: "synced" });
    return true;
  });
}

export async function acknowledgeOperations(
  ownerId: string,
  operationIds: string[],
): Promise<void> {
  if (!operationIds.length) return;
  const exactIds = [...new Set(operationIds)];
  await db.transaction(
    "rw",
    [db.operations, db.brews, db.preferences],
    async () => {
      await assertOwnerWritable(ownerId);
      const journalPreferenceKey = ownerPreferenceKey(
        ownerId,
        ANONYMOUS_TRANSFER_JOURNAL_KEY,
      );
      const [journalPreference, sourceDestinationOwnerId] = await Promise.all([
        db.preferences.get(journalPreferenceKey),
        db.preferences.get(
          ownerPreferenceKey(
            ANONYMOUS_OWNER_ID,
            ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
          ),
        ),
      ]);
      if (journalPreference) {
        const journal = parseBoundAnonymousTransferJournal(
          journalPreference.value,
          ownerId,
          sourceDestinationOwnerId?.value,
        );
        const transferOperationIds = new Set(journal.operationIds);
        const acknowledgedOperationIds = new Set(
          journal.acknowledgedOperationIds,
        );
        for (const operationId of exactIds) {
          if (transferOperationIds.has(operationId)) {
            acknowledgedOperationIds.add(operationId);
          }
        }
        await db.preferences.put({
          key: journalPreferenceKey,
          value: JSON.stringify({
            ...journal,
            acknowledgedOperationIds: [...acknowledgedOperationIds],
          }),
        });
      } else if (sourceDestinationOwnerId?.value === ownerId) {
        throw new AnonymousTransferStateError();
      }

      const acknowledged: Array<Owned<SyncOperation>> = [];
      for (const operationId of exactIds) {
        const operation = await db.operations.get(
          ownerKey(ownerId, operationId),
        );
        if (operation) acknowledged.push(operation);
      }

      await db.operations.bulkDelete(
        acknowledged.map((operation) =>
          ownerKey(ownerId, operation.operationId),
        ),
      );

      const affectedBrews = new Set(
        acknowledged
          .filter((operation) => operation.entity === "brew")
          .map((operation) => operation.entityId),
      );
      if (!affectedBrews.size) return;

      const remaining = await db.operations
        .where("ownerId")
        .equals(ownerId)
        .toArray();
      for (const brewId of affectedBrews) {
        const stillPending = remaining.some(
          (operation) =>
            operation.entity === "brew" && operation.entityId === brewId,
        );
        if (stillPending) continue;
        const key = ownerKey(ownerId, brewId);
        const brew = await db.brews.get(key);
        if (brew) {
          await db.brews.update(key, { syncState: "synced" });
        }
      }
    },
  );
}

export interface RemoteOperation {
  entity: string;
  entityId: string;
  action: "upsert" | "delete";
  payload?: unknown;
}

interface PreparedRemoteOperation {
  entity: SyncEntity;
  entityId: string;
  action: "upsert" | "delete";
  payload?: RemotePayload;
}

type OwnerScopedRecord =
  | Owned<Coffee>
  | Owned<CoffeeBag>
  | Owned<Machine>
  | Owned<Grinder>
  | Owned<Brew>;

function isLegacyBeanPayload(
  payload: unknown,
): payload is LegacyBeanRemotePayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "kind" in payload &&
    payload.kind === "legacy-bean"
  );
}

function prepareRemoteOperation(
  remote: RemoteOperation,
): PreparedRemoteOperation {
  const entity = parseRemoteEntity(remote.entity);
  const entityId = RemoteEntityIdSchema.parse(remote.entityId);
  let payload: RemotePayload | undefined;
  if (remote.action === "upsert") {
    if (remote.payload == null) {
      throw new Error("Remote upsert payload is required");
    }
    payload =
      entity === "bean" && isLegacyBeanPayload(remote.payload)
        ? parseLegacyBeanRemotePayload(remote.payload)
        : parseRemotePayload(entity, remote.payload);
    const payloadId = isLegacyBeanPayload(payload)
      ? payload.bag.id
      : payload.id;
    if (payloadId !== entityId) {
      throw new Error(
        `Payload ID ${payloadId} does not match envelope ID ${entityId}`,
      );
    }
  }

  return { entity, entityId, action: remote.action, payload };
}

function tableForEntity(
  entity: SyncEntity,
): Table<OwnerScopedRecord, OwnerScopedKey> {
  const table =
    entity === "coffee"
      ? db.coffees
      : entity === "bean"
        ? db.bags
        : entity === "machine"
          ? db.machines
          : entity === "grinder"
            ? db.grinders
            : db.brews;
  return table as unknown as Table<OwnerScopedRecord, OwnerScopedKey>;
}

async function hasPendingLocalOperation(
  ownerId: string,
  entity: SyncEntity,
  entityId: string,
  ignoredPendingIds: ReadonlySet<string>,
): Promise<boolean> {
  const pending = await db.operations
    .where("ownerId")
    .equals(ownerId)
    .filter(
      (candidate) =>
        candidate.entity === entity &&
        candidate.entityId === entityId &&
        !ignoredPendingIds.has(candidate.operationId),
    )
    .first();
  return pending !== undefined;
}

async function applyPreparedRemoteOperation(
  ownerId: string,
  remote: PreparedRemoteOperation,
  ignoredPendingIds: ReadonlySet<string>,
): Promise<void> {
  const table = tableForEntity(remote.entity);
  const key = ownerKey(ownerId, remote.entityId);
  const current = await table.get(key);
  const legacyBeanPayload =
    remote.action === "upsert" &&
    remote.entity === "bean" &&
    isLegacyBeanPayload(remote.payload)
      ? remote.payload
      : undefined;
  const hasPendingEntityOperation = await hasPendingLocalOperation(
    ownerId,
    remote.entity,
    remote.entityId,
    ignoredPendingIds,
  );
  if (hasPendingEntityOperation && !legacyBeanPayload) return;

  if (remote.action === "delete") {
    if (remote.entity === "coffee") {
      const activeBag = await db.bags
        .where("[ownerId+coffeeId]")
        .equals([ownerId, remote.entityId])
        .first();
      if (activeBag) {
        throw new Error("Coffee is still referenced by a bag for owner");
      }
    }
    if (!current) return;
    await table.delete(key);
    if (remote.entity !== "bean") return;

    const deletedBag = current as Owned<CoffeeBag>;
    if (!deletedBag.legacyPairedCoffee) return;
    const hasPendingCoffeeOperation = await hasPendingLocalOperation(
      ownerId,
      "coffee",
      deletedBag.coffeeId,
      ignoredPendingIds,
    );
    if (hasPendingCoffeeOperation) return;
    const otherBag = await db.bags
      .where("[ownerId+coffeeId]")
      .equals([ownerId, deletedBag.coffeeId])
      .first();
    if (!otherBag) {
      await db.coffees.delete(ownerKey(ownerId, deletedBag.coffeeId));
    }
    return;
  }

  if (legacyBeanPayload) {
    const hasPendingCoffeeOperation = await hasPendingLocalOperation(
      ownerId,
      "coffee",
      legacyBeanPayload.coffee.id,
      ignoredPendingIds,
    );
    if (!hasPendingCoffeeOperation) {
      await db.coffees.put({ ...legacyBeanPayload.coffee, ownerId });
    }
    if (!hasPendingEntityOperation) {
      await db.bags.put({ ...legacyBeanPayload.bag, ownerId });
    }
    return;
  }

  if (remote.entity === "bean") {
    const bag = remote.payload as CoffeeBag;
    const coffee = await db.coffees.get(ownerKey(ownerId, bag.coffeeId));
    if (!coffee) throw new Error("Coffee does not exist for owner");
  }

  const record =
    remote.entity === "brew"
      ? { ...remote.payload!, ownerId, syncState: "synced" as const }
      : { ...remote.payload!, ownerId };
  await table.put(record as OwnerScopedRecord);
}

export async function applyRemoteOperation(
  ownerId: string,
  remote: RemoteOperation,
  ignoredPendingOperationIds: readonly string[] = [],
): Promise<void> {
  const prepared = prepareRemoteOperation(remote);
  const table = tableForEntity(prepared.entity);

  await db.transaction(
    "rw",
    remote.entity === "coffee" || remote.entity === "bean"
      ? [db.coffees, db.bags, db.operations, db.preferences]
      : [table, db.operations, db.preferences],
    async () => {
      await assertOwnerWritable(ownerId);
      await applyPreparedRemoteOperation(
        ownerId,
        prepared,
        new Set(ignoredPendingOperationIds),
      );
    },
  );
}

export async function applyRemotePage(
  ownerId: string,
  operations: readonly RemoteOperation[],
  preferenceKey: string,
  cursor: number,
  ignoredPendingOperationIds: readonly string[] = [],
): Promise<void> {
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new Error("Remote page cursor is malformed");
  }

  // Validate the complete page before opening a write transaction.
  const prepared = operations.map(prepareRemoteOperation);
  const ignoredPendingIds = new Set(ignoredPendingOperationIds);
  await db.transaction(
    "rw",
    [
      db.coffees,
      db.bags,
      db.machines,
      db.grinders,
      db.brews,
      db.operations,
      db.preferences,
    ],
    async () => {
      await assertOwnerWritable(ownerId);
      const storedCursorValue = (
        await db.preferences.get(ownerPreferenceKey(ownerId, preferenceKey))
      )?.value;
      const storedCursor = Number(storedCursorValue);
      if (
        Number.isInteger(storedCursor) &&
        storedCursor >= 0 &&
        cursor < storedCursor
      ) {
        return;
      }

      for (const operation of prepared) {
        await applyPreparedRemoteOperation(
          ownerId,
          operation,
          ignoredPendingIds,
        );
      }
      await db.preferences.put({
        key: ownerPreferenceKey(ownerId, preferenceKey),
        value: String(cursor),
      });
    },
  );
}
