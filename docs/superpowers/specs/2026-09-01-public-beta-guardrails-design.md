# Public Beta Guardrails Design

## Summary

Dialed will add the minimum application-level abuse controls needed before its Cloudflare Access gate is removed for a small friend beta. The API will rate-limit authenticated accounts in memory, and the PostgreSQL sync store will enforce a durable maximum of 50,000 unique sync operations per account.

This work is intentionally narrow. It protects the single Raspberry Pi deployment without adding distributed infrastructure, an administration system, billing, automatic retry scheduling, or new quota user interfaces. Once these guardrails pass verification and are deployed, the public-hostname cutover should proceed as the next task without introducing additional launch prerequisites.

## Goals

- Bound the request rate an authenticated account can send to each `/v1` API operation.
- Bound each account's append-only sync ledger at 50,000 unique operations.
- Keep rate-limit and quota decisions independent of the client-supplied account header.
- Preserve idempotent sync retries at the quota boundary.
- Reject an over-quota push atomically without partially storing its operations.
- Return stable machine-readable errors for rate limiting and quota exhaustion.
- Preserve unsynchronized local operations when either control rejects a push.
- Keep the controls simple to run on the existing single API instance.

## Non-goals

- Removing or changing Cloudflare Access, Tunnel, DNS, WAF, or the external health checker in this change.
- Distributed rate-limit state for multiple API replicas.
- Redis, PostgreSQL-backed request counters, or cross-restart rate-limit persistence.
- Special throttle or quota UI states, usage meters, warnings, automatic retries, or quota purchase flows.
- Per-user quota overrides or an administrative quota interface.
- Byte-based storage accounting or active-entity accounting.
- Changing Better Auth's own authentication-endpoint rate limiting.
- Hiding API documentation or changing health and readiness responses.

## Existing Context

The production proof of concept runs one Fastify API instance behind the Next.js web service and Cloudflare Tunnel. All `/v1` routes authenticate through Better Auth. Mutating routes additionally compare the authenticated principal with `x-dialed-account-id` to prevent a client from applying work to an unexpected local account partition.

Sync data is stored as an append-only, per-account operation ledger. `PostgresSyncStore.push` already acquires a PostgreSQL transaction-scoped advisory lock derived from the user ID before reading the existing ledger, validating dependencies, allocating revisions, and inserting operations. Duplicate operation IDs are idempotent and return their original revision.

The web client keeps pending operations in IndexedDB until a complete push-and-pull cycle succeeds. A failed push therefore already leaves local work queued and displays the existing generic sync-error state.

## Chosen Approach

The API will use `@fastify/rate-limit` version 11.2.0 or newer with its in-memory store. Version 11.2.0 is the minimum because it contains the current IPv6 normalization security fix and is compatible with Fastify 5. Rate limiting will use the authenticated account ID, not an IP address or a request header. Cloudflare remains the volumetric and IP-level protection layer.

The sync quota will be enforced in `PostgresSyncStore.push` under the existing account advisory lock. The quota is therefore durable and safe across concurrent requests even though request-rate counters are intentionally local to the single API process.

Alternatives considered were Cloudflare-only request limits and PostgreSQL-backed request counters. Cloudflare-only controls would make core API behavior deployment-specific and harder to verify locally. Database request counters would persist across restarts and replicas but would add write load and operational complexity that the single-instance friend beta does not need.

## Authentication and Rate Limiting

Each `/v1` route will authenticate in a Fastify `preValidation` hook. A successful hook will attach the verified principal and its ID to request-owned decorations. Route handlers will read that principal rather than authenticating a second time. If authentication fails, the hook returns the existing `401 unauthorized` response and the handler does not run.

The rate-limit plugin will run at `preHandler`, after authentication. Its key generator will use only the attached verified account ID. The `x-dialed-account-id` header remains an expected-account assertion for the routes that currently require it, but it will never select a rate-limit bucket. This ordering prevents header spoofing from evading a limit.

The initial per-account, per-route policies are:

| Route | Limit | Window |
| --- | ---: | --- |
| `GET /v1/me` | 120 | 1 minute |
| `POST /v1/sync/push` | 30 | 1 minute |
| `GET /v1/sync/pull` | 120 | 1 minute |
| `GET /v1/account/export` | 5 | 1 hour |
| `DELETE /v1/account` | 5 | 1 hour |

Health, readiness, documentation, and Better Auth routes will not use this authenticated-account limiter. Each row in the table has an independent bucket. Rate-limit defaults will live in one typed server policy object. `ServerDependencies` will accept an override so tests can use small deterministic limits without adding five production environment variables.

