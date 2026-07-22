/**
 * Scenario Profiles — the named sets of assumed variable values a Simulation
 * runs under.
 *
 * Two adapters sit at this seam:
 *   - the built-in ref contexts below ("what kind of ref triggered this"),
 *   - Scenario Profiles authored as YAML and committed in the Template
 *     Project (see parseScenarioProfile).
 *
 * Both produce the same scenario shape, so nothing downstream knows which
 * kind it is holding:
 *   { key, label, description, source, kind, refNames, vars }
 * where `vars` maps a variable name to a set of possible values —
 * `{ known: true, vals: [...] }` — or is absent, meaning unknown.
 */

const DEFAULT_BRANCHES = ["main", "master"];

export function known(...vals) {
  return { known: true, vals };
}
export const UNKNOWN = { known: false };

export const BUILTIN_SCENARIOS = {
  all: { label: "All jobs", source: "builtin", description: "Every job in the pipeline, unfiltered." },
  mr: {
    label: "Merge request",
    source: "builtin",
    description: "A merge request pipeline on a feature branch.",
    kind: "mr",
    refNames: ["feature/awesome"],
    vars: {
      CI_PIPELINE_SOURCE: known("merge_request_event"),
      CI_COMMIT_BRANCH: known(null),
      CI_COMMIT_TAG: known(null),
      CI_COMMIT_REF_NAME: known("feature/awesome"),
      CI_MERGE_REQUEST_ID: known("1"),
      CI_MERGE_REQUEST_IID: known("1"),
      CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: known("feature/awesome"),
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: known(...DEFAULT_BRANCHES),
      CI_OPEN_MERGE_REQUESTS: known("group/project!1"),
      CI_DEFAULT_BRANCH: known(...DEFAULT_BRANCHES),
    },
  },
  default: {
    label: "Default branch",
    source: "builtin",
    description: "A push to the default branch (main or master).",
    kind: "branch",
    refNames: DEFAULT_BRANCHES,
    vars: {
      CI_PIPELINE_SOURCE: known("push"),
      CI_COMMIT_BRANCH: known(...DEFAULT_BRANCHES),
      CI_COMMIT_TAG: known(null),
      CI_COMMIT_REF_NAME: known(...DEFAULT_BRANCHES),
      CI_MERGE_REQUEST_ID: known(null),
      CI_OPEN_MERGE_REQUESTS: known(null),
      CI_DEFAULT_BRANCH: known(...DEFAULT_BRANCHES),
    },
  },
  branch: {
    label: "Feature branch",
    source: "builtin",
    description: "A push to a non-default branch.",
    kind: "branch",
    refNames: ["feature/awesome"],
    vars: {
      CI_PIPELINE_SOURCE: known("push"),
      CI_COMMIT_BRANCH: known("feature/awesome"),
      CI_COMMIT_TAG: known(null),
      CI_COMMIT_REF_NAME: known("feature/awesome"),
      CI_MERGE_REQUEST_ID: known(null),
      CI_OPEN_MERGE_REQUESTS: known(null),
      CI_DEFAULT_BRANCH: known(...DEFAULT_BRANCHES),
    },
  },
  tag: {
    label: "Tag",
    source: "builtin",
    description: "A tag pipeline (v1.0.0).",
    kind: "tag",
    refNames: ["v1.0.0"],
    vars: {
      CI_PIPELINE_SOURCE: known("push"),
      CI_COMMIT_BRANCH: known(null),
      CI_COMMIT_TAG: known("v1.0.0"),
      CI_COMMIT_REF_NAME: known("v1.0.0"),
      CI_MERGE_REQUEST_ID: known(null),
      CI_OPEN_MERGE_REQUESTS: known(null),
      CI_DEFAULT_BRANCH: known(...DEFAULT_BRANCHES),
    },
  },
  schedule: {
    label: "Schedule",
    source: "builtin",
    description: "A scheduled pipeline on the default branch.",
    kind: "schedule",
    refNames: DEFAULT_BRANCHES,
    vars: {
      CI_PIPELINE_SOURCE: known("schedule"),
      CI_COMMIT_BRANCH: known(...DEFAULT_BRANCHES),
      CI_COMMIT_TAG: known(null),
      CI_COMMIT_REF_NAME: known(...DEFAULT_BRANCHES),
      CI_MERGE_REQUEST_ID: known(null),
      CI_OPEN_MERGE_REQUESTS: known(null),
      CI_DEFAULT_BRANCH: known(...DEFAULT_BRANCHES),
    },
  },
};

