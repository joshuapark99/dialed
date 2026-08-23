# Coffee and Coffee Bags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reusable Coffee records and separately selectable CoffeeBag records with standard metadata, legacy migration, cloud sync, grouped setup UI, bag-specific brew history, and updated exports.

**Architecture:** Keep the existing persisted/wire `bean` entity as the CoffeeBag record so existing brew `beanId` references remain valid, and add a new `coffee` entity/table for shared metadata. Upgrade every legacy Bean into a Coffee and first CoffeeBag using the same ID in separate entity namespaces; all new brews continue storing the selected bag ID in `beanId`.

**Tech Stack:** TypeScript, Zod, Dexie/IndexedDB, React 19, Next.js 15, Fastify, Drizzle/PostgreSQL, Vitest, Node test runner, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-local-data-transfer-coffee-bags-design.md`

## Global Constraints

- Coffee name and roaster are required; origin country, region, producer, process, varietal, elevation, roast level, and notes are optional.
- CoffeeBag requires only ID, Coffee ID, and creation timestamp; roast, purchase, and open dates, starting weight, and notes are optional.
- No arbitrary custom fields, editing/deleting metadata, bag depletion, or cross-bag coaching.
- Preserve existing brew `beanId` values and the authoritative append-only operation ledger.
- Legacy Bean payloads and current CoffeeBag payloads must both remain readable and idempotent.
- Preserve unrelated working-tree changes, especially the in-progress authentication/database migration files.

---

## File Structure

- `packages/domain/src/schemas.ts`: canonical Coffee and CoffeeBag validation and types.
- `packages/domain/src/domain.test.ts`: domain schema validation.
- `apps/web/lib/models.ts`: offline UI model aliases and `coffee` sync entity.
- `apps/web/lib/coffee-form.ts`: form parsing and bag-label formatting.
- `apps/web/lib/coffee-form.test.ts`: fixed-field parsing and formatting tests.
- `apps/web/lib/db.ts`: Coffee table, legacy IndexedDB upgrade, atomic Coffee/bag writes, owner cleanup, and remote routing.
- `apps/web/lib/db.test.ts`: migration and persistence tests.
- `apps/web/lib/sync-payloads.ts`: legacy/current wire parsing and normalized payload types.
- `apps/web/lib/sync-payloads.test.ts`: legacy and current replay tests.
- `apps/api/src/contracts.ts`: API validation for `coffee` and both `bean` payload generations.
- `apps/api/test/server.test.ts`: API acceptance/rejection tests.
- `packages/db/src/schema.ts`: PostgreSQL sync enum extension only; normalized tables remain untouched.
- `packages/db/migrations/0002_add_coffee_sync_entity.sql`: additive enum migration.
- `packages/db/migrations/meta/_journal.json`: Drizzle migration registration.
- `apps/web/components/coffee-dialog.tsx`: Add Coffee and Add Another Bag dialog.
- `apps/web/components/coffee-library.tsx`: grouped Coffee cards and bags.
- `apps/web/components/setup-view.tsx`: compose Coffee UI and updated export actions.
- `apps/web/components/onboarding.tsx`: create Coffee plus first bag during onboarding.
- `apps/web/components/dialed-app.tsx`: owner-scoped Coffee and bag queries and view props.
- `apps/web/components/brew-log.tsx`: bag selector labels and most-recent default.
- `apps/web/components/home-view.tsx`: Coffee lookup through the selected bag.
- `apps/web/components/history-view.tsx`: Coffee plus roast-date search and display.
- `apps/web/components/brew-result.tsx`: Coffee/bag result labels.
- `apps/web/lib/export.ts`: owner-view JSON and brew CSV serialization.
- `apps/web/lib/export.test.ts`: new export shape and escaping tests.
- `e2e/app.spec.ts`: complete Coffee/bag user flow and bag-specific comparisons.

### Task 1: Canonical Coffee and CoffeeBag Contracts

**Files:**

- Modify: `packages/domain/src/schemas.ts`
- Modify: `packages/domain/src/domain.test.ts`
- Modify: `apps/web/lib/models.ts`

**Interfaces:**

- Produces: `CoffeeSchema`, `CoffeeBagSchema`, `Coffee`, `CoffeeBag`, and web `SyncEntity = "coffee" | "bean" | "machine" | "grinder" | "brew"`.
- Produces: `CoffeeBag.id` as the value persisted in `Brew.beanId`.

- [ ] **Step 1: Write failing schema tests**

Add focused cases to `packages/domain/src/domain.test.ts`:

```ts
it("validates reusable coffee details and a physical bag", () => {
  expect(
    CoffeeSchema.parse({
      id: ids.bean,
      userId: null,
      name: "Hualalai Kona",
      roaster: "Coffee Purveyors",
      originCountry: "United States",
      originRegion: "Kona",
      producer: "Hualalai Estate",
      process: "Washed",
      varietal: "Typica",
      elevationMeters: 700,
      roastLevel: "medium-light",
      notes: "Seasonal release",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }),
  ).toMatchObject({ name: "Hualalai Kona", elevationMeters: 700 });

  expect(
    CoffeeBagSchema.parse({
      id: ids.bag,
      userId: null,
      coffeeId: ids.bean,
      roastedOn: "2026-08-12",
      purchasedOn: "2026-08-14",
      openedOn: "2026-08-18",
      startingWeightGrams: 340,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }),
  ).toMatchObject({ coffeeId: ids.bean, startingWeightGrams: 340 });
});

