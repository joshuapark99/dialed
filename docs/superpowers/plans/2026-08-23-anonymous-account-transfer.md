# Anonymous-to-Account Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ask authenticated users whether to move anonymous device data into their account, perform a complete idempotent transfer through existing sync, and delete anonymous data only after cloud acknowledgement.

**Architecture:** Build a transfer store around an IndexedDB journal and an atomic owner-to-owner copy, then run it as a destination-owner mutation inside the existing sync coordinator. The journal freezes anonymous writes during an active move, records the exact destination operation IDs, supports retry after any interruption, and permits cleanup only after those operations have disappeared from the pending queue.

**Tech Stack:** TypeScript, Dexie/IndexedDB, React 19, Next.js 15, Vitest with fake-indexeddb, Fetch API sync client, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-local-data-transfer-coffee-bags-design.md`

## Global Constraints

- Complete `docs/superpowers/plans/2026-08-23-coffee-bags.md` first; this plan consumes its Coffee and CoffeeBag tables and sync entities.
- Never transfer solely because sign-in succeeded; require explicit Move data confirmation.
- Transfer Coffees, bags, machines, grinders, brews, and the allowlisted onboarding preference as one validated graph.
- Preserve entity IDs and abort same-ID/different-content conflicts without writes.
- Keep anonymous data until every transfer-created sync operation is acknowledged.
- Retry must not duplicate entities or operations.
- Serialize transfer with destination sync, cache reset, and account deletion; prevent anonymous writes while a transfer journal is active.
- Do not add a server import endpoint or mix owner partitions in exports/views.
- Preserve unrelated working-tree changes.

---

## File Structure

- `apps/web/lib/anonymous-transfer.ts`: summary, graph validation, semantic equality, journal lifecycle, atomic staging, and cleanup.
- `apps/web/lib/anonymous-transfer.test.ts`: database-level transfer, conflict, rollback, retry, and cleanup tests.
- `apps/web/lib/db.ts`: owner write guard for an active anonymous transfer and a narrowly exported owner-record deletion primitive used by cleanup.
- `apps/web/lib/db.test.ts`: active-transfer write rejection and other-owner isolation.
- `apps/web/lib/sync.ts`: transfer orchestration within the owner mutation coordinator.
- `apps/web/lib/sync.test.ts`: ordering, serialization, failure, acknowledgement, and identity tests.
- `apps/web/components/local-data-transfer-dialog.tsx`: accessible offer/progress/error presentation.
- `apps/web/components/dialed-app.tsx`: initial destination sync gate, prompt discovery, accept/defer/retry flow, and onboarding order.
- `apps/web/components/setup-view.tsx`: deferred Move local data action and transfer status.
- `apps/web/lib/onboarding-state.ts`: account onboarding decision after transfer-offer resolution.
- `apps/web/lib/onboarding-state.test.ts`: prompt/onboarding ordering rules.
- `e2e/app.spec.ts`: accept, decline, retry, cleanup, and Settings paths.
- `README.md`: consented local-to-account migration behavior.
- `docs/implementation-tickets.md`: completed delivery ticket.

### Task 1: Transfer Summary, Graph Validation, and Journal Types

**Files:**
- Create: `apps/web/lib/anonymous-transfer.ts`
- Create: `apps/web/lib/anonymous-transfer.test.ts`

**Interfaces:**
- Consumes: `ANONYMOUS_OWNER_ID`, `db.coffees`, `db.bags`, `db.machines`, `db.grinders`, `db.brews`, `db.operations`, and owner preferences from the Coffee/bag plan.
- Produces: `AnonymousTransferSummary`, `AnonymousTransferJournal`, `AnonymousTransferConflictError`, `AnonymousTransferValidationError`, `getAnonymousTransferSummary`, and `getAnonymousTransferOffer`.

- [ ] **Step 1: Write failing summary and graph-validation tests**

Create fake-indexeddb fixtures for a valid anonymous graph and assert:

```ts
expect(await getAnonymousTransferSummary()).toEqual({
  coffees: 1,
  bags: 1,
  machines: 1,
  grinders: 1,
  brews: 2,
  hasData: true,
});
```

Add cases where a bag references a missing Coffee and a brew references a missing bag/machine/grinder. Expect `validateAnonymousTransferGraph` to throw `AnonymousTransferValidationError` containing the entity type and ID. Assert an empty partition returns `hasData: false`.

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `pnpm --filter @dialed/web test -- lib/anonymous-transfer.test.ts`

Expected: FAIL because `anonymous-transfer.ts` does not exist.

- [ ] **Step 3: Define public types and read-only graph helpers**

Use these interfaces:

```ts
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

