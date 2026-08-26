import { describe, expect, it } from "vitest";
import {
  isRecoverableActiveTransfer,
  requiresOnboarding,
  shouldDeferAnonymousTransfer,
} from "./onboarding-state";

describe("onboarding readiness", () => {
  it.each([
    "syncing",
    "checking-transfer",
    "offering",
    "consent-changed",
  ] as const)(
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

  it("defers pre-stage consent states but never a failed move with a possible active journal", () => {
    expect(shouldDeferAnonymousTransfer("offering")).toBe(true);
    expect(shouldDeferAnonymousTransfer("consent-changed")).toBe(true);
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
});
