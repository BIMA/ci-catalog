import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("generate CLI: fixture project → manifest.json (offline, no viewer build)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-catalog-test-"));
  const project = join(dir, "templates");
  mkdirSync(join(project, "lib"), { recursive: true });
  writeFileSync(
    join(project, "java.yml"),
    `
stages: [build, deploy]
include: [{local: lib/base.yml}]
build-jar:
  stage: build
  extends: .maven
  script: [mvn package]
deploy:
  stage: deploy
  needs: [build-jar]
  script: [helm upgrade]
  rules:
    - if: $KUBECONFIG
`
  );
  writeFileSync(
    join(project, "lib", "base.yml"),
    `
.maven:
  image: maven:3
`
  );
  // entrypoint with an unresolved project include still lands in the manifest
  writeFileSync(
    join(project, "with-remote.yml"),
    `
include:
  - project: grp/templates
    file: /jobs.yml
local-job: {script: [echo]}
`
  );

  const out = join(dir, "docs");
  const stdout = execFileSync(
    process.execPath,
    [join(repoRoot, "bin", "generate.mjs"), project, "-o", out, "--no-build", "--offline"],
    { encoding: "utf8" }
  );
  assert.match(stdout, /2 pipelines parsed/);

  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.pipelines.length, 2);

  const java = manifest.pipelines.find((p) => p.name === "java");
  assert.equal(java.jobCount, 2);
  const build = java.model.jobs.find((j) => j.name === "build-jar");
  assert.equal(build.image, "maven:3"); // extends resolved through the local include

  const remote = manifest.pipelines.find((p) => p.name === "with-remote");
  assert.equal(remote.jobCount, 1);
  assert.ok(remote.model.warnings.some((w) => w.includes("not resolved")));
});
