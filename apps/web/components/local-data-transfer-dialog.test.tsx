import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  LocalDataTransferDialog,
  activateTransferModalLifecycle,
  handleTransferModalCancel,
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
    const restoreTarget = { focus: () => calls.push("restoreFocus") };

    const deactivate = activateTransferModalLifecycle(dialog, restoreTarget);
    deactivate();

    expect(calls).toEqual(["showModal", "close", "restoreFocus"]);
  });
});
