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
  parseRemoteEntity,
  parseRemotePayload,
  RemoteEntityIdSchema,
  type RemotePayload,
} from "./sync-payloads";

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

type OwnerScopedKey = [ownerId: string, localId: string];
const deletedOwnerMarkerKey = "deleted-owner";

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
    createdAt: bean.createdAt,
  };
}

function legacyRoastLevel(
  roastLevel: Coffee["roastLevel"],
): Bean["roastLevel"] {
  if (roastLevel === "medium-light") return "light";
  if (roastLevel === "medium-dark") return "dark";
  if (roastLevel === "unknown") return "medium";
  return roastLevel;
}

export class DialedDatabase extends Dexie {
  coffees!: Table<Owned<Coffee>, OwnerScopedKey>;
  bags!: Table<Owned<CoffeeBag>, OwnerScopedKey>;
  /** @deprecated Remove in Task 5 after every legacy Bean view is migrated. */
  beans!: Table<Owned<CoffeeBag>, OwnerScopedKey>;
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
            createdAt,
          })),
        );
      });

    this.coffees = this.table("ownedCoffees");
    this.bags = this.table("ownedBeans");
    // Deprecated adapter: remove in Task 5 after every Bean view is migrated.
    this.beans = this.table("ownedBeans");
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
  await db.preferences.put({ key: ownerPreferenceKey(ownerId, key), value });
}

/** @deprecated Remove in Task 5 after every legacy Bean view is migrated. */
export async function getBeans(ownerId: string): Promise<Array<Owned<Bean>>> {
  const [bags, coffees] = await Promise.all([
    getCoffeeBags(ownerId),
    getCoffees(ownerId),
  ]);
  const coffeesById = new Map(coffees.map((coffee) => [coffee.id, coffee]));

  return bags.flatMap((bag) => {
    const coffee = coffeesById.get(bag.coffeeId);
    if (!coffee) return [];
    return [
      {
        ownerId,
        id: bag.id,
        name: coffee.name,
        roaster: coffee.roaster,
        origin: coffee.originCountry,
        roastLevel: legacyRoastLevel(coffee.roastLevel),
        createdAt: bag.createdAt,
      },
    ];
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
  return destructivelyClearOwnerData(ANONYMOUS_OWNER_ID, false);
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
): Owned<SyncOperation> {
  return {
    ownerId,
    operationId: makeId(),
    entity,
    entityId,
    action: "upsert",
    payload,
    createdAt: new Date().toISOString(),
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

/** @deprecated Remove in Task 5 after every legacy Bean view is migrated. */
export async function saveBean(ownerId: string, bean: Bean) {
  await saveCoffeeWithBag(
    ownerId,
    coffeeFromLegacyBean(bean),
    bagFromLegacyBean(bean),
  );
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
      await db.operations.add(
        operation(ownerId, "coffee", coffee.id, { ...coffee }),
      );
      await db.operations.add(operation(ownerId, "bean", bag.id, { ...bag }));
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
  await db.transaction("rw", db.operations, async () => {
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
  return db.transaction("rw", db.brews, async () => {
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
  await db.transaction("rw", [db.operations, db.brews], async () => {
    const acknowledged: Array<Owned<SyncOperation>> = [];
    for (const operationId of exactIds) {
      const operation = await db.operations.get(ownerKey(ownerId, operationId));
      if (operation) acknowledged.push(operation);
    }

    await db.operations.bulkDelete(
      acknowledged.map((operation) => ownerKey(ownerId, operation.operationId)),
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
  });
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
  Owned<CoffeeBag> | Owned<Machine> | Owned<Grinder> | Owned<Brew>;

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
    payload = parseRemotePayload(entity, remote.payload);
    if (payload.id !== entityId) {
      throw new Error(
        `Payload ID ${payload.id} does not match envelope ID ${entityId}`,
      );
    }
  }

  return { entity, entityId, action: remote.action, payload };
}

function tableForEntity(
  entity: SyncEntity,
): Table<OwnerScopedRecord, OwnerScopedKey> {
  const table =
    entity === "bean"
      ? db.bags
      : entity === "machine"
        ? db.machines
        : entity === "grinder"
          ? db.grinders
          : db.brews;
  return table as unknown as Table<OwnerScopedRecord, OwnerScopedKey>;
}

async function applyPreparedRemoteOperation(
  ownerId: string,
  remote: PreparedRemoteOperation,
  ignoredPendingIds: ReadonlySet<string>,
): Promise<void> {
  const table = tableForEntity(remote.entity);
  const key = ownerKey(ownerId, remote.entityId);
  const current = await table.get(key);
  const hasPendingLocalOperation = await db.operations
    .where("ownerId")
    .equals(ownerId)
    .filter(
      (pending) =>
        pending.entity === remote.entity &&
        pending.entityId === remote.entityId &&
        !ignoredPendingIds.has(pending.operationId),
    )
    .first();
  if (hasPendingLocalOperation) return;

  if (remote.action === "delete") {
    if (current) await table.delete(key);
    return;
  }

  if (remote.entity === "bean") {
    const legacyBean = remote.payload as Bean;
    await db.coffees.put({ ...coffeeFromLegacyBean(legacyBean), ownerId });
    await db.bags.put({ ...bagFromLegacyBean(legacyBean), ownerId });
    return;
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
    remote.entity === "bean"
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
