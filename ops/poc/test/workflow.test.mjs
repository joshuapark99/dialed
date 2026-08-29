import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const workflow = readFileSync(
  resolve(repositoryRoot, ".github/workflows/ci.yml"),
  "utf8",
);

function job(name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, `missing ${name} job`);
  const bodyStart = start + marker.length;
  const rest = workflow.slice(bodyStart);
  const nextJob = rest.search(/\n  [a-z][a-z0-9_-]*:\n/);
  return nextJob < 0 ? rest : rest.slice(0, nextJob);
}

test("verification runs on Node.js 22 and 24 without self-hosted runners", () => {
  const verify = job("verify");
  assert.match(verify, /node-version:\s*\[[^\]]*22[^\]]*24[^\]]*\]/);
  assert.doesNotMatch(workflow, /runs-on:\s*.*self-hosted/);
});

test("publication is main-push-only and owns the only package write grant", () => {
  const publish = job("publish");
  assert.match(publish, /github\.event_name\s*==\s*'push'/);
  assert.match(publish, /github\.ref\s*==\s*'refs\/heads\/main'/);
  assert.match(publish, /packages:\s*write/);
  assert.equal(workflow.match(/packages:\s*write/g)?.length, 1);
});

test("external smoke verification uses the protected POC environment", () => {
  const smoke = job("smoke");
  assert.match(smoke, /environment:\s*poc/);
  assert.match(smoke, /ops\/poc\/bin\/check-external\.mjs/);
  assert.match(smoke, /cancel-in-progress:\s*false/);
});

test("workflow runs for one ref cannot race publication and smoke checks", () => {
  const settings = workflow.slice(0, workflow.indexOf("\njobs:\n"));
  assert.match(settings, /concurrency:/);
  assert.match(
    settings,
    /group:\s*ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/,
  );
  assert.match(settings, /cancel-in-progress:\s*false/);
});

test("every GitHub action is pinned to an immutable commit", () => {
  const actions = [...workflow.matchAll(/^\s+(?:-\s+)?uses:\s+(\S+)/gm)].map(
    ([, action]) => action,
  );
  assert.ok(actions.length > 0);
  for (const action of actions) {
    assert.match(action, /@[0-9a-f]{40}$/, `${action} is not SHA-pinned`);
  }
});
