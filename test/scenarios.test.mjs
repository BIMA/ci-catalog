import { test } from "node:test";
import assert from "node:assert/strict";
import yaml from "js-yaml";

import { resolvePipeline } from "../src/resolve/index.js";
import { buildScenarios, parseScenarioProfile, simulate } from "../src/simulate/index.js";
import {
  parseCatalogConfig,
  scenarioPaths,
  scenarioDocs,
  selectEntrypoints,
} from "../src/catalog-config.js";

const parse = (text) => {
  const { model, errors } = resolvePipeline(text, { path: "entry.yml" });
  if (!model) throw new Error(errors.join("; "));
  return model;
};

const profile = (src) => parseScenarioProfile(yaml.load(src), { path: "p.yml" });

// ---- Scenario Profile parsing ----

test("profile turns variables into known single-value sets", () => {
  const { scenario, warnings } = profile(`
name: prod-deploy
description: Production deploy with cluster credentials present
variables:
  KUBECONFIG: /etc/k8s/prod
  REPLICAS: 3
`);
  assert.deepEqual(warnings, []);
  assert.equal(scenario.key, "prod-deploy");
  assert.equal(scenario.source, "profile");
  assert.deepEqual(scenario.vars.KUBECONFIG, { known: true, vals: ["/etc/k8s/prod"] });
  // non-strings are stringified, matching how GitLab treats CI variables
  assert.deepEqual(scenario.vars.REPLICAS, { known: true, vals: ["3"] });
});

test("a null variable means explicitly unset, not unknown", () => {
  const { scenario } = profile(`
name: no-token
variables:
  DEPLOY_TOKEN: null
`);
  assert.deepEqual(scenario.vars.DEPLOY_TOKEN, { known: true, vals: [null] });
});

test("profile without a name is rejected with a warning", () => {
  const { scenario, warnings } = profile(`variables: {A: b}`);
  assert.equal(scenario, null);
  assert.ok(warnings[0].includes("needs a `name`"));
});

test("extends starts from a built-in and the profile wins per key", () => {
  const [base] = buildScenarios([]).scenarios.filter((s) => s.key === "default");
  const { scenario } = parseScenarioProfile(
    yaml.load(`
name: prod-deploy
extends: default
variables:
  KUBECONFIG: /etc/k8s/prod
  CI_COMMIT_BRANCH: main
`),
    { path: "p.yml", base }
  );
  // inherited from the built-in default-branch context
  assert.deepEqual(scenario.vars.CI_PIPELINE_SOURCE, { known: true, vals: ["push"] });
  // overridden by the profile
  assert.deepEqual(scenario.vars.CI_COMMIT_BRANCH, { known: true, vals: ["main"] });
  assert.deepEqual(scenario.vars.KUBECONFIG, { known: true, vals: ["/etc/k8s/prod"] });
  assert.equal(scenario.kind, "branch");
});

test("buildScenarios keeps built-ins and appends profiles; a profile may replace a built-in", () => {
  const { scenarios } = buildScenarios([
    { path: "a.yml", doc: { name: "prod-deploy", extends: "default", variables: { KUBECONFIG: "/k" } } },
    { path: "b.yml", doc: { name: "tag", label: "Release tag", kind: "tag", refs: ["v1.2.3"] } },
  ]);
  const keys = scenarios.map((s) => s.key);
  assert.ok(keys.includes("all") && keys.includes("mr"));
  assert.ok(keys.includes("prod-deploy"));
  // replaced, not duplicated
  assert.equal(keys.filter((k) => k === "tag").length, 1);
  assert.equal(scenarios.find((s) => s.key === "tag").label, "Release tag");
});

// ---- Simulation under a profile ----

const PIPELINE = `
stages: [build, deploy]
variables:
  APP_NAME: checkout
build:
  stage: build
  script: [make]
deploy-prod:
  stage: deploy
  script: [helm upgrade]
  rules:
    - if: $KUBECONFIG && $CLUSTER_NAME
`;

