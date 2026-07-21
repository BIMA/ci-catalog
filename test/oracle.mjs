#!/usr/bin/env node
// Correctness oracle: diff this parser against GitLab's own CI Lint API.
//
// GitLab's `POST /projects/:id/ci/lint` returns `merged_yaml` — the config
// after GitLab itself resolved includes, !reference, and YAML merging. We
// parse (a) the raw input with our resolver and (b) GitLab's merged_yaml,
// then diff the resulting models. Divergence = a bug in our approximation.
//
// Usage:
//   GITLAB_PROJECT=group/project [GITLAB_URL=…] [GITLAB_TOKEN=…] \
//     node test/oracle.mjs <file.yml> [more.yml…]
//
// The project only provides evaluation context (its includes are reachable
// from it); the files under test are sent as content.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname, basename, sep } from "node:path";
import { resolvePipeline } from "../src/resolve/index.js";

const parsePipeline = (text, opts) => {
  const { model, errors } = resolvePipeline(text, opts);
  if (!model) throw new Error(errors.join("; "));
  return model;
};

const IGNORE_DIRS = new Set(["node_modules", ".git", ".idea", "dist", "pipeline-docs"]);

// `include: local` is repo-root-relative; GitLab resolves it against the
// project, so we must resolve it against the file's directory tree or every
// included job would count as "missing" on our side.
function walkYaml(dir) {
  const files = {};
  const recurse = (cur) => {
    for (const name of readdirSync(cur)) {
      const full = join(cur, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!IGNORE_DIRS.has(name)) recurse(full);
      } else if (name.endsWith(".yml") || name.endsWith(".yaml")) {
        files[relative(dir, full).split(sep).join("/")] = readFileSync(full, "utf8");
      }
    }
  };
  recurse(dir);
  return files;
}

const fileMaps = new Map(); // project dir → files map
function filesFor(file) {
  const dir = dirname(file);
  if (!fileMaps.has(dir)) fileMaps.set(dir, walkYaml(dir));
  return fileMaps.get(dir);
}

const GITLAB_URL = (process.env.GITLAB_URL || "https://gitlab.com").replace(/\/+$/, "");
const PROJECT = process.env.GITLAB_PROJECT;
const TOKEN = process.env.GITLAB_TOKEN;

const argv = process.argv.slice(2);
// --ignore-extra-jobs: the catalog deliberately resolves rules-gated includes
// that GitLab's lint may skip (e.g. `include: rules: if: $FLAG == 'true'`
// with the flag unset), so "extra job on our side" can be intentional.
const IGNORE_EXTRA = argv.includes("--ignore-extra-jobs");
const files = argv.filter((a) => !a.startsWith("--"));
if (!PROJECT || files.length === 0) {
  console.error("Usage: GITLAB_PROJECT=group/project [GITLAB_TOKEN=…] node test/oracle.mjs [--ignore-extra-jobs] <file.yml>…");
  process.exit(2);
}

async function lint(content) {
  const res = await fetch(`${GITLAB_URL}/api/v4/projects/${encodeURIComponent(PROJECT)}/ci/lint`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN ? { "PRIVATE-TOKEN": TOKEN } : {}),
    },
    body: JSON.stringify({ content, include_merged_yaml: true }),
  });
  if (!res.ok) throw new Error(`lint API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function summarize(model) {
  const jobs = {};
  for (const [name, j] of model.jobs) {
    jobs[name] = {
      stage: j.stage,
      needs: j.needs ? j.needs.map((n) => n.job).sort() : null,
      when: j.when ?? null,
      hasRules: Array.isArray(j.rules),
    };
  }
  return { stages: model.stages, jobs };
}

function diffSummaries(ours, theirs) {
  const problems = [];
  const ourNames = Object.keys(ours.jobs).sort();
  const theirNames = Object.keys(theirs.jobs).sort();
  for (const n of theirNames) if (!ours.jobs[n]) problems.push(`missing job (GitLab has it, we don't): ${n}`);
  if (!IGNORE_EXTRA) {
    for (const n of ourNames) if (!theirs.jobs[n]) problems.push(`extra job (we have it, GitLab doesn't): ${n}`);
  }
  const stagesOk = IGNORE_EXTRA
    ? theirs.stages.every((s) => ours.stages.includes(s)) // extra-job stages allowed
    : JSON.stringify(ours.stages) === JSON.stringify(theirs.stages);
  if (!stagesOk) {
    problems.push(`stages differ: ours=${JSON.stringify(ours.stages)} gitlab=${JSON.stringify(theirs.stages)}`);
  }
  for (const n of theirNames) {
    if (!ours.jobs[n]) continue;
    for (const field of ["stage", "needs", "when", "hasRules"]) {
      const a = JSON.stringify(ours.jobs[n][field]);
      const b = JSON.stringify(theirs.jobs[n][field]);
      if (a !== b) problems.push(`job ${n}: ${field} differs — ours=${a} gitlab=${b}`);
    }
  }
  return problems;
}

let failures = 0;
for (const file of files) {
  const content = readFileSync(file, "utf8");
  process.stdout.write(`${file} … `);

  let lintRes;
  try {
    lintRes = await lint(content);
  } catch (e) {
    console.log(`SKIP (${e.message})`);
    continue;
  }
  if (!lintRes.valid) {
    console.log(`GitLab says INVALID: ${(lintRes.errors ?? []).join("; ")}`);
    failures++;
    continue;
  }
  if (!lintRes.merged_yaml) {
    console.log("SKIP (no merged_yaml in response)");
    continue;
  }

  try {
    // Ours: raw content through our own include/!reference resolution.
    // Theirs: GitLab's fully merged config through the same job extractor,
    // so any diff comes from resolution, not from extraction.
    const ours = summarize(parsePipeline(content, { files: filesFor(file), path: basename(file) }));
    const theirs = summarize(parsePipeline(lintRes.merged_yaml, { path: `${file} (gitlab merged)` }));
    const problems = diffSummaries(ours, theirs);
    if (problems.length === 0) {
      console.log(`OK (${Object.keys(ours.jobs).length} jobs match GitLab)`);
    } else {
      console.log("DIVERGES:");
      for (const p of problems) console.log(`  · ${p}`);
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(".oracle", { recursive: true });
      const dump = `.oracle/${basename(file)}.merged.yml`;
      writeFileSync(dump, lintRes.merged_yaml);
      console.log(`  (GitLab's merged config saved to ${dump} for inspection)`);
      failures++;
    }
  } catch (e) {
    console.log(`PARSE ERROR: ${e.message}`);
    failures++;
  }
}

process.exit(failures === 0 ? 0 : 1);
