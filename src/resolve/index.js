// Static Resolution — the one interface callers use. Expands `include`,
// `spec:` inputs, `!reference`, and `extends` into a flat pipeline model,
// in that order (each phase lives in its own module; see ADR-0002).
//
// Errors are values: resolution failures ("empty document", "no jobs") are
// normal Template Project inputs, so the result always has the same shape —
// `model` is null exactly when `errors` is non-empty. `warnings` and
// `unresolved` are also carried on a successful model for the manifest.

import { isObject } from "./util.js";
import { resolveIncludes } from "./includes.js";
import { resolveReferences } from "./references.js";
import { buildModel } from "./model.js";

export { includeKeys } from "./includes.js";
export { dumpJobYaml } from "./model.js";

/**
 * Resolve .gitlab-ci.yml text into a pipeline model:
 * {
 *   model: {
 *     stages: [name],          // ordered, only stages that have jobs (plus .pre/.post when used)
 *     jobs:   Map<name, job>,  // visible (non-hidden) resolved jobs
 *     templates: [name],       // hidden .jobs used via extends
 *     warnings, unresolved, workflow,
 *   } | null,
 *   errors: [string],          // model === null iff errors is non-empty
 *   warnings: [string],
 *   unresolved: [includeKey],  // non-local includes missing from `files`
 * }
 */
export function resolvePipeline(text, { files = {}, path = "(input)" } = {}) {
  const warnings = [];
  const unresolved = [];
  let doc = resolveIncludes(text, files, { path, warnings, unresolved });
  if (!isObject(doc) || Object.keys(doc).length === 0) {
    return {
      model: null,
      errors: ["YAML root must be a mapping with content (empty or non-mapping document)."],
      warnings,
      unresolved,
    };
  }
  doc = resolveReferences(doc, warnings);

  const model = buildModel(doc, warnings);
  if (model.jobs.size === 0) {
    return {
      model: null,
      errors: ["No jobs found. Hidden jobs (names starting with '.') are templates and never run."],
      warnings,
      unresolved,
    };
  }

  model.warnings = warnings;
  model.unresolved = unresolved;
  return { model, errors: [], warnings, unresolved };
}
