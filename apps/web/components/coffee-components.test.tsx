import "fake-indexeddb/auto";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import {
  db,
  getCoffeeBags,
  getCoffees,
  getGrinders,
  getMachines,
  getOwnerPreference,
} from "../lib/db";
import type { Coffee, CoffeeBag } from "../lib/models";
import {
  activateModalLifecycle,
  CoffeeDialog,
  handleModalCancel,
  selectVisibleFieldError,
} from "./coffee-dialog";
import { CoffeeLibrary } from "./coffee-library";
import {
  Onboarding,
  OnboardingNavigation,
  runOnboardingSubmission,
  saveOnboardingSetup,
} from "./onboarding";

const coffees: Coffee[] = [
  {
    id: "0198d3a4-1111-7000-8000-000000000040",
    name: "Hualalai Kona",
    roaster: "Coffee Purveyors",
    roastLevel: "medium",
    createdAt: "2026-08-10T12:00:00.000Z",
  },
  {
    id: "0198d3a4-1111-7000-8000-000000000050",
    name: "Suke Quto",
    roaster: "Tim Wendelboe",
    roastLevel: "light",
    createdAt: "2026-08-11T12:00:00.000Z",
  },
];

const bags: CoffeeBag[] = [
  {
    id: "0198d3a4-1111-7000-8000-000000000041",
    coffeeId: coffees[0].id,
    roastedOn: "2026-08-01",
    createdAt: "2026-08-12T12:00:00.000Z",
  },
  {
    id: "0198d3a4-1111-7000-8000-000000000042",
    coffeeId: coffees[0].id,
    roastedOn: "2026-08-12",
    createdAt: "2026-08-20T12:00:00.000Z",
  },
  {
    id: "0198d3a4-1111-7000-8000-000000000051",
    coffeeId: coffees[1].id,
    createdAt: "2026-08-13T12:00:00.000Z",
  },
];

describe("CoffeeDialog", () => {
  it("renders coffee details and first-bag fields with invalid submission disabled", () => {
    const markup = renderToStaticMarkup(
      <CoffeeDialog mode="coffee" ownerId="anonymous" onClose={() => {}} />,
    );

    expect(markup).toContain("Coffee details");
    expect(markup).toContain("First bag");
    expect(markup).toContain('name="originCountry"');
    expect(markup).toContain('name="startingWeightGrams"');
    expect(markup).toContain("<dialog");
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-labelledby="coffee-dialog-coffee-title"');
    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain("autofocus");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Save coffee/);
  });

  it("renders only bag fields and the selected coffee in bag mode", () => {
    const markup = renderToStaticMarkup(
      <CoffeeDialog
        mode="bag"
        ownerId="anonymous"
        coffee={coffees[0]}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain("Add another bag");
    expect(markup).toContain('aria-labelledby="coffee-dialog-bag-title"');
    expect(markup).toContain("Hualalai Kona");
    expect(markup).toContain('name="roastedOn"');
    expect(markup).not.toContain('name="originCountry"');
  });

  it("opens modally, handles Escape, closes, and restores prior focus", () => {
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

    const deactivate = activateModalLifecycle(dialog, restoreTarget);
    const cancelEvent = { preventDefault: () => calls.push("preventDefault") };
    handleModalCancel(cancelEvent, false, () => calls.push("onClose"));
    deactivate();

    expect(calls).toEqual([
      "showModal",
      "preventDefault",
      "onClose",
      "close",
      "restoreFocus",
    ]);
  });

  it("defers field errors until interaction and links them to the input", () => {
    const error = {
      scope: "coffee" as const,
      field: "name",
      message: "Coffee name is required",
    };

    expect(selectVisibleFieldError(error, new Set())).toBeUndefined();
    expect(selectVisibleFieldError(error, new Set(["coffee.name"]))).toEqual({
      ...error,
      id: "coffee-name-error",
    });
  });
});

describe("CoffeeLibrary", () => {
  it("groups bags under coffees and orders each group newest-created first", () => {
    const markup = renderToStaticMarkup(
      <CoffeeLibrary ownerId="anonymous" coffees={coffees} bags={bags} />,
    );

    expect(markup).toContain("Add coffee");
    expect(markup.match(/Add another bag/g)).toHaveLength(2);
    expect(markup.indexOf("Hualalai Kona")).toBeLessThan(
      markup.indexOf("Suke Quto"),
    );
    expect(markup.indexOf("Roasted Aug 12, 2026")).toBeLessThan(
      markup.indexOf("Roasted Aug 1, 2026"),
    );
    expect(markup).toContain("Roast date not set");
  });
});

