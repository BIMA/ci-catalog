// Flatten a fully resolved configuration doc into the pipeline model the
// viewer and manifest consume: ordered stages, resolved jobs, templates.

import yaml from "js-yaml";
import { isObject, UNSAFE_KEYS } from "./util.js";
import { resolveExtends } from "./extends.js";

// Top-level keys in .gitlab-ci.yml that are configuration, not jobs.
const RESERVED_KEYS = new Set([
  "image",
  "services",
  "stages",
  "types",
  "before_script",
  "after_script",
  "variables",
  "cache",
  "include",
  "workflow",
  "default",
  "spec",
]);

const DEFAULT_STAGES = ["build", "test", "deploy"];

// Keys the `default:` section may provide to jobs that don't set them.
const DEFAULTABLE_KEYS = [
  "image",
  "services",
  "before_script",
  "after_script",
  "tags",
  "cache",
  "artifacts",
  "retry",
  "timeout",
  "interruptible",
];

function normalizeNeeds(needs) {
  // Returns { list: [{job, optional, artifacts, external}], startsImmediately }
  if (needs === undefined) return { list: null, startsImmediately: false };
  // A `!reference` spliced into needs can appear as a nested list (GitLab's
  // merged_yaml serializes it that way) — flatten before normalizing.
  const arr = (Array.isArray(needs) ? needs : [needs]).flat(2);
  if (arr.length === 0) return { list: [], startsImmediately: true };
  const list = [];
  for (const n of arr) {
    if (typeof n === "string") {
      list.push({ job: n, optional: false, artifacts: true, external: false });
    } else if (isObject(n)) {
      list.push({
        job: n.job ?? "",
        optional: Boolean(n.optional),
        artifacts: n.artifacts !== false,
        // needs on another pipeline/project can't be drawn as a local edge
        external: Boolean(n.pipeline || n.project),
      });
    }
  }
  return { list, startsImmediately: false };
}

function describeParallel(parallel) {
  if (parallel === undefined || parallel === null) return null;
  if (typeof parallel === "number") return { kind: "count", count: parallel };
  if (isObject(parallel) && Array.isArray(parallel.matrix)) {
    let combos = 0;
    for (const entry of parallel.matrix) {
      let n = 1;
      for (const v of Object.values(entry)) {
        n *= Array.isArray(v) ? v.length : 1;
      }
      combos += n;
    }
    return { kind: "matrix", count: combos };
  }
  return null;
}

/**
 * Build the pipeline model from a fully resolved doc (includes and
 * `!reference` already expanded): resolve `extends:`, fill defaults, order
 * stages, validate needs targets. Returns
 * { stages, jobs: Map<name, job>, templates, workflow }.
 */
export function buildModel(doc, warnings) {
  const defaults = isObject(doc.default) ? doc.default : {};
  // Legacy top-level defaults (image, before_script, …) still work in GitLab.
  for (const k of DEFAULTABLE_KEYS) {
    if (doc[k] !== undefined && defaults[k] === undefined) defaults[k] = doc[k];
  }

  const rawJobs = {};
  for (const [key, val] of Object.entries(doc)) {
    if (RESERVED_KEYS.has(key) || UNSAFE_KEYS.has(key)) continue;
    if (!isObject(val)) {
      if (!key.startsWith(".")) warnings.push(`Ignored top-level key \`${key}\` (not a job mapping).`);
      continue;
    }
    rawJobs[key] = val;
  }

  const declaredStages = Array.isArray(doc.stages)
    ? doc.stages.map(String)
    : Array.isArray(doc.types)
      ? doc.types.map(String)
      : DEFAULT_STAGES.slice();

  const jobs = new Map();
  const templates = [];
  for (const name of Object.keys(rawJobs)) {
    if (name.startsWith(".")) {
      templates.push(name);
      continue;
    }
    let def;
    try {
      def = resolveExtends(name, rawJobs);
    } catch (e) {
      warnings.push(`Job \`${name}\`: ${e.message} — shown unresolved.`);
      def = { ...rawJobs[name] };
      delete def.extends;
    }

    for (const k of DEFAULTABLE_KEYS) {
      if (def[k] === undefined && defaults[k] !== undefined) def[k] = defaults[k];
    }

    const { list: needs, startsImmediately } = normalizeNeeds(def.needs);
    const isTrigger = isObject(def.trigger) || typeof def.trigger === "string";

    jobs.set(name, {
      name,
      stage: def.stage !== undefined ? String(def.stage) : "test",
      needs, // null = stage-ordered, [] = starts immediately, [...] = explicit
      startsImmediately,
      dependencies: Array.isArray(def.dependencies) ? def.dependencies.map(String) : null,
      when: def.when ?? (def.rules ? null : "on_success"),
      allowFailure:
        def.allow_failure === true ||
        (isObject(def.allow_failure) && Boolean(def.allow_failure.exit_codes)),
      manual: def.when === "manual",
      parallel: describeParallel(def.parallel),
      trigger: isTrigger ? def.trigger : null,
      image: typeof def.image === "string" ? def.image : def.image?.name ?? null,
      services: def.services ?? null,
      tags: def.tags ?? null,
      script: def.script ?? null,
      beforeScript: def.before_script ?? null,
      afterScript: def.after_script ?? null,
      rules: def.rules ?? null,
      only: def.only ?? null,
      except: def.except ?? null,
      artifacts: def.artifacts ?? null,
      cache: def.cache ?? null,
      environment: def.environment ?? null,
      variables: def.variables ?? null,
      retry: def.retry ?? null,
      timeout: def.timeout ?? null,
      coverage: def.coverage ?? null,
      resourceGroup: def.resource_group ?? null,
      raw: def,
    });
  }

  // Stage order: .pre, declared stages, .post; then only keep non-empty,
  // appending any stage a job references that wasn't declared.
  const usedStages = new Set([...jobs.values()].map((j) => j.stage));
  const order = [".pre", ...declaredStages.filter((s) => s !== ".pre" && s !== ".post"), ".post"];
  const stages = order.filter((s) => usedStages.has(s));
  for (const s of usedStages) {
    if (!stages.includes(s)) {
      stages.push(s);
      warnings.push(`Stage \`${s}\` is used by a job but not declared in \`stages:\`.`);
    }
  }

  // Validate needs targets exist (parallel:matrix jobs can be needed by
  // base name, so this stays a warning, not an error).
  for (const job of jobs.values()) {
    if (!job.needs) continue;
    for (const n of job.needs) {
      if (!n.external && n.job && !jobs.has(n.job) && !n.optional) {
        warnings.push(`Job \`${job.name}\` needs \`${n.job}\`, which doesn't exist in this file.`);
      }
    }
  }

  return { stages, jobs, templates, workflow: isObject(doc.workflow) ? doc.workflow : null };
}

export function dumpJobYaml(job) {
  return yaml.dump({ [job.name]: job.raw }, { lineWidth: 100, noRefs: true });
}