export class AnonymousTransferConflictError extends Error {
  constructor(public readonly entity: SyncEntity, public readonly entityId: string);
}

export class AnonymousTransferValidationError extends Error {
  constructor(public readonly entity: string, public readonly entityId: string);
}
```

Add:

```ts
export async function getAnonymousTransferSummary(): Promise<AnonymousTransferSummary>;
export async function getAnonymousTransferOffer(
  destinationOwnerId: string,
): Promise<AnonymousTransferSummary | null>;
```

`getAnonymousTransferOffer` returns null for an empty source, an active journal targeting a different account, or destination preference `anonymous-transfer-dismissed === "true"`. It does not mutate either owner.

- [ ] **Step 4: Validate a complete same-owner graph**

Read every anonymous collection once, build ID sets, validate each bag and brew dependency, and return the snapshot to the staging function without exposing mutable table records. Do not require anonymous pending operations to be empty; staging creates new destination operations from current entity state.

- [ ] **Step 5: Run the focused tests**

Run: `pnpm --filter @dialed/web test -- lib/anonymous-transfer.test.ts`

Expected: PASS for summary and validation cases.

- [ ] **Step 6: Commit read-only transfer discovery**

```bash
git add apps/web/lib/anonymous-transfer.ts apps/web/lib/anonymous-transfer.test.ts
git commit -m "feat: discover transferable local data"
```

### Task 2: Atomic Staging, Conflict Detection, and Safe Cleanup

**Files:**
- Modify: `apps/web/lib/anonymous-transfer.ts`
- Modify: `apps/web/lib/anonymous-transfer.test.ts`
- Modify: `apps/web/lib/db.ts`
- Modify: `apps/web/lib/db.test.ts`

**Interfaces:**
- Consumes: Task 1 validated snapshot.
- Produces: `stageAnonymousTransfer`, `completeAnonymousTransfer`, `deferAnonymousTransfer`, and `OwnerTransferInProgressError`.

- [ ] **Step 1: Write failing atomic transfer tests**

Cover these independent cases:

```ts
const journal = await stageAnonymousTransfer(alice);
expect((await getCoffees(alice))[0]?.id).toBe(sourceCoffee.id);
expect((await getCoffeeBags(alice))[0]?.coffeeId).toBe(sourceCoffee.id);
expect((await getBrews(alice))[0]?.beanId).toBe(sourceBag.id);
expect(journal.operationIds).toHaveLength(5);
expect(await getAnonymousTransferSummary()).toMatchObject({ hasData: true });
```

- Destination unrelated records remain.
- Same-ID/semantically-identical records are skipped.
- Same-ID/different-content throws `AnonymousTransferConflictError` and writes nothing.
- An injected operation write failure rolls back all destination records and the journal.
- Re-running `stageAnonymousTransfer` returns the existing journal and adds no operations.
- `completeAnonymousTransfer` refuses cleanup while any journal operation remains pending.
- Normal acknowledgement records the journal operation IDs before removing their pending operations.
- After every journal operation is explicitly recorded as acknowledged, cleanup deletes only anonymous data and journal markers.

Semantic equality must ignore `ownerId`; for brews it also ignores `syncState`, since imported and acknowledged copies legitimately differ there.

- [ ] **Step 2: Write failing owner-freeze tests**

In `db.test.ts`, seed an active anonymous journal, then expect `saveCoffeeWithBag`, `saveCoffeeBag`, `saveMachine`, `saveGrinder`, `saveBrew`, `updateBrew`, and `deleteBrew` for `ANONYMOUS_OWNER_ID` to reject `OwnerTransferInProgressError`. Confirm another account remains writable.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `pnpm --filter @dialed/web test -- lib/anonymous-transfer.test.ts lib/db.test.ts`

Expected: FAIL because staging, cleanup, and the write guard do not exist.

- [ ] **Step 4: Implement the journal keys and semantic comparison**

Use local-only owner preference keys:

```ts
const activeJournalKey = "anonymous-transfer-journal";
const dismissedKey = "anonymous-transfer-dismissed";
const transferablePreferenceKeys = new Set(["onboarded"]);
```

Store the journal under the destination owner's preference namespace and a small source marker containing `destinationOwnerId`. Initialize `acknowledgedOperationIds` to `[]`. Canonicalize records by removing `ownerId` and, for brews, `syncState`; compare stable JSON with sorted object keys.

- [ ] **Step 5: Implement one-transaction staging**

Add:

```ts
export async function stageAnonymousTransfer(
  destinationOwnerId: string,
): Promise<AnonymousTransferJournal>;
```

Reject `anonymous` as a destination. If a journal exists for this destination, return it. Validate the graph and all destination conflicts before the first write. Then, in one `rw` transaction over every entity table, preferences, and operations:

1. Write the anonymous source marker.
2. Copy absent records with `ownerId: destinationOwnerId`.
3. Set imported brews to `syncState: "pending"`.
4. Add one fresh destination upsert operation per newly copied entity in dependency order: Coffee, bean/bag, machine, grinder, brew.
5. Copy only the `onboarded` preference.
6. Store the journal with the exact new operation IDs.

Never copy anonymous operations or sync cursors.

- [ ] **Step 6: Guard anonymous writes and implement cleanup/defer**

Export `OwnerTransferInProgressError` from `db.ts` and make `assertOwnerWritable` reject anonymous writes while the source marker exists. Add:

```ts
export async function completeAnonymousTransfer(
  destinationOwnerId: string,
): Promise<{ completed: boolean; pendingCount: number }>;
export async function deferAnonymousTransfer(destinationOwnerId: string): Promise<void>;
```

Extend `acknowledgeOperations` in `db.ts` so its existing transaction also reads the destination journal, appends the intersection of acknowledged IDs to `acknowledgedOperationIds`, and only then deletes those pending operations. This makes acknowledgement evidence crash-safe and prevents an unrelated local deletion from masquerading as cloud acknowledgement.

`completeAnonymousTransfer` checks that every journal `operationId` appears in `acknowledgedOperationIds`. If any are missing, return `{ completed: false, pendingCount }`. Otherwise, atomically delete all anonymous entity records, anonymous preferences and operations, the source marker, destination journal, and dismissed marker. `deferAnonymousTransfer` writes only the destination dismissed marker and is rejected when a journal is already active.

- [ ] **Step 7: Run persistence and transfer tests**

Run: `pnpm --filter @dialed/web test -- lib/anonymous-transfer.test.ts lib/db.test.ts`

Expected: PASS, including rollback, retry, source freeze, and cleanup timing.

- [ ] **Step 8: Commit the transfer store**

```bash
git add apps/web/lib/anonymous-transfer.ts apps/web/lib/anonymous-transfer.test.ts apps/web/lib/db.ts apps/web/lib/db.test.ts
git commit -m "feat: stage local account transfers safely"
```

### Task 3: Sync-Coordinated Transfer Orchestration

**Files:**
- Modify: `apps/web/lib/sync.ts`
- Modify: `apps/web/lib/sync.test.ts`

**Interfaces:**
- Consumes: `stageAnonymousTransfer` and `completeAnonymousTransfer` from Task 2.
- Produces: `moveAnonymousDataToAccount(ownerId)` and coordinator `transferAnonymous(ownerId, stage, complete)`.

- [ ] **Step 1: Write failing orchestration-order tests**

Using injected coordinator dependencies, assert the exact sequence:

```ts
expect(events).toEqual([
  "destination-sync-before-stage",
  "stage",
  "destination-sync-after-stage",
  "complete",
]);
```

Add cases proving:

- A failed initial sync never stages.
- A failed post-stage sync never completes or deletes anonymous data.
- Retry reuses the journal and completes after acknowledgement.
- AuthenticationExpiredError and AccountMismatchError propagate unchanged.
- A queued cache reset or account deletion cannot interleave between stage and completion.
- Concurrent transfer callers coalesce to one transfer promise.

- [ ] **Step 2: Run sync tests and verify failure**

Run: `pnpm --filter @dialed/web test -- lib/sync.test.ts`

Expected: FAIL because the coordinator has no transfer operation.

- [ ] **Step 3: Extract the existing sync-drain loop**

Refactor the existing repeated `runSynchronization`/pending-queue probe into a private helper without changing behavior:

```ts
async function drainOwnerSynchronization(
  ownerId: string,
  dependencies: SyncDependencies,
  shouldStop: () => boolean,
): Promise<void>;
```

First run the existing sync tests to prove this extraction alone is behavior-preserving.

- [ ] **Step 4: Add transfer as a destination-owner coordinator mutation**

Extend `SyncCoordinator`:

```ts
transferAnonymous(
  ownerId: string,
  stage: () => Promise<AnonymousTransferJournal>,
  complete: () => Promise<{ completed: boolean; pendingCount: number }>,
): Promise<{ completed: boolean; pendingCount: number }>;
```

Under the same owner lock used for reset/delete, drain the destination, call stage, drain again until the transfer operations are acknowledged, then call complete. Register the transfer in the same mutation state checks so normal sync joins it and reset/delete wait for it. Coalesce concurrent same-owner transfer calls.

- [ ] **Step 5: Expose the production entry point**

Add:

```ts
export function moveAnonymousDataToAccount(
  ownerId: string,
): Promise<{ completed: boolean; pendingCount: number }> {
  if (ownerId === ANONYMOUS_OWNER_ID) {
    return Promise.reject(new Error("Transfer destination must be an account"));
  }
  return syncCoordinator.transferAnonymous(
    ownerId,
    () => stageAnonymousTransfer(ownerId),
    () => completeAnonymousTransfer(ownerId),
  );
}
```

Account binding is still enforced by `runSynchronization` through `getCurrentUser` and `ownerIdForAccount` before pending destination data is read or pushed.

- [ ] **Step 6: Run all sync tests**

Run: `pnpm --filter @dialed/web test -- lib/sync.test.ts lib/anonymous-transfer.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit orchestration**

