import { describe, expect, it } from "vitest";
import { shouldPollForFileChanges } from "./lib/dev-file-watching";
import nextConfig from "./next.config";

function applyWebpackConfig(
  dev: boolean,
  watchOptions?: Record<string, unknown>,
) {
  const configureWebpack = nextConfig.webpack;
  expect(configureWebpack).toBeTypeOf("function");
  if (!configureWebpack) throw new Error("Webpack configuration is missing");

  return configureWebpack(
    { watchOptions } as Parameters<typeof configureWebpack>[0],
    { dev } as Parameters<typeof configureWebpack>[1],
  );
}

describe("Next.js development file watching", () => {
  it("polls only for Linux workspaces on mounted filesystems", () => {
    expect(shouldPollForFileChanges("linux", "/mnt/c/work/dialed")).toBe(true);
    expect(shouldPollForFileChanges("linux", "/home/user/dialed")).toBe(false);
    expect(shouldPollForFileChanges("darwin", "/mnt/work/dialed")).toBe(false);
  });

  it("adds polling in development and leaves production watching unchanged", () => {
    const development = applyWebpackConfig(true, {
      ignored: ["**/node_modules/**"],
    });
    expect(development.watchOptions).toEqual({
      ignored: ["**/node_modules/**"],
      poll: 1_000,
      aggregateTimeout: 200,
    });

    const productionWatchOptions = { ignored: ["**/.next/**"] };
    const production = applyWebpackConfig(false, productionWatchOptions);
    expect(production.watchOptions).toBe(productionWatchOptions);
  });

  it("creates development watcher settings when none exist", () => {
    expect(applyWebpackConfig(true).watchOptions).toEqual({
      poll: 1_000,
      aggregateTimeout: 200,
    });
  });
});
