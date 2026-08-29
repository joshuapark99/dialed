import { describe, expect, it } from "vitest";
import {
  configureFileWatching,
  shouldPollForFileChanges,
} from "./lib/dev-file-watching";
import nextConfig from "./next.config";

describe("Next.js development file watching", () => {
  it("polls only for Linux workspaces on mounted filesystems", () => {
    expect(shouldPollForFileChanges("linux", "/mnt/c/work/dialed")).toBe(true);
    expect(shouldPollForFileChanges("linux", "/home/user/dialed")).toBe(false);
    expect(shouldPollForFileChanges("darwin", "/mnt/work/dialed")).toBe(false);
  });

  it("adds polling only when the caller explicitly enables it", () => {
    const enabled = { watchOptions: { ignored: ["**/node_modules/**"] } };
    expect(configureFileWatching(enabled, true, true).watchOptions).toEqual({
      ignored: ["**/node_modules/**"],
      poll: 1_000,
      aggregateTimeout: 200,
    });

    const pollingDisabled = {
      watchOptions: { ignored: ["**/node_modules/**"] },
    };
    expect(configureFileWatching(pollingDisabled, true, false)).toBe(
      pollingDisabled,
    );
    expect(pollingDisabled.watchOptions).toEqual({
      ignored: ["**/node_modules/**"],
    });

    const production = { watchOptions: { ignored: ["**/.next/**"] } };
    expect(configureFileWatching(production, false, true)).toBe(production);
    expect(production.watchOptions).toEqual({ ignored: ["**/.next/**"] });
  });
});

describe("Next.js health routing", () => {
  it("routes API health checks through the same public origin", async () => {
    const rewrites = await nextConfig.rewrites?.();

    expect(rewrites).toEqual(
      expect.arrayContaining([
        {
          source: "/api/healthz",
          destination: "http://127.0.0.1:3001/healthz",
        },
        {
          source: "/api/readyz",
          destination: "http://127.0.0.1:3001/readyz",
        },
      ]),
    );
  });
});
