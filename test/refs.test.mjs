import { test } from "node:test";
import assert from "node:assert/strict";

import { evalIf, jobVerdict, filterModel, REF_CONTEXTS } from "../src/refs.js";
import { parsePipeline } from "../src/parser.js";

const mr = REF_CONTEXTS.mr;
const branch = REF_CONTEXTS.branch;
const def = REF_CONTEXTS.default;
const tag = REF_CONTEXTS.tag;
const schedule = REF_CONTEXTS.schedule;

// ---- evalIf: three-valued logic ----

test("== against known variable", () => {
  assert.equal(evalIf('$CI_PIPELINE_SOURCE == "merge_request_event"', mr.vars), "T");
  assert.equal(evalIf('$CI_PIPELINE_SOURCE == "merge_request_event"', branch.vars), "F");
});

test("unknown project variable → U", () => {
  assert.equal(evalIf('$DEPLOY_CLUSTER == "prod"', mr.vars), "U");
  assert.equal(evalIf("$KUBECONFIG", mr.vars), "U");
});

test("null comparisons", () => {
  assert.equal(evalIf("$CI_COMMIT_TAG == null", branch.vars), "T");
  assert.equal(evalIf("$CI_COMMIT_TAG != null", tag.vars), "T");
});

test("truthiness of bare variable", () => {
  assert.equal(evalIf("$CI_COMMIT_TAG", tag.vars), "T");
  assert.equal(evalIf("$CI_COMMIT_TAG", branch.vars), "F");
});

test("&& and || with parens", () => {
  assert.equal(evalIf('$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH', branch.vars), "T");
  assert.equal(evalIf('($CI_COMMIT_TAG) || ($CI_PIPELINE_SOURCE == "push")', branch.vars), "T");
  // U && F short-circuits to F
  assert.equal(evalIf('$UNKNOWN == "x" && $CI_COMMIT_TAG', branch.vars), "F");
  // U || T short-circuits to T
  assert.equal(evalIf('$UNKNOWN == "x" || $CI_COMMIT_BRANCH', branch.vars), "T");
});

test("regex match =~ and !~", () => {
  assert.equal(evalIf("$CI_COMMIT_TAG =~ /^v\\d+/", tag.vars), "T");
  assert.equal(evalIf("$CI_COMMIT_TAG !~ /^v\\d+/", tag.vars), "F");
  assert.equal(evalIf("$CI_COMMIT_REF_NAME =~ /^hotfix\\//", branch.vars), "F");
});

test("default-branch union semantics: main and master both match", () => {
  assert.equal(evalIf('$CI_COMMIT_BRANCH == "main"', def.vars), "T");
  assert.equal(evalIf('$CI_COMMIT_BRANCH == "master"', def.vars), "T");
  assert.equal(evalIf("$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH", def.vars), "T");
});

test("malformed expression → U, never a crash", () => {
  assert.equal(evalIf("$X ==", mr.vars), "U");
  assert.equal(evalIf("«garbage»", mr.vars), "U");
});

// ---- jobVerdict: rules / only / except ----

const verdict = (jobYaml, ctx) => {
  const m = parsePipeline(`job:\n  script: [x]\n${jobYaml}`);
  return jobVerdict(m.jobs.get("job"), ctx);
};

test("rules: first matching rule wins; when: never filters", () => {
  const rules = `
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      when: never
    - if: $CI_COMMIT_BRANCH
`;
  assert.equal(verdict(rules, mr), "F");
  assert.equal(verdict(rules, branch), "T");
  assert.equal(verdict(rules, tag), "F");
});

test("rules with changes: → U (depends on the diff)", () => {
  const rules = `
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      changes: [src/**]
`;
  assert.equal(verdict(rules, mr), "U");
  assert.equal(verdict(rules, branch), "F");
});

test("rules on unknown project variable → U", () => {
  const rules = `
  rules:
    - if: $KUBECONFIG && $CLUSTER_NAME
`;
  assert.equal(verdict(rules, def), "U");
});

test("only/except keywords", () => {
  assert.equal(verdict("  only: [merge_requests]", mr), "T");
  assert.equal(verdict("  only: [merge_requests]", branch), "F");
  assert.equal(verdict("  only: [tags]", tag), "T");
  assert.equal(verdict("  only: [schedules]", schedule), "T");
  assert.equal(verdict("  except: [tags]", tag), "F");
  assert.equal(verdict("  except: [tags]", branch), "T");
});

test("only with branch wildcard patterns", () => {
  assert.equal(verdict('  only: ["feature/*"]', branch), "T");
  assert.equal(verdict('  only: ["release/*"]', branch), "F");
});

test("no rules/only/except → runs everywhere", () => {
  assert.equal(verdict("", mr), "T");
  assert.equal(verdict("", tag), "T");
});

// ---- filterModel ----

test("filterModel drops F jobs, keeps U as conditional, filters stages", () => {
  const m = parsePipeline(`
stages: [build, deploy]
build-job:
  stage: build
  script: [x]
mr-only:
  stage: build
  script: [x]
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
deploy-prod:
  stage: deploy
  script: [x]
  rules:
    - if: $KUBECONFIG
`);
  const { model, verdicts } = filterModel(m, "tag");
  assert.ok(model.jobs.has("build-job"));
  assert.ok(!model.jobs.has("mr-only"));
  assert.equal(verdicts.get("deploy-prod"), "U");
  assert.deepEqual(model.stages, ["build", "deploy"]);

  const mrView = filterModel(m, "mr");
  assert.ok(mrView.model.jobs.has("mr-only"));
});

test("workflow rules gate the whole pipeline per context", () => {
  const m = parsePipeline(`
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
job: {script: [x]}
`);
  assert.equal(filterModel(m, "mr").workflow, "T");
  assert.equal(filterModel(m, "branch").workflow, "F");
});
