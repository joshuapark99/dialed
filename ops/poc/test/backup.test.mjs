import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const backupPath = join(repositoryRoot, "ops/poc/bin/backup");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dialed-backup-test-"));
  const bin = join(root, "bin");
  const backups = join(root, "backups");
  const data = join(root, "data");
  const environmentFile = join(root, "poc.env");
  const activeState = join(root, "active.env");
  const composeFile = join(root, "compose.poc.yaml");
  const dockerLog = join(root, "docker.log");
  const recordLog = join(root, "record-operation.log");
  mkdirSync(bin);
  mkdirSync(backups);
  mkdirSync(data);

  writeFileSync(
    environmentFile,
    [
      `DIALED_BACKUP_DIR=${backups}`,
      `DIALED_DATA_DIR=${data}`,
      "POSTGRES_USER=dialed",
      "POSTGRES_PASSWORD=test-password",
      "POSTGRES_DB=dialed",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  writeFileSync(
    activeState,
    [
      "WEB_IMAGE=ghcr.io/example/web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "API_IMAGE=ghcr.io/example/api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "APP_REVISION=0123456789abcdef0123456789abcdef01234567",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  writeFileSync(
    composeFile,
    readFileSync(join(repositoryRoot, "compose.poc.yaml")),
    { mode: 0o644 },
  );

  const docker = join(bin, "docker");
  writeFileSync(
    docker,
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$FAKE_DOCKER_MODE" in
  fail) exit 23 ;;
  empty) exit 0 ;;
  success) printf '%s' "$FAKE_DUMP_CONTENT" ;;
  signal-block)
    : > "$FAKE_BLOCK_READY"
    sleep 0.2
    printf '%s' "$FAKE_DUMP_CONTENT"
    ;;
  *) exit 24 ;;
esac
`,
  );
  chmodSync(docker, 0o755);

  const date = join(bin, "date");
  writeFileSync(date, "#!/bin/sh\nprintf '%s\\n' \"$FAKE_DATE\"\n");
  chmodSync(date, 0o755);

  const recorder = join(bin, "record-operation");
  writeFileSync(
    recorder,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_RECORD_LOG"
[ "$FAKE_RECORD_MODE" = fail ] && exit 71
`,
  );
  chmodSync(recorder, 0o755);

  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    bin,
    backups,
    environmentFile,
    activeState,
    composeFile,
    dockerLog,
    recordLog,
    recorder,
  };
}

function runBackup(fixtureValue, mode, reason = "scheduled", overrides = {}) {
  return spawnSync("sh", [backupPath, reason], {
    encoding: "utf8",
    env: backupEnvironment(fixtureValue, mode, overrides),
  });
}

function backupEnvironment(fixtureValue, mode, overrides = {}) {
  return {
    ...process.env,
    PATH: `${fixtureValue.bin}:${process.env.PATH}`,
    DIALED_ENV_FILE: fixtureValue.environmentFile,
    DIALED_ACTIVE_STATE: fixtureValue.activeState,
    DIALED_STATE_DIR: fixtureValue.root,
    DIALED_LOCK_FILE: join(fixtureValue.root, "deploy.lock"),
    DIALED_COMPOSE_FILE: fixtureValue.composeFile,
    DIALED_RECORD_OPERATION: fixtureValue.recorder,
    FAKE_DOCKER_LOG: fixtureValue.dockerLog,
    FAKE_DOCKER_MODE: mode,
    FAKE_DUMP_CONTENT: "verified custom-format dump",
    FAKE_DATE: "20260829T031500Z",
    FAKE_RECORD_LOG: fixtureValue.recordLog,
    FAKE_RECORD_MODE: "success",
    FAKE_BLOCK_READY: join(fixtureValue.root, "block.ready"),
    ...overrides,
  };
}

async function waitForFile(path, child) {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (child.exitCode !== null)
      throw new Error(`child exited ${child.exitCode}`);
    if (Date.now() >= deadline)
      throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function signalBackup(fixtureValue, signal) {
  const ready = join(fixtureValue.root, "block.ready");
  const child = spawn("sh", [backupPath, "scheduled"], {
    env: backupEnvironment(fixtureValue, "signal-block"),
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await waitForFile(ready, child);
  child.kill(signal);
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, closeSignal) =>
      resolvePromise({ code, signal: closeSignal, stderr }),
    );
  });
}

test("HUP, INT, and TERM preserve signal-derived failure statuses", async (t) => {
  for (const [signal, expectedStatus] of [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    const value = fixture(t);
    const result = await signalBackup(value, signal);

    assert.equal(result.signal, null, signal);
    assert.equal(result.code, expectedStatus, `${signal}: ${result.stderr}`);
    assert.equal(
      readFileSync(value.recordLog, "utf8").trim(),
      "backup failure 0123456789abcdef0123456789abcdef01234567 scheduled",
      signal,
    );
  }
});

test("a failed pg_dump leaves no archive or temporary file", (t) => {
  const value = fixture(t);
  const result = runBackup(value, "fail");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pg_dump/i);
  assert.deepEqual(readdirSync(value.backups), []);
});

test("an empty pg_dump is rejected before archive promotion", (t) => {
  const value = fixture(t);
  const result = runBackup(value, "empty");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /empty/i);
  assert.deepEqual(readdirSync(value.backups), []);
});

test("a successful dump is atomically named with revision metadata", (t) => {
  const value = fixture(t);
  const result = runBackup(value, "success", "predeploy");
  const expected = join(
    value.backups,
    "dialed-20260829T031500Z-0123456789abcdef0123456789abcdef01234567-predeploy.dump",
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), expected);
  assert.equal(readFileSync(expected, "utf8"), "verified custom-format dump");
  assert.deepEqual(readdirSync(value.backups), [expected.split("/").at(-1)]);
});

test("scheduled retention keeps fourteen dailies and every predeploy archive", (t) => {
  const value = fixture(t);
  const revision = "0123456789abcdef0123456789abcdef01234567";
  for (let day = 1; day <= 15; day += 1) {
    const timestamp = `202608${String(day).padStart(2, "0")}T031500Z`;
    writeFileSync(
      join(value.backups, `dialed-${timestamp}-${revision}-scheduled.dump`),
      `scheduled-${day}`,
    );
  }
  const predeployNames = [
    `dialed-20260801T020000Z-${revision}-predeploy.dump`,
    `dialed-20260802T020000Z-${revision}-predeploy.dump`,
  ];
  for (const name of predeployNames) {
    writeFileSync(join(value.backups, name), "predeploy");
  }

  const result = runBackup(value, "success");
  assert.equal(result.status, 0, result.stderr);

  const names = readdirSync(value.backups);
  assert.equal(
    names.filter((name) => name.endsWith("-scheduled.dump")).length,
    14,
  );
  assert.equal(
    names.includes(`dialed-20260801T031500Z-${revision}-scheduled.dump`),
    false,
  );
  assert.equal(
    names.includes(`dialed-20260802T031500Z-${revision}-scheduled.dump`),
    false,
  );
  for (const name of predeployNames) assert.ok(names.includes(name));
});

test("recorder failure does not change successful backup status", (t) => {
  const value = fixture(t);
  const result = runBackup(value, "success", "scheduled", {
    FAKE_RECORD_MODE: "fail",
  });

  assert.equal(result.status, 0, result.stderr);
});

test("recorder failure does not change failed backup status", (t) => {
  const value = fixture(t);
  const result = runBackup(value, "fail", "scheduled", {
    FAKE_RECORD_MODE: "fail",
  });

  assert.equal(result.status, 1, result.stderr);
});
