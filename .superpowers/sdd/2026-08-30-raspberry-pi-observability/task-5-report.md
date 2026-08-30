# Task 5 report: Allowlisted operational metrics and operation outcomes

## Scope

Implemented the operational-metrics slice:

- Added atomic `observe` and `record-operation` scripts.
- Added the constrained 30-second observe service and timer.
- Added fake-command snapshot/recorder coverage.
- Added best-effort operation recording to backup and reconciliation without
  changing their original exit statuses.
- Added systemd and no-op reconciliation regression coverage.

## TDD record

1. Added `observe.test.mjs` before either new script existed and ran it. The
   suite failed because `observe` and `record-operation` did not exist.
2. Implemented the smallest validated snapshot and recorder behavior, then
   reran the suite successfully.
3. Added the observe-unit contract before the unit files existed and ran the
   systemd test. It failed with `ENOENT` for
   `dialed-poc-observe.service`.
4. Added the service and timer, then reran the focused suite successfully.
5. During review, added a regression requiring the `deploy.env` state to emit
   the existing dashboard-compatible `operation="deployment"` label. The test
   failed while the snapshot emitted `deploy`, then passed after the bounded
   mapping was added.

## Behavior

- `record-operation` accepts only the specified operation/result/reason
  combinations and lowercase 40-character revisions. It writes `0600`
  temporary files in the operations directory and atomically renames them.
- Backup always records its actual result best-effort. Reconciliation records
  failures and meaningful force/release/rollback attempts, while a successful
  normal no-op leaves the previous deployment event unchanged. The zero
  revision is used until a valid candidate revision is known.
- Recorder failure is ignored after preserving the original backup/reconcile
  status, including direct command failures such as the migration command's
  exit status `25`.
- `observe` has hard-coded POC and observability service allowlists, exact
  Compose labels, three fixed loopback readiness endpoints, fixed health
  values (`healthy`, `unhealthy`, `starting`, `none`), and no container-ID
  labels. It builds a complete temporary `dialed.prom`, sets mode `0640`, sets
  `root:alloy` when running as root, and replaces the old snapshot only after
  all Docker queries succeed.
- The observe service is root-run, one-shot, capability-free, and limited to
  the textfile write path while retaining Docker and systemd-query access.

## Verification

Passed:

    node --test ops/poc/test/observe.test.mjs ops/poc/test/backup.test.mjs ops/poc/test/reconcile.test.mjs ops/poc/test/systemd.test.mjs
    33 passed, 0 failed

    sh -n ops/poc/bin/observe ops/poc/bin/record-operation ops/poc/bin/backup ops/poc/bin/reconcile
    exit 0

    pnpm exec prettier --check ops/poc/test/observe.test.mjs ops/poc/test/backup.test.mjs ops/poc/test/reconcile.test.mjs ops/poc/test/systemd.test.mjs
    All matched files use Prettier code style!

    git diff --check
    exit 0

## Remaining concern

`systemd-analyze verify` could parse the new units, but this WSL workspace does
not have the installed `/opt/dialed/bin/observe` asset or `docker.service`, so
it reported those host-environment dependencies. The repository unit contracts
and shell syntax checks pass; validate the installed units on a Docker-enabled
Pi during deployment.
