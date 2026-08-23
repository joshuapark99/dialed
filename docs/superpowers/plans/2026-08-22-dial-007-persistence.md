# DIAL-007 Persistence and Account Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate every local record and sync cursor by owner, make synchronization single-flight and session-aware, and reject malformed cloud payloads without weakening anonymous offline use.

**Architecture:** Keep one Dexie database and the PostgreSQL operation ledger, adding an `ownerId` partition key to local entity and operation records. The root app resolves the current account before rendering owner-scoped live queries; anonymous data remains under a stable `anonymous` owner and is never silently transferred to an account. Sync accepts an explicit authenticated owner, serializes concurrent calls, validates pulled payloads, and rebuilds only that owner's local cache.

**Tech Stack:** Next.js 15, React 19, TypeScript, Dexie 4, Zod, Vitest, fake-indexeddb, Playwright

**Spec:** `docs/implementation-tickets.md` (DIAL-007)

## Global Constraints

- Preserve fully offline anonymous logging.
- Never expose, upload, clear, or apply records belonging to another owner.
- Keep the existing append-only PostgreSQL operation ledger as the cloud source of truth.
- Do not silently claim anonymous data after authentication.
- Validate every remote upsert payload before writing it to IndexedDB.
- A `401` is an expired session, never a successful synchronization.

---

### Task 1: Owner-scoped local persistence

**Files:**

- Modify: `apps/web/lib/models.ts`
- Modify: `apps/web/lib/db.ts`
- Create: `apps/web/lib/db.test.ts`
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces: `ANONYMOUS_OWNER_ID`, `Owned<T>`, `ownerPreferenceKey(ownerId, key)`, owner-aware save/update/clear/query helpers.
- Migration: Dexie version 3 stamps all version-2 records and queued operations with `ownerId: "anonymous"`.

- [x] Add failing fake-indexeddb tests proving records from two owners are queried separately, operations retain their owner, clearing one owner preserves the other, and version-2 records migrate to anonymous.
- [x] Run `pnpm --filter @dialed/web test -- db.test.ts` and confirm failures are caused by missing owner-aware APIs.
- [x] Add `ownerId` to stored entities/operations, compound owner indexes, scoped preference keys, and transactional owner-only clear/save/update helpers.
- [x] Re-run the focused tests and confirm they pass.

### Task 2: Remote payload validation and safe replay

**Files:**

- Create: `apps/web/lib/sync-payloads.ts`
- Create: `apps/web/lib/sync-payloads.test.ts`
- Modify: `apps/web/lib/db.ts`

**Interfaces:**

- Produces: `parseRemotePayload(entity, payload)` returning a validated local entity without trusting `syncState` or `ownerId` from the network.
- Consumes: explicit `ownerId` passed to `applyRemoteOperation(ownerId, operation)`.

- [x] Add failing tests for valid bean/machine/grinder/brew payloads, malformed payload rejection, unsupported entity rejection, and prevention of remote owner/sync-state injection.
- [x] Run the focused test and confirm the validation API is absent.
- [x] Implement strict Zod schemas and make remote replay stamp the authenticated owner locally.
- [x] Re-run focused tests and the Task 1 tests.

### Task 3: Serialized, account-aware synchronization

**Files:**

- Modify: `apps/web/lib/sync.ts`
- Create: `apps/web/lib/sync.test.ts`

**Interfaces:**

- Produces: `AuthenticationExpiredError`, `synchronize(ownerId)`, and a single-flight wrapper returning the same promise to concurrent callers.
- Consumes: owner-filtered pending operations, owner-scoped cursor preference, and owner-aware remote replay.

- [x] Add failing tests proving concurrent calls produce one push/pull sequence, only the requested owner's operations upload, cursors are independent, `401` rejects with `AuthenticationExpiredError`, and failed pushes retain queued operations.
- [x] Run the focused test and verify the expected failures.
- [x] Refactor sync behind dependency-injected internals, omit local-only fields from wire payloads, and implement the single-flight/session behavior.
- [x] Re-run focused tests and all web unit tests.

### Task 4: Owner-aware application and safe data controls

**Files:**

- Modify: `apps/web/components/dialed-app.tsx`
- Modify: `apps/web/components/onboarding.tsx`
- Modify: `apps/web/components/brew-log.tsx`
- Modify: `apps/web/components/brew-result.tsx`
- Modify: `apps/web/components/setup-view.tsx`
- Modify: `e2e/app.spec.ts`
- Modify: `docs/implementation-tickets.md`

**Interfaces:**

- The root resolves account state, derives `account:<id>` or `anonymous`, and passes the explicit owner to every persistence action.
- Signed-in clearing means clearing the current local cache only after refusing when unsynced operations exist; anonymous clearing remains permanent and owner-scoped.

- [x] Add a failing Playwright scenario that seeds records for another owner and proves they are not rendered or exported in anonymous mode.
- [x] Update components to use owner-filtered live queries and explicit owner-aware persistence functions; treat expired sync sessions as local mode instead of synced.
- [x] Update data-control copy and behavior so clearing affects only the active owner and cannot discard pending account changes.
- [x] Mark DIAL-007 complete and document the retained operation-ledger decision.
- [x] Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm test:e2e`.