it.each([0, -1, 9001])("rejects invalid coffee elevation %s", (value) => {
  expect(() =>
    CoffeeSchema.parse({ ...validCoffee, elevationMeters: value }),
  ).toThrow();
});

it.each([0, -1])("rejects invalid starting bag weight %s", (value) => {
  expect(() =>
    CoffeeBagSchema.parse({ ...validBag, startingWeightGrams: value }),
  ).toThrow();
});
```

- [ ] **Step 2: Run the domain tests and confirm the new exports are missing**

Run: `pnpm --filter @dialed/domain test -- src/domain.test.ts`

Expected: FAIL because `CoffeeSchema` and `CoffeeBagSchema` do not exist.

- [ ] **Step 3: Add strict canonical schemas**

In `packages/domain/src/schemas.ts`, replace the old Coffee-as-Bean contract with separate schemas while leaving brew `beanId` unchanged:

```ts
export const CoffeeSchema = z
  .object({
    ...entityFields,
    name: z.string().trim().min(1).max(120),
    roaster: z.string().trim().min(1).max(120),
    originCountry: z.string().trim().min(1).max(120).optional(),
    originRegion: z.string().trim().min(1).max(120).optional(),
    producer: z.string().trim().min(1).max(240).optional(),
    process: z.string().trim().min(1).max(120).optional(),
    varietal: z.string().trim().min(1).max(240).optional(),
    elevationMeters: z.number().finite().int().min(1).max(9000).optional(),
    roastLevel: RoastLevelSchema.default("unknown"),
    notes: optionalText,
  })
  .strict();

export const CoffeeBagSchema = z
  .object({
    ...entityFields,
    coffeeId: EntityIdSchema,
    roastedOn: z.string().date().optional(),
    purchasedOn: z.string().date().optional(),
    openedOn: z.string().date().optional(),
    startingWeightGrams: positiveMeasurement.max(100_000).optional(),
    notes: optionalText,
  })
  .strict();

