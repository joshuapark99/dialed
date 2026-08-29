export function shouldPollForFileChanges(
  platform: NodeJS.Platform,
  workspaceRoot: string,
): boolean {
  return platform === "linux" && workspaceRoot.startsWith("/mnt/");
}

export function configureFileWatching<
  T extends { watchOptions?: Record<string, unknown> },
>(config: T, dev: boolean, poll: boolean): T {
  if (!dev || !poll) return config;
  config.watchOptions = {
    ...config.watchOptions,
    poll: 1_000,
    aggregateTimeout: 200,
  };
  return config;
}
