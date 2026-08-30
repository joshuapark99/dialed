import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pocRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readUnit(name) {
  return readFileSync(join(pocRoot, "systemd", name), "utf8");
}

function readInstaller() {
  return readFileSync(join(pocRoot, "bin", "install"), "utf8");
}

function parseUnit(name) {
  const sections = new Map();
  let section;
  for (const rawLine of readUnit(name).split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1);
      sections.set(section, new Map());
      continue;
    }
    const separator = line.indexOf("=");
    assert.ok(separator > 0, `${name} contains an invalid line: ${line}`);
    assert.ok(section, `${name} has a setting outside a section`);
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    const values = sections.get(section);
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  return sections;
}

function value(unit, section, key) {
  const values = unit.get(section)?.get(key);
  assert.ok(values, `missing ${section}.${key}`);
  return values.at(-1);
}

test("deployment and backup services are ordered one-shot root operations", () => {
  const deploy = parseUnit("dialed-poc-deploy.service");
  const backup = parseUnit("dialed-poc-backup.service");

  assert.equal(value(deploy, "Service", "Type"), "oneshot");
  assert.equal(value(backup, "Service", "Type"), "oneshot");
  assert.equal(
    value(deploy, "Service", "ExecStart"),
    "/opt/dialed/bin/reconcile",
  );
  assert.equal(
    value(backup, "Service", "ExecStart"),
    "/opt/dialed/bin/backup scheduled",
  );
  assert.equal(value(deploy, "Service", "UMask"), "0077");
  assert.equal(value(backup, "Service", "UMask"), "0077");
  assert.match(value(deploy, "Unit", "After"), /docker\.service/);
  assert.match(value(deploy, "Unit", "After"), /network-online\.target/);
  assert.match(value(backup, "Unit", "After"), /docker\.service/);
});

test("persistent timers schedule minute reconciliation and a 03:15 UTC backup", () => {
  const deploy = parseUnit("dialed-poc-deploy.timer");
  const backup = parseUnit("dialed-poc-backup.timer");

  assert.equal(value(deploy, "Timer", "Persistent"), "true");
  assert.equal(value(backup, "Timer", "Persistent"), "true");
  assert.equal(value(deploy, "Timer", "OnCalendar"), "*-*-* *:*:00");
  assert.equal(value(backup, "Timer", "OnCalendar"), "*-*-* 03:15:00 UTC");
  assert.equal(value(deploy, "Timer", "Unit"), "dialed-poc-deploy.service");
  assert.equal(value(backup, "Timer", "Unit"), "dialed-poc-backup.service");
});

test("observability snapshots run as a constrained root one-shot every thirty seconds", () => {
  const observe = parseUnit("dialed-poc-observe.service");
  const timer = parseUnit("dialed-poc-observe.timer");

  assert.equal(value(observe, "Service", "Type"), "oneshot");
  assert.equal(value(observe, "Service", "User"), "root");
  assert.equal(value(observe, "Service", "Group"), "root");
  assert.equal(
    value(observe, "Service", "ExecStart"),
    "/opt/dialed/bin/observe",
  );
  assert.equal(value(observe, "Service", "CapabilityBoundingSet"), "");
  assert.equal(value(observe, "Service", "NoNewPrivileges"), "true");
  assert.equal(value(observe, "Service", "PrivateTmp"), "true");
  assert.equal(value(observe, "Service", "ProtectHome"), "true");
  assert.equal(value(observe, "Service", "ProtectSystem"), "full");
  assert.match(
    value(observe, "Service", "ReadWritePaths"),
    /\/var\/lib\/dialed\/observability\/textfile/,
  );
  assert.equal(value(timer, "Timer", "OnBootSec"), "30s");
  assert.equal(value(timer, "Timer", "OnUnitActiveSec"), "30s");
  assert.equal(value(timer, "Timer", "AccuracySec"), "5s");
  assert.equal(value(timer, "Timer", "Unit"), "dialed-poc-observe.service");
  assert.equal(value(timer, "Timer", "Persistent"), "true");
});