export type Coffee = z.infer<typeof CoffeeSchema>;
export type CoffeeBag = z.infer<typeof CoffeeBagSchema>;
```

Keep `BeanSchema` exported as a legacy read contract until Task 3 supplies its adapter.

Mirror the persisted fields in `apps/web/lib/models.ts`, add `Coffee`/`CoffeeBag`, retain `type Bean = LegacyBean` only for migration parsing, and add `"coffee"` to `SyncEntity`.

- [ ] **Step 4: Run schema tests and typecheck both consumers**

Run: `pnpm --filter @dialed/domain test && pnpm --filter @dialed/domain typecheck && pnpm --filter @dialed/web typecheck`

Expected: PASS. Keep the existing web `Bean` interface unchanged in this task and add Coffee/CoffeeBag alongside it, so downstream production code remains buildable until the persistence compatibility adapters land in Task 2.

- [ ] **Step 5: Commit the contracts**

```bash
git add packages/domain/src/schemas.ts packages/domain/src/domain.test.ts apps/web/lib/models.ts
git commit -m "feat: define coffee and bag contracts"
```

### Task 2: IndexedDB Migration and Atomic Persistence

**Files:**

- Modify: `apps/web/lib/db.ts`
- Modify: `apps/web/lib/db.test.ts`

**Interfaces:**

- Consumes: `Coffee`, `CoffeeBag`, and `SyncEntity` from Task 1.
- Produces: `db.coffees`, `db.bags`, `getCoffees(ownerId)`, `getCoffeeBags(ownerId)`, `saveCoffeeWithBag(ownerId, coffee, bag)`, and `saveCoffeeBag(ownerId, bag)`.
- Produces: version-6 legacy migration where Coffee ID = bag ID = legacy Bean ID.

- [ ] **Step 1: Write failing migration and atomic-write tests**

Add tests to `apps/web/lib/db.test.ts` that seed a version-5 `ownedBeans` record and a brew, open the current database, and assert:

```ts
expect(await getCoffees(alice)).toEqual([
  expect.objectContaining({
    id: legacyBean.id,
    name: legacyBean.name,
    roaster: legacyBean.roaster,
  }),
]);
expect(await getCoffeeBags(alice)).toEqual([
  expect.objectContaining({ id: legacyBean.id, coffeeId: legacyBean.id }),
]);
expect((await getBrews(alice))[0]?.beanId).toBe(legacyBean.id);
```

Add a rollback test by mocking `db.operations.add` to reject during `saveCoffeeWithBag`; assert neither Coffee nor bag remains. Add a test that `saveCoffeeBag` rejects an absent or cross-owner Coffee.

- [ ] **Step 2: Run the database tests and verify failure**

Run: `pnpm --filter @dialed/web test -- lib/db.test.ts`

Expected: FAIL because Coffee storage and write APIs do not exist.

- [ ] **Step 3: Add the Coffee store and version-6 upgrade**

Extend `DialedDatabase` with:

```ts
coffees!: Table<Owned<Coffee>, OwnerScopedKey>;
bags!: Table<Owned<CoffeeBag>, OwnerScopedKey>;
```

Add `ownedCoffees` and redefine the existing `ownedBeans` indexes for bag lookup:

```ts
const coffeeAndBagStores = {
  ownedCoffees:
    "[ownerId+id], ownerId, [ownerId+createdAt], id, name, roaster, createdAt",
  ownedBeans:
    "[ownerId+id], ownerId, [ownerId+createdAt], [ownerId+coffeeId], id, coffeeId, createdAt",
} as const;
```

Version 6 must read every legacy `ownedBeans` record, bulk-put a Coffee using the same ID, and replace the bean value with `{ ownerId, id, coffeeId: id, createdAt }`. Map legacy `origin` to `originCountry` and retain `roastLevel`. Assign `this.bags = this.table("ownedBeans")`.

Until Task 5 migrates every view, keep explicit deprecated adapters so each intermediate commit still typechecks: `db.beans` aliases the bag table, `getBeans(ownerId)` joins bags to Coffees and returns the old display-shaped Bean objects with bag IDs, and `saveBean(ownerId, legacyBean)` calls `saveCoffeeWithBag` using the same ID for the Coffee and first bag. Mark all three adapters for removal in Task 5.

- [ ] **Step 4: Implement owner-scoped reads, cleanup, and atomic writes**

Add exact APIs:

```ts
export async function getCoffees(
  ownerId: string,
): Promise<Array<Owned<Coffee>>>;
export async function getCoffeeBags(
  ownerId: string,
): Promise<Array<Owned<CoffeeBag>>>;
export async function saveCoffeeWithBag(
  ownerId: string,
  coffee: Coffee,
  bag: CoffeeBag,
): Promise<void>;
export async function saveCoffeeBag(
  ownerId: string,
  bag: CoffeeBag,
): Promise<void>;
```

`saveCoffeeWithBag` validates `bag.coffeeId === coffee.id`, writes both records, and adds `coffee` then `bean` operations in one transaction. `saveCoffeeBag` checks `[ownerId, bag.coffeeId]` exists before writing. Add both stores to owner clear/delete and remote-page transactions.

- [ ] **Step 5: Run database tests**

Run: `pnpm --filter @dialed/web test -- lib/db.test.ts`

Expected: PASS, including rollback and version-6 migration cases.

- [ ] **Step 6: Commit persistence**

```bash
git add apps/web/lib/db.ts apps/web/lib/db.test.ts
git commit -m "feat: persist coffees and physical bags"
```

### Task 3: Backward-Compatible Sync and API Validation

**Files:**

- Modify: `apps/web/lib/sync-payloads.ts`
- Modify: `apps/web/lib/sync-payloads.test.ts`
- Modify: `apps/web/lib/db.ts`
- Modify: `apps/api/src/contracts.ts`
- Modify: `apps/api/test/server.test.ts`
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/migrations/0002_add_coffee_sync_entity.sql`
- Modify: `packages/db/migrations/meta/_journal.json`

