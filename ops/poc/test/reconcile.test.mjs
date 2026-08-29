import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const reconcilePath = join(repositoryRoot, "ops/poc/bin/reconcile");
const candidateRevision = "0123456789abcdef0123456789abcdef01234567";
const priorRevision = "1111111111111111111111111111111111111111";
const webCandidate =
  "ghcr.io/joshuapark99/dialed-web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const apiCandidate =
  "ghcr.io/joshuapark99/dialed-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const webPrior =
  "ghcr.io/joshuapark99/dialed-web@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const apiPrior =
  "ghcr.io/joshuapark99/dialed-api@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const webExpired =
  "ghcr.io/joshuapark99/dialed-web@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const apiExpired =
  "ghcr.io/joshuapark99/dialed-api@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

function stateText(webImage, apiImage, revision) {
  return [
    `WEB_IMAGE=${webImage}`,
    `API_IMAGE=${apiImage}`,
    `APP_REVISION=${revision}`,
    "",
  ].join("\n");
}

function fixture(t, { active = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dialed-reconcile-test-"));
  const bin = join(root, "bin");
  const state = join(root, "state");
  const backups = join(root, "backups");
  const data = join(root, "data");
  const environmentFile = join(root, "poc.env");
  const composeFile = join(root, "compose.poc.yaml");
  const activeState = join(state, "active.env");
  const rollbackState = join(state, "rollback.env");
  const dockerLog = join(root, "docker.log");
  mkdirSync(bin);
  mkdirSync(state);
  mkdirSync(backups);
  mkdirSync(data);

  writeFileSync(
    environmentFile,
    [
      "APP_URL=https://poc.example.com",
      "BETTER_AUTH_SECRET=test-only-secret-with-at-least-32-characters",
      "GOOGLE_CLIENT_ID=test-google-client-id",
      "GOOGLE_CLIENT_SECRET=test-google-client-secret",
      "POSTGRES_USER=dialed",
      "POSTGRES_PASSWORD=test-password",
      "POSTGRES_DB=dialed",
      "TUNNEL_TOKEN=test-token",
      `DIALED_DATA_DIR=${data}`,
      `DIALED_BACKUP_DIR=${backups}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  writeFileSync(
    composeFile,
    readFileSync(join(repositoryRoot, "compose.poc.yaml")),
    { mode: 0o644 },
  );
  if (active) {
    writeFileSync(activeState, stateText(webPrior, apiPrior, priorRevision), {
      mode: 0o600,
    });
  }

  const docker = join(bin, "docker");
  writeFileSync(
    docker,
    `#!/bin/sh
command_line="$*"
printf '%s\n' "$command_line" >> "$FAKE_DOCKER_LOG"

case "$command_line" in
  "pull "*) exit 0 ;;
  *"image inspect"*"RepoDigests"*"dialed-web:poc"*) printf '%s\n' "$FAKE_WEB_IMAGE"; exit 0 ;;
  *"image inspect"*"RepoDigests"*"dialed-api:poc"*) printf '%s\n' "$FAKE_API_IMAGE"; exit 0 ;;
  *"image inspect"*"org.opencontainers.image.revision"*"dialed-web@sha256:"*) printf '%s\n' "$FAKE_WEB_REVISION"; exit 0 ;;
  *"image inspect"*"org.opencontainers.image.revision"*"dialed-api@sha256:"*) printf '%s\n' "$FAKE_API_REVISION"; exit 0 ;;
  *"image ls"*"dialed-web"*) printf '%s\n' "$FAKE_WEB_IMAGE" "$FAKE_WEB_PRIOR" "$FAKE_WEB_EXPIRED"; exit 0 ;;
  *"image ls"*"dialed-api"*) printf '%s\n' "$FAKE_API_IMAGE" "$FAKE_API_PRIOR" "$FAKE_API_EXPIRED"; exit 0 ;;
  "image rm "*) exit 0 ;;
  *"pg_isready"*) exit 0 ;;
  *"pg_dump"*)
    if [ "$FAKE_MODE" = "backup-fail" ]; then exit 23; fi
    printf '%s' 'verified backup'
    exit 0
    ;;
  *"run --rm --no-deps migrate"*)
    if [ "$FAKE_MODE" = "migration-fail" ]; then exit 25; fi
    exit 0
    ;;
  *"up --no-deps -d cloudflared"*)
    if [ "$FAKE_MODE" = "tunnel-fail" ]; then exit 27; fi
    exit 0
    ;;
  *"EXPECTED_REVISION="*" node -e "*)
    case "$command_line" in
      *"EXPECTED_REVISION=$FAKE_PRIOR_REVISION"*) exit 0 ;;
    esac
    if [ "$FAKE_MODE" = "health-fail" ]; then exit 26; fi
    exit 0
    ;;
  *"compose"*) exit 0 ;;
esac

