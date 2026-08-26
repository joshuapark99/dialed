import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AnonymousTransferSummaryChangedError,
  type AnonymousTransferSummary,
} from "../lib/anonymous-transfer";
import {
  reconcileAnonymousTransferRecovery,
  recoveryForAnonymousTransferError,
  shouldPresentAnonymousTransferOffer,
  type AnonymousTransferRecovery,
} from "../lib/anonymous-transfer-ui";
import {
  LocalDataTransferDialog,
  LocalDataTransferRecoveryNotice,
  activateTransferModalLifecycle,
  handleTransferModalCancel,
  selectTransferFocusRestoreTarget,
} from "./local-data-transfer-dialog";

const summary = {
  coffees: 1,
  bags: 2,
  machines: 1,
  grinders: 0,
  brews: 3,
  hasData: true,
};

function OwnerSettingsRecoveryHarness({
  recovery,
  liveSummary,
  retryOpen,
}: {
  recovery: AnonymousTransferRecovery;
  liveSummary: AnonymousTransferSummary | undefined;
  retryOpen?: boolean;
}) {
  const currentRecovery = reconcileAnonymousTransferRecovery(
    recovery,
    liveSummary,
  );
  const globalOffer = shouldPresentAnonymousTransferOffer(
    liveSummary?.hasData ? liveSummary : null,
    currentRecovery,
  );

  return (
    <main data-owner-settings="mounted">
      {globalOffer && <p data-global-transfer-offer="open">Global offer</p>}
      {currentRecovery && (
        <LocalDataTransferRecoveryNotice
          recovery={currentRecovery}
          onRetry={() => {}}
        />
      )}
      {retryOpen && currentRecovery && (
        <LocalDataTransferDialog
          summary={currentRecovery.summary}
          status="offering"
          onMove={() => {}}
          onNotNow={() => {}}
        />
      )}
    </main>
  );
}