```bash
git add apps/web/lib/sync.ts apps/web/lib/sync.test.ts
git commit -m "feat: coordinate local transfer with account sync"
```

### Task 4: Transfer Offer, Deferred Settings Action, and Onboarding Gate

**Files:**
- Create: `apps/web/components/local-data-transfer-dialog.tsx`
- Modify: `apps/web/components/dialed-app.tsx`
- Modify: `apps/web/components/setup-view.tsx`
- Modify: `apps/web/lib/onboarding-state.ts`
- Modify: `apps/web/lib/onboarding-state.test.ts`

**Interfaces:**
- Consumes: `getAnonymousTransferOffer`, `getAnonymousTransferSummary`, `deferAnonymousTransfer`, and `moveAnonymousDataToAccount`.
- Produces: `LocalDataTransferDialog` and initial-account state that resolves sync/offer before onboarding.

- [ ] **Step 1: Write failing onboarding-order tests**

Extend `onboarding-state.test.ts` so an authenticated empty account does not enter onboarding while transfer discovery is unresolved or an offer is visible:

```ts
expect(
  requiresOnboarding({
    authenticated: true,
    accountInitialization: "checking-transfer",
    onboarded: undefined,
    beanCount: 0,
    machineCount: 0,
    grinderCount: 0,
  }),
).toBe(false);
```

