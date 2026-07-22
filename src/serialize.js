// Serialize a parsed pipeline model to JSON-safe form and back.
// The model's `jobs` is a Map (not JSON-representable); everything else is
// already plain data. Graph and per-ref views are derived in the viewer via
// buildGraph/filterModel, so the manifest only carries the model.

export function serializeModel(model) {
  return {
    stages: model.stages,
    jobs: [...model.jobs.values()],
    templates: model.templates,
    warnings: model.warnings,
    variables: model.variables ?? null,
    workflow: model.workflow ?? null,
  };
}

export function deserializeModel(obj) {
  return {
    stages: obj.stages ?? [],
    jobs: new Map((obj.jobs ?? []).map((j) => [j.name, j])),
    templates: obj.templates ?? [],
    warnings: obj.warnings ?? [],
    variables: obj.variables ?? null,
    workflow: obj.workflow ?? null,
  };
}