**Interfaces:**

- Consumes: Task 2 Coffee/bag tables.
- Produces: `parseRemotePayload` support for `coffee`, current `bean` (bag), and `legacy-bean` normalization.
- Produces: API acceptance of the new entity without a new endpoint.

- [ ] **Step 1: Write failing web parser/replay tests**

Cover these exact cases in `sync-payloads.test.ts`:

```ts
expect(parseRemotePayload("coffee", coffee())).toEqual(coffee());
expect(parseRemotePayload("bean", bag())).toEqual(bag());
expect(parseRemotePayload("bean", legacyBean())).toMatchObject({
  kind: "legacy-bean",
  coffee: expect.objectContaining({ id: ids.bean }),
  bag: expect.objectContaining({ id: ids.bean, coffeeId: ids.bean }),
});
```

Replay a legacy bean upsert and assert both tables receive the paired records. Replay it twice and assert one Coffee and one bag. Assert malformed current and legacy payloads make no write.

- [ ] **Step 2: Write failing API contract tests**

In `apps/api/test/server.test.ts`, push one valid `coffee` operation and one current `bean`/bag operation and expect 200. Push an invalid bag with zero weight or invalid Coffee ID and expect 400. Retain an explicit case proving a legacy bean operation still returns 200.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `pnpm --filter @dialed/web test -- lib/sync-payloads.test.ts && pnpm --filter @dialed/api test`

Expected: FAIL on unsupported `coffee` and the new bag payload.

- [ ] **Step 4: Implement normalized web payload parsing and application**

Use a strict legacy/current union for `bean`. Return a discriminated legacy result so `applyRemoteOperation` can atomically route one old upsert to both `db.coffees` and `db.bags`. Current wire shapes are:

```ts
const CoffeePayloadSchema = z
  .object({
    id: RemoteEntityIdSchema,
    name: RequiredTextSchema,
    roaster: RequiredTextSchema,
    originCountry: RequiredTextSchema.optional(),
    originRegion: RequiredTextSchema.optional(),
    producer: RequiredTextSchema.optional(),
    process: RequiredTextSchema.optional(),
    varietal: RequiredTextSchema.optional(),
    elevationMeters: z.number().int().min(1).max(9000).optional(),
    roastLevel: RoastLevelPayloadSchema,
    notes: OptionalTextSchema,
    createdAt: TimestampSchema,
  })
  .strict();

const CoffeeBagPayloadSchema = z
  .object({
    id: RemoteEntityIdSchema,
    coffeeId: RemoteEntityIdSchema,
    roastedOn: z.string().date().optional(),
    purchasedOn: z.string().date().optional(),
    openedOn: z.string().date().optional(),
    startingWeightGrams: z.number().finite().positive().max(100_000).optional(),
    notes: OptionalTextSchema,
    createdAt: TimestampSchema,
  })
  .strict();
```

