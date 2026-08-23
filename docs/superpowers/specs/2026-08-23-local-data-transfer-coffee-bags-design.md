# Local Data Transfer and Coffee Bags Design

## Summary

Dialed will let a person move anonymous, device-local data into an authenticated account after explicit confirmation. The transfer includes shots and every coffee, bag, machine, and grinder referenced by them. It is retryable and does not remove the anonymous source until the imported account data has been acknowledged by cloud sync.

Dialed will also separate a reusable coffee identity from a physical bag. A coffee holds stable product details; a bag holds batch- and purchase-specific details such as roast date. Shots reference bags so two bags of the same coffee retain separate dialing histories while remaining grouped in the library.

## Goals

- Ask before moving anonymous data into an account.
- Move a complete, valid dependency graph rather than shots alone.
- Prevent data loss when import or sync is interrupted.
- Support richer, fixed coffee metadata without arbitrary custom fields.
- Represent multiple physical bags of the same coffee with distinct roast dates and shot histories.
- Preserve compatibility with existing local records, shot references, and cloud operation ledgers.

## Non-goals

- Arbitrary user-defined label/value fields.
- Tracking remaining coffee or automatically marking a bag empty.
- General inventory, purchasing, or cost analytics.
- Cross-bag recommendation comparisons by default.
- Editing or deleting coffee and bag metadata in this release.
- A new server-side import endpoint.

## Domain Model

### Coffee

`Coffee` is the reusable identity shared by one or more bags.

Fields:

- `id`
- `name` (required)
- `roaster` (required)
- `originCountry`
- `originRegion`
- `producer`
- `process`
- `varietal`
- `elevationMeters`
- `roastLevel`
- `notes`
- `createdAt`

All fields except `id`, `name`, `roaster`, and `createdAt` are optional. Text fields use the existing trimmed and bounded validation conventions. Elevation must be a positive, reasonably bounded number. Roast level uses the shared domain choices rather than free text.

### Coffee bag

`CoffeeBag` represents one physical bag or batch purchase.

Fields:

- `id`
- `coffeeId` (required)
- `roastedOn`
- `purchasedOn`
- `openedOn`
- `startingWeightGrams`
- `notes`
- `createdAt`

Only `id`, `coffeeId`, and `createdAt` are required. Dates are calendar dates. Starting weight must be positive. A bag must reference a coffee owned by the same local owner/account.

### Brew relationship

Each brew references a `CoffeeBag`. The existing `beanId` storage/wire field remains the bag identifier during this compatibility-focused release; application-facing types and UI may expose it as `bagId` where doing so does not break persisted data. Recommendation and comparison selection continues to filter on that identifier, which naturally isolates dialing history by bag.

## Compatibility and Migration

The existing `Bean` concept already behaves like a bag because brews reference it directly. To avoid rewriting brew IDs or making existing append-only cloud ledgers unreadable:

- The existing `bean` sync entity becomes the persisted/wire representation of `CoffeeBag`.
- A new `coffee` sync entity stores reusable Coffee records.
- Each legacy Bean migrates into one Coffee and one CoffeeBag.
- Both migrated records reuse the legacy Bean ID: the Coffee ID is the old Bean ID, the CoffeeBag ID is also the old Bean ID, and the bag's `coffeeId` points to that ID. Entity namespaces keep these records distinct.
- Existing brew `beanId` values therefore remain valid without rewriting brews.
- Legacy bean payloads remain accepted. When a legacy payload lacks `coffeeId`, the client derives the paired Coffee and CoffeeBag representation using the legacy ID.
- The migration is idempotent. Reopening an upgraded database or replaying legacy cloud operations cannot create additional coffees or bags.

New CoffeeBag records use new IDs and reference an existing Coffee ID. The sync API and PostgreSQL sync enum gain the `coffee` entity. The append-only operation ledger remains authoritative; this feature does not require normalized PostgreSQL tables to be materialized from operation payloads.

## Adding Coffee and Bags

### Add coffee

The Coffee setup tab presents an Add Coffee flow with two compact sections:

1. Coffee details: name and roaster are required; origin country, region, producer, process, varietal, elevation, roast level, and notes are optional.
2. First bag: roast date, purchase date, opened date, starting weight, and bag notes are optional.

Saving creates the Coffee and first CoffeeBag atomically and queues both sync operations for an authenticated owner.

### Add another bag

Each Coffee card exposes **Add another bag**. The flow shows the selected coffee for context and requests only bag-specific fields. Saving creates a new CoffeeBag referencing the existing Coffee; it does not duplicate the Coffee metadata.

### Library and shot logging

- The Coffee library shows one card per Coffee and lists its bags by roast date.
- A bag without a roast date uses a clear fallback such as “Roast date not set.”
- Brew logging labels bag choices with coffee name and roast date, for example “Hualalai Kona — roasted Aug 12.”
- The most recently added bag is selected by default when starting a new brew.
- History displays both coffee name and bag roast date so shots from different bags are distinguishable.
- Recommendation comparisons remain scoped to the exact bag by default.

