import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const observePath = join(repositoryRoot, "ops/poc/bin/observe");
const recorderPath = join(repositoryRoot, "ops/poc/bin/record-operation");
const revision = "0123456789abcdef0123456789abcdef01234567";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dialed-observe-test-"));
  const bin = join(root, "bin");
  const state = join(root, "state");
  const operations = join(state, "operations");
  const observability = join(root, "observability");
  const textfile = join(observability, "textfile");
  const activeState = join(state, "active.env");
  const sentinel = join(observability, "INGESTION_STOPPED");
  mkdirSync(bin);
  mkdirSync(state);
  mkdirSync(operations);
  mkdirSync(observability);
  mkdirSync(textfile);
  writeFileSync(activeState, `APP_REVISION=${revision}\n`, { mode: 0o600 });
  writeFileSync(
    join(operations, "backup.env"),
    [
      "RESULT=success",
      "TIMESTAMP_SECONDS=1787992500",
      `REVISION=${revision}`,
      "REASON=scheduled",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  writeFileSync(
    join(operations, "deploy.env"),
    [
      "RESULT=failure",
      "TIMESTAMP_SECONDS=1787992400",
      `REVISION=${revision}`,
      "REASON=release",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh
case "$*" in
  *"label=com.docker.compose.project=dialed-poc"*"label=com.docker.compose.service=postgres"*) printf '%s\\n' container-postgres ;;
  *"label=com.docker.compose.project=dialed-poc"*"label=com.docker.compose.service=api"*)
    [ "$FAKE_DOCKER_MODE" = "fail-api-query" ] && exit 43
    printf '%s\\n' container-api
    ;;
  *"label=com.docker.compose.project=dialed-poc"*"label=com.docker.compose.service=web"*) printf '%s\\n' container-web ;;
  *"label=com.docker.compose.project=dialed-poc"*"label=com.docker.compose.service=cloudflared"*) printf '%s\\n' container-cloudflared ;;
  *"label=com.docker.compose.project=dialed-observability"*"label=com.docker.compose.service=grafana"*) printf '%s\\n' container-grafana ;;
  *"label=com.docker.compose.project=dialed-observability"*"label=com.docker.compose.service=loki"*) printf '%s\\n' container-loki ;;
  *"label=com.docker.compose.project=dialed-observability"*"label=com.docker.compose.service=prometheus"*) printf '%s\\n' container-prometheus ;;
  *inspect*container-postgres*) printf '%s\\n' 'true healthy 0' ;;
  *inspect*container-api*) printf '%s\\n' 'true healthy 2' ;;
  *inspect*container-web*) printf '%s\\n' 'true starting 1' ;;
  *inspect*container-cloudflared*) printf '%s\\n' 'true none 0' ;;
  *inspect*container-grafana*) printf '%s\\n' 'true healthy 0' ;;
  *inspect*container-loki*) printf '%s\\n' 'true unhealthy 3' ;;
  *inspect*container-prometheus*) printf '%s\\n' 'false none 0' ;;
  *) exit 99 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh
case "$*" in
  *3002/api/health*) [ "$FAKE_CURL_DOWN" = grafana ] && exit 22; exit 0 ;;
  *3100/ready*) [ "$FAKE_CURL_DOWN" = loki ] && exit 22; exit 0 ;;
  *9090/-/ready*) [ "$FAKE_CURL_DOWN" = prometheus ] && exit 22; exit 0 ;;
  *) exit 98 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "systemctl"),
    "#!/bin/sh\nprintf '%s\\n' inactive\n",
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "date"), "#!/bin/sh\nprintf '%s\\n' 1787992500\n", {
    mode: 0o755,
  });

  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { activeState, bin, operations, root, sentinel, state, textfile };
}

function runObserve(value, overrides = {}, arguments_ = []) {
  return spawnSync("sh", [observePath, ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${value.bin}:${process.env.PATH}`,
      DIALED_ACTIVE_STATE: value.activeState,
      DIALED_STATE_DIR: value.state,
      DIALED_OBSERVABILITY_DIR: join(value.root, "observability"),
      FAKE_DOCKER_MODE: "success",
      FAKE_CURL_DOWN: "",
      ...overrides,
    },
  });
}

function runRecorder(value, arguments_) {
  return spawnSync("sh", [recorderPath, ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${value.bin}:${process.env.PATH}`,
      DIALED_STATE_DIR: value.state,
    },
  });
}