printf 'unexpected docker command: %s\n' "$command_line" >&2
exit 99
`,
  );
  chmodSync(docker, 0o755);

  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    bin,
    state,
    backups,
    environmentFile,
    composeFile,
    activeState,
    rollbackState,
    dockerLog,
  };
}

function runReconcile(value, overrides = {}) {
  return spawnSync("sh", [reconcilePath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${value.bin}:${process.env.PATH}`,
      DIALED_ENV_FILE: value.environmentFile,
      DIALED_COMPOSE_FILE: value.composeFile,
      DIALED_STATE_DIR: value.state,
      DIALED_ACTIVE_STATE: value.activeState,
      DIALED_ROLLBACK_STATE: value.rollbackState,
      DIALED_LOCK_FILE: join(value.root, "deploy.lock"),
      DIALED_HEALTH_TIMEOUT_SECONDS: "0",
      DIALED_HEALTH_INTERVAL_SECONDS: "0",
      FAKE_DOCKER_LOG: value.dockerLog,
      FAKE_MODE: "success",
      FAKE_WEB_IMAGE: webCandidate,
      FAKE_API_IMAGE: apiCandidate,
      FAKE_WEB_REVISION: candidateRevision,
      FAKE_API_REVISION: candidateRevision,
      FAKE_PRIOR_REVISION: priorRevision,
      FAKE_WEB_PRIOR: webPrior,
      FAKE_API_PRIOR: apiPrior,
      FAKE_WEB_EXPIRED: webExpired,
      FAKE_API_EXPIRED: apiExpired,
      ...overrides,
    },
  });
}

function dockerLog(value) {
  return existsSync(value.dockerLog)
    ? readFileSync(value.dockerLog, "utf8")
    : "";
}

test("unchanged exact digests exit without backup, migration, or restart", (t) => {
  const value = fixture(t);
  writeFileSync(
    value.activeState,
    stateText(webCandidate, apiCandidate, candidateRevision),
    { mode: 0o600 },
  );

  const result = runReconcile(value);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(dockerLog(value), /pg_dump|run --rm|compose up/);
});

test("mismatched OCI revisions fail before backup", (t) => {
  const value = fixture(t);
  const result = runReconcile(value, {
    FAKE_API_REVISION: "2222222222222222222222222222222222222222",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /revision/i);
  assert.doesNotMatch(dockerLog(value), /pg_dump/);
});

test("backup failure prevents migration and preserves active state", (t) => {
  const value = fixture(t);
  const before = readFileSync(value.activeState, "utf8");
  const result = runReconcile(value, { FAKE_MODE: "backup-fail" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /backup|pg_dump/i);
  assert.equal(readFileSync(value.activeState, "utf8"), before);
  assert.doesNotMatch(dockerLog(value), /run --rm --no-deps migrate/);
});

test("migration failure leaves active state unchanged", (t) => {
  const value = fixture(t);
  const before = readFileSync(value.activeState, "utf8");
  const result = runReconcile(value, { FAKE_MODE: "migration-fail" });

  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(value.activeState, "utf8"), before);
  assert.match(dockerLog(value), /pg_dump/);
  assert.doesNotMatch(dockerLog(value), /EXPECTED_REVISION=/);
});

test("healthy candidate promotion preserves prior state for rollback", (t) => {
  const value = fixture(t);
  const before = readFileSync(value.activeState, "utf8");
  const result = runReconcile(value);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(value.activeState, "utf8"),
    stateText(webCandidate, apiCandidate, candidateRevision),
  );
  assert.equal(readFileSync(value.rollbackState, "utf8"), before);
  assert.match(dockerLog(value), /EXPECTED_REVISION=.*api node -e/);
  assert.match(dockerLog(value), /EXPECTED_REVISION=.*web node -e/);
  assert.doesNotMatch(readFileSync(value.activeState, "utf8"), /:poc/);
});

test("successful promotion prunes only expired Dialed image digests", (t) => {
  const value = fixture(t);
  const result = runReconcile(value);

  assert.equal(result.status, 0, result.stderr);
  const removals = dockerLog(value)
    .split("\n")
    .filter((line) => line.startsWith("image rm "))
    .sort();
  assert.deepEqual(removals, [
    `image rm ${apiExpired}`,
    `image rm ${webExpired}`,
  ]);
});

test("tunnel startup failure prevents candidate state promotion", (t) => {
  const value = fixture(t);
  const before = readFileSync(value.activeState, "utf8");
  const result = runReconcile(value, { FAKE_MODE: "tunnel-fail" });

  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(value.activeState, "utf8"), before);
  assert.equal(existsSync(value.rollbackState), false);
  assert.doesNotMatch(dockerLog(value), /image rm /);
});

test("unhealthy candidate recreates only prior API and web digests", (t) => {
  const value = fixture(t);
  const before = readFileSync(value.activeState, "utf8");
  const result = runReconcile(value, { FAKE_MODE: "health-fail" });

  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(value.activeState, "utf8"), before);
  const log = dockerLog(value);
  assert.equal((log.match(/up --no-deps -d api web/g) ?? []).length, 2);
  assert.match(log, new RegExp(`EXPECTED_REVISION=${priorRevision}`));
  assert.doesNotMatch(log, /pg_restore/);
});

test("first deployment promotes without a meaningless predeploy backup", (t) => {
  const value = fixture(t, { active: false });
  const result = runReconcile(value);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(value.activeState, "utf8"),
    stateText(webCandidate, apiCandidate, candidateRevision),
  );
  assert.equal(existsSync(value.rollbackState), false);
  assert.doesNotMatch(dockerLog(value), /pg_dump/);
});
