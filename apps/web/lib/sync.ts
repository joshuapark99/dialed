import {
  acknowledgeOperations,
  acquireOwnerMutationFence,
  ANONYMOUS_OWNER_ID,
  applyRemotePage,
  clearDeletedAccountData,
  clearOwnerData,
  DeletedOwnerWriteError,
  finishOwnerMutationFence,
  getOperations,
  getOperationsByIds,
  getOwnerMutationState,
  getOwnerPreference,
  verifyOwnerMutationFence,
  type ClearOwnerDataResult,
  type OwnerMutationFence,
  type OwnerMutationKind,
  type OwnerMutationState,
  type RemoteOperation,
} from "./db";
import {
  completeAnonymousTransfer,
  stageAnonymousTransfer,
  type AnonymousTransferSummary,
  type AnonymousTransferJournal,
} from "./anonymous-transfer";
import {
  ANONYMOUS_TRANSFER_JOURNAL_KEY,
  ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
  AnonymousTransferStateError,
  parseBoundAnonymousTransferJournal,
} from "./anonymous-transfer-state";
import type { AccountUser, Owned, SyncEntity, SyncOperation } from "./models";
import {
  parseRemoteEntity,
  parseRemotePayload,
  RemoteEntityIdSchema,
} from "./sync-payloads";

const cursorKey = "sync-cursor";
const cloudEnabledKey = "dialed-cloud-enabled";

export function isCloudIdentityStorageEvent(
  event: Pick<StorageEvent, "key">,
): boolean {
  return event.key === cloudEnabledKey;
}

interface PullOperation {
  operationId: string;
  entity: SyncEntity;
  entityId: string;
  action: "upsert" | "delete";
  payload?: Record<string, unknown> | null;
  revision: number;
}

export type SyncStatus = "local" | "syncing" | "synced" | "offline" | "error";

export class AuthenticationExpiredError extends Error {
  constructor(public readonly endpoint: "me" | "push" | "pull") {
    super("Your session has expired. Sign in again to synchronize.");
    this.name = "AuthenticationExpiredError";
  }
}

export class AccountMismatchError extends Error {
  constructor(
    public readonly requestedOwnerId: string,
    public readonly actualAccount?: AccountUser,
  ) {
    super(
      actualAccount
        ? `Authenticated account ${actualAccount.id} does not match ${requestedOwnerId}`
        : `Authenticated account does not match ${requestedOwnerId}`,
    );
    this.name = "AccountMismatchError";
  }
}

export class OwnerCacheRebuildError extends Error {
  readonly cacheCleared = true;

  constructor(public readonly cause: unknown) {
    super("The local cache was cleared, but cloud rebuild failed");
    this.name = "OwnerCacheRebuildError";
  }
}