For a legacy delete, delete the bag; delete the paired Coffee only when no other local bag references it. Preserve pending-local-operation conflict rules for both entity types.

- [ ] **Step 5: Extend API and PostgreSQL sync entity validation**

Add `coffee` to both Zod `syncEntitySchema` and the Drizzle `syncEntity` enum. Mirror the strict payload schemas and use `z.union([coffeeBagPayloadSchema, legacyBeanPayloadSchema])` for `bean`.

Create `packages/db/migrations/0002_add_coffee_sync_entity.sql` with:

```sql
ALTER TYPE "public"."sync_entity" ADD VALUE IF NOT EXISTS 'coffee';
```

Register it after the existing account-issuer migration in the Drizzle journal. Do not modify or regenerate the user's existing `0001_add_account_issuer.sql` contents.

- [ ] **Step 6: Run sync, API, and database checks**

Run: `pnpm --filter @dialed/web test -- lib/sync-payloads.test.ts lib/db.test.ts && pnpm --filter @dialed/api test && pnpm --filter @dialed/db typecheck`

Expected: PASS.

- [ ] **Step 7: Commit sync compatibility**

```bash
git add apps/web/lib/sync-payloads.ts apps/web/lib/sync-payloads.test.ts apps/web/lib/db.ts apps/api/src/contracts.ts apps/api/test/server.test.ts packages/db/src/schema.ts packages/db/migrations/0002_add_coffee_sync_entity.sql packages/db/migrations/meta/_journal.json
git commit -m "feat: sync coffees and bags compatibly"
```

### Task 4: Coffee Form Parsing and Grouped Setup UI

**Files:**

- Create: `apps/web/lib/coffee-form.ts`
- Create: `apps/web/lib/coffee-form.test.ts`
- Create: `apps/web/components/coffee-dialog.tsx`
- Create: `apps/web/components/coffee-library.tsx`
- Modify: `apps/web/components/onboarding.tsx`

**Interfaces:**

- Consumes: `saveCoffeeWithBag`, `saveCoffeeBag`, `Coffee`, and `CoffeeBag`.
- Produces: `parseCoffeeForm`, `parseBagForm`, `formatBagLabel`, `CoffeeLibrary`, and `CoffeeDialog`.

- [ ] **Step 1: Write failing form-helper tests**

Create `coffee-form.test.ts` with required-field, blank-optional, numeric-bound, and date-label cases:

```ts
expect(
  parseCoffeeForm({ ...validCoffeeDraft, elevationMeters: "700" }),
).toEqual(expect.objectContaining({ elevationMeters: 700 }));
expect(parseCoffeeForm({ ...validCoffeeDraft, name: "" }).valid).toBe(false);
expect(parseBagForm({ ...blankBagDraft, startingWeightGrams: "" })).toEqual({
  valid: true,
  value: {},
});
expect(parseBagForm({ ...blankBagDraft, startingWeightGrams: "0" }).valid).toBe(
  false,
);
expect(formatBagLabel({ ...bag, roastedOn: "2026-08-12" }, "en-US")).toBe(
  "Roasted Aug 12, 2026",
);
expect(formatBagLabel(bagWithoutDate, "en-US")).toBe("Roast date not set");
```

- [ ] **Step 2: Run helper tests and verify failure**

Run: `pnpm --filter @dialed/web test -- lib/coffee-form.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement strict draft parsing**

Define draft interfaces with string inputs, normalize blank optional strings to `undefined`, parse elevation/weight as finite numbers, and return:

```ts
export type FormParseResult<T> =
  { valid: true; value: T } | { valid: false; field: string; message: string };