Keep the existing restored-cloud and anonymous-marker cases.

- [ ] **Step 2: Run the onboarding-state test and verify failure**

Run: `pnpm --filter @dialed/web test -- lib/onboarding-state.test.ts`

Expected: FAIL because account initialization is not represented.

- [ ] **Step 3: Add the presentation component**

Create:

```ts
interface LocalDataTransferDialogProps {
  summary: AnonymousTransferSummary;
  status: "offering" | "moving" | "error";
  error?: string;
  onMove: () => void;
  onNotNow: () => void;
}
```

Render an accessible modal with a sentence generated from all nonzero counts, a primary **Move data** button, secondary **Not now**, progress copy while moving, and `role="alert"` retry copy on error. Disable dismissal while moving; leave retry on the primary action after error.

- [ ] **Step 4: Gate initial account rendering in DialedApp**

For authenticated owners, introduce:

```ts
type AccountInitialization =
  | { status: "syncing" }
  | { status: "checking-transfer" }
  | { status: "offering"; summary: AnonymousTransferSummary }
  | { status: "ready" }
  | { status: "transfer-error"; summary: AnonymousTransferSummary; message: string };
```

After owner-scoped local tables load, run initial destination sync. Only after it succeeds, call `getAnonymousTransferOffer`. Render the dialog before the onboarding branch. **Move data** calls `moveAnonymousDataToAccount`, refreshes live queries, and enters ready only after `{ completed: true }`. **Not now** calls `deferAnonymousTransfer` and enters ready without touching anonymous data. Existing authentication/account mismatch handling remains authoritative.

