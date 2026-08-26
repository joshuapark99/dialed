export function requiresOnboarding({
  authenticated,
  accountInitialization,
  onboarded,
  beanCount,
  machineCount,
  grinderCount,
}: {
  authenticated: boolean;
  accountInitialization:
    | "syncing"
    | "checking-transfer"
    | "offering"
    | "consent-changed"
    | "ready"
    | "transfer-error";
  onboarded: string | undefined;
  beanCount: number;
  machineCount: number;
  grinderCount: number;
}): boolean {
  if (authenticated && accountInitialization !== "ready") return false;
  const setupIsIncomplete =
    beanCount === 0 || machineCount === 0 || grinderCount === 0;
  return setupIsIncomplete || (!authenticated && !onboarded);
}

export function shouldDeferAnonymousTransfer(
  status: "offering" | "consent-changed" | "transfer-error",
): boolean {
  return status === "offering" || status === "consent-changed";
}

export function isRecoverableActiveTransfer(
  activeDestinationOwnerId: string | undefined,
  destinationOwnerId: string,
): boolean {
  return activeDestinationOwnerId === destinationOwnerId;
}