export function ownerIdForAccount(accountId: string): string {
  return `account:${accountId}`;
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface SyncDependencies {
  isOnline(): boolean;
  fetch: FetchLike;
  getOperations(
    ownerId: string,
    limit?: number,
  ): Promise<Array<Owned<SyncOperation>>>;
  getOperationsByIds(
    ownerId: string,
    operationIds: readonly string[],
    limit?: number,
  ): Promise<Array<Owned<SyncOperation>>>;
  acknowledgeOperations(ownerId: string, operationIds: string[]): Promise<void>;
  getPreference(ownerId: string, key: string): Promise<string | undefined>;
  applyRemotePage(
    ownerId: string,
    operations: readonly RemoteOperation[],
    preferenceKey: string,
    cursor: number,
    ignoredPendingOperationIds: readonly string[],
  ): Promise<void>;
  getOwnerMutationState(ownerId: string): Promise<OwnerMutationState>;
  acquireOwnerMutationFence(
    ownerId: string,
    kind: OwnerMutationKind,
  ): Promise<OwnerMutationFence>;
  verifyOwnerMutationFence(
    ownerId: string,
    fence: OwnerMutationFence,
  ): Promise<void>;
  finishOwnerMutationFence(
    ownerId: string,
    fence: OwnerMutationFence,
  ): Promise<void>;
}

export interface OwnerLock {
  readonly crossContextSafe: boolean;
  runExclusive<T>(ownerId: string, callback: () => Promise<T>): Promise<T>;
}

export class CrossContextOwnerLockUnavailableError extends Error {
  constructor() {
    super(
      "This account operation requires cross-tab locking. Retry in a browser with Web Locks support.",
    );
    this.name = "CrossContextOwnerLockUnavailableError";
  }
}

const fallbackLockTails = new Map<string, Promise<void>>();

function runWithFallbackLock<T>(
  ownerId: string,
  callback: () => Promise<T>,
): Promise<T> {
  const preceding = fallbackLockTails.get(ownerId) ?? Promise.resolve();
  const result = preceding.then(callback, callback);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  fallbackLockTails.set(ownerId, tail);
  void tail.finally(() => {
    if (fallbackLockTails.get(ownerId) === tail) {
      fallbackLockTails.delete(ownerId);
    }
  });
  return result;
}

const browserOwnerLock: OwnerLock = {
  get crossContextSafe(): boolean {
    return typeof navigator !== "undefined" && Boolean(navigator.locks);
  },
  runExclusive<T>(ownerId: string, callback: () => Promise<T>): Promise<T> {
    const lockManager =
      typeof navigator === "undefined" ? undefined : navigator.locks;
    if (!lockManager) return runWithFallbackLock(ownerId, callback);
    return lockManager
      .request<Promise<T>>(
        `dialed:owner-sync:${ownerId}`,
        { mode: "exclusive" },
        callback,
      )
      .then((result) => result);
  },
};

function requireCrossContextOwnerLock(ownerLock: OwnerLock): void {
  if (!ownerLock.crossContextSafe) {
    throw new CrossContextOwnerLockUnavailableError();
  }
}

export async function getCurrentUser(): Promise<AccountUser | null> {
  if (localStorage.getItem(cloudEnabledKey) !== "true") return null;
  const response = await fetch("/api/v1/me", { credentials: "include" });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Account lookup failed");
  return parseAccountUser(await response.json());
}

export async function signInWithGoogle(): Promise<void> {
  const response = await fetch("/api/auth/sign-in/social", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "google",
      callbackURL: window.location.origin,
    }),
  });
  if (!response.ok) throw new Error("Google sign-in could not be started");
  const result = (await response.json()) as {
    url?: string;
    redirect?: boolean;
  };
  if (!result.url) throw new Error("Google sign-in did not return a redirect");
  localStorage.setItem(cloudEnabledKey, "true");
  window.location.assign(result.url);
}

export async function signOut(): Promise<void> {
  await fetch("/api/auth/sign-out", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  localStorage.removeItem(cloudEnabledKey);
}

export async function deleteCloudAccount(
  expectedAccountId: string,
): Promise<void> {
  const response = await fetch("/api/v1/account", {
    method: "DELETE",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      "x-dialed-account-id": expectedAccountId,
    },
    body: JSON.stringify({ confirmation: "DELETE" }),
  });
  await accountMismatch(response, ownerIdForAccount(expectedAccountId));
  if (!response.ok) throw new Error("Account deletion failed");
  localStorage.removeItem(cloudEnabledKey);
}

function authenticationExpired(
  response: Response,
  endpoint: "me" | "push" | "pull",
) {
  if (response.status === 401) throw new AuthenticationExpiredError(endpoint);
}

async function accountMismatch(
  response: Response,
  requestedOwnerId: string,
): Promise<void> {
  if (response.status !== 409) return;

  let actualAccount: AccountUser | undefined;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AccountMismatchError(requestedOwnerId);
  }
  if (typeof body === "object" && body !== null) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const candidate = error as Record<string, unknown>;
      try {
        actualAccount = parseAccountUser({ user: candidate.actualAccount });
      } catch {
        actualAccount = undefined;
      }
    }
  }

  throw new AccountMismatchError(requestedOwnerId, actualAccount);
}

