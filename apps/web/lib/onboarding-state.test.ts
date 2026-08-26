import { describe, expect, it } from "vitest";
import {
  isRecoverableActiveTransfer,
  requiresOnboarding,
  shouldDeferAnonymousTransfer,
  shouldSynchronizePendingOperations,
} from "./onboarding-state";

describe("onboarding readiness", () => {
  it.each(["syncing", "checking-transfer", "offering"] as const)(
    "waits for authenticated account initialization while %s",
    (accountInitialization) => {
      expect(
        requiresOnboarding({
          authenticated: true,
          accountInitialization,
          onboarded: undefined,
          beanCount: 0,
          machineCount: 0,
          grinderCount: 0,
        }),
      ).toBe(false);
    },
  );

  it("starts authenticated onboarding only after account initialization is ready", () => {
    expect(
      requiresOnboarding({
        authenticated: true,
        accountInitialization: "ready",
        onboarded: undefined,
        beanCount: 0,
        machineCount: 0,
        grinderCount: 0,
      }),
    ).toBe(true);
  });

  it("uses restored setup records for an authenticated account without a local marker", () => {
    expect(
      requiresOnboarding({
        authenticated: true,
        accountInitialization: "ready",
        onboarded: undefined,
        beanCount: 1,
        machineCount: 1,
        grinderCount: 1,
      }),
    ).toBe(false);
  });

  it("still requires the local onboarding marker for anonymous data", () => {
    expect(
      requiresOnboarding({
        authenticated: false,
        accountInitialization: "ready",
        onboarded: undefined,
        beanCount: 1,
        machineCount: 1,
        grinderCount: 1,
      }),
    ).toBe(true);
  });

  it("defers an untouched offer but never a failed move with a possible active journal", () => {
    expect(shouldDeferAnonymousTransfer("offering")).toBe(true);
    expect(shouldDeferAnonymousTransfer("transfer-error")).toBe(false);
  });

  it("recovers only a same-account active transfer after a deferred Settings move", () => {
    expect(isRecoverableActiveTransfer("account:alice", "account:alice")).toBe(
      true,
    );
    expect(isRecoverableActiveTransfer("account:bob", "account:alice")).toBe(
      false,
    );
    expect(isRecoverableActiveTransfer(undefined, "account:alice")).toBe(false);
  });

  it.each([
    {
      name: "a new pending operation after readiness",
      input: {
        authenticated: true,
        accountInitialization: "ready" as const,
        online: true,
        previousPendingCount: 0,
        pendingCount: 1,
      },
      expected: true,
    },
    {
      name: "the pending queue draining after sync",
      input: {
        authenticated: true,
        accountInitialization: "ready" as const,
        online: true,
        previousPendingCount: 1,
        pendingCount: 0,
      },
      expected: false,
    },
    {
      name: "the initial pending count observation",
      input: {
        authenticated: true,
        accountInitialization: "ready" as const,
        online: true,
        previousPendingCount: undefined,
        pendingCount: 2,
      },
      expected: false,
    },
    {
      name: "an offline account",
      input: {
        authenticated: true,
        accountInitialization: "ready" as const,
        online: false,
        previousPendingCount: 0,
        pendingCount: 1,
      },
      expected: false,
    },
    {
      name: "account initialization before readiness",
      input: {
        authenticated: true,
        accountInitialization: "checking-transfer" as const,
        online: true,
        previousPendingCount: 0,
        pendingCount: 1,
      },
      expected: false,
    },
  ])(
    "synchronizes pending operations for $name: $expected",
    ({ input, expected }) => {
      expect(shouldSynchronizePendingOperations(input)).toBe(expected);
    },
  );
});