test("a profile supplying the gating variables turns a conditional job into a definite one", () => {
  const model = parse(PIPELINE);
  const { scenarios } = buildScenarios([
    {
      path: "prod.yml",
      doc: {
        name: "prod-deploy",
        extends: "default",
        variables: { KUBECONFIG: "/etc/k8s/prod", CLUSTER_NAME: "prod-cluster" },
      },
    },
  ]);
  const byKey = (k) => scenarios.find((s) => s.key === k);

  // without the profile the rule depends on variables we can't see
  assert.equal(simulate(model, byKey("default")).verdicts.get("deploy-prod"), "U");
  // with it, the simulation is definite — under the profile's assumptions
  assert.equal(simulate(model, byKey("prod-deploy")).verdicts.get("deploy-prod"), "T");
});

test("simulation reports which variables it had to assume", () => {
  const model = parse(PIPELINE);
  const { scenarios } = buildScenarios([
    { path: "prod.yml", doc: { name: "prod", extends: "default", variables: { KUBECONFIG: "/k", CLUSTER_NAME: "c" } } },
  ]);
  const { assumed } = simulate(model, scenarios.find((s) => s.key === "prod"));
  assert.deepEqual(
    assumed.map((a) => a.name).sort(),
    ["CLUSTER_NAME", "KUBECONFIG"]
  );
  // built-in contexts assume nothing beyond GitLab's predefined variables
  assert.deepEqual(simulate(model, scenarios.find((s) => s.key === "default")).assumed, []);
});

// ---- Catalog Config ----

test("catalog config parses entrypoints and scenarios, flagging unknown keys", () => {
  const { config, warnings } = parseCatalogConfig(`
entrypoints:
  - java-k8s.yml
  - "reactjs-*.yml"
scenarios: scenarios/
nonsense: 1
`);
  assert.deepEqual(config.entrypoints, ["java-k8s.yml", "reactjs-*.yml"]);
  assert.deepEqual(config.scenarios, ["scenarios/"]);
  assert.ok(warnings.some((w) => w.includes("unknown key `nonsense`")));
});

test("missing or empty config leaves everything on the convention", () => {
  assert.deepEqual(parseCatalogConfig("").config, { entrypoints: null, scenarios: null });
  assert.deepEqual(parseCatalogConfig("# just a comment\n").config, { entrypoints: null, scenarios: null });
});

const FILES = {
  "ci-catalog.yml": "",
  "java-k8s.yml": "",
  "reactjs-web.yml": "",
  "library/base.yml": "",
  "scenarios/prod.yml": "",
  "scenarios/mr.yml": "",
};

test("without config, entrypoints are root-level files only", () => {
  assert.deepEqual(selectEntrypoints(FILES, { entrypoints: null }, { scenarios: [] }), [
    "java-k8s.yml",
    "reactjs-web.yml",
  ]);
});

test("configured entrypoints support globs and can reach into subdirectories", () => {
  assert.deepEqual(
    selectEntrypoints(FILES, { entrypoints: ["reactjs-*.yml", "library/**"] }, { scenarios: [] }),
    ["library/base.yml", "reactjs-web.yml"]
  );
});

test("scenario files and the config file are never entrypoints", () => {
  const scenarios = scenarioPaths(FILES, { scenarios: ["scenarios/"] });
  assert.deepEqual(scenarios, ["scenarios/mr.yml", "scenarios/prod.yml"]);
  const entrypoints = selectEntrypoints(FILES, { entrypoints: ["**/*.yml"] }, { scenarios });
  assert.deepEqual(entrypoints, ["java-k8s.yml", "library/base.yml", "reactjs-web.yml"]);
});

test("scenarios may be listed as individual files", () => {
  assert.deepEqual(scenarioPaths(FILES, { scenarios: ["scenarios/prod.yml"] }), ["scenarios/prod.yml"]);
});

test("scenarioDocs reports a YAML error instead of throwing", () => {
  const { docs, warnings } = scenarioDocs({ "bad.yml": "a: [1,\n" }, ["bad.yml"]);
  assert.equal(docs.length, 0);
  assert.ok(warnings[0].includes("YAML error"));
});
