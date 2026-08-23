import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Brew, Coffee, CoffeeBag } from "../lib/models";
import { HistoryView } from "./history-view";

const historyState = vi.hoisted(() => ({
  callIndex: 0,
  selectedId: undefined as string | undefined,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initialState: T | (() => T)) => {
      const callIndex = historyState.callIndex;
      historyState.callIndex += 1;
      const initialValue =
        typeof initialState === "function"
          ? (initialState as () => T)()
          : initialState;
      const value = callIndex === 1 ? historyState.selectedId : initialValue;
      return [value as T, () => undefined] as const;
    },
  };
});

const coffee: Coffee = {
  id: "coffee-1",
  name: "Hualalai Kona",
  roaster: "Coffee Purveyors",
  roastLevel: "medium",
  createdAt: "2026-08-01T12:00:00.000Z",
};

const bags: CoffeeBag[] = [
  {
    id: "bag-dated",
    coffeeId: coffee.id,
    roastedOn: "2026-08-12",
    createdAt: "2026-08-13T12:00:00.000Z",
  },
  {
    id: "bag-undated",
    coffeeId: coffee.id,
    createdAt: "2026-08-14T12:00:00.000Z",
  },
];

function brew(id: string, beanId: string, createdAt: string): Brew {
  return {
    id,
    beanId,
    machineId: "machine-1",
    grinderId: "grinder-1",
    dose: 18,
    yield: 36,
    duration: 28,
    grind: "4",
    taste: {
      acidity: 3,
      bitterness: 3,
      strength: 3,
      body: 3,
      enjoyment: 4,
    },
    ratio: 2,
    flow: 36 / 28,
    recommendation: {
      variable: "hold",
      direction: "hold",
      headline: "Hold steady",
      rationale: "The shot is balanced.",
      expectedEffect: "Keep the current balance.",
      confidence: "high",
      ruleVersion: "web-1",
    },
    createdAt,
    updatedAt: createdAt,
    syncState: "synced",
  };
}

const brews = [
  brew("brew-dated", bags[0]!.id, "2026-08-15T12:00:00.000Z"),
  brew("brew-undated", bags[1]!.id, "2026-08-16T12:00:00.000Z"),
];

function renderHistory(selectedId?: string): string {
  Object.assign(globalThis, { React });
  historyState.callIndex = 0;
  historyState.selectedId = selectedId;
  return renderToStaticMarkup(
    <HistoryView
      ownerId="anonymous"
      coffees={[coffee]}
      bags={bags}
      brews={brews}
      onLog={() => {}}
    />,
  );
}

describe("HistoryView", () => {
  it("shows each exact bag roast label in rows and selected details", () => {
    const rows = renderHistory();

    expect(rows.match(/Roasted Aug 12, 2026/g) ?? []).toHaveLength(1);
    expect(rows.match(/Roast date not set/g) ?? []).toHaveLength(1);

    expect(
      renderHistory("brew-dated").match(/Roasted Aug 12, 2026/g) ?? [],
    ).toHaveLength(2);
    expect(
      renderHistory("brew-undated").match(/Roast date not set/g) ?? [],
    ).toHaveLength(2);
  });
});