describe("LocalDataTransferDialog", () => {
  it("offers every nonzero entity count in an accessible consent dialog", () => {
    const markup = renderToStaticMarkup(
      <LocalDataTransferDialog
        summary={summary}
        status="offering"
        onMove={() => {}}
        onNotNow={() => {}}
      />,
    );

    expect(markup).toContain("<dialog");
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("3 shots, 1 coffee, 2 bags, and 1 machine");
    expect(markup).not.toContain("grinder");
    expect(markup).toContain("Move data");
    expect(markup).toContain("Not now");
    expect(markup).not.toContain("autofocus");
  });

  it("uses safe generic copy for an empty summary", () => {
    const markup = renderToStaticMarkup(
      <LocalDataTransferDialog
        summary={{
          coffees: 0,
          bags: 0,
          machines: 0,
          grinders: 0,
          brews: 0,
          hasData: false,
        }}
        status="offering"
        onMove={() => {}}
        onNotNow={() => {}}
      />,
    );

    expect(markup).toContain("Local data from local mode");
    expect(markup).not.toContain("undefined");
  });

  it("prevents dismissal and exposes progress while moving", () => {
    const markup = renderToStaticMarkup(
      <LocalDataTransferDialog
        summary={summary}
        status="moving"
        onMove={() => {}}
        onNotNow={() => {}}
      />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain("Moving local data");
    expect(markup.match(/disabled=""/g)).toHaveLength(2);

    const calls: string[] = [];
    handleTransferModalCancel(
      { preventDefault: () => calls.push("preventDefault") },
      true,
      () => calls.push("onNotNow"),
    );
    expect(calls).toEqual(["preventDefault"]);
  });

  it("keeps the primary action available as a retry after an error", () => {
    const markup = renderToStaticMarkup(
      <LocalDataTransferDialog
        summary={summary}
        status="error"
        error="Local data was preserved. Try again."
        onMove={() => {}}
        onNotNow={() => {}}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Local data was preserved. Try again.");
    expect(markup).toContain("Retry move");
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Retry move/);
  });

  it("presents refreshed counts and requires Retry move after consent changes", () => {
    const currentSummary = {
      coffees: 2,
      bags: 3,
      machines: 0,
      grinders: 0,
      brews: 4,
      hasData: true,
    };
    const recovery = recoveryForAnonymousTransferError(
      new AnonymousTransferSummaryChangedError(currentSummary),
      summary,
    );
    const markup = renderToStaticMarkup(
      <LocalDataTransferDialog
        summary={recovery.summary}
        status="error"
        error={recovery.message}
        onMove={() => {}}
        onNotNow={() => {}}
      />,
    );

    expect(markup).toContain("4 shots, 2 coffees, and 3 bags");
    expect(markup).not.toContain("3 shots, 1 coffee, 2 bags, and 1 machine");
    expect(markup).toContain("Review the updated counts");
    expect(markup).toContain("Retry move");
  });

  it("opens modally, closes, and restores prior focus", () => {
    const calls: string[] = [];
    const dialog = {
      open: false,
      showModal() {
        calls.push("showModal");
        this.open = true;
      },
      close() {
        calls.push("close");
        this.open = false;
      },
    };
    const primaryTarget = {
      isConnected: true,
      focus: () => calls.push("focusPrimary"),
    };
    const restoreTarget = {
      isConnected: true,
      focus: () => calls.push("restoreFocus"),
    };
    const fallbackTarget = {
      isConnected: true,
      focus: () => calls.push("fallbackFocus"),
    };

    const deactivate = activateTransferModalLifecycle(
      dialog,
      primaryTarget,
      restoreTarget,
      () => fallbackTarget,
    );
    deactivate();

    expect(calls).toEqual([
      "showModal",
      "focusPrimary",
      "close",
      "restoreFocus",
    ]);
  });

  it("falls back to a connected host when the opener disappears", () => {
    const calls: string[] = [];
    const dialog = {
      open: false,
      showModal() {
        calls.push("showModal");
        this.open = true;
      },
      close() {
        calls.push("close");
        this.open = false;
      },
    };
    const disconnectedOpener = {
      isConnected: false,
      focus: () => calls.push("restoreFocus"),
    };
    const connectedFallback = {
      isConnected: true,
      focus: () => calls.push("fallbackFocus"),
    };

    const deactivate = activateTransferModalLifecycle(
      dialog,
      { isConnected: true, focus: () => calls.push("focusPrimary") },
      disconnectedOpener,
      () => connectedFallback,
    );
    deactivate();

    expect(calls).toEqual([
      "showModal",
      "focusPrimary",
      "close",
      "fallbackFocus",
    ]);
  });

  it("does not treat the document body as a meaningful opener", () => {
    const body = { isConnected: true, focus: () => {} };
    const button = { isConnected: true, focus: () => {} };

    expect(selectTransferFocusRestoreTarget(body, body)).toBeUndefined();
    expect(selectTransferFocusRestoreTarget(button, body)).toBe(button);
  });
});

describe("LocalDataTransferRecoveryNotice", () => {
  it("keeps a clear Settings retry path after the offer dialog closes", () => {
    const markup = renderToStaticMarkup(
      <LocalDataTransferRecoveryNotice
        recovery={{
          summary,
          message: "Another tab interrupted this local data move.",
        }}
        onRetry={() => {}}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Local data move needs recovery");
    expect(markup).toContain("Another tab interrupted this local data move.");
    expect(markup).toContain("Retry local data move");
  });

  it("passes the recovery summary selected by Settings as the retry payload", () => {
    const retrySummary = {
      coffees: 2,
      bags: 3,
      machines: 0,
      grinders: 0,
      brews: 4,
      hasData: true,
    };
    let receivedSummary: AnonymousTransferSummary | undefined;
    const notice = LocalDataTransferRecoveryNotice({
      recovery: {
        summary: retrySummary,
        message: "Local data was preserved.",
      },
      onRetry: (nextSummary: AnonymousTransferSummary) => {
        receivedSummary = nextSummary;
      },
    });
    const retryButton = React.Children.toArray(notice.props.children).find(
      (child): child is React.ReactElement<{ onClick: () => void }, "button"> =>
        React.isValidElement<{ onClick: () => void }>(child) &&
        child.type === "button",
    );

    expect(retryButton).toBeDefined();
    retryButton?.props.onClick();
    expect(receivedSummary).toBe(retrySummary);
  });

  it("refreshes visible Settings counts and the retry dialog without reopening the global offer", () => {
    const recovery = {
      summary: {
        coffees: 1,
        bags: 0,
        machines: 0,
        grinders: 0,
        brews: 1,
        hasData: true,
      },
      message: "Local data was preserved after a pre-stage failure.",
    } satisfies AnonymousTransferRecovery;
    const refreshedSummary = {
      coffees: 2,
      bags: 3,
      machines: 0,
      grinders: 0,
      brews: 4,
      hasData: true,
    };

    const initialMarkup = renderToStaticMarkup(
      <OwnerSettingsRecoveryHarness
        recovery={recovery}
        liveSummary={recovery.summary}
      />,
    );
    const refreshedMarkup = renderToStaticMarkup(
      <OwnerSettingsRecoveryHarness
        recovery={recovery}
        liveSummary={refreshedSummary}
        retryOpen
      />,
    );

    expect(initialMarkup).toContain('data-owner-settings="mounted"');
    expect(initialMarkup).toContain("1 shot and 1 coffee");
    expect(refreshedMarkup).toContain('data-owner-settings="mounted"');
    expect(refreshedMarkup).toContain("4 shots, 2 coffees, and 3 bags");
    expect(refreshedMarkup).not.toContain("1 shot and 1 coffee");
    expect(refreshedMarkup).toContain("<dialog");
    expect(initialMarkup).not.toContain("data-global-transfer-offer");
    expect(refreshedMarkup).not.toContain("data-global-transfer-offer");
  });

  it("removes recovery only after authoritative source disappearance while keeping Settings mounted", () => {
    const markup = renderToStaticMarkup(
      <OwnerSettingsRecoveryHarness
        recovery={{
          summary,
          message: "Local data was preserved.",
        }}
        liveSummary={{
          coffees: 0,
          bags: 0,
          machines: 0,
          grinders: 0,
          brews: 0,
          hasData: false,
        }}
      />,
    );

    expect(markup).toContain('data-owner-settings="mounted"');
    expect(markup).not.toContain("Local data move needs recovery");
    expect(markup).not.toContain("data-global-transfer-offer");
  });
});