export function parseCoffeeForm(
  draft: CoffeeFormDraft,
): FormParseResult<CoffeeFormValue>;
export function parseBagForm(
  draft: BagFormDraft,
): FormParseResult<BagFormValue>;
export function formatBagLabel(bag: CoffeeBag, locale?: string): string;
```

Use calendar-date parsing that does not shift the displayed date across time zones.

- [ ] **Step 4: Run helper tests**

Run: `pnpm --filter @dialed/web test -- lib/coffee-form.test.ts`

Expected: PASS.

- [ ] **Step 5: Build CoffeeDialog and CoffeeLibrary**

`CoffeeDialog` accepts:

```ts
type CoffeeDialogProps =
  | { mode: "coffee"; ownerId: string; onClose: () => void }
  | { mode: "bag"; ownerId: string; coffee: Coffee; onClose: () => void };
```

Coffee mode renders Coffee details and First bag sections, creates two UUIDv7 IDs, and calls `saveCoffeeWithBag`. Bag mode shows the Coffee name, renders only bag fields, and calls `saveCoffeeBag`. Keep submission disabled while invalid or saving and render parser errors with `role="alert"`.

`CoffeeLibrary` groups `CoffeeBag[]` by `coffeeId`, sorts each group newest-created first, lists roast labels, and exposes Add Coffee and Add Another Bag actions.

- [ ] **Step 6: Integrate onboarding while keeping Setup on its compatibility adapter**

Update onboarding's first step to create a Coffee and first bag atomically, retaining its compact name/roaster/roast controls and adding optional roast date. Leave `SetupView` on Task 2's deprecated joined-Bean adapter until Task 5 can switch Setup and all brew views together without an intermediate broken UI.

- [ ] **Step 7: Run UI typecheck and unit tests**

Run: `pnpm --filter @dialed/web test && pnpm --filter @dialed/web typecheck`

Expected: PASS with no type errors.

- [ ] **Step 8: Commit the grouped setup flow**

```bash
git add apps/web/lib/coffee-form.ts apps/web/lib/coffee-form.test.ts apps/web/components/coffee-dialog.tsx apps/web/components/coffee-library.tsx apps/web/components/onboarding.tsx
git commit -m "feat: add coffees and repeat bags"
```

### Task 5: Brew Views and Exports

**Files:**

- Modify: `apps/web/components/dialed-app.tsx`
- Modify: `apps/web/components/brew-log.tsx`
- Modify: `apps/web/components/home-view.tsx`
- Modify: `apps/web/components/history-view.tsx`
- Modify: `apps/web/components/brew-result.tsx`
- Create: `apps/web/lib/export.ts`
- Create: `apps/web/lib/export.test.ts`
- Modify: `apps/web/components/setup-view.tsx`

**Interfaces:**

- Consumes: owner-scoped Coffee/bag reads and `formatBagLabel`.
- Produces: `buildJsonExport`, `buildBrewCsv`, and Coffee/bag-aware view props.

- [ ] **Step 1: Write failing export tests**

Create `export.test.ts` asserting owner-filtered inputs serialize separate collections and CSV adds stable columns:

```ts
expect(
  JSON.parse(buildJsonExport({ coffees, bags, machines, grinders, brews })),
).toEqual({
  coffees,
  bags,
  machines,
  grinders,
  brews,
});
expect(buildBrewCsv({ coffees, bags, brews }).split("\n")[0]).toBe(
  '"date","coffee","roaster","roast_date","dose_g","yield_g","duration_s","grind","ratio","enjoyment","dialed"',
);
```

Include quote escaping and missing-roast-date cases.

- [ ] **Step 2: Run export tests and verify failure**

Run: `pnpm --filter @dialed/web test -- lib/export.test.ts`

Expected: FAIL because the export module does not exist.

- [ ] **Step 3: Implement focused export serializers**

Add:

```ts
export function buildJsonExport(data: ExportData): string;
export function buildBrewCsv(
  data: Pick<ExportData, "coffees" | "bags" | "brews">,
): string;
```

Resolve each brew `beanId` to a bag and then its Coffee. Keep CSV escaping in this module and remove `toCsv` from `setup-view.tsx`.

- [ ] **Step 4: Thread Coffee and bag collections through views**

In `DialedApp`, query `getCoffees(ownerId)` and `getCoffeeBags(ownerId)` separately. Pass both where labels are needed and bags where selection/comparison is needed.

Replace the bean branch inside `SetupView` with `CoffeeLibrary`; leave the machine/grinder AddDialog behavior intact. After every consumer is migrated, remove the deprecated `db.beans`, `getBeans`, and `saveBean` adapters introduced in Task 2.

In `BrewLog`, keep local state/persistence named `beanId` for compatibility, default to `bags[0]?.id`, label each option `${coffee.name} — ${formatBagLabel(bag)}`, and keep `previous` filtering on the exact bag ID plus equipment.

In Home, History, and BrewResult, resolve `brew.beanId -> bag.coffeeId -> coffee`. History search includes Coffee name, roaster, and bag roast date. Its manual comparison dropdown remains restricted to `brew.beanId === selected.beanId`.

- [ ] **Step 5: Connect setup export actions**

Pass owner-scoped `coffees` and `bags` into `SetupView`; JSON calls `buildJsonExport`, CSV calls `buildBrewCsv`. Keep file download behavior unchanged.

- [ ] **Step 6: Run all web tests and typecheck**

Run: `pnpm --filter @dialed/web test && pnpm --filter @dialed/web typecheck`

Expected: PASS with no remaining production reference to `getBeans`, `db.beans`, or Bean-as-display metadata.

- [ ] **Step 7: Commit view and export wiring**

```bash
git add apps/web/components/dialed-app.tsx apps/web/components/brew-log.tsx apps/web/components/home-view.tsx apps/web/components/history-view.tsx apps/web/components/brew-result.tsx apps/web/components/setup-view.tsx apps/web/lib/export.ts apps/web/lib/export.test.ts
git commit -m "feat: show bag-specific brew history"
```

### Task 6: Browser Coverage and Full Verification

**Files:**

- Modify: `e2e/app.spec.ts`
- Modify: `README.md`
- Modify: `docs/implementation-tickets.md`

**Interfaces:**

- Consumes: complete Coffee/bag flow from Tasks 1–5.
- Produces: release-level regression proof and updated product documentation.

- [ ] **Step 1: Add a failing end-to-end Coffee/bag scenario**

Add a Playwright test that completes onboarding with roast date `2026-08-01`, opens Setup, adds another bag dated `2026-08-15`, logs one shot against each bag, and asserts:

```ts
await expect(page.getByText("Roasted Aug 1, 2026")).toBeVisible();
await expect(page.getByText("Roasted Aug 15, 2026")).toBeVisible();
await expect(
  page.getByRole("option", { name: /Hualalai Kona.*Aug 15/ }),
).toBeVisible();
await expect(page.getByText(/Hualalai Kona.*Aug 15/)).toBeVisible();
```

Inspect the second brew in IndexedDB and assert its `comparisonBrewId` is absent when the only previous brew belongs to the older bag.

- [ ] **Step 2: Run the focused browser test and confirm the selector/assertion failure**

Run: `pnpm test:e2e --grep "groups repeat bags and keeps comparisons bag-specific"`

Expected: FAIL until any missing accessible label or display detail is completed.

- [ ] **Step 3: Make only the accessibility/display adjustments exposed by the test**

Ensure dialogs have `role="dialog"`, stable accessible names, associated labels, focus on the first field, and buttons named Add coffee / Add another bag. Do not add metadata editing or inventory tracking.

- [ ] **Step 4: Run focused and complete verification**

Run:

```bash
pnpm test:e2e --grep "groups repeat bags and keeps comparisons bag-specific"
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

Expected: every command PASS. If Docker or browser installation is unavailable, record the exact environmental error; do not report that check as passing.

- [ ] **Step 5: Update documentation**

Update README's capability summary to mention reusable Coffee records and per-bag roast dates. Add a completed implementation ticket for Coffee/bag modeling; retain later-release boundaries.

- [ ] **Step 6: Commit verification and docs**

```bash
git add e2e/app.spec.ts README.md docs/implementation-tickets.md
git commit -m "test: cover repeat coffee bags"
```
