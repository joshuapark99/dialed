export function requiresOnboarding({
  authenticated,
  onboarded,
  beanCount,
  machineCount,
  grinderCount,
}: {
  authenticated: boolean;
  onboarded: string | undefined;
  beanCount: number;
  machineCount: number;
  grinderCount: number;
}): boolean {
  const setupIsIncomplete =
    beanCount === 0 || machineCount === 0 || grinderCount === 0;
  return setupIsIncomplete || (!authenticated && !onboarded);
}
