import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pocRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const renderUnitsPath = join(pocRoot, "bin", "render-observability-units");

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
  assert.equal(
    observe.get("Service")?.get("ReadWritePaths"),
    undefined,
    "the configured SSD path belongs in the generated drop-in",
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
  assert.equal(value(guard, "Service", "StandardError"), "journal");
  assert.equal(value(guard, "Service", "SyslogLevel"), "crit");
  assert.equal(
    guard.get("Service")?.get("ReadWritePaths"),
    undefined,
    "the configured SSD path belongs in the generated drop-in",
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
    /--storage\.path=\/run\/dialed-observability\/alloy/,
  );
  assert.match(
    value(alloy, "Service", "ExecStart"),
    /\/opt\/dialed\/observability\/alloy\/config\.alloy$/,
  );
  assert.equal(value(alloy, "Service", "NoNewPrivileges"), "true");
  assert.equal(value(alloy, "Service", "PrivateTmp"), "true");
  assert.equal(value(alloy, "Service", "ProtectHome"), "true");
  assert.equal(value(alloy, "Service", "ProtectSystem"), "strict");
  assert.match(
    value(alloy, "Service", "ReadWritePaths"),
    /\/run\/dialed-observability\/alloy/,
  );
  assert.match(
    value(alloy, "Service", "ReadOnlyPaths"),
    /\/run\/dialed-observability\/textfile/,
  );
  assert.doesNotMatch(
    readUnit("dialed-poc-alloy.service"),
    /docker\.sock|SupplementaryGroups=docker/,
  );
});

test("installer renders one safe SSD path contract into each observability unit", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dialed-observability-units-"));
  const unitRoot = join(root, "units");
  const observability = join(root, "ssd", "observability");
  mkdirSync(unitRoot, { recursive: true });
  mkdirSync(join(observability, "alloy"), { recursive: true });
  mkdirSync(join(observability, "textfile"));
  chmodSync(observability, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const rendered = spawnSync("sh", [renderUnitsPath, unitRoot, observability], {
    encoding: "utf8",
  });
  assert.equal(rendered.status, 0, rendered.stderr);

  const alloy = readFileSync(
    join(unitRoot, "dialed-poc-alloy.service.d", "observability-path.conf"),
    "utf8",
  );
  const observe = readFileSync(
    join(unitRoot, "dialed-poc-observe.service.d", "observability-path.conf"),
    "utf8",
  );
  const guard = readFileSync(
    join(
      unitRoot,
      "dialed-poc-storage-guard.service.d",
      "observability-path.conf",
    ),
    "utf8",
  );

  assert.match(
    alloy,
    new RegExp(
      `^BindPaths="${observability}/alloy:/run/dialed-observability/alloy"$`,
      "m",
    ),
  );
  assert.match(
    alloy,
    new RegExp(
      `^BindReadOnlyPaths="${observability}/textfile:/run/dialed-observability/textfile"$`,
      "m",
    ),
  );
  assert.doesNotMatch(alloy, new RegExp(`${observability}:`));
  for (const [source, writePath] of [
    [observe, `${observability}/textfile`],
    [guard, observability],
  ]) {
    assert.match(
      source,
      new RegExp(
        `^Environment="DIALED_OBSERVABILITY_DIR=${observability}"$`,
        "m",
      ),
    );
    assert.match(source, new RegExp(`^ReadWritePaths="${writePath}"$`, "m"));
  }

  const installer = readInstaller();
  const observeSource = readFileSync(join(pocRoot, "bin", "observe"), "utf8");
  const renderCommand =
    'sh "$POC_ROOT/bin/render-observability-units" /etc/systemd/system "$observability_path"';
  assert.ok(compactShell(installer).includes(renderCommand));
  const renderPosition = compactShell(installer).indexOf(renderCommand);
  const verifyPosition = installer.indexOf("systemd-analyze verify");
  const reloadPosition = installer.indexOf(
    "systemctl daemon-reload",
    verifyPosition,
  );
  assert.ok(renderPosition >= 0);
  assert.ok(verifyPosition > renderPosition);
  assert.ok(reloadPosition > verifyPosition);
  assert.match(
    observeSource,
    /DIALED_OBSERVABILITY_DIR:\?DIALED_OBSERVABILITY_DIR is required/,
  );
});

test("unit drop-in renderer rejects paths that cannot be encoded literally", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dialed-observability-paths-"));
  const unitRoot = join(root, "units");
  mkdirSync(unitRoot);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const unsafe of [
    join(root, "space path"),
    join(root, "colon:path"),
    join(root, "percent%path"),
    `${root}/dot/../path`,
  ]) {
    const result = spawnSync("sh", [renderUnitsPath, unitRoot, unsafe], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, `${unsafe} was accepted`);
  }
});

