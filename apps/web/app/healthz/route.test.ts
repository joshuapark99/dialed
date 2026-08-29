import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("web health", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports the deployed revision dynamically", async () => {
    vi.stubEnv("APP_REVISION", "0123456789abcdef0123456789abcdef01234567");

    expect(await (await GET()).json()).toEqual({
      status: "ok",
      revision: "0123456789abcdef0123456789abcdef01234567",
    });
  });
});
