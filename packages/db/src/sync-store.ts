import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
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
      const current = await tx
        .select({ revision: syncOperations.revision })
        .from(syncOperations)
        .where(eq(syncOperations.userId, userId))
        .orderBy(desc(syncOperations.revision))
        .limit(1);
      let nextRevision = (current[0]?.revision ?? 0) + 1;
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
