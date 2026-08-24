import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { DialedDatabase } from "./client.js";
import { syncOperations, type SyncAction, type SyncEntity } from "./schema.js";

export interface IncomingSyncOperation {
  operationId: string;
  entity: SyncEntity;
  entityId: string;
  action: SyncAction;
  payload?: Record<string, unknown> | null;
}

export interface StoredSyncOperation extends IncomingSyncOperation {
  revision: number;
  receivedAt: string;
}

export interface PushResult {
  operationId: string;
  revision: number;
  duplicate: boolean;
}

export class InvalidSyncDependencyError extends Error {
  constructor(
    public readonly entityId: string,
    public readonly coffeeId: string,
  ) {
    super(`Coffee bag ${entityId} references a missing Coffee ${coffeeId}`);
    this.name = "InvalidSyncDependencyError";
  }
}

interface ActiveBag {
  coffeeId: string;
  legacyPairedCoffee: boolean;
}

function recordPayload(
  payload: IncomingSyncOperation["payload"],
): Record<string, unknown> | undefined {
  return payload && typeof payload === "object" ? payload : undefined;
}

function applyCoffeeDependencyOperation(
  coffees: Set<string>,
  bags: Map<string, ActiveBag>,
  operation: IncomingSyncOperation,
  validateDependencies: boolean,
): void {
  if (operation.entity === "coffee") {
    if (operation.action === "upsert") {
      coffees.add(operation.entityId);
    } else {
      if (validateDependencies) {
        for (const [bagId, bag] of bags) {
          if (bag.coffeeId === operation.entityId) {
            throw new InvalidSyncDependencyError(bagId, operation.entityId);
          }
        }
      }
      coffees.delete(operation.entityId);
    }
    return;
  }
  if (operation.entity !== "bean") return;

  if (operation.action === "delete") {
    const deletedBag = bags.get(operation.entityId);
    bags.delete(operation.entityId);
    if (
      deletedBag?.legacyPairedCoffee &&
      ![...bags.values()].some((bag) => bag.coffeeId === deletedBag.coffeeId)
    ) {
      coffees.delete(deletedBag.coffeeId);
    }
    return;
  }

  const payload = recordPayload(operation.payload);
  if (!payload) return;
  if (typeof payload.coffeeId !== "string") {
    // A raw legacy Bean creates its paired Coffee and bag during replay.
    coffees.add(operation.entityId);
    bags.set(operation.entityId, {
      coffeeId: operation.entityId,
      legacyPairedCoffee: true,
    });
    return;
  }

  if (validateDependencies && !coffees.has(payload.coffeeId)) {
    throw new InvalidSyncDependencyError(operation.entityId, payload.coffeeId);
  }
  bags.set(operation.entityId, {
    coffeeId: payload.coffeeId,
    legacyPairedCoffee: payload.legacyPairedCoffee === true,
  });
}

/**
 * Projects the user-scoped append-only ledger, then validates each new
 * operation in order. Callers must provide existing operations in revision
 * order and from only the destination user.
 */
export function validateCoffeeBagDependencies(
  existingOperations: readonly IncomingSyncOperation[],
  incomingOperations: readonly IncomingSyncOperation[],
): void {
  const coffees = new Set<string>();
  const bags = new Map<string, ActiveBag>();
  const operationIds = new Set<string>();

  for (const operation of existingOperations) {
    operationIds.add(operation.operationId);
    applyCoffeeDependencyOperation(coffees, bags, operation, false);
  }
  for (const operation of incomingOperations) {
    if (operationIds.has(operation.operationId)) continue;
    applyCoffeeDependencyOperation(coffees, bags, operation, true);
    operationIds.add(operation.operationId);
  }
}

export interface SyncStore {
  health(): Promise<void>;
  push(
    userId: string,
    operations: IncomingSyncOperation[],
  ): Promise<PushResult[]>;
  pull(
    userId: string,
    cursor: number,
    limit: number,
  ): Promise<StoredSyncOperation[]>;
  exportUser(userId: string): Promise<StoredSyncOperation[]>;
  deleteUser(userId: string): Promise<void>;
}

export class PostgresSyncStore implements SyncStore {
  constructor(private readonly db: DialedDatabase) {}

  async health(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }

  async push(
    userId: string,
    operations: IncomingSyncOperation[],
  ): Promise<PushResult[]> {
    return this.db.transaction(async (tx) => {
      // Serializes revision allocation per user without a separate cursor table.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
      const existingLedger = await tx
        .select()
        .from(syncOperations)
        .where(eq(syncOperations.userId, userId))
        .orderBy(asc(syncOperations.revision));
      validateCoffeeBagDependencies(existingLedger, operations);
      let nextRevision = (existingLedger.at(-1)?.revision ?? 0) + 1;
      const results: PushResult[] = [];

      for (const operation of operations) {
        const existing = await tx
          .select({ revision: syncOperations.revision })
          .from(syncOperations)
          .where(
            and(
              eq(syncOperations.userId, userId),
              eq(syncOperations.operationId, operation.operationId),
            ),
          )
          .limit(1);
        if (existing[0]) {
          results.push({
            operationId: operation.operationId,
            revision: existing[0].revision,
            duplicate: true,
          });
          continue;
        }

        await tx.insert(syncOperations).values({
          ...operation,
          userId,
          payload: operation.payload ?? null,
          revision: nextRevision,
        });
        results.push({
          operationId: operation.operationId,
          revision: nextRevision,
          duplicate: false,
        });
        nextRevision += 1;
      }
      return results;
    });
  }

  async pull(
    userId: string,
    cursor: number,
    limit: number,
  ): Promise<StoredSyncOperation[]> {
    const rows = await this.db
      .select()
      .from(syncOperations)
      .where(
        and(
          eq(syncOperations.userId, userId),
          gt(syncOperations.revision, cursor),
        ),
      )
      .orderBy(asc(syncOperations.revision))
      .limit(limit);
    return rows.map(({ userId: _userId, receivedAt, ...row }) => ({
      ...row,
      receivedAt: receivedAt.toISOString(),
    }));
  }

  async exportUser(userId: string): Promise<StoredSyncOperation[]> {
    const rows = await this.db
      .select()
      .from(syncOperations)
      .where(eq(syncOperations.userId, userId))
      .orderBy(asc(syncOperations.revision));
    return rows.map(({ userId: _userId, receivedAt, ...row }) => ({
      ...row,
      receivedAt: receivedAt.toISOString(),
    }));
  }

  async deleteUser(userId: string): Promise<void> {
    // User-owned rows and auth records are removed by cascading foreign keys.
    const { users } = await import("./schema.js");
    await this.db.delete(users).where(eq(users.id, userId));
  }
}
