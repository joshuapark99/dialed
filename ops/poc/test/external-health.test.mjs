import assert from "node:assert/strict";
import test from "node:test";
import {
  validateExternalHealthConfig,
  waitForExternalRevision,
} from "../lib/external-health.mjs";

const revision = "0123456789abcdef0123456789abcdef01234567";
const oldRevision = "1111111111111111111111111111111111111111";
const credentials = {
  clientId: "service-token-id",
  clientSecret: "service-token-secret",
};

function healthResponse(pathname, deployedRevision = revision) {
  return Response.json({
    status: pathname === "/healthz" ? "ok" : "ready",
    revision: deployedRevision,
  });
}

test("external verification configuration requires HTTPS, a Git revision, and credentials", () => {
  assert.deepEqual(
    validateExternalHealthConfig({
      baseUrl: "https://poc.example.com/",
      revision,
      ...credentials,
    }),
    {
      baseUrl: "https://poc.example.com",
      revision,
      ...credentials,
    },
  );
  assert.throws(
    () =>
      validateExternalHealthConfig({
        baseUrl: "http://poc.example.com",
        revision,
        ...credentials,
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      validateExternalHealthConfig({
        baseUrl: "https://poc.example.com",
        revision: "main",
        ...credentials,
      }),
    /40-character/,
  );
  assert.throws(
    () =>
      validateExternalHealthConfig({
        baseUrl: "https://poc.example.com",
        revision,
        clientId: "",
        clientSecret: "",
      }),
    /credentials/,
  );
});

test("both public health requests carry Cloudflare Access credentials", async () => {
  const requests = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    requests.push({ url, headers: new Headers(init.headers) });
    return healthResponse(url.pathname);
  };

  await waitForExternalRevision({
    baseUrl: "https://poc.example.com",
    revision,
    ...credentials,
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
    assert.equal(headers.get("CF-Access-Client-Id"), credentials.clientId);
    assert.equal(
      headers.get("CF-Access-Client-Secret"),
      credentials.clientSecret,
    );
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
    ...credentials,
    timeoutMs: 1_000,
    intervalMs: 0,
    fetchImpl,
    delay: async () => {},
  });

  assert.equal(calls, 4);
});

test("a transient Cloudflare Access denial is retried", async () => {
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
    ...credentials,
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
      ...credentials,
      timeoutMs: 0,
      intervalMs: 0,
      fetchImpl,
      delay: async () => {},
    }),
    /1111111111111111111111111111111111111111.*mismatch/i,
  );
});

test("timeout errors include the last observed Access and origin states", async () => {
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
      ...credentials,
      timeoutMs: 0,
      intervalMs: 0,
      fetchImpl,
      delay: async () => {},
    }),
    /web=403.*api=503.*unavailable.*1111111111111111111111111111111111111111/i,
  );
});
