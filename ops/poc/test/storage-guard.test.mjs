import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
const guardPath = join(repositoryRoot, "ops/poc/bin/storage-guard");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dialed-storage-guard-test-"));
  const bin = join(root, "bin");
  const observability = join(root, "observability");
  const environmentFile = join(root, "poc.env");
  const commandLog = join(root, "commands.log");
  mkdirSync(bin);
  mkdirSync(observability);

  for (const [name, source] of Object.entries({
    date: "#!/bin/sh\nprintf '%s\\n' 2026-08-30T12:34:56Z\n",
    du: '#!/bin/sh\nprintf \'du %s\\n\' "$*" >> "$FAKE_COMMAND_LOG"\nprintf \'%s\\t%s\\n\' "$FAKE_USED_BYTES" "$2"\n',
    df: "#!/bin/sh\nprintf 'df %s\\n' \"$*\" >> \"$FAKE_COMMAND_LOG\"\nprintf '%s\\n' 'Filesystem 1B-blocks Used Available Use% Mounted on'\nprintf '%s\\n' \"/dev/fake 1000000 1 $FAKE_FREE_BYTES 1% /fake\"\n",
    systemctl:
      '#!/bin/sh\nprintf \'systemctl %s\\n\' "$*" >> "$FAKE_COMMAND_LOG"\n',
  })) {
    const path = join(bin, name);
    writeFileSync(path, source);
    chmodSync(path, 0o755);
  }

  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    bin,
    commandLog,
    environmentFile,
    observability,
    root,
    sentinel: join(observability, "INGESTION_STOPPED"),
  };
}

function writeEnvironment(value, settings = {}) {
  const environment = {
    DIALED_OBSERVABILITY_DIR: value.observability,
    DIALED_OBSERVABILITY_MAX_BYTES: "100",
    DIALED_OBSERVABILITY_MIN_FREE_BYTES: "200",
    ...settings,
  };
  writeFileSync(
    value.environmentFile,
    `${Object.entries(environment)
      .map(([key, entry]) => `${key}='${entry}'`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );
}

function runGuard(value, settings = {}) {
  writeEnvironment(value, settings);
  return spawnSync("sh", [guardPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      DIALED_ENV_FILE: value.environmentFile,
      FAKE_COMMAND_LOG: value.commandLog,
      FAKE_FREE_BYTES: settings.freeBytes ?? "201",
      FAKE_USED_BYTES: settings.usedBytes ?? "99",
      PATH: `${value.bin}:${process.env.PATH}`,
    },
  });
}

function commands(value) {
  return existsSync(value.commandLog)
    ? readFileSync(value.commandLog, "utf8").trim().split("\n").filter(Boolean)
    : [];
}

test("storage boundaries stop only Alloy and atomically record the active threshold", (t) => {
  const cases = [
    {
      freeBytes: "201",
      label: "with an empty observability directory",
      stopped: false,
      usedBytes: "0",
    },
    {
      freeBytes: "201",
      label: "below the usage limit",
      stopped: false,
      usedBytes: "99",
    },
    {
      freeBytes: "201",
      label: "at the usage limit",
      reason: "used_bytes",
      stopped: true,
      usedBytes: "100",
    },
    {
      freeBytes: "201",
      label: "above the usage limit",
      reason: "used_bytes",
      stopped: true,
      usedBytes: "101",
    },
    {
      freeBytes: "201",
      label: "above the free-space reserve",
      stopped: false,
      usedBytes: "99",
    },
    {
      freeBytes: "200",
      label: "at the free-space reserve",
      stopped: false,
      usedBytes: "99",
    },
    {
      freeBytes: "199",
      label: "below the free-space reserve",
      reason: "free_bytes",
      stopped: true,
      usedBytes: "99",
    },
  ];

  for (const entry of cases) {
    const value = fixture(t);
    const result = runGuard(value, entry);
    assert.equal(result.status, 0, `${entry.label}: ${result.stderr}`);
    assert.deepEqual(
      commands(value).slice(-1),
      entry.stopped
        ? ["systemctl stop dialed-poc-alloy.service"]
        : ["df -PB1 " + value.observability],
    );
    assert.equal(existsSync(value.sentinel), entry.stopped, entry.label);
    if (entry.stopped) {
      assert.equal(
        readFileSync(value.sentinel, "utf8"),
        [
          `reason=${entry.reason}`,
          `observed_bytes=${entry.reason === "used_bytes" ? entry.usedBytes : entry.freeBytes}`,
          `threshold_bytes=${entry.reason === "used_bytes" ? "100" : "200"}`,
          "timestamp=2026-08-30T12:34:56Z",
          "",
        ].join("\n"),
      );
      assert.deepEqual(
        readdirSync(value.observability).filter((name) =>
          name.startsWith(".INGESTION_STOPPED."),
        ),
        [],
      );
    }
  }
});

test("the same active condition leaves an existing sentinel and Alloy journal untouched", (t) => {
  const value = fixture(t);
  writeFileSync(value.sentinel, "reason=used_bytes\noperator_note=preserve\n", {
    mode: 0o600,
  });

  const result = runGuard(value, { usedBytes: "100" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(value.sentinel, "utf8"),
    "reason=used_bytes\noperator_note=preserve\n",
  );
  assert.deepEqual(commands(value), [
    `du -sB1 ${value.observability}`,
    `df -PB1 ${value.observability}`,
  ]);
});

test("below threshold never clears a prior stop marker or resumes ingestion", (t) => {
  const value = fixture(t);
  writeFileSync(value.sentinel, "reason=used_bytes\n", { mode: 0o600 });

  const result = runGuard(value, { freeBytes: "200", usedBytes: "99" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(value.sentinel, "utf8"), "reason=used_bytes\n");
  assert.deepEqual(commands(value), [
    `du -sB1 ${value.observability}`,
    `df -PB1 ${value.observability}`,
  ]);
});

test("invalid settings and newline paths fail before disk or service commands", (t) => {
  for (const settings of [
    { DIALED_OBSERVABILITY_MAX_BYTES: "" },
    { DIALED_OBSERVABILITY_MAX_BYTES: "0" },
    { DIALED_OBSERVABILITY_MAX_BYTES: "-1" },
    { DIALED_OBSERVABILITY_MAX_BYTES: "ten" },
    { DIALED_OBSERVABILITY_MIN_FREE_BYTES: "" },
    { DIALED_OBSERVABILITY_MIN_FREE_BYTES: "0" },
    { DIALED_OBSERVABILITY_MIN_FREE_BYTES: "-1" },
    { DIALED_OBSERVABILITY_MIN_FREE_BYTES: "two-hundred" },
    { DIALED_OBSERVABILITY_DIR: "/tmp/dialed\nunsafe" },
  ]) {
    const value = fixture(t);
    const result = runGuard(value, settings);
    assert.notEqual(result.status, 0, JSON.stringify(settings));
    assert.deepEqual(commands(value), [], JSON.stringify(settings));
  }
});

test("the guard source cannot delete data or target anything except Alloy", () => {
  const source = readFileSync(guardPath, "utf8");
  assert.doesNotMatch(
    source,
    /\brm\b|\bdocker\b|\bfind\b|\b(?:api|web|postgres)\.service\b/i,
  );
  assert.deepEqual(source.match(/systemctl[^\n]*/g), [
    "systemctl stop dialed-poc-alloy.service",
  ]);
});
