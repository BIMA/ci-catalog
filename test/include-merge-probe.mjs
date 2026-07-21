#!/usr/bin/env node
// One-question oracle probe for ADR-0002 commit B: when the main file
// redefines a job (and a top-level key) that also comes from an include,
// does GitLab deep-merge them or replace them wholesale?
//
// Usage:
//   GITLAB_PROJECT=330 [GITLAB_URL=…] [GITLAB_TOKEN=…] \
//     node test/include-merge-probe.mjs <include-path-in-repo> <job-name-from-that-file>
//
// Pick a job that has at least two keys (e.g. image + script) in the included
// file, so the two outcomes are distinguishable:
//   - merged job still has the included keys → GitLab DEEP-MERGES
//   - merged job has only the override keys  → GitLab REPLACES at top level

import yaml from "js-yaml";

const GITLAB_URL = (process.env.GITLAB_URL || "https://gitlab.com").replace(/\/+$/, "");
const PROJECT = process.env.GITLAB_PROJECT;
const TOKEN = process.env.GITLAB_TOKEN;
const [includePath, jobName] = process.argv.slice(2);

if (!PROJECT || !includePath || !jobName) {
  console.error("Usage: GITLAB_PROJECT=… node test/include-merge-probe.mjs <include-path> <job-name>");
  process.exit(2);
}

const content = `
include:
  - local: ${includePath}
variables:
  PROBE_MAIN_VAR: "from-main"
${jobName}:
  script: [echo probe-override]
`;

const res = await fetch(`${GITLAB_URL}/api/v4/projects/${encodeURIComponent(PROJECT)}/ci/lint`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(TOKEN ? { "PRIVATE-TOKEN": TOKEN } : {}) },
  body: JSON.stringify({ content, include_merged_yaml: true }),
});
if (!res.ok) {
  console.error(`lint API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const lint = await res.json();
if (!lint.valid) {
  console.error(`GitLab says INVALID: ${(lint.errors ?? []).join("; ")}`);
  process.exit(1);
}

const merged = yaml.load(lint.merged_yaml);
console.log(`--- merged job "${jobName}" ---`);
console.log(yaml.dump(merged[jobName] ?? "(job missing from merged config!)"));
console.log("--- merged top-level variables ---");
console.log(yaml.dump(merged.variables ?? "(none)"));
console.log("--- verdict hints ---");
const job = merged[jobName];
if (job && typeof job === "object") {
  const keys = Object.keys(job);
  console.log(`job keys after merge: ${keys.join(", ")}`);
  console.log(
    keys.length > 1 || keys.some((k) => k !== "script")
      ? "→ included keys survived alongside the override: DEEP-MERGE"
      : "→ only the override keys remain: TOP-LEVEL REPLACE"
  );
}
