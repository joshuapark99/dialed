import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../src/config.js";

const validEnvironment = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://dialed:dialed@localhost:5432/dialed",
  BETTER_AUTH_SECRET: "a-development-only-secret-with-32-characters",
  APP_URL: "http://localhost:3000",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
};

test("configuration provides local API defaults", () => {
  const config = readConfig(validEnvironment);
  assert.equal(config.API_HOST, "0.0.0.0");
  assert.equal(config.API_PORT, 3001);
  assert.equal(config.APP_REVISION, "development");
});

test("configuration accepts the deployed revision", () => {
  const revision = "0123456789abcdef0123456789abcdef01234567";
  const config = readConfig({ ...validEnvironment, APP_REVISION: revision });

  assert.equal(config.APP_REVISION, revision);
});

test("configuration reports every missing production dependency", () => {
  assert.throws(
    () => readConfig({}),
    (error) => {
      assert.match(String(error), /DATABASE_URL/);
      assert.match(String(error), /BETTER_AUTH_SECRET/);
      assert.match(String(error), /GOOGLE_CLIENT_ID/);
      return true;
    },
  );
});
