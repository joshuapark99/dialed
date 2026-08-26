import { describe, expect, it } from "vitest";
import {
  AnonymousTransferConflictError,
  AnonymousTransferStateError,
  AnonymousTransferSummaryChangedError,
  AnonymousTransferValidationError,
  type AnonymousTransferSummary,
} from "./anonymous-transfer";
import {
  OwnerMutationConflictError,
  OwnerMutationFenceLostError,
  OwnerMutationStateError,
} from "./db";
import { CrossContextOwnerLockUnavailableError } from "./sync";
import {
  PendingAccountSyncScheduler,
  TransferDiscoveryGuard,
  anonymousTransferErrorMessage,
  reconcileAnonymousTransferRecovery,
  recoveryForAnonymousTransferError,
  runAnonymousTransferConsentAttempt,
  shouldPresentAnonymousTransferOffer,
  type AnonymousTransferRecovery,
} from "./anonymous-transfer-ui";

const alice = "account:alice";
const bob = "account:bob";
const summary = {
  coffees: 1,
  bags: 1,
  machines: 1,
  grinders: 1,
  brews: 1,
  hasData: true,
};

function pendingInput(
  pendingCount: number,
  overrides: Partial<{
    authenticated: boolean;
    ready: boolean;
    online: boolean;
    transferInFlight: boolean;
  }> = {},
) {
  return {
    authenticated: true,
    ready: true,
    online: true,
    transferInFlight: false,
    pendingCount,
    ...overrides,
  };
}

describe("PendingAccountSyncScheduler", () => {
  it("does not consume pending work observed before readiness", () => {
    const scheduler = new PendingAccountSyncScheduler();

    expect(scheduler.observe(pendingInput(2, { ready: false }))).toBe(false);
    expect(scheduler.observe(pendingInput(2))).toBe(true);
    expect(scheduler.observe(pendingInput(2))).toBe(false);
  });

  it("schedules remaining positive work once a transfer settles", () => {
    const scheduler = new PendingAccountSyncScheduler();

    expect(scheduler.observe(pendingInput(0))).toBe(false);
    expect(scheduler.observe(pendingInput(3, { transferInFlight: true }))).toBe(
      false,
    );
    expect(scheduler.observe(pendingInput(2))).toBe(true);
    expect(scheduler.observe(pendingInput(0))).toBe(false);
  });

  it("schedules only positive queue growth during ordinary readiness", () => {
    const scheduler = new PendingAccountSyncScheduler();

    expect(scheduler.observe(pendingInput(0))).toBe(false);
    expect(scheduler.observe(pendingInput(1))).toBe(true);
    expect(scheduler.observe(pendingInput(0))).toBe(false);
  });
});

describe("TransferDiscoveryGuard", () => {
  it("allows only the latest same-owner discovery to commit", () => {
    const guard = new TransferDiscoveryGuard(alice);
    const first = guard.beginDiscovery();
    const second = guard.beginDiscovery();

    expect(guard.canCommit(first, alice)).toBe(false);
    expect(guard.canCommit(second, alice)).toBe(true);
    expect(guard.canCommit(second, bob)).toBe(false);
  });

  it("invalidates discovery across transfer, defer, and owner changes", () => {
    const guard = new TransferDiscoveryGuard(alice);
    const beforeTransfer = guard.beginDiscovery();
    guard.beginTransfer();

    expect(guard.canCommit(beforeTransfer, alice)).toBe(false);
    const duringTransfer = guard.beginDiscovery();
    expect(guard.canCommit(duringTransfer, alice)).toBe(false);

    guard.finishTransfer();
    const beforeDefer = guard.beginDiscovery();
    guard.invalidate();
    expect(guard.canCommit(beforeDefer, alice)).toBe(false);

    const beforeOwnerChange = guard.beginDiscovery();
    guard.changeOwner(bob);
    expect(guard.canCommit(beforeOwnerChange, alice)).toBe(false);
    expect(guard.canCommit(guard.beginDiscovery(), bob)).toBe(true);
  });
});