function metricLines(source) {
  return source
    .trim()
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));
}

test("observe writes only allowlisted operational metric families", (t) => {
  const value = fixture(t);
  const result = runObserve(value);

  assert.equal(result.status, 0, result.stderr);
  const snapshot = readFileSync(join(value.textfile, "dialed.prom"), "utf8");
  const names = new Set(
    metricLines(snapshot).map((line) => line.split(/[ {]/, 1)[0]),
  );
  assert.deepEqual(
    names,
    new Set([
      "dialed_container_running",
      "dialed_container_health_status",
      "dialed_container_restart_count",
      "dialed_active_revision_info",
      "dialed_operation_last_result",
      "dialed_operation_last_timestamp_seconds",
      "dialed_observability_endpoint_up",
      "dialed_observability_ingestion_stopped",
    ]),
  );
  assert.match(
    snapshot,
    /dialed_container_running\{stack="poc",service="api"\} 1/,
  );
  assert.match(
    snapshot,
    /dialed_container_health_status\{stack="poc",service="api",status="healthy"\} 1/,
  );
  assert.match(
    snapshot,
    /dialed_container_restart_count\{stack="poc",service="api"\} 2/,
  );
  assert.match(
    snapshot,
    new RegExp(`dialed_active_revision_info\\{revision="${revision}"\\} 1`),
  );
  assert.match(
    snapshot,
    /dialed_operation_last_result\{operation="backup",reason="scheduled",result="success"\} 1/,
  );
  assert.match(
    snapshot,
    /dialed_operation_last_timestamp_seconds\{operation="backup",reason="scheduled"\} 1787992500/,
  );
  assert.match(
    snapshot,
    /dialed_operation_last_result\{operation="deployment",reason="release",result="failure"\} 1/,
  );
  assert.match(
    snapshot,
    /dialed_observability_endpoint_up\{service="grafana"\} 1/,
  );
  assert.match(snapshot, /dialed_observability_ingestion_stopped 0/);
  assert.doesNotMatch(
    snapshot,
    /container-(api|postgres|web|cloudflared|grafana|loki|prometheus)/,
  );
  assert.equal(
    statSync(join(value.textfile, "dialed.prom")).mode & 0o777,
    0o640,
  );
  assert.deepEqual(
    readdirSync(value.textfile).filter((name) =>
      name.startsWith(".dialed.prom."),
    ),
    [],
  );
});

test("observe reports the fixed health-status set without container identifiers", (t) => {
  const value = fixture(t);
  const result = runObserve(value);

  assert.equal(result.status, 0, result.stderr);
  const snapshot = readFileSync(join(value.textfile, "dialed.prom"), "utf8");
  for (const status of ["healthy", "unhealthy", "starting", "none"]) {
    assert.match(snapshot, new RegExp(`status="${status}"`));
  }
  assert.doesNotMatch(snapshot, /status="(null|missing|container-|unknown)"/);
});

test("a Docker query failure retains the prior complete snapshot", (t) => {
  const value = fixture(t);
  const destination = join(value.textfile, "dialed.prom");
  writeFileSync(destination, "prior complete snapshot\n", { mode: 0o640 });

  const result = runObserve(value, { FAKE_DOCKER_MODE: "fail-api-query" });

  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(destination, "utf8"), "prior complete snapshot\n");
});

test("observe rejects a caller-supplied service argument", (t) => {
  const value = fixture(t);
  const result = runObserve(value, {}, ["api"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage|argument/i);
});

test("record-operation atomically replaces only validated operation state", (t) => {
  const value = fixture(t);
  const prior = join(value.operations, "backup.env");
  const result = runRecorder(value, [
    "backup",
    "failure",
    revision,
    "predeploy",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(prior, "utf8"),
    [
      "RESULT=failure",
      "TIMESTAMP_SECONDS=1787992500",
      `REVISION=${revision}`,
      "REASON=predeploy",
      "",
    ].join("\n"),
  );
  assert.equal(statSync(prior).mode & 0o777, 0o600);
  assert.deepEqual(
    readdirSync(value.operations).filter((name) =>
      name.startsWith(".backup.env."),
    ),
    [],
  );

  const invalid = runRecorder(value, [
    "backup",
    "success",
    revision,
    "release",
  ]);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /reason/i);
  assert.match(readFileSync(prior, "utf8"), /RESULT=failure/);
});
