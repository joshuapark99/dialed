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

function readCommon() {
  return readFileSync(join(pocRoot, "bin", "common"), "utf8");
}

function compactShell(source) {
  return source.replaceAll(/\\\n\s*/g, " ").replaceAll(/[ \t]+/g, " ");
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

test("observability lifecycle is a Docker-ordered persistent one-shot", () => {
  const observability = parseUnit("dialed-poc-observability.service");

  assert.equal(value(observability, "Service", "Type"), "oneshot");
  assert.equal(value(observability, "Service", "RemainAfterExit"), "yes");
  assert.equal(
    value(observability, "Service", "ExecStart"),
    "/opt/dialed/bin/observability start",
  );
  assert.equal(
    value(observability, "Service", "ExecStop"),
    "/opt/dialed/bin/observability stop",
  );
  assert.match(value(observability, "Unit", "After"), /docker\.service/);
  assert.match(value(observability, "Unit", "After"), /network-online\.target/);
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

test("installer provisions the complete observability stack before dependency-ordered units", () => {
  const source = readInstaller();
  const common = readCommon();
  const compactSource = compactShell(source);
  const validators = [
    'docker compose --env-file /etc/dialed/poc.env -f "$stage_directory/compose.poc.yaml" config --quiet',
    'docker compose --env-file /etc/dialed/poc.env -f "$stage_directory/compose.observability.yaml" config --quiet',
    '/usr/bin/alloy validate "$stage_directory/observability/alloy/config.alloy"',
    'docker run --rm -v "$stage_directory/observability/loki.yaml:/etc/loki/config.yaml:ro" grafana/loki:3.7.6 -verify-config=true -config.file=/etc/loki/config.yaml',
    'docker run --rm --entrypoint promtool -v "$stage_directory/observability/prometheus.yaml:/etc/prometheus/prometheus.yml:ro" prom/prometheus:v3.13.2 check config /etc/prometheus/prometheus.yml',
  ];
  const activeCopies = [
    'install -o root -g root -m 0644 "$stage_directory/compose.poc.yaml" /opt/dialed/compose.poc.yaml',
    'install -o root -g root -m 0644 "$stage_directory/compose.observability.yaml" /opt/dialed/compose.observability.yaml',
    'install_configuration_tree "$stage_directory/observability" /opt/dialed/observability',
    'install -o root -g root -m 0755 "$POC_ROOT/bin/$executable" "/opt/dialed/bin/$executable"',
    'install -D -o root -g root -m 0644 "$library" "/opt/dialed/lib/$(basename "$library")"',
    'install -o root -g root -m 0644 "$POC_ROOT/systemd/$unit" "/etc/systemd/system/$(basename "$unit")"',
    'mv -f "$journald_stage" /etc/systemd/journald.conf.d/90-dialed-poc.conf',
  ];
  const enables = [
    "systemctl enable --now dialed-poc-observability.service",
    "systemctl enable --now dialed-poc-observe.timer",
    "systemctl enable --now dialed-poc-storage-guard.timer",
    "systemctl enable --now dialed-poc-alloy.service",
    "systemctl enable --now dialed-poc-deploy.timer",
    "systemctl enable --now dialed-poc-backup.timer",
  ];

  assert.match(source, /require_command curl/);
  assert.match(source, /alloy --version/);
  assert.match(source, /require_alloy_version/);
  assert.match(source, /validate_observability_environment/);
  assert.match(common, /1\.19\.0/);
  assert.match(common, /DIALED_OBSERVABILITY_DIR/);
  assert.match(common, /GRAFANA_ADMIN_USER/);
  assert.match(common, /GRAFANA_ADMIN_PASSWORD/);
  assert.match(common, /DIALED_OBSERVABILITY_MAX_BYTES/);
  assert.match(common, /DIALED_OBSERVABILITY_MIN_FREE_BYTES/);
  assert.match(source, /observability_path/);
  assert.match(source, /grafana.*472 472 0700/s);
  assert.match(source, /loki.*10001 10001 0700/s);
  assert.match(source, /prometheus.*65534 65534 0700/s);
  assert.match(source, /textfile.*root alloy 0750/s);
  assert.match(source, /operations.*root root 0700/s);
  assert.match(source, /90-dialed-poc\.conf/);
  const validatorPositions = validators.map((command) =>
    compactSource.indexOf(command),
  );
  const activeCopyPositions = activeCopies.map((command) =>
    compactSource.indexOf(command),
  );
  const enablePositions = enables.map((command) =>
    compactSource.indexOf(command),
  );
  for (const [index, position] of validatorPositions.entries()) {
    assert.ok(position >= 0, `missing validator: ${validators[index]}`);
  }
  for (const [index, position] of activeCopyPositions.entries()) {
    assert.ok(position >= 0, `missing active copy: ${activeCopies[index]}`);
  }
  for (const [index, position] of enablePositions.entries()) {
    assert.ok(position >= 0, `missing enablement: ${enables[index]}`);
  }
  for (let index = 1; index < validatorPositions.length; index += 1) {
    assert.ok(validatorPositions[index - 1] < validatorPositions[index]);
  }
  const firstActiveCopy = Math.min(...activeCopyPositions);
  const firstEnablement = enablePositions[0];
  for (const position of validatorPositions) {
    assert.ok(position < firstActiveCopy);
    assert.ok(position < firstEnablement);
  }
  assert.ok(Math.max(...activeCopyPositions) < firstEnablement);
  for (let index = 1; index < enablePositions.length; index += 1) {
    assert.ok(enablePositions[index - 1] < enablePositions[index]);
  }
  assert.doesNotMatch(source, /chown\s+-R|chown\s+--recursive/);
});

test("staged Compose validation uses a full digest placeholder", () => {
  const source = readInstaller();
  const match = source.match(/^zero_digest=([^\n]+)$/m);

  assert.ok(match);
  assert.equal(match[1].length, 64);
  assert.match(match[1], /^[0-9a-f]+$/);
  assert.match(source, /WEB_IMAGE=.*@sha256:\$zero_digest/);
  assert.match(source, /API_IMAGE=.*@sha256:\$zero_digest/);
});

test("installer ships every observability operation and its service or timer", () => {
  const source = readInstaller();

  for (const executable of ["observe", "record-operation", "storage-guard"]) {
    assert.match(source, new RegExp(`\\b${executable}\\b`));
  }
  assert.match(source, /"\/opt\/dialed\/bin\/\$executable"/);
  for (const unit of [
    "dialed-poc-observe.service",
    "dialed-poc-observe.timer",
    "dialed-poc-storage-guard.service",
    "dialed-poc-storage-guard.timer",
  ]) {
    assert.match(source, new RegExp(`\\b${unit.replace(".", "\\.")}\\b`));
  }
  assert.match(source, /"\/etc\/systemd\/system\/\$\(basename "\$unit"\)"/);
});

test("installer validates dedicated storage without chmodding existing paths", () => {
  const source = readInstaller();
  const common = readCommon();
  assert.match(source, /validate_observability_environment/);
  assert.match(common, /require_dedicated_storage_path/);
  assert.match(source, /ensure_component_directory/);
  assert.match(common, /must be a dedicated nested path/);
  assert.match(common, /must be separate dedicated directories/);
  assert.doesNotMatch(
    source,
    /install -d -o root -g root -m 0700 "\$data_path" "\$backup_path"/,
  );
});
