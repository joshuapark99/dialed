export function shouldPollForFileChanges(
  platform: NodeJS.Platform,
  workspaceRoot: string,
): boolean {
  return platform === "linux" && workspaceRoot.startsWith("/mnt/");
}
