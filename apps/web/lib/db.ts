import Dexie, { type EntityTable } from "dexie";
import type {
  Bean,
  Brew,
  Grinder,
  Machine,
  Preference,
  SyncEntity,
  SyncOperation,
} from "./models";

export class DialedDatabase extends Dexie {
  beans!: EntityTable<Bean, "id">;
  machines!: EntityTable<Machine, "id">;
  grinders!: EntityTable<Grinder, "id">;
  brews!: EntityTable<Brew, "id">;
  preferences!: EntityTable<Preference, "key">;
  operations!: EntityTable<SyncOperation, "operationId">;

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

export async function clearLocalData() {
  await db.transaction(
    "rw",
    [
      db.beans,
      db.machines,
      db.grinders,
      db.brews,
      db.preferences,
      db.operations,
    ],
    async () => {
      await Promise.all([
        db.beans.clear(),
        db.machines.clear(),
        db.grinders.clear(),
        db.brews.clear(),
        db.preferences.clear(),
        db.operations.clear(),
      ]);
    },
  );
}

function operation(
  entity: SyncEntity,
  entityId: string,
  payload: Record<string, unknown>,
): SyncOperation {
  return {
    operationId: makeId(),
    entity,
    entityId,
    action: "upsert",
    payload,
    createdAt: new Date().toISOString(),
  };
}

export async function saveBean(bean: Bean) {
  await db.transaction("rw", [db.beans, db.operations], async () => {
    await db.beans.put(bean);
    await db.operations.add(operation("bean", bean.id, { ...bean }));
  });
}

export async function saveMachine(machine: Machine) {
  await db.transaction("rw", [db.machines, db.operations], async () => {
    await db.machines.put(machine);
    await db.operations.add(operation("machine", machine.id, { ...machine }));
  });
}

export async function saveGrinder(grinder: Grinder) {
  await db.transaction("rw", [db.grinders, db.operations], async () => {
    await db.grinders.put(grinder);
    await db.operations.add(operation("grinder", grinder.id, { ...grinder }));
  });
}

export async function saveBrew(brew: Brew) {
  const pending = { ...brew, syncState: "pending" as const };
  await db.transaction("rw", [db.brews, db.operations], async () => {
    await db.brews.put(pending);
    await db.operations.add(operation("brew", brew.id, pending));
  });
}

export async function updateBrew(id: string, changes: Partial<Brew>) {
  const current = await db.brews.get(id);
  if (!current) return;
  await saveBrew({ ...current, ...changes, id, syncState: "pending" });
}

export async function applyRemoteOperation(remote: {
  entity: SyncEntity;
  entityId: string;
  action: "upsert" | "delete";
  payload?: Record<string, unknown> | null;
}) {
  const table =
    remote.entity === "bean"
      ? db.beans
      : remote.entity === "machine"
        ? db.machines
        : remote.entity === "grinder"
          ? db.grinders
          : db.brews;

  if (remote.action === "delete") {
    await table.delete(remote.entityId);
    return;
  }
  if (!remote.payload) return;
  const payload =
    remote.entity === "brew"
      ? { ...remote.payload, syncState: "synced" }
      : remote.payload;
  await table.put(payload as never);
}
