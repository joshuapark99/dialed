import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
});
