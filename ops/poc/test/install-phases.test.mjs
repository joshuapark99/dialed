import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pocRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const phasesPath = resolve(pocRoot, "lib/install-phases.sh");

function shellValue(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runFailure(failAt) {
  const script = `
. ${shellValue(phasesPath)}
step() {
  printf '%s\\n' "$1"
  [ "$FAIL_AT" != "$1" ] || return 42
}
validate_core_assets() { step core-validate; }
activate_core_assets() { step core-activate; }
enable_core_timers() { step core-enable; }
prepare_observability_assets() { step observability-prepare; }
pull_observability_images() { step observability-pull; }
validate_observability_assets() { step observability-validate; }
activate_observability_assets() { step observability-activate; }
start_observability_services() { step observability-start; }
run_installation_phases
`;
  return spawnSync("sh", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, FAIL_AT: failAt },
  });
}

test("observability failures occur only after core timers are secured", () => {
  const cases = [
    [
      "observability-pull",
      [
        "core-validate",
        "core-activate",
        "core-enable",
        "observability-prepare",
        "observability-pull",
      ],
    ],
    [
      "observability-validate",
      [
        "core-validate",
        "core-activate",
        "core-enable",
        "observability-prepare",
        "observability-pull",
        "observability-validate",
      ],
    ],
    [
      "observability-activate",
      [
        "core-validate",
        "core-activate",
        "core-enable",
        "observability-prepare",
        "observability-pull",
        "observability-validate",
        "observability-activate",
      ],
    ],
    [
      "observability-start",
      [
        "core-validate",
        "core-activate",
        "core-enable",
        "observability-prepare",
        "observability-pull",
        "observability-validate",
        "observability-activate",
        "observability-start",
      ],
    ],
  ];

  for (const [failAt, expectedSteps] of cases) {
    const result = runFailure(failAt);
    assert.equal(result.status, 42, `${failAt}: ${result.stderr}`);
    assert.deepEqual(result.stdout.trim().split("\n"), expectedSteps, failAt);
    assert.match(
      result.stderr,
      /core deploy and backup timers remain enabled/i,
    );
    assert.match(result.stderr, /application stack was left unchanged/i);
  }
});
