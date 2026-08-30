import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import type { FastifyServerOptions } from "fastify";
import type { SyncStore } from "@dialed/db";
import type { AuthService } from "../src/auth.js";
import { createProductionLoggerOptions } from "../src/logger.js";
import { createServer } from "../src/server.js";

class MemoryStore implements SyncStore {
  async health() {}
  async push() {
    return [];
  }
  async pull() {
    return [];
  }
  async exportUser() {
    return [];
  }
  async deleteUser() {}
}

const signedOut: AuthService = {
  async authenticate() {
    return null;
  },
};

test("production logs normalize completed requests and redact secrets", async () => {
  const revision = "0123456789abcdef0123456789abcdef01234567";
  let serialized = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      serialized += chunk.toString();
      callback();
    },
  });
  const logger = {
    ...(createProductionLoggerOptions(revision) as Exclude<
      FastifyServerOptions["logger"],
      boolean
    >),
    stream,
    serializers: {
      req: (request: unknown) => request,
      res: (reply: unknown) => reply,
    },
  };
  const app = createServer({
    auth: signedOut,
    store: new MemoryStore(),
    logger,
  });

  await app.inject({
    method: "GET",
    url: "/v1/me?cursor=session-secret",
    headers: {
      authorization: "Bearer bearer-secret",
      cookie: "session=session-secret",
    },
  });
  app.log.info(
    {
      req: {
        headers: {
          authorization: "Bearer bearer-secret",
          cookie: "session=session-secret",
        },
      },
      res: { headers: { "set-cookie": "session=session-secret" } },
    },
    "sensitive fields",
  );
  await app.close();

  const records = serialized
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, any>);
  const completed = records.find(
    (record) => record.msg === "request completed",
  );
  const sensitive = records.find((record) => record.msg === "sensitive fields");

  assert.ok(completed);
  assert.equal(completed.service, "api");
  assert.equal(completed.revision, revision);
  assert.equal(completed.method, "GET");
  assert.equal(completed.route, "/v1/me");
  assert.equal(completed.statusCode, 401);
  assert.equal(typeof completed.responseTime, "number");
  assert.doesNotMatch(serialized, /session-secret|bearer-secret/);
  assert.doesNotMatch(completed.route, /\?|cursor|session-secret/);
  assert.equal(sensitive.req.headers.authorization, "[Redacted]");
  assert.equal(sensitive.req.headers.cookie, "[Redacted]");
  assert.equal(sensitive.res.headers["set-cookie"], "[Redacted]");
});