function parseAccountUser(value: unknown): AccountUser {
  if (typeof value !== "object" || value === null) {
    throw new Error("Account response is malformed");
  }
  const user = (value as { user?: unknown }).user;
  if (typeof user !== "object" || user === null) {
    throw new Error("Account response is malformed");
  }
  const candidate = user as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.email !== "string" ||
    typeof candidate.name !== "string"
  ) {
    throw new Error("Account response is malformed");
  }
  if (
    candidate.image !== undefined &&
    candidate.image !== null &&
    typeof candidate.image !== "string"
  ) {
    throw new Error("Account response is malformed");
  }
  return {
    id: candidate.id,
    email: candidate.email,
    name: candidate.name,
    image: candidate.image as string | null | undefined,
  };
}

function parsePulledOperation(value: unknown): PullOperation {
  if (typeof value !== "object" || value === null) {
    throw new Error("Pulled operation is malformed");
  }
  const candidate = value as Record<string, unknown>;
  const operationId = RemoteEntityIdSchema.parse(candidate.operationId);
  const entity = parseRemoteEntity(String(candidate.entity));
  const entityId = RemoteEntityIdSchema.parse(candidate.entityId);
  if (candidate.action !== "upsert" && candidate.action !== "delete") {
    throw new Error("Pulled operation action is malformed");
  }
  if (!Number.isInteger(candidate.revision) || Number(candidate.revision) < 1) {
    throw new Error("Pulled operation revision is malformed");
  }

  let payload: Record<string, unknown> | undefined;
  if (candidate.action === "upsert") {
    const parsed = parseRemotePayload(entity, candidate.payload);
    if (parsed.id !== entityId) {
      throw new Error(
        `Payload ID ${parsed.id} does not match envelope ID ${entityId}`,
      );
    }
    payload = parsed as unknown as Record<string, unknown>;
  }

  return {
    operationId,
    entity,
    entityId,
    action: candidate.action,
    payload,
    revision: Number(candidate.revision),
  };
}

function parsePullPage(
  value: unknown,
  currentCursor: number,
): { operations: PullOperation[]; cursor: number; hasMore: boolean } {
  if (typeof value !== "object" || value === null) {
    throw new Error("Sync pull response is malformed");
  }
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.operations)) {
    throw new Error("Sync pull operations are malformed");
  }
  if (
    !Number.isInteger(candidate.cursor) ||
    Number(candidate.cursor) < currentCursor
  ) {
    throw new Error("Sync pull cursor is malformed");
  }
  if (typeof candidate.hasMore !== "boolean") {
    throw new Error("Sync pull pagination is malformed");
  }
  const operations = candidate.operations.map(parsePulledOperation);
  const cursor = Number(candidate.cursor);
  let previousRevision = currentCursor;
  for (const operation of operations) {
    if (operation.revision <= previousRevision) {
      throw new Error("Sync pull revisions are out of order");
    }
    previousRevision = operation.revision;
  }
  const expectedCursor = operations.length
    ? operations[operations.length - 1]!.revision
    : currentCursor;
  if (cursor !== expectedCursor) {
    throw new Error("Sync pull cursor does not match its operations");
  }
  if (candidate.hasMore && cursor === currentCursor) {
    throw new Error("Sync pull cursor did not advance");
  }
  return { operations, cursor, hasMore: candidate.hasMore };
}

