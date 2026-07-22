/**
 * Variable Provenance (ADR-0001): for every variable a job's rules reference,
 * say where its value comes from. This is what keeps a Simulation honest —
 * a verdict computed from `external` variables is an assumption, not a fact.
 *
 *   predefined — a GitLab predefined variable the scenario models
 *   scenario   — supplied by the active Scenario Profile
 *   repo       — defined in the pipeline YAML (top-level or job `variables:`)
 *   external   — not visible to a local parser; lives in GitLab settings
 */

import { tokenize } from "./evaluate.js";
import { BUILTIN_SCENARIOS } from "./scenarios.js";

// Variables the built-in scenarios model. Anything CI_-prefixed is predefined
// by GitLab even when no built-in scenario happens to set it.
const MODELLED = new Set(Object.values(BUILTIN_SCENARIOS).flatMap((c) => Object.keys(c.vars ?? {})));

function varsInExpression(expr) {
  try {
    return tokenize(String(expr))
      .filter((t) => t.type === "var")
      .map((t) => t.value);
  } catch {
    return [];
  }
}

/** Every variable name referenced by a job's rules / only / except. */
export function referencedVariables(job) {
  const names = new Set();
  const addExpr = (e) => varsInExpression(e).forEach((n) => names.add(n));
  if (Array.isArray(job.rules)) {
    for (const rule of job.rules) {
      const r = typeof rule === "string" ? { if: rule } : rule ?? {};
      if (r.if !== undefined) addExpr(r.if);
    }
  }
  for (const clause of [job.only, job.except]) {
    if (clause && !Array.isArray(clause) && Array.isArray(clause.variables)) {
      clause.variables.forEach(addExpr);
    }
  }
  return [...names];
}

/**
 * Classify one variable name.
 * `repoVars` is the set of names defined anywhere in the resolved pipeline;
 * `scenario` is the active scenario (or null for provenance without one).
 */
export function classifyVariable(name, { repoVars = new Set(), scenario = null } = {}) {
  // Predefined first: a profile that restates CI_COMMIT_BRANCH is modelling a
  // GitLab-provided value, not inventing one, so it stays "predefined".
  if (MODELLED.has(name) || name.startsWith("CI_") || name === "GITLAB_CI") return "predefined";
  if (repoVars.has(name)) return "repo";
  // Anything left is invisible to a local parser — unless a profile supplies
  // it, in which case the profile is the (assumed) source.
  if (scenario?.vars?.[name]) return "scenario";
  return "external";
}

/** The set of variable names defined by the pipeline itself. */
export function repoDefinedVariables(model) {
  const names = new Set(Object.keys(model.variables ?? {}));
  for (const job of model.jobs.values()) {
    for (const key of Object.keys(job.variables ?? {})) names.add(key);
  }
  return names;
}

/**
 * Provenance for every variable each job's rules depend on:
 *   Map<jobName, [{ name, provenance }]>
 * Jobs with no rule variables are omitted.
 */
export function variableProvenance(model, scenario = null) {
  const repoVars = repoDefinedVariables(model);
  const out = new Map();
  for (const [name, job] of model.jobs) {
    const refs = referencedVariables(job);
    if (refs.length === 0) continue;
    out.set(
      name,
      refs.map((v) => ({ name: v, provenance: classifyVariable(v, { repoVars, scenario }) }))
    );
  }
  return out;
}