describe("Onboarding", () => {
  beforeEach(async () => {
    db.close();
    await db.delete();
    await db.open();
  });

  it("offers an optional roast date in the compact coffee step", () => {
    Object.assign(globalThis, { React });
    const markup = renderToStaticMarkup(<Onboarding ownerId="anonymous" />);

    expect(markup).toContain('name="roastedOn"');
    expect(markup).toContain('type="date"');
  });

  it("creates the Coffee and first bag atomically during setup", async () => {
    const ownerId = "onboarding-test";

    await saveOnboardingSetup(ownerId, {
      coffeeName: "  Hualalai Kona  ",
      roaster: "  Coffee Purveyors  ",
      roast: "medium",
      roastedOn: "2026-08-12",
      machine: "  Gaggia Classic Pro  ",
      temperatureControl: "none",
      grinder: "  Fellow Opus  ",
      finerDirection: "lower",
    });

    const [coffee] = await getCoffees(ownerId);
    expect(coffee).toMatchObject({
      name: "Hualalai Kona",
      roaster: "Coffee Purveyors",
      roastLevel: "medium",
    });
    expect(await getCoffeeBags(ownerId)).toEqual([
      expect.objectContaining({
        coffeeId: coffee?.id,
        roastedOn: "2026-08-12",
      }),
    ]);
    expect((await getMachines(ownerId))[0]?.name).toBe("Gaggia Classic Pro");
    expect((await getGrinders(ownerId))[0]?.name).toBe("Fellow Opus");
    expect(await getOwnerPreference(ownerId, "onboarded")).toBe("true");
  });

  it("reuses stable record IDs when a failed setup is retried", async () => {
    const ownerId = "onboarding-retry";
    const draft = {
      coffeeName: "Hualalai Kona",
      roaster: "Coffee Purveyors",
      roast: "medium" as const,
      roastedOn: "2026-08-12",
      machine: "Gaggia Classic Pro",
      temperatureControl: "none" as const,
      grinder: "Fellow Opus",
      finerDirection: "lower" as const,
    };
    const ids = {
      coffeeId: "0198d3a4-1111-7000-8000-000000000060",
      bagId: "0198d3a4-1111-7000-8000-000000000061",
      machineId: "0198d3a4-1111-7000-8000-000000000062",
      grinderId: "0198d3a4-1111-7000-8000-000000000063",
    };

    await saveOnboardingSetup(ownerId, draft, ids);
    await saveOnboardingSetup(ownerId, draft, ids);

    expect(await getCoffees(ownerId)).toHaveLength(1);
    expect(await getCoffeeBags(ownerId)).toHaveLength(1);
    expect(await getMachines(ownerId)).toHaveLength(1);
    expect(await getGrinders(ownerId)).toHaveLength(1);
  });

  it("prevents duplicate submissions while setup persistence is pending", async () => {
    const lock = { saving: false };
    const states: Array<{ saving: boolean; error?: string }> = [];
    let calls = 0;
    let resolveSave: (() => void) | undefined;
    const save = () => {
      calls += 1;
      return new Promise<void>((resolve) => {
        resolveSave = resolve;
      });
    };

    const first = runOnboardingSubmission(lock, save, (state) =>
      states.push(state),
    );
    const second = runOnboardingSubmission(lock, save, (state) =>
      states.push(state),
    );

    expect(calls).toBe(1);
    expect(states).toEqual([{ saving: true }]);
    resolveSave?.();
    await Promise.all([first, second]);
    expect(states.at(-1)).toEqual({ saving: false });
  });

  it("surfaces setup rejection and renders disabled saving navigation", async () => {
    const states: Array<{ saving: boolean; error?: string }> = [];
    await runOnboardingSubmission(
      { saving: false },
      async () => {
        throw new Error("disk full");
      },
      (state) => states.push(state),
    );

    expect(states).toEqual([
      { saving: true },
      {
        saving: false,
        error: "Could not finish setup. Please try again.",
      },
    ]);

    const savingMarkup = renderToStaticMarkup(
      <OnboardingNavigation
        step={2}
        valid
        submission={{ saving: true }}
        onBack={() => {}}
        onContinue={() => {}}
      />,
    );
    expect(savingMarkup.match(/disabled=""/g)).toHaveLength(2);
    expect(savingMarkup).toContain("Saving…");

    const failedMarkup = renderToStaticMarkup(
      <OnboardingNavigation
        step={2}
        valid
        submission={states.at(-1)!}
        onBack={() => {}}
        onContinue={() => {}}
      />,
    );
    expect(failedMarkup).toContain('role="alert"');
    expect(failedMarkup).toContain("Could not finish setup. Please try again.");
  });
});