async function runSynchronization(
  ownerId: string,
  dependencies: SyncDependencies,
  selectedOperations?: readonly Owned<SyncOperation>[],
): Promise<ReadonlySet<string>> {
  if (!dependencies.isOnline()) {
    throw new Error("Synchronization requires a network connection");
  }

  const meResponse = await dependencies.fetch("/api/v1/me", {
    credentials: "include",
  });
  authenticationExpired(meResponse, "me");
  if (!meResponse.ok) throw new Error("Account verification failed");
  const actualAccount = parseAccountUser(await meResponse.json());
  if (ownerIdForAccount(actualAccount.id) !== ownerId) {
    throw new AccountMismatchError(ownerId, actualAccount);
  }

  const pending = selectedOperations
    ? [...selectedOperations]
    : await dependencies.getOperations(ownerId, 100);
  const pushedOperationIds = pending.map((item) => item.operationId);
  if (pending.length) {
    const pushResponse = await dependencies.fetch("/api/v1/sync/push", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "x-dialed-account-id": actualAccount.id,
      },
      body: JSON.stringify({
        operations: pending.map(
          ({ ownerId: _ownerId, createdAt: _createdAt, ...item }) => item,
        ),
      }),
    });
    authenticationExpired(pushResponse, "push");
    await accountMismatch(pushResponse, ownerId);
    if (!pushResponse.ok) throw new Error("Sync push failed");
  }

  const storedCursor = Number(
    (await dependencies.getPreference(ownerId, cursorKey)) ?? "0",
  );
  let cursor =
    Number.isInteger(storedCursor) && storedCursor >= 0 ? storedCursor : 0;
  let hasMore = true;
  while (hasMore) {
    const pullResponse = await dependencies.fetch(
      `/api/v1/sync/pull?cursor=${cursor}`,
      {
        credentials: "include",
        headers: { "x-dialed-account-id": actualAccount.id },
      },
    );
    authenticationExpired(pullResponse, "pull");
    await accountMismatch(pullResponse, ownerId);
    if (!pullResponse.ok) throw new Error("Sync pull failed");

    // Parse the complete page before its first write so validation cannot partially apply it.
    const page = parsePullPage(await pullResponse.json(), cursor);
    await dependencies.applyRemotePage(
      ownerId,
      page.operations,
      cursorKey,
      page.cursor,
      pushedOperationIds,
    );
    cursor = page.cursor;
    hasMore = page.hasMore;
  }

  // Keep the retryable queue until the complete pull sequence has succeeded.
  if (pending.length) {
    await dependencies.acknowledgeOperations(ownerId, pushedOperationIds);
  }
  return new Set(pushedOperationIds);
}

async function drainOwnerSynchronization(
  ownerId: string,
  dependencies: SyncDependencies,
  shouldStop: () => boolean,
): Promise<void> {
  while (true) {
    const pushedOperationIds = await runSynchronization(ownerId, dependencies);
    if (shouldStop()) return;
    const [next] = await dependencies.getOperations(ownerId, 1);
    if (shouldStop()) return;
    if (!next || pushedOperationIds.has(next.operationId)) return;
  }
}

function sameOperationIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((operationId, index) => operationId === right[index])
  );
}

async function readStoredTransferJournal(
  ownerId: string,
  expected: AnonymousTransferJournal,
  dependencies: SyncDependencies,
): Promise<AnonymousTransferJournal> {
  const [storedValue, sourceDestinationOwnerId] = await Promise.all([
    dependencies.getPreference(ownerId, ANONYMOUS_TRANSFER_JOURNAL_KEY),
    dependencies.getPreference(
      ANONYMOUS_OWNER_ID,
      ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
    ),
  ]);
  if (storedValue === undefined) throw new AnonymousTransferStateError();
  const stored = parseBoundAnonymousTransferJournal(
    storedValue,
    ownerId,
    sourceDestinationOwnerId,
  );
  if (
    stored.startedAt !== expected.startedAt ||
    !sameOperationIds(stored.operationIds, expected.operationIds)
  ) {
    throw new AnonymousTransferStateError();
  }
  return stored;
}

async function drainTransferSynchronization(
  ownerId: string,
  journal: AnonymousTransferJournal,
  dependencies: SyncDependencies,
): Promise<void> {
  parseBoundAnonymousTransferJournal(JSON.stringify(journal), ownerId, ownerId);
  let acknowledged = new Set(journal.acknowledgedOperationIds);
  let firstRead = true;
  while (true) {
    const previouslyAcknowledged = acknowledged;
    const stored = await readStoredTransferJournal(
      ownerId,
      journal,
      dependencies,
    );
    const storedAcknowledged = new Set(stored.acknowledgedOperationIds);
    if (
      firstRead &&
      !sameOperationIds(
        journal.acknowledgedOperationIds,
        stored.acknowledgedOperationIds,
      )
    ) {
      throw new AnonymousTransferStateError();
    }
    if (
      [...previouslyAcknowledged].some(
        (operationId) => !storedAcknowledged.has(operationId),
      )
    ) {
      throw new AnonymousTransferStateError();
    }
    acknowledged = storedAcknowledged;
    firstRead = false;
    if (
      journal.operationIds.every((operationId) => acknowledged.has(operationId))
    ) {
      return;
    }
    const remainingOperationIds = journal.operationIds.filter(
      (operationId) => !acknowledged.has(operationId),
    );
    const nextOperationIds = remainingOperationIds.slice(0, 100);
    const nextOperations = await dependencies.getOperationsByIds(
      ownerId,
      nextOperationIds,
      100,
    );
    if (
      !sameOperationIds(
        nextOperations.map(({ operationId }) => operationId),
        nextOperationIds,
      )
    ) {
      throw new AnonymousTransferStateError();
    }
    await runSynchronization(ownerId, dependencies, nextOperations);
    const afterPush = await readStoredTransferJournal(
      ownerId,
      journal,
      dependencies,
    );
    acknowledged = new Set(afterPush.acknowledgedOperationIds);
    if (
      [...previouslyAcknowledged].some(
        (operationId) => !acknowledged.has(operationId),
      ) ||
      acknowledged.size === previouslyAcknowledged.size
    ) {
      throw new AnonymousTransferStateError();
    }
    if (
      journal.operationIds.every((operationId) => acknowledged.has(operationId))
    ) {
      return;
    }
  }
}