An offline or ordinary sync failure must not strand the authenticated app on a loading screen: preserve the existing offline/error sync status and enter ready using the current account cache. After the next successful focus/online sync, run transfer-offer discovery and show the prompt then. An authentication-expired or account-mismatch failure still refreshes identity instead of exposing an owner partition.

Avoid double initial sync by replacing the current mount-time auto-sync effect with this initialization sequence; retain focus, online, and pending-operation sync after readiness.

- [ ] **Step 5: Add the deferred Settings action**

Pass an `onMoveAnonymousData` callback and current anonymous summary to `SetupView`. For authenticated accounts with `summary.hasData`, render **Move local data** under Your data. Confirmation uses the same summary, then runs the same coordinator entry point. Show success only after cleanup; preserve the action and show retry copy after failure.

- [ ] **Step 6: Run web unit tests and typecheck**

Run: `pnpm --filter @dialed/web test && pnpm --filter @dialed/web typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the consent UI**

```bash
git add apps/web/components/local-data-transfer-dialog.tsx apps/web/components/dialed-app.tsx apps/web/components/setup-view.tsx apps/web/lib/onboarding-state.ts apps/web/lib/onboarding-state.test.ts
git commit -m "feat: ask before moving local account data"
```

### Task 5: Browser Failure/Recovery Coverage and Full Verification

**Files:**
- Modify: `e2e/app.spec.ts`
- Modify: `README.md`
- Modify: `docs/implementation-tickets.md`

**Interfaces:**
- Consumes: completed transfer store, coordinator, and UI.
- Produces: end-to-end proof that consent, isolation, retry, and deletion timing work together.

- [ ] **Step 1: Add reusable authenticated-route fixtures**

In `e2e/app.spec.ts`, add a fixture helper that seeds anonymous Coffee/bag/equipment/brews in IndexedDB, sets the cloud-enabled localStorage flag, mocks `/api/v1/me`, `/api/v1/sync/pull`, and `/api/v1/sync/push`, and captures pushed operations by entity/ID. Keep it inside the test file so production bundles do not gain test hooks.

- [ ] **Step 2: Add failing accept and decline tests**

Accept path assertions:

```ts
await expect(page.getByRole("dialog", { name: /move local data/i })).toBeVisible();
await expect(page.getByText(/2 shots.*1 coffee.*1 machine.*1 grinder/i)).toBeVisible();
await page.getByRole("button", { name: "Move data" }).click();
await expect(page.getByText("Anonymous coffee")).toBeVisible();
```

Inspect IndexedDB: account records exist, anonymous records are gone, and pushed operations contain Coffee before bag/brew dependencies.

Decline path: click **Not now**, assert account UI does not show anonymous coffee, anonymous IndexedDB records remain, reload does not prompt again, and Settings shows **Move local data**.

- [ ] **Step 3: Add failing sync-retry and conflict tests**

For retry, make the first transfer push return 503. Assert the dialog shows recoverable error and anonymous records remain. Restore 200, click Move data again, and assert one copy per ID followed by anonymous cleanup.

For conflict, seed the destination with the same Coffee ID but different content. Assert conflict copy, no push, no overwritten destination, and intact anonymous data.

- [ ] **Step 4: Run focused browser tests and confirm failure**

Run: `pnpm test:e2e --grep "moves anonymous data|defers anonymous data|retries anonymous transfer|rejects transfer conflicts"`

Expected: FAIL until selectors, refresh behavior, or recovery copy exposed by the integrated browser flow are completed.

- [ ] **Step 5: Make only integration fixes revealed by browser tests**

Correct reactive query refresh, focus management, disabled states, and error copy. Do not weaken acknowledgement checks, auto-accept transfers, or add a server endpoint.

- [ ] **Step 6: Run complete verification**

Run:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

Expected: every command PASS. If a command cannot run because the environment lacks a service or browser, record the exact failure and do not count it as passing.

- [ ] **Step 7: Update product documentation**

Document that anonymous data remains device-local after sign-in unless the person accepts a move, that complete dependencies move together, and that anonymous data is deleted only after sync acknowledgement. Add a completed implementation ticket without changing later-release scope.

- [ ] **Step 8: Commit browser coverage and documentation**

```bash
git add e2e/app.spec.ts README.md docs/implementation-tickets.md
git commit -m "test: verify consented local data transfer"
```