## Anonymous-to-Account Transfer

### Prompt timing

After OAuth sign-in, Dialed first resolves the authenticated account and synchronizes its existing cloud data. It then checks the anonymous partition on the same device. If transferable data exists, Dialed presents a prompt summarizing the number of shots, coffees/bags, machines, and grinders.

Actions:

- **Move data** starts the transfer.
- **Not now** leaves anonymous and account data unchanged. Settings exposes **Move local data** so the person can return to the action later.

Dialed never starts a transfer solely because the user signed in.

### Transfer unit

The transfer includes the complete anonymous owner partition needed to preserve valid records:

- Coffees
- Coffee bags
- Machines
- Grinders
- Brews
- Relevant owner preferences

Shots are not transferred independently from their referenced records. Before writing, Dialed validates entity schemas, same-owner references, and the complete dependency graph. Invalid source data stops the transfer and leaves both partitions unchanged.

### Transaction and sync behavior

1. Synchronize the destination account to obtain its current cloud state.
2. Validate the anonymous graph and compare source IDs with destination IDs.
3. In one local IndexedDB transaction, copy the graph into the account partition and create account-owned sync operations.
4. Run normal account synchronization.
5. Confirm that all transfer-created operations were acknowledged.
6. Delete the anonymous source partition only after successful acknowledgement.

Records retain their IDs during transfer, preserving relationships. A destination record with the same ID and identical content is treated as already imported. A matching ID with different content aborts before any transfer writes, preventing an implicit overwrite.

### Idempotency and recovery

The transfer records enough local progress to distinguish copied, acknowledged, and cleaned-up states. Retrying reuses the same entity IDs and does not create duplicate records or operations for an already completed step.

- If the local copy fails, the transaction rolls back and anonymous data remains untouched.
- If cloud sync fails, both partitions remain available and the UI offers a retry.
- If acknowledgement succeeds but anonymous cleanup is interrupted, the next attempt detects identical destination records and completes cleanup without re-uploading duplicates.
- Authentication expiry or account mismatch stops the transfer, preserves anonymous data, and returns control to the existing account-resolution flow.
- The transfer UI reports a recoverable failure rather than claiming success until source cleanup completes.

Transfer coordination must serialize with normal synchronization, account-cache reset, and account deletion for the destination owner. Anonymous deletion must not race with writes from an open anonymous view.

## Exports

- JSON export includes separate `coffees` and `bags` collections alongside machines, grinders, and brews.
- Brew CSV adds coffee, roaster, and roast-date columns while preserving existing shot measurement columns.
- Export queries remain owner-scoped; anonymous and account partitions never leak into one another unless the explicit transfer completes.

## Validation and Error Handling

- Reject malformed dates and non-positive starting weights.
- Bound text using the shared domain schema conventions.
- Bound elevation to a plausible positive range.
- Reject a bag whose Coffee is absent or belongs to a different owner.
- Reject a brew whose bag or equipment dependencies are missing during transfer.
- Keep legacy payload parsing explicit so an unknown or malformed payload cannot partially enter IndexedDB.
- Show actionable retry messaging for network and sync failures while retaining both copies.
- Show a conflict message for same-ID/different-content records and make no changes.

## Testing Strategy

### Domain and local database tests

- Validate Coffee and CoffeeBag schemas, including optional and invalid fields.
- Migrate legacy Bean records into paired Coffee/CoffeeBag records without changing brew references.
- Prove that migration and legacy operation replay are idempotent.
- Save a Coffee and first bag atomically.
- Add multiple bags to one Coffee and retain separate bag IDs.
- Keep identical IDs isolated across owner partitions and entity namespaces.
- Reject missing or cross-owner references.

### Sync and transfer tests

- Parse legacy bean payloads and current Coffee/CoffeeBag payloads.
- Push and pull the new `coffee` entity across multiple devices.
- Transfer a complete anonymous graph to an empty account.
- Merge into an account that already contains unrelated records.
- Treat identical destination records as already imported.
- Abort on a same-ID/different-content conflict.
- Roll back a failed local copy.
- Preserve both partitions after a failed sync.
- Delete anonymous data only after acknowledgement.
- Retry safely after copy, acknowledgement, and cleanup interruptions.
- Serialize transfer with sync, reset, deletion, and account mismatch handling.

### Browser tests

- Accept and decline the post-sign-in transfer prompt.
- Start a deferred transfer from Settings.
- Retry a failed transfer without duplicates or data loss.
- Add a Coffee with detailed standard fields and its first bag.
- Add another bag with a different roast date.
- Select and log against each bag.
- Display coffee and roast date in history.
- Confirm recommendation comparison selection remains bag-specific.
- Confirm JSON/CSV exports exclude other owner partitions and include the new fields.

## Delivery Boundaries

Implementation should preserve unrelated working-tree changes. Existing authentication, account-isolation, and sync-coordination behavior remains the foundation; changes should extend those boundaries rather than replace them. Editing coffee/bag metadata, bag depletion, arbitrary custom fields, and cross-bag coaching can be proposed separately after this feature is complete.