async function requireCompletedTransfer(
  transfer: Promise<{ completed: boolean; pendingCount: number }> | undefined,
): Promise<void> {
  if (!transfer) return;
  const result = await transfer;
  requireCompletedTransferResult(result);
}

function requireCompletedTransferResult(result: {
  completed: boolean;
  pendingCount: number;
}): void {
  if (!result.completed) {
    throw new Error(
      `Anonymous transfer did not complete (${result.pendingCount} pending operations)`,
    );
  }
}

async function assertNoPersistentTransfer(
  ownerId: string,
  dependencies: SyncDependencies,
): Promise<void> {
  const [storedJournal, sourceDestinationOwnerId] = await Promise.all([
    dependencies.getPreference(ownerId, ANONYMOUS_TRANSFER_JOURNAL_KEY),
    dependencies.getPreference(
      ANONYMOUS_OWNER_ID,
      ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
    ),
  ]);
  if (storedJournal === undefined) {
    if (sourceDestinationOwnerId === ownerId) {
      throw new AnonymousTransferStateError();
    }
    return;
  }
  parseBoundAnonymousTransferJournal(
    storedJournal,
    ownerId,
    sourceDestinationOwnerId,
  );
  throw new Error(`Anonymous transfer to ${ownerId} is still active`);
}

function assertTransferMutationState(
  ownerId: string,
  requested: OwnerMutationState,
  current: OwnerMutationState,
): void {
  if (requested.deleted || current.deleted) {
    throw new DeletedOwnerWriteError(ownerId);
  }
  if (
    (requested.activeToken !== undefined && requested.kind !== "transfer") ||
    (current.activeToken !== undefined && current.kind !== "transfer") ||
    (requested.generation !== current.generation && current.kind !== "transfer")
  ) {
    throw new Error(
      `Cannot transfer anonymous data after a queued mutation for ${ownerId}`,
    );
  }
}

async function assertOwnerNotDeleted(
  ownerId: string,
  dependencies: SyncDependencies,
): Promise<void> {
  if ((await dependencies.getOwnerMutationState(ownerId)).deleted) {
    throw new DeletedOwnerWriteError(ownerId);
  }
}

export interface SyncCoordinator {
  synchronize(ownerId: string): Promise<void>;
  /**
   * The injected stage and complete callbacks run while the owner's lock is
   * held. They must not call this coordinator again for the same owner.
   */
  transferAnonymous(
    ownerId: string,
    stage: () => Promise<AnonymousTransferJournal>,
    complete: () => Promise<{ completed: boolean; pendingCount: number }>,
  ): Promise<{ completed: boolean; pendingCount: number }>;
  resetAndSynchronize(
    ownerId: string,
    resetOwner: () => Promise<ClearOwnerDataResult>,
  ): Promise<ClearOwnerDataResult>;
  deleteAccount(
    ownerId: string,
    deleteCloud: () => Promise<void>,
    clearLocal: () => Promise<void>,
  ): Promise<void>;
}