test("runtime-path sources stay aligned across installer, units, and collectors", () => {
  const installer = readInstaller();
  const alloy = readUnit("dialed-poc-alloy.service");
  const config = readFileSync(
    join(pocRoot, "observability", "alloy", "config.alloy"),
    "utf8",
  );
  const observe = readFileSync(join(pocRoot, "bin", "observe"), "utf8");
  const guard = readFileSync(join(pocRoot, "bin", "storage-guard"), "utf8");
  const renderer = readFileSync(renderUnitsPath, "utf8");

  assert.match(
    installer,
    /ensure_component_directory DIALED_OBSERVABILITY_DIR "\$observability_path" root root 0700/,
  );
  for (const child of [
    'grafana "\$observability_path/grafana" 472 472 0700',
    'loki "\$observability_path/loki" 10001 10001 0700',
    'prometheus "\$observability_path/prometheus" 65534 65534 0700',
    'alloy "\$observability_path/alloy" alloy alloy 0700',
    'textfile "\$observability_path/textfile" root alloy 0750',
  ]) {
    assert.ok(installer.includes(child), child);
  }
  assert.match(alloy, /--storage\.path=\/run\/dialed-observability\/alloy/);
  assert.match(alloy, /\/opt\/dialed\/observability\/alloy\/config\.alloy/);
  assert.match(
    config,
    /directory\s*=\s*"\/run\/dialed-observability\/textfile"/,
  );
  assert.match(
    renderer,
    /observability_directory\/alloy:\/run\/dialed-observability\/alloy/,
  );
  assert.match(
    renderer,
    /observability_directory\/textfile:\/run\/dialed-observability\/textfile/,
  );
  assert.match(
    observe,
    /DIALED_OBSERVABILITY_DIR:\?DIALED_OBSERVABILITY_DIR is required/,
  );
  assert.match(guard, /load_poc_env/);
  assert.match(guard, /DIALED_OBSERVABILITY_DIR/);
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

test("installer secures validated core timers before optional observability work", () => {
  const source = readInstaller();
  const common = readCommon();
  const compactSource = compactShell(source);
  const coreValidator = compactSource.indexOf(
    'docker compose --env-file /etc/dialed/poc.env -f "$core_stage/compose.poc.yaml" config --quiet',
  );
  const coreCopy = compactSource.indexOf(
    'install -o root -g root -m 0644 "$core_stage/compose.poc.yaml" /opt/dialed/compose.poc.yaml',
  );
  const deployEnable = compactSource.indexOf(
    "systemctl enable --now dialed-poc-deploy.timer",
  );
  const backupEnable = compactSource.indexOf(
    "systemctl enable --now dialed-poc-backup.timer",
  );
  const observabilityPull = compactSource.indexOf(
    "docker pull grafana/grafana:13.1.3",
  );
  const observabilityValidator = compactSource.indexOf(
    'docker compose --env-file /etc/dialed/poc.env -f "$observability_stage/compose.observability.yaml" config --quiet',
  );
  const observabilityCopy = compactSource.indexOf(
    'install -o root -g root -m 0644 "$observability_stage/compose.observability.yaml" /opt/dialed/compose.observability.yaml',
  );
  const observabilityEnable = compactSource.indexOf(
    "systemctl enable --now dialed-poc-observability.service",
  );

  assert.match(source, /require_command curl/);
  assert.match(source, /alloy --version/);
  assert.match(source, /require_alloy_version/);
  assert.match(source, /validate_observability_environment/);
  assert.match(source, /run_installation_phases/);
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
  for (const position of [
    coreValidator,
    coreCopy,
    deployEnable,
    backupEnable,
    observabilityPull,
    observabilityValidator,
    observabilityCopy,
    observabilityEnable,
  ]) {
    assert.ok(position >= 0);
  }
  assert.ok(coreValidator < coreCopy);
  assert.ok(coreCopy < deployEnable);
  assert.ok(deployEnable < backupEnable);
  assert.ok(backupEnable < observabilityPull);
  assert.ok(observabilityPull < observabilityValidator);
  assert.ok(observabilityValidator < observabilityCopy);
  assert.ok(observabilityCopy < observabilityEnable);
  assert.doesNotMatch(source, /docker compose[^\n]*(?:down|stop|up|create)/);
  assert.doesNotMatch(source, /chown\s+-R|chown\s+--recursive/);
});

test("staged Compose validation uses a full digest placeholder", () => {
  const source = readInstaller();
  const match = source.match(/^\s*zero_digest=([^\n]+)$/m);

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