/**
 * Parse one Scenario Profile document into a scenario.
 *
 *   name: prod-deploy
 *   description: Production deploy with cluster credentials present
 *   extends: default            # optional built-in (or earlier profile) to build on
 *   kind: branch                # mr | branch | tag | schedule (only/except matching)
 *   refs: [main]                # ref names only/except patterns match against
 *   variables:
 *     KUBECONFIG: /etc/k8s/prod
 *     DEPLOY_ENABLED: "true"
 *     UNSET_ON_PURPOSE: null    # explicitly absent, not unknown
 *
 * `base` supplies the scenario named by `extends:` — its variables are the
 * starting point and the profile's own `variables:` win per key.
 * Returns { scenario, warnings }.
 */
export function parseScenarioProfile(doc, { path = "(profile)", base = null } = {}) {
  const warnings = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { scenario: null, warnings: [`\`${path}\`: scenario profile must be a mapping.`] };
  }
  const name = doc.name ?? null;
  if (!name) {
    return { scenario: null, warnings: [`\`${path}\`: scenario profile needs a \`name\`.`] };
  }
  if (doc.extends && !base) {
    warnings.push(`\`${path}\`: unknown \`extends: ${doc.extends}\` — starting from an empty scenario.`);
  }

  const vars = { ...(base?.vars ?? {}) };
  const declared = doc.variables ?? {};
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) {
    warnings.push(`\`${path}\`: \`variables\` must be a mapping of name to value.`);
  } else {
    for (const [key, value] of Object.entries(declared)) {
      if (value === null) {
        vars[key] = known(null);
      } else if (typeof value === "object") {
        warnings.push(`\`${path}\`: variable \`${key}\` must be a scalar — ignored.`);
      } else {
        vars[key] = known(String(value));
      }
    }
  }

  const refs = doc.refs ?? doc.ref_names;
  return {
    scenario: {
      key: String(name),
      label: String(doc.label ?? name),
      description: doc.description ? String(doc.description) : "",
      source: "profile",
      path,
      extends: doc.extends ? String(doc.extends) : null,
      kind: String(doc.kind ?? base?.kind ?? "branch"),
      refNames: Array.isArray(refs) ? refs.map(String) : (base?.refNames ?? DEFAULT_BRANCHES),
      vars,
    },
    warnings,
  };
}

/**
 * Build the full scenario list for a catalog: built-ins first, then profiles
 * in declaration order. Profiles may `extends:` a built-in or an earlier
 * profile. A profile whose key collides with a built-in replaces it, so a
 * project can retune "Default branch" to its own conventions.
 * `docs` is [{ path, doc }] — already-parsed YAML.
 * Returns { scenarios: [scenario], warnings }.
 */
export function buildScenarios(docs = []) {
  const warnings = [];
  const byKey = new Map();
  for (const [key, ctx] of Object.entries(BUILTIN_SCENARIOS)) {
    byKey.set(key, { key, refNames: [], vars: {}, ...ctx });
  }
  for (const { path, doc } of docs) {
    const base = doc?.extends ? byKey.get(String(doc.extends)) ?? null : null;
    const { scenario, warnings: w } = parseScenarioProfile(doc, { path, base });
    warnings.push(...w);
    if (scenario) byKey.set(scenario.key, scenario);
  }
  return { scenarios: [...byKey.values()], warnings };
}