export function createSyncCoordinator(
  dependencies: SyncDependencies,
  ownerLock: OwnerLock = browserOwnerLock,
): SyncCoordinator {
  const inFlight = new Map<string, Promise<void>>();
  const transfers = new Map<
    string,
    Promise<{ completed: boolean; pendingCount: number }>
  >();
  const resets = new Map<string, Promise<ClearOwnerDataResult>>();
  const deletions = new Map<string, Promise<void>>();

  const startSynchronization = (ownerId: string): Promise<void> => {
    const existing = inFlight.get(ownerId);
    if (existing) return existing;
    let request!: Promise<void>;
    request = ownerLock
      .runExclusive(ownerId, () =>
        drainOwnerSynchronization(
          ownerId,
          dependencies,
          () =>
            transfers.has(ownerId) ||
            resets.has(ownerId) ||
            deletions.has(ownerId),
        ),
      )
      .finally(() => {
        if (inFlight.get(ownerId) === request) inFlight.delete(ownerId);
      });
    inFlight.set(ownerId, request);
    return request;
  };

  const synchronize = (ownerId: string): Promise<void> => {
    const deleting = deletions.get(ownerId);
    if (deleting) return deleting;
    const resetting = resets.get(ownerId);
    if (resetting) {
      return resetting.then((result) =>
        result.cleared ? undefined : startSynchronization(ownerId),
      );
    }
    const transferring = transfers.get(ownerId);
    if (transferring) {
      return transferring.then((result) => {
        requireCompletedTransferResult(result);
      });
    }
    return startSynchronization(ownerId);
  };

  const transferAnonymous = (
    ownerId: string,
    stage: () => Promise<AnonymousTransferJournal>,
    complete: () => Promise<{ completed: boolean; pendingCount: number }>,
  ): Promise<{ completed: boolean; pendingCount: number }> => {
    try {
      requireCrossContextOwnerLock(ownerLock);
    } catch (error) {
      return Promise.reject(error);
    }
    const existing = transfers.get(ownerId);
    if (existing) return existing;
    if (resets.has(ownerId)) {
      return Promise.reject(
        new Error(`Cannot transfer anonymous data while ${ownerId} is reset`),
      );
    }
    if (deletions.has(ownerId)) {
      return Promise.reject(
        new Error(`Cannot transfer anonymous data while ${ownerId} is deleted`),
      );
    }
    const requestedMutationState = dependencies.getOwnerMutationState(ownerId);
    let request!: Promise<{ completed: boolean; pendingCount: number }>;
    request = ownerLock
      .runExclusive(ownerId, async () => {
        assertTransferMutationState(
          ownerId,
          await requestedMutationState,
          await dependencies.getOwnerMutationState(ownerId),
        );
        const mutation = await dependencies.acquireOwnerMutationFence(
          ownerId,
          "transfer",
        );
        try {
          await assertOwnerNotDeleted(ownerId, dependencies);
          await dependencies.verifyOwnerMutationFence(ownerId, mutation);
          await drainOwnerSynchronization(ownerId, dependencies, () => false);
          await dependencies.verifyOwnerMutationFence(ownerId, mutation);
          const journal = await stage();
          await drainTransferSynchronization(ownerId, journal, dependencies);
          await dependencies.verifyOwnerMutationFence(ownerId, mutation);
          return await complete();
        } finally {
          await dependencies.finishOwnerMutationFence(ownerId, mutation);
        }
      })
      .finally(() => {
        if (transfers.get(ownerId) === request) transfers.delete(ownerId);
      });
    transfers.set(ownerId, request);
    return request;
  };

  const resetAndSynchronize = (
    ownerId: string,
    resetOwner: () => Promise<ClearOwnerDataResult>,
  ): Promise<ClearOwnerDataResult> => {
    try {
      requireCrossContextOwnerLock(ownerLock);
    } catch (error) {
      return Promise.reject(error);
    }
    const existing = resets.get(ownerId);
    if (existing) return existing;
    const deleting = deletions.get(ownerId);
    if (deleting) {
      return deleting.then(() => ({ cleared: true as const }));
    }
    const transferring = transfers.get(ownerId);
    let request!: Promise<ClearOwnerDataResult>;
    request = ownerLock
      .runExclusive(ownerId, async () => {
        const mutation = await dependencies.acquireOwnerMutationFence(
          ownerId,
          "reset",
        );
        try {
          await requireCompletedTransfer(transferring);
          await assertNoPersistentTransfer(ownerId, dependencies);
          await assertOwnerNotDeleted(ownerId, dependencies);
          await dependencies.verifyOwnerMutationFence(ownerId, mutation);
          const result = await resetOwner();
          if (!result.cleared) return result;
          await dependencies.verifyOwnerMutationFence(ownerId, mutation);
          try {
            await runSynchronization(ownerId, dependencies);
          } catch (error) {
            throw new OwnerCacheRebuildError(error);
          }
          return result;
        } finally {
          await dependencies.finishOwnerMutationFence(ownerId, mutation);
        }
      })
      .finally(() => {
        if (resets.get(ownerId) === request) resets.delete(ownerId);
      });
    resets.set(ownerId, request);
    return request;
  };

  const deleteAccount = (
    ownerId: string,
    deleteCloud: () => Promise<void>,
    clearLocal: () => Promise<void>,
  ): Promise<void> => {
    try {
      requireCrossContextOwnerLock(ownerLock);
    } catch (error) {
      return Promise.reject(error);
    }
    const existing = deletions.get(ownerId);
    if (existing) return existing;
    const transferring = transfers.get(ownerId);
    let request!: Promise<void>;
    request = ownerLock
      .runExclusive(ownerId, async () => {
        const mutation = await dependencies.acquireOwnerMutationFence(
          ownerId,
          "delete",
        );
        try {
          await requireCompletedTransfer(transferring);
          await assertNoPersistentTransfer(ownerId, dependencies);
          await assertOwnerNotDeleted(ownerId, dependencies);
          await dependencies.verifyOwnerMutationFence(ownerId, mutation);
          await deleteCloud();
          await dependencies.verifyOwnerMutationFence(ownerId, mutation);
          await clearLocal();
        } finally {
          await dependencies.finishOwnerMutationFence(ownerId, mutation);
        }
      })
      .finally(() => {
        if (deletions.get(ownerId) === request) deletions.delete(ownerId);
      });
    deletions.set(ownerId, request);
    return request;
  };

  return {
    synchronize,
    transferAnonymous,
    resetAndSynchronize,
    deleteAccount,
  };
}

