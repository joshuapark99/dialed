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
    "syncing" | "checking-transfer" | "offering" | "ready" | "transfer-error";
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
  status: "offering" | "transfer-error",
): boolean {
  return status === "offering";
}

export function isRecoverableActiveTransfer(
  activeDestinationOwnerId: string | undefined,
  destinationOwnerId: string,
): boolean {
  return activeDestinationOwnerId === destinationOwnerId;
}

export function shouldSynchronizePendingOperations({
  authenticated,
  accountInitialization,
  online,
  previousPendingCount,
  pendingCount,
}: {
  authenticated: boolean;
  accountInitialization:
    "syncing" | "checking-transfer" | "offering" | "ready" | "transfer-error";
  online: boolean;
  previousPendingCount: number | undefined;
  pendingCount: number;
}): boolean {
  return (
    authenticated &&
    accountInitialization === "ready" &&
    online &&
    previousPendingCount !== undefined &&
    pendingCount > previousPendingCount
  );
}
