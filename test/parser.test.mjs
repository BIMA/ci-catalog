import { test } from "node:test";
import assert from "node:assert/strict";

import { resolvePipeline, includeKeys } from "../src/resolve/index.js";

const parse = (text, files = {}) => {
  const { model, errors } = resolvePipeline(text, { files, path: ".gitlab-ci.yml" });
  if (!model) throw new Error(errors.join("; "));
  return model;
};

// ---- extends / merge semantics ----

test("extends deep-merges hashes, child wins on scalars", () => {
  const m = parse(`
.base:
  image: node:20
  variables: {A: "1", B: "2"}
job:
  extends: .base
  variables: {B: "3"}
  script: [echo hi]
`);
  const job = m.jobs.get("job");
  assert.equal(job.image, "node:20");
  assert.deepEqual(job.variables, { A: "1", B: "3" });
});

test("extends replaces arrays wholesale (GitLab semantics)", () => {
  const m = parse(`
.base:
  script: [one, two]
job:
  extends: .base
  script: [three]
`);
  assert.deepEqual(m.jobs.get("job").script, ["three"]);
});

test("multi-parent extends merges left to right, later parents win", () => {
  const m = parse(`
.a: {variables: {X: "a", Y: "a"}}
.b: {variables: {Y: "b"}}
job:
  extends: [.a, .b]
  script: [run]
`);
  assert.deepEqual(m.jobs.get("job").variables, { X: "a", Y: "b" });
});

test("circular extends becomes a warning, job kept unresolved", () => {
  const m = parse(`
.a: {extends: .b}
.b: {extends: .a}
job:
  extends: .a
  script: [run]
`);
  assert.ok(m.jobs.has("job"));
  assert.ok(m.warnings.some((w) => w.includes("circular extends")));
});

// ---- !reference ----

test("!reference into an array splices flat, like GitLab", () => {
  const m = parse(`
.setup:
  script: [a, b]
job:
  script:
    - !reference [.setup, script]
    - c
`);
  assert.deepEqual(m.jobs.get("job").script, ["a", "b", "c"]);
});

test("unresolvable !reference warns and keeps placeholder text", () => {
  const m = parse(`
job:
  script:
    - !reference [.missing, script]
`);
  assert.ok(m.warnings.some((w) => w.includes("Unresolvable")));
});

// ---- include: local ----

test("include local merges, includer wins on conflicts", () => {
  const files = {
    "lib/base.yml": `
variables: {FROM: include}
included-job:
  script: [from-include]
job:
  script: [include-version]
`,
  };
  const m = parse(
    `
include: [{local: lib/base.yml}]
job:
  script: [root-version]
`,
    files
  );
  assert.ok(m.jobs.has("included-job"));
  assert.deepEqual(m.jobs.get("job").script, ["root-version"]);
});

test("circular local includes warn instead of recursing forever", () => {
  const files = {
    "a.yml": "include: [{local: b.yml}]\n",
    "b.yml": "include: [{local: a.yml}]\njob: {script: [hi]}\n",
  };
  const m = parse("include: [{local: a.yml}]\nroot: {script: [x]}\n", files);
  assert.ok(m.warnings.some((w) => w.startsWith("Circular include")));
  assert.ok(m.jobs.has("job"));
});

// ---- spec: inputs ----

test("spec inputs interpolate with defaults and per-include overrides", () => {
  const files = {
    "tpl.yml": `
spec:
  inputs:
    stage:
      default: test
    name: {}
---
"$[[ inputs.name ]]-job":
  stage: $[[ inputs.stage ]]
  script: [run]
`,
  };
  const m = parse(
    `
stages: [test, deploy]
include:
  - local: tpl.yml
    inputs: {name: unit}
`,
    files
  );
  assert.ok(m.jobs.has("unit-job"));
  assert.equal(m.jobs.get("unit-job").stage, "test");
});

// ---- non-local includes → canonical keys + unresolved ----

test("includeKeys builds canonical keys for every include kind", () => {
  assert.deepEqual(
    includeKeys({ project: "grp/proj", ref: "release/1.0", file: ["/a.yml", "b.yml"] }).map((i) => i.key),
    ["project://grp/proj@release/1.0/a.yml", "project://grp/proj@release/1.0/b.yml"]
  );
  assert.equal(includeKeys({ project: "grp/proj", file: "a.yml" })[0].ref, "HEAD");
  assert.equal(includeKeys({ template: "Jobs/SAST.gitlab-ci.yml" })[0].key, "template://Jobs/SAST.gitlab-ci.yml");
  assert.equal(
    includeKeys({ component: "gitlab.com/grp/comp/deploy@1.0" })[0].key,
    "component://gitlab.com/grp/comp/deploy@1.0"
  );
  assert.equal(includeKeys({ remote: "https://x.test/ci.yml" })[0].key, "remote://https://x.test/ci.yml");
});

