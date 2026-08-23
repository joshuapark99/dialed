# Dialed implementation tickets

This file keeps the delivery sequence explicit so work can continue safely across sessions.

## DIAL-001: Monorepo foundation

Status: Complete

- Configure pnpm workspaces, Turborepo, strict TypeScript, formatting, CI, and environment examples.
- Add portable development and production container definitions.
- Document repository setup and verification commands.

## DIAL-002: Espresso domain and recommendation engine

Status: Complete

- Define beans, equipment, espresso brews, taste assessments, comparisons, and recommendation contracts.
- Implement ratio/flow calculations, automatic comparison selection, and grinder calibration.
- Produce one deterministic, capability-aware next adjustment and cover the decision matrix with unit tests.

## DIAL-003: Offline-first web application

Status: Complete

- Create the mobile-first installable Next.js application.
- Add onboarding, logging, guided taste capture, recommendations, history, comparisons, and dialed recipes.
- Persist anonymous data in IndexedDB and expose offline/sync state.

## DIAL-004: API, persistence, and authentication

Status: Complete

- Create the Fastify API and PostgreSQL schema.
- Add Google authentication boundaries, ownership enforcement, idempotent push/pull sync, export, and deletion.
- Add health endpoints, migrations, and integration coverage.

## DIAL-005: Integration and release hardening

Status: Complete

- Join the web, domain, and API contracts and resolve end-to-end type boundaries.
- Add Docker Compose, production images, service-worker behavior, and deployment documentation.
- Run formatting, lint, type checks, tests, builds, and responsive browser verification.

Completed with desktop and mobile Playwright coverage. Docker artifacts are included but require a Docker-enabled host for runtime verification.

## DIAL-006: Recommendation engine V2

Status: Planned

- Separate extraction guidance from strength and body guidance.
- Use roast context, marked dialed brews, symptom severity, and controlled-change history.
- Generalize prior-adjustment evaluation beyond yield while preserving the one-change invariant.
- Make confidence reflect evidence quality and add coverage for conflicting taste signals.

## DIAL-007: Persistence and account isolation

Status: Complete

- Partition local data, sync cursors, and pending operations by anonymous or authenticated owner.
- Use owner-inclusive IndexedDB primary keys so identical cloud IDs can coexist across accounts, with transactional migration from the legacy stores.
- Serialize synchronization, handle expired sessions explicitly, and make local clearing safe.
- Validate remote entity payloads before applying them to IndexedDB.
- Bind sync and account deletion to the UI-resolved account, and commit each validated pull page with its cursor atomically.
- Retain the validated append-only operation ledger as the authoritative cloud source of truth; normalized PostgreSQL tables are not materialized from ledger payloads.

## Later releases

- Pour-over brew method and method-specific coaching.
- Bluetooth scale and live flow capture.
- Public brew links, collaboration, and native clients.
