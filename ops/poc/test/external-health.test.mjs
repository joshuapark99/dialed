import assert from "node:assert/strict";
import test from "node:test";
import {
  validateExternalHealthConfig,
  waitForExternalRevision,
} from "../lib/external-health.mjs";

const revision = "0123456789abcdef0123456789abcdef01234567";
const oldRevision = "1111111111111111111111111111111111111111";

function healthResponse(pathname, deployedRevision = revision) {
  return Response.json({
    status: pathname === "/healthz" ? "ok" : "ready",
    revision: deployedRevision,
  });
}

test("public verification configuration requires HTTPS and a Git revision", () => {
  assert.deepEqual(
    validateExternalHealthConfig({
      baseUrl: "https://poc.example.com/",
      revision,
    }),
    {
      baseUrl: "https://poc.example.com",
      revision,
    },
  );
  assert.throws(
    () =>
      validateExternalHealthConfig({
        baseUrl: "http://poc.example.com",
        revision,
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      validateExternalHealthConfig({
        baseUrl: "https://poc.example.com",
        revision: "main",
      }),
    /40-character/,
  );
});

test("both public health requests are sent without authentication headers", async () => {
  const requests = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    requests.push({ url, headers: new Headers(init.headers) });
    return healthResponse(url.pathname);
  };

  await waitForExternalRevision({
    baseUrl: "https://poc.example.com",
    revision,
    timeoutMs: 1_000,
    intervalMs: 0,
    fetchImpl,
    delay: async () => {},
  });

  assert.deepEqual(
    requests.map(({ url }) => url.pathname),
    ["/healthz", "/api/readyz"],
  );
  for (const { headers } of requests) {
    assert.deepEqual([...headers], []);
  }
});

test("an old deployed revision is retried until both services converge", async () => {
  let calls = 0;
  const fetchImpl = async (input) => {
    const attempt = Math.floor(calls / 2);
    calls += 1;
    return healthResponse(
      new URL(input).pathname,
      attempt === 0 ? oldRevision : revision,
    );
  };

  await waitForExternalRevision({
    baseUrl: "https://poc.example.com",
    revision,
    timeoutMs: 1_000,
    intervalMs: 0,
    fetchImpl,
    delay: async () => {},
  });

  assert.equal(calls, 4);
});

test("a transient edge denial is retried", async () => {
  let calls = 0;
  const fetchImpl = async (input) => {
    const attempt = Math.floor(calls / 2);
    calls += 1;
    if (attempt === 0) return new Response("forbidden", { status: 403 });
    return healthResponse(new URL(input).pathname);
  };

  await waitForExternalRevision({
    baseUrl: "https://poc.example.com",
    revision,
    timeoutMs: 1_000,
    intervalMs: 0,
    fetchImpl,
    delay: async () => {},
  });

  assert.equal(calls, 4);
});

test("mismatched web and API revisions are never accepted", async () => {
  const fetchImpl = async (input) => {
    const pathname = new URL(input).pathname;
    return healthResponse(
      pathname,
      pathname === "/healthz" ? revision : oldRevision,
    );
  };

  await assert.rejects(
    waitForExternalRevision({
      baseUrl: "https://poc.example.com",
      revision,
      timeoutMs: 0,
      intervalMs: 0,
      fetchImpl,
      delay: async () => {},
    }),
    /1111111111111111111111111111111111111111.*mismatch/i,
  );
});

test("timeout errors include the last observed public endpoint states", async () => {
  const fetchImpl = async (input) =>
    new URL(input).pathname === "/healthz"
      ? new Response("forbidden", { status: 403 })
      : Response.json(
          { status: "unavailable", revision: oldRevision },
          { status: 503 },
        );

  await assert.rejects(
    waitForExternalRevision({
      baseUrl: "https://poc.example.com",
      revision,
      timeoutMs: 0,
      intervalMs: 0,
      fetchImpl,
      delay: async () => {},
    }),
    /web=403.*api=503.*unavailable.*1111111111111111111111111111111111111111/i,
  );
});