Rate counters may reset when the API process restarts. This is acceptable for the single-instance beta because the durable storage quota and Cloudflare edge remain in force. Horizontal API scaling requires revisiting the rate-limit store before adding another replica.

## Sync Quota

`SYNC_OPERATION_QUOTA` will be added to API configuration as a positive integer with a default of `50000`. `main.ts` will pass it to `PostgresSyncStore`; tests may construct stores with smaller limits.

Inside `PostgresSyncStore.push`, after acquiring the user advisory lock and reading the existing ledger, the store will determine which incoming operation IDs are genuinely new for that user. IDs already in the ledger and repeated IDs within the same request do not consume another quota slot.

If the existing ledger count plus the number of genuinely new IDs exceeds the configured limit, the store throws `SyncOperationQuotaExceededError`. The error records:

- `limit`: the configured operation maximum.
- `current`: the number of operations already stored for the account.
- `attemptedNew`: the number of unique new operations in the request.

The error is raised before any operation from that request is inserted. The transaction rolls back normally. A request that fills the ledger exactly succeeds. A duplicate-only retry succeeds when the ledger is already full. Pull, export, and account deletion remain available because quota enforcement applies only to push.

The design requires no schema migration. The existing ledger read already needed for dependency projection supplies the rows used for quota accounting.

## Error Contracts

An exceeded request-rate bucket returns HTTP `429 Too Many Requests`, the plugin's standard rate-limit headers including `Retry-After`, and this application envelope:

```json
{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "Too many requests; try again shortly",
    "retryAfterSeconds": 30
  }
}
```

`retryAfterSeconds` reflects the remaining bucket lifetime and may vary.

An over-quota push returns HTTP `413 Content Too Large`:

```json
{
  "error": {
    "code": "sync_quota_exceeded",
    "message": "Cloud sync storage limit reached",
    "limit": 50000,
    "current": 50000,
    "attemptedNew": 1
  }
}
```

HTTP `413` keeps quota exhaustion distinct from the existing HTTP `409` account-mismatch contract. The API error handler must preserve both expected responses instead of converting them to `500 internal_error`.

The web synchronizer will continue treating either response as a failed push. It must not acknowledge pending operation IDs, clear the pending queue, or enter the identity-refresh path. The current generic `Sync error` UI remains for this beta. Typed client errors and more detailed user-facing throttle and quota messages are explicitly deferred.

## Configuration and Operations

The local Compose configuration will rely on the default 50,000-operation quota. The POC environment contract and Compose service will expose `SYNC_OPERATION_QUOTA=50000` so an operator can inspect the deployed policy and deliberately change it later without rebuilding an image.

No new service, port, database table, secret, or long-running process is introduced. Application logs may record the normalized route, response status, and existing request metadata, but must not add account IDs or sync payloads. A `429` or `413` remains visible through the existing status-based request logs.

## Verification

API tests will use small injected rate policies to prove:

- Each protected route returns `429` after its configured allowance.
- The response contains `Retry-After` and the stable `rate_limit_exceeded` envelope.
- Authentication runs before account-based limiting.
- Changing or omitting `x-dialed-account-id` cannot create another bucket for the same authenticated principal.
- Quota errors map to HTTP `413` with the stable fields.
- Existing unauthorized and account-mismatch behavior is preserved.

Database integration tests will use a small quota to prove:

- A push that reaches the exact limit succeeds.
- A push that would cross the limit inserts nothing.
- Duplicate retries succeed at the limit and do not consume capacity.
- Repeated operation IDs within one request count once.
- Two concurrent requests competing for the final slot cannot both insert a new operation.

Web synchronizer tests will explicitly exercise `429` and `413` push responses and prove that pending operations are not acknowledged or removed. No new UI component tests are required because the visible state is intentionally unchanged.

Completion verification will run the repository's type checks, API and web unit suites, database integration suite, and production builds. Dependency installation will update the lockfile, and the selected `@fastify/rate-limit` version must remain at or above the security-fixed minimum.

## Rollout and Exit Criteria

The guardrails will first deploy while Cloudflare Access is still enabled. The deployment is accepted when normal account sync, pull, export, and deletion work; abusive test requests receive the designed errors; duplicate sync retries remain idempotent; and the existing health and readiness checks remain green.

This milestone is complete when those checks pass in production. The immediate next task is the minimal public-hostname cutover: update the external verification that currently requires Cloudflare Access, configure the intended Cloudflare WAF rate rule, and remove Access from the application hostname. Richer abuse tooling and quota UX must not delay inviting the initial friend cohort unless real beta traffic demonstrates a need.
