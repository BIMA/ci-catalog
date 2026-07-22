/**
 * Simulation — evaluating a resolved pipeline under one Scenario Profile.
 *
 * Everything a caller needs comes back from one call, so no consumer
 * re-derives a verdict or splits job verdicts from the workflow verdict:
 *
 *   simulate(model, scenario)
 *     → { model, verdicts, workflow, assumed }
 *
 * A Simulation is always the user's assumptions, never ground truth
 * (ADR-0001): `assumed` lists the variables whose values were supplied by the
 * scenario rather than known from the config, so the UI can say so.
 */

import { jobVerdict, evalRulesList } from "./evaluate.js";
import { referencedVariables, classifyVariable, repoDefinedVariables } from "./provenance.js";

export { BUILTIN_SCENARIOS, buildScenarios, parseScenarioProfile, known, UNKNOWN } from "./scenarios.js";
export { formatCondition } from "./format.js";
export { evalIf, jobVerdict } from "./evaluate.js";
export { variableProvenance, referencedVariables, classifyVariable } from "./provenance.js";

/** True when this scenario means "show everything, filter nothing". */
function isUnfiltered(scenario) {
  return !scenario || scenario.key === "all" || !scenario.vars;
}

/**
 * Run one scenario against a resolved model.
 * Returns { model, verdicts: Map<name,'T'|'U'>, workflow: 'T'|'F'|'U',
 *           assumed: [{ name, provenance }] }.
 * Jobs with verdict 'F' are dropped from the returned model; 'U' jobs are
 * kept so the viewer can draw them as conditional.
 */
export function simulate(model, scenario) {
  if (isUnfiltered(scenario)) {
    return { model, verdicts: new Map(), workflow: "T", assumed: [] };
  }
  const verdicts = new Map();
  const jobs = new Map();
  for (const [name, job] of model.jobs) {
    const v = jobVerdict(job, scenario);
    if (v === "F") continue;
    verdicts.set(name, v);
    jobs.set(name, job);
  }
  const stages = model.stages.filter((s) => [...jobs.values()].some((j) => j.stage === s));
  const workflow = Array.isArray(model.workflow?.rules)
    ? evalRulesList(model.workflow.rules, scenario)
    : "T";

  return {
    model: { ...model, stages, jobs, warnings: [] },
    verdicts,
    workflow,
    assumed: assumedVariables(model, scenario),
  };
}

/**
 * The variables this simulation had to assume a value for: every variable the
 * pipeline's rules reference that the scenario supplies but the config does
 * not define. These are exactly the claims a viewer must label as assumptions.
 */
export function assumedVariables(model, scenario) {
  if (isUnfiltered(scenario)) return [];
  const repoVars = repoDefinedVariables(model);
  const seen = new Map();
  for (const job of model.jobs.values()) {
    for (const name of referencedVariables(job)) {
      if (seen.has(name)) continue;
      const provenance = classifyVariable(name, { repoVars, scenario });
      if (provenance === "scenario" || (provenance === "external" && scenario.vars?.[name])) {
        seen.set(name, { name, provenance: "scenario" });
      }
    }
  }
  return [...seen.values()];
}

/** Per-scenario job counts, for tab labels. */
export function scenarioCounts(model, scenarios) {
  const counts = {};
  for (const scenario of scenarios) {
    counts[scenario.key] = isUnfiltered(scenario) ? model.jobs.size : simulate(model, scenario).model.jobs.size;
  }
  return counts;
}