test("storage ingestion guard runs as a constrained root one-shot every five minutes", () => {
  const guard = parseUnit("dialed-poc-storage-guard.service");
  const timer = parseUnit("dialed-poc-storage-guard.timer");

  assert.equal(value(guard, "Service", "Type"), "oneshot");
  assert.equal(value(guard, "Service", "User"), "root");
  assert.equal(value(guard, "Service", "Group"), "root");
  assert.equal(
    value(guard, "Service", "ExecStart"),
    "/opt/dialed/bin/storage-guard",
  );
  assert.equal(value(guard, "Service", "NoNewPrivileges"), "true");
  assert.equal(value(guard, "Service", "PrivateTmp"), "true");
  assert.equal(value(guard, "Service", "ProtectHome"), "true");
  assert.equal(value(guard, "Service", "ProtectSystem"), "full");
  assert.match(
    value(guard, "Service", "ReadWritePaths"),
    /\/var\/lib\/dialed\/observability/,
  );
  assert.equal(value(timer, "Timer", "OnBootSec"), "2min");
  assert.equal(value(timer, "Timer", "OnUnitActiveSec"), "5min");
  assert.equal(value(timer, "Timer", "AccuracySec"), "30s");
  assert.equal(
    value(timer, "Timer", "Unit"),
    "dialed-poc-storage-guard.service",
  );
  assert.equal(value(timer, "Timer", "Persistent"), "true");
});

test("unit files contain no runtime credential values", () => {
  for (const name of [
    "dialed-poc-deploy.service",
    "dialed-poc-deploy.timer",
    "dialed-poc-backup.service",
    "dialed-poc-backup.timer",
  ]) {
    const source = readUnit(name);
    assert.doesNotMatch(
      source,
      /TUNNEL_TOKEN|BETTER_AUTH_SECRET|POSTGRES_PASSWORD/,
    );
  }
});

test("Alloy runs as a constrained loopback-only host collector", () => {
  const alloy = parseUnit("dialed-poc-alloy.service");

  assert.equal(
    value(alloy, "Unit", "Requires"),
    "dialed-poc-observability.service",
  );
  assert.match(
    value(alloy, "Unit", "After"),
    /dialed-poc-observability\.service/,
  );
  assert.equal(value(alloy, "Service", "User"), "alloy");
  assert.equal(value(alloy, "Service", "Group"), "alloy");
  assert.equal(
    value(alloy, "Service", "SupplementaryGroups"),
    "adm systemd-journal",
  );
  assert.equal(value(alloy, "Service", "MemoryMax"), "256M");
  assert.equal(value(alloy, "Service", "CPUQuota"), "50%");
  assert.equal(value(alloy, "Service", "Nice"), "5");
  assert.equal(value(alloy, "Service", "Restart"), "on-failure");
  assert.match(value(alloy, "Service", "ExecStart"), /\/usr\/bin\/alloy run/);
  assert.match(value(alloy, "Service", "ExecStart"), /127\.0\.0\.1:12345/);
  assert.match(
    value(alloy, "Service", "ExecStart"),
    /--storage\.path=\/var\/lib\/dialed\/observability\/alloy/,
  );
  assert.equal(value(alloy, "Service", "NoNewPrivileges"), "true");
  assert.equal(value(alloy, "Service", "PrivateTmp"), "true");
  assert.equal(value(alloy, "Service", "ProtectHome"), "true");
  assert.equal(value(alloy, "Service", "ProtectSystem"), "strict");
  assert.match(
    value(alloy, "Service", "ReadWritePaths"),
    /\/var\/lib\/dialed\/observability\/alloy/,
  );
  assert.match(
    value(alloy, "Service", "ReadOnlyPaths"),
    /\/var\/lib\/dialed\/observability\/textfile/,
  );
  assert.doesNotMatch(
    readUnit("dialed-poc-alloy.service"),
    /docker\.sock|SupplementaryGroups=docker/,
  );
});

test("installer preserves operator secrets and validates before enabling timers", () => {
  const source = readInstaller();
  const requireEnvironment = source.indexOf(
    "if [ ! -e /etc/dialed/poc.env ]; then",
  );
  const loadEnvironment = source.indexOf("load_poc_env");
  const validateCompose = source.indexOf("config --quiet");
  const enableTimers = source.indexOf("systemctl enable --now");

  assert.ok(requireEnvironment >= 0);
  assert.ok(loadEnvironment > requireEnvironment);
  assert.ok(validateCompose > loadEnvironment);
  assert.ok(enableTimers > validateCompose);
  assert.doesNotMatch(
    source,
    /poc\.env\.example["'\\\s]+\/etc\/dialed\/poc\.env(?:["'\\\s]|$)/,
  );
});

test("installer validates dedicated storage without chmodding existing paths", () => {
  const source = readInstaller();
  assert.match(source, /require_dedicated_storage_path/);
  assert.match(source, /ensure_root_directory/);
  assert.match(source, /must be a dedicated nested path/);
  assert.match(source, /must be separate dedicated directories/);
  assert.doesNotMatch(
    source,
    /install -d -o root -g root -m 0700 "\$data_path" "\$backup_path"/,
  );
});