test("unfetched project include is collected as unresolved with a warning", () => {
  const m = parse(`
include:
  - project: grp/templates
    ref: main
    file: /ci/base.yml
job: {script: [hi]}
`);
  assert.equal(m.unresolved.length, 1);
  assert.equal(m.unresolved[0].key, "project://grp/templates@main/ci/base.yml");
  assert.ok(m.warnings.some((w) => w.includes("not resolved")));
});

test("project include resolves when its canonical key is in the file map", () => {
  const files = {
    "project://grp/templates@main/ci/base.yml": `
included-job: {script: [from-remote-project]}
`,
  };
  const m = parse(
    `
include:
  - project: grp/templates
    ref: main
    file: /ci/base.yml
job: {script: [hi]}
`,
    files
  );
  assert.ok(m.jobs.has("included-job"));
  assert.equal(m.unresolved.length, 0);
});

test("component include resolves via canonical key, with inputs", () => {
  const files = {
    "component://gitlab.com/grp/comp/deploy@1.0": `
spec:
  inputs:
    env: {default: staging}
---
"deploy-$[[ inputs.env ]]": {script: [deploy]}
`,
  };
  const m = parse(
    `
include:
  - component: gitlab.com/grp/comp/deploy@1.0
    inputs: {env: prod}
job: {script: [hi]}
`,
    files
  );
  assert.ok(m.jobs.has("deploy-prod"));
});

test("entrypoint with only unresolved includes reports the error and unresolved as values", () => {
  const { model, errors, unresolved } = resolvePipeline(
    `
include:
  - project: grp/templates
    file: /jobs.yml
`,
    { path: ".gitlab-ci.yml" }
  );
  assert.equal(model, null);
  assert.equal(errors.length, 1);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].kind, "project");
});

// ---- needs / stages / defaults ----

test("needs: [] means starts immediately; object form parsed", () => {
  const m = parse(`
a: {script: [x], needs: []}
b:
  script: [y]
  needs:
    - {job: a, optional: true, artifacts: false}
`);
  assert.equal(m.jobs.get("a").startsImmediately, true);
  assert.deepEqual(m.jobs.get("b").needs, [{ job: "a", optional: true, artifacts: false, external: false }]);
});

test("!reference spliced into needs resolves to job entries, nested lists flatten", () => {
  const m = parse(`
.shared_needs:
  - {job: release, artifacts: false}
release: {script: [x]}
notes:
  script: [x]
  needs:
    - {job: version, artifacts: true}
    - !reference [.shared_needs]
version: {script: [x]}
`);
  assert.deepEqual(
    m.jobs.get("notes").needs.map((n) => n.job).sort(),
    ["release", "version"]
  );
});

test("needs on a missing job warns", () => {
  const m = parse(`
b: {script: [y], needs: [ghost]}
`);
  assert.ok(m.warnings.some((w) => w.includes("ghost")));
});

test("stage order: .pre first, .post last, undeclared stage appended with warning", () => {
  const m = parse(`
stages: [build, test]
pre: {stage: .pre, script: [x]}
b: {stage: build, script: [x]}
t: {stage: test, script: [x]}
post: {stage: .post, script: [x]}
extra: {stage: undeclared, script: [x]}
`);
  assert.deepEqual(m.stages, [".pre", "build", "test", ".post", "undeclared"]);
  assert.ok(m.warnings.some((w) => w.includes("undeclared")));
});

test("default: section and legacy top-level defaults fill unset job keys", () => {
  const m = parse(`
image: legacy:1
default:
  before_script: [setup]
job: {script: [x]}
override: {image: mine:2, script: [x]}
`);
  assert.equal(m.jobs.get("job").image, "legacy:1");
  assert.deepEqual(m.jobs.get("job").beforeScript, ["setup"]);
  assert.equal(m.jobs.get("override").image, "mine:2");
});

test("hidden jobs are templates, never runnable jobs", () => {
  const m = parse(`
.tpl: {script: [x]}
job: {extends: .tpl}
`);
  assert.deepEqual(m.templates, [".tpl"]);
  assert.ok(!m.jobs.has(".tpl"));
});

test("workflow rules are captured on the model", () => {
  const m = parse(`
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
job: {script: [x]}
`);
  assert.ok(Array.isArray(m.workflow.rules));
});

test("__proto__ keys in YAML never touch prototypes", () => {
  const m = parse(`
".base":
  variables: {A: "1"}
"__proto__": {polluted: "yes"}
job:
  extends: .base
  "__proto__": {alsoPolluted: "yes"}
  script: [x]
`);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.alsoPolluted, undefined);
  const job = m.jobs.get("job");
  assert.equal(job.polluted, undefined);
  assert.equal(job.alsoPolluted, undefined);
  assert.ok(!m.jobs.has("__proto__"));
});

test("parallel matrix counts combinations", () => {
  const m = parse(`
job:
  script: [x]
  parallel:
    matrix:
      - {A: [1, 2], B: [a, b, c]}
      - {A: [9]}
`);
  assert.deepEqual(m.jobs.get("job").parallel, { kind: "matrix", count: 7 });
});
