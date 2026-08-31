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
const dockerfile = readFileSync(resolve(repositoryRoot, "Dockerfile"), "utf8");

function job(name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, `missing ${name} job`);
  const bodyStart = start + marker.length;
  const rest = workflow.slice(bodyStart);
  const nextJob = rest.search(/\n  [a-z][a-z0-9_-]*:\n/);
  return nextJob < 0 ? rest : rest.slice(0, nextJob);
}

function dockerStage(name) {
  const marker = ` AS ${name}\n`;
  const start = dockerfile.indexOf(marker);
  assert.ok(start >= 0, `missing ${name} Docker stage`);
  const bodyStart = start + marker.length;
  const rest = dockerfile.slice(bodyStart);
  const nextStage = rest.search(/\nFROM\s/);
  return nextStage < 0 ? rest : rest.slice(0, nextStage);
}

test("verification runs on Node.js 22 and 24 without self-hosted runners", () => {
  const verify = job("verify");
  assert.match(verify, /node-version:\s*\[[^\]]*22[^\]]*24[^\]]*\]/);
  assert.doesNotMatch(workflow, /runs-on:\s*.*self-hosted/);
});

test("publication is main-push-only and package writes stay in release jobs", () => {
  const publish = job("publish");
  const manifests = job("publish-manifests");
  assert.match(publish, /github\.event_name\s*==\s*'push'/);
  assert.match(publish, /github\.ref\s*==\s*'refs\/heads\/main'/);
  assert.match(publish, /packages:\s*write/);
  assert.match(manifests, /packages:\s*write/);
  assert.equal(workflow.match(/packages:\s*write/g)?.length, 2);
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

test("container gate builds and exercises each architecture natively", () => {
  const containers = job("containers");
  assert.match(containers, /runs-on:\s*\$\{\{ matrix\.runner \}\}/);
  assert.match(containers, /runner:\s*ubuntu-24\.04\b/);
  assert.match(containers, /runner:\s*ubuntu-24\.04-arm\b/);
  assert.match(containers, /platform:\s*linux\/amd64\b/);
  assert.match(containers, /platform:\s*linux\/arm64\b/);
  assert.equal(containers.match(/^\s+- arch:/gm)?.length, 2);
  assert.match(containers, /docker\/setup-buildx-action@/);
  assert.doesNotMatch(workflow, /docker\/setup-qemu-action@/);
  assert.doesNotMatch(containers, /linux\/amd64,linux\/arm64/);
  assert.match(containers, /--platform "?\$\{\{ matrix\.platform \}\}"?/);
  assert.match(containers, /--load/);
  assert.match(containers, /--name dialed-api-ci/);
  assert.match(containers, /--name dialed-web-ci/);
  assert.match(containers, /\.State\.Health\.Status/);
});

test("container gate validates the Alloy configuration with the pinned runtime", () => {
  const containers = job("containers");

  assert.match(containers, /grafana\/alloy:v1\.19\.0/);
  assert.match(
    containers,
    /grafana\/alloy:v1\.19\.0\s+\\?\s*validate \/etc\/alloy\/config\.alloy/,
  );
  assert.match(
    containers,
    /ops\/poc\/observability\/alloy\/config\.alloy:\/etc\/alloy\/config\.alloy:ro/,
  );
});

test("each image target builds only its own dependency graph", () => {
  const webBuild = dockerStage("web-build");
  const apiBuild = dockerStage("api-build");

  assert.match(webBuild, /RUN pnpm turbo run build --filter=@dialed\/web\b/);
  assert.doesNotMatch(webBuild, /@dialed\/api/);
  assert.match(apiBuild, /RUN pnpm turbo run build --filter=@dialed\/api\b/);
  assert.doesNotMatch(apiBuild, /@dialed\/web/);
  assert.doesNotMatch(dockerfile, /RUN pnpm build\b/);
});

test("publication assembles native digests before promoting release tags", () => {
  const publish = job("publish");
  const manifests = job("publish-manifests");
  const smoke = job("smoke");

  assert.match(publish, /runs-on:\s*\$\{\{ matrix\.runner \}\}/);
  assert.match(publish, /runner:\s*ubuntu-24\.04\b/);
  assert.match(publish, /runner:\s*ubuntu-24\.04-arm\b/);
  assert.match(publish, /platform:\s*linux\/amd64\b/);
  assert.match(publish, /platform:\s*linux\/arm64\b/);
  const matrixRows = [
    [
      "web",
      "ghcr.io/joshuapark99/dialed-web",
      "amd64",
      "linux/amd64",
      "ubuntu-24.04",
    ],
    [
      "web",
      "ghcr.io/joshuapark99/dialed-web",
      "arm64",
      "linux/arm64",
      "ubuntu-24.04-arm",
    ],
    [
      "api",
      "ghcr.io/joshuapark99/dialed-api",
      "amd64",
      "linux/amd64",
      "ubuntu-24.04",
    ],
    [
      "api",
      "ghcr.io/joshuapark99/dialed-api",
      "arm64",
      "linux/arm64",
      "ubuntu-24.04-arm",
    ],
  ];
  for (const [target, image, arch, platform, runner] of matrixRows) {
    const row = [
      `          - target: ${target}`,
      `            image: ${image}`,
      `            arch: ${arch}`,
      `            platform: ${platform}`,
      `            runner: ${runner}`,
    ].join("\n");
    assert.ok(
      publish.includes(row),
      `missing native publish row for ${target}/${arch}`,
    );
  }
  assert.equal(publish.match(/^\s+- target:/gm)?.length, matrixRows.length);
  assert.match(publish, /push-by-digest=true/);
  assert.match(publish, /provenance:\s*false/);
  assert.match(publish, /actions\/upload-artifact@/);
  assert.doesNotMatch(publish, /platforms:\s*linux\/amd64,linux\/arm64/);

  assert.match(manifests, /needs:\s*publish/);
  assert.match(manifests, /actions\/download-artifact@/);
  assert.match(manifests, /docker buildx imagetools create/);
  assert.match(manifests, /sha-\$\{\{ github\.sha \}\}/);
  assert.match(manifests, /:poc/);
  const webAssembly = manifests.indexOf(
    'create_manifest "$WEB_IMAGE" /tmp/digests/web',
  );
  const apiAssembly = manifests.indexOf(
    'create_manifest "$API_IMAGE" /tmp/digests/api',
  );
  const webPromotion = manifests.indexOf('--tag "$WEB_IMAGE:poc"');
  const apiPromotion = manifests.indexOf('--tag "$API_IMAGE:poc"');
  assert.ok(webAssembly >= 0 && apiAssembly > webAssembly);
  assert.ok(webPromotion > apiAssembly && apiPromotion > webPromotion);
  assert.match(smoke, /needs:\s*publish-manifests/);
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