export function createSynchronizer(
  dependencies: SyncDependencies,
): (ownerId: string) => Promise<void> {
  return createSyncCoordinator(dependencies).synchronize;
}

const syncCoordinator = createSyncCoordinator({
  isOnline: () => typeof navigator !== "undefined" && navigator.onLine,
  fetch: (input, init) => fetch(input, init),
  getOperations,
  getOperationsByIds,
  acknowledgeOperations,
  getPreference: getOwnerPreference,
  applyRemotePage,
  getOwnerMutationState,
  acquireOwnerMutationFence,
  verifyOwnerMutationFence,
  finishOwnerMutationFence,
});

export function synchronize(ownerId: string): Promise<void> {
  return syncCoordinator.synchronize(ownerId);
}

export function moveAnonymousDataToAccount(
  ownerId: string,
  expectedSummary?: AnonymousTransferSummary,
): Promise<{ completed: boolean; pendingCount: number }> {
  if (ownerId === ANONYMOUS_OWNER_ID) {
    return Promise.reject(new Error("Transfer destination must be an account"));
  }
  return syncCoordinator.transferAnonymous(
    ownerId,
    () => stageAnonymousTransfer(ownerId, expectedSummary),
    () => completeAnonymousTransfer(ownerId),
  );
}

export function resetAndSynchronize(
  ownerId: string,
): Promise<ClearOwnerDataResult> {
  return syncCoordinator.resetAndSynchronize(ownerId, () =>
    clearOwnerData(ownerId),
  );
}

export function deleteAccountAndClear(
  ownerId: string,
  expectedAccountId: string,
): Promise<void> {
  if (ownerIdForAccount(expectedAccountId) !== ownerId) {
    return Promise.reject(new AccountMismatchError(ownerId));
  }
  return syncCoordinator.deleteAccount(
    ownerId,
    () => deleteCloudAccount(expectedAccountId),
    () => clearDeletedAccountData(ownerId).then(() => undefined),
  );
}