describe("anonymous transfer recovery", () => {
  const recovery: AnonymousTransferRecovery = {
    summary,
    message: "A local data move needs recovery.",
  };

  it("replaces stale pre-stage counts from a complete positive live summary", () => {
    const refreshedSummary = {
      coffees: 2,
      bags: 3,
      machines: 1,
      grinders: 1,
      brews: 4,
      hasData: true,
    };

    expect(
      reconcileAnonymousTransferRecovery(recovery, refreshedSummary),
    ).toEqual({
      summary: refreshedSummary,
      message: "A local data move needs recovery.",
    });
  });

  it("preserves stable recovery through unavailable or incomplete live data", () => {
    expect(reconcileAnonymousTransferRecovery(recovery, undefined)).toBe(
      recovery,
    );
    expect(
      reconcileAnonymousTransferRecovery(recovery, {
        coffees: 7,
        hasData: true,
      } as AnonymousTransferSummary),
    ).toBe(recovery);
    expect(
      reconcileAnonymousTransferRecovery(recovery, {
        coffees: 0,
        hasData: false,
      } as AnonymousTransferSummary),
    ).toBe(recovery);
  });

  it("adopts an unchanged post-stage frozen summary once and then stays stable", () => {
    const frozenSummary = { ...summary };
    const reconciled = reconcileAnonymousTransferRecovery(
      recovery,
      frozenSummary,
    );

    expect(reconciled).toEqual({
      summary: frozenSummary,
      message: "A local data move needs recovery.",
    });
    expect(reconciled?.summary).toBe(frozenSummary);
    expect(reconcileAnonymousTransferRecovery(reconciled, frozenSummary)).toBe(
      reconciled,
    );
  });

  it("clears after authoritative source disappearance", () => {
    expect(
      reconcileAnonymousTransferRecovery(recovery, {
        coffees: 0,
        bags: 0,
        machines: 0,
        grinders: 0,
        brews: 0,
        hasData: false,
      }),
    ).toBeUndefined();
  });

  it("keeps ready Settings UI mounted while recovery is pending", () => {
    expect(shouldPresentAnonymousTransferOffer(summary, recovery)).toBe(false);
    expect(shouldPresentAnonymousTransferOffer(summary, undefined)).toBe(true);
    expect(shouldPresentAnonymousTransferOffer(null, undefined)).toBe(false);
  });
});

describe("anonymousTransferErrorMessage", () => {
  it.each([
    {
      error: new OwnerMutationConflictError(alice, "reset", "transfer"),
      expected:
        "A local cache reset needs recovery before local data can be moved. Retry the cache reset, then select Retry move. Local data was preserved.",
    },
    {
      error: new OwnerMutationConflictError(alice, "delete", "transfer"),
      expected:
        "An account deletion needs recovery before local data can be moved. Retry the account deletion, then select Retry move. Local data was preserved.",
    },
    {
      error: new OwnerMutationFenceLostError(alice, "transfer"),
      expected:
        "Another tab took over this local data move. Finish there, or select Retry move here after it stops. Local data was preserved.",
    },
    {
      error: new OwnerMutationStateError(),
      expected:
        "Local account recovery state is inconsistent. Reload Dialed, then select Retry move. Local data was preserved.",
    },
    {
      error: new AnonymousTransferStateError(),
      expected:
        "Local data move recovery state is inconsistent. Reload Dialed, then select Retry move. Local data was preserved.",
    },
    {
      error: new CrossContextOwnerLockUnavailableError(),
      expected:
        "This browser cannot safely coordinate the local data move across tabs. Open Dialed in a browser with Web Locks support, then select Retry move. Local data was preserved.",
    },
    {
      error: new AnonymousTransferConflictError("bean", "bag-1"),
      expected:
        "Local bag data conflicts with this account. Local data was preserved. Select Retry move to try again.",
    },
    {
      error: new AnonymousTransferValidationError("bean", "bag-1"),
      expected:
        "Local bag data is incomplete and could not be moved. Local data was preserved. Select Retry move to try again.",
    },
  ])("maps $error.name to actionable recovery copy", ({ error, expected }) => {
    expect(anonymousTransferErrorMessage(error)).toBe(expected);
  });

  it("maps a changed summary to new-consent copy and the current complete summary", () => {
    const currentSummary = {
      coffees: 2,
      bags: 3,
      machines: 1,
      grinders: 1,
      brews: 4,
      hasData: true,
    };
    const error = new AnonymousTransferSummaryChangedError(currentSummary);

    expect(anonymousTransferErrorMessage(error)).toBe(
      "Local data changed before the move started. Review the updated counts, then select Retry move to confirm them. Nothing was moved.",
    );
    expect(recoveryForAnonymousTransferError(error, summary)).toEqual({
      summary: currentSummary,
      message:
        "Local data changed before the move started. Review the updated counts, then select Retry move to confirm them. Nothing was moved.",
    });
  });

  it("requires a second explicit consent attempt after the summary changes", async () => {
    const currentSummary = {
      coffees: 2,
      bags: 3,
      machines: 1,
      grinders: 1,
      brews: 4,
      hasData: true,
    };
    const attemptedSummaries: AnonymousTransferSummary[] = [];
    const move = async (attemptedSummary: AnonymousTransferSummary) => {
      attemptedSummaries.push(attemptedSummary);
      if (attemptedSummaries.length === 1) {
        throw new AnonymousTransferSummaryChangedError(currentSummary);
      }
    };

    const first = await runAnonymousTransferConsentAttempt(summary, move);

    expect(first).toEqual({
      status: "error",
      recovery: {
        summary: currentSummary,
        message:
          "Local data changed before the move started. Review the updated counts, then select Retry move to confirm them. Nothing was moved.",
      },
    });
    expect(attemptedSummaries).toEqual([summary]);
    if (first.status !== "error") throw new Error("Expected updated consent");

    await expect(
      runAnonymousTransferConsentAttempt(first.recovery.summary, move),
    ).resolves.toEqual({ status: "moved" });
    expect(attemptedSummaries).toEqual([summary, currentSummary]);
  });
});
