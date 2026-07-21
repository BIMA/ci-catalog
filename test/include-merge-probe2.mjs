#!/usr/bin/env node
// Follow-up oracle probe: top-level hash semantics for include-merge.
// Probe A — main overrides ONE key inside included top-level `variables:`
//           (aks_terraform.yml defines TF_VERSION, TF_STATE_FILE, …).
// Probe B — main sets `default: retry:` while the include (dummy-ci.yml)
//           defines `default: image:`.
// Both answer: do the included sibling keys survive (deep merge) or vanish
// (top-level replace)?
//
// Usage: GITLAB_PROJECT=330 node test/include-merge-probe2.mjs

import yaml from "js-yaml";

const GITLAB_URL = (process.env.GITLAB_URL || "https://gitlab.com").replace(/\/+$/, "");
const PROJECT = process.env.GITLAB_PROJECT;
const TOKEN = process.env.GITLAB_TOKEN;

async function lint(content) {
  const res = await fetch(`${GITLAB_URL}/api/v4/projects/${encodeURIComponent(PROJECT)}/ci/lint`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(TOKEN ? { "PRIVATE-TOKEN": TOKEN } : {}) },
    body: JSON.stringify({ content, include_merged_yaml: true }),
  });
  if (!res.ok) throw new Error(`lint API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const out = await res.json();
  if (!out.valid) throw new Error(`GitLab says INVALID: ${(out.errors ?? []).join("; ")}`);
  return yaml.load(out.merged_yaml);
}

console.log("=== Probe A: top-level variables (include: aks_terraform.yml) ===");
const a = await lint(`
include:
  - local: aks_terraform.yml
variables:
  TF_VERSION: "probe-override"
`);
console.log(yaml.dump({ variables: a.variables ?? "(none)" }));
const av = a.variables ?? {};
console.log(
  Object.keys(av).length > 1
    ? "→ sibling variables survived: DEEP-MERGE for top-level variables\n"
    : "→ only the override remains: TOP-LEVEL REPLACE for variables\n"
);

console.log("=== Probe B: default: (include: dummy-ci.yml) ===");
const b = await lint(`
include:
  - local: dummy-ci.yml
default:
  retry: 2
`);
console.log(yaml.dump({ default: b.default ?? "(none)" }));
const bd = b.default ?? {};
console.log(
  bd.image && bd.retry !== undefined
    ? "→ included default.image survived next to main default.retry: DEEP-MERGE for default"
    : "→ included default keys gone: TOP-LEVEL REPLACE for default"
);
