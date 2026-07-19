import yaml from "js-yaml";

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

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ---- GitLab YAML dialect: `!reference` tag ----

class GitlabRef {
  constructor(path) {
    this.path = path; // e.g. ['.job', 'script']
  }
  toString() {
    return `!reference [${this.path.join(", ")}]`;
  }
}

const REFERENCE_TYPE = new yaml.Type("!reference", {
  kind: "sequence",
  construct: (seq) => new GitlabRef((seq ?? []).map(String)),
});

const GITLAB_SCHEMA = yaml.DEFAULT_SCHEMA.extend([REFERENCE_TYPE]);

function loadDocs(text) {
  return yaml.loadAll(text, { schema: GITLAB_SCHEMA }).filter((d) => d !== null && d !== undefined);
}

// Resolve every GitlabRef in the doc against the doc itself (GitLab resolves
// them against the fully merged configuration). Refs that resolve to arrays
// are flattened one level when they sit inside an array, matching how GitLab
// splices `!reference [.job, script]` into a script list.
function resolveReferences(doc, warnings) {
  const MAX_DEPTH = 10;
  const lookup = (ref, depth) => {
    if (depth > MAX_DEPTH) return ref.toString();
    let cur = doc;
    for (const seg of ref.path) {
      cur = isObject(cur) || Array.isArray(cur) ? cur[seg] : undefined;
      if (cur === undefined) {
        warnings.push(`Unresolvable ${ref.toString()} — target not found.`);
        return ref.toString();
      }
    }
    return walk(cur, depth + 1);
  };
  const walk = (node, depth = 0) => {
    if (node instanceof GitlabRef) return lookup(node, depth);
    if (Array.isArray(node)) {
      const out = [];
      for (const item of node) {
        const wasRef = item instanceof GitlabRef;
        const v = walk(item, depth);
        if (wasRef && Array.isArray(v)) out.push(...v);
        else out.push(v);
      }
      return out;
    }
    if (isObject(node)) {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v, depth);
      return out;
    }
    return node;
  };
  return walk(doc);
}

// ---- `spec: inputs:` templates and $[[ inputs.x ]] interpolation ----

function interpolateInputs(node, inputs, warnings, filePath) {
  const subst = (str) =>
    str.replace(/\$\[\[\s*inputs\.([A-Za-z0-9_-]+)\s*\]\]/g, (m, name) => {
      if (inputs[name] === undefined) {
        warnings.push(`\`${filePath}\`: input \`${name}\` has no value or default.`);
        return m;
      }
      return String(inputs[name]);
    });
  const walk = (n) => {
    if (typeof n === "string") return subst(n);
    if (Array.isArray(n)) return n.map(walk);
    if (isObject(n)) {
      const out = {};
      for (const [k, v] of Object.entries(n)) out[subst(k)] = walk(v);
      return out;
    }
    return n;
  };
  return walk(node);
}

// ---- include: resolution against an in-memory file map ----

function normalizeIncludes(include) {
  const arr = Array.isArray(include) ? include : [include];
  return arr.map((entry) => {
    if (typeof entry === "string") {
      return /^https?:\/\//.test(entry) ? { remote: entry } : { local: entry };
    }
    return entry ?? {};
  });
}

/**
 * Canonical `files` map keys for non-local includes, so a generator can
 * pre-fetch them and the parser resolves them like local files:
 *   project://<project>@<ref>/<file>   (ref defaults to HEAD)
 *   template://<name>
 *   component://<address>              (address includes @version)
 *   remote://<url>
 * Returns [{key, inputs, describe}] — one per file for `project:` includes.
 */
export function includeKeys(entry) {
  const inputs = entry.inputs ?? {};
  if (entry.project) {
    const ref = String(entry.ref ?? "HEAD");
    const files = Array.isArray(entry.file) ? entry.file : [entry.file];
    return files.filter(Boolean).map((f) => {
      const file = String(f).replace(/^\/+/, "");
      return {
        key: `project://${entry.project}@${ref}/${file}`,
        kind: "project",
        project: String(entry.project),
        ref,
        file,
        inputs,
        describe: `project ${entry.project} file ${f}`,
      };
    });
  }
  if (entry.template) {
    return [{ key: `template://${entry.template}`, kind: "template", name: String(entry.template), inputs, describe: `template ${entry.template}` }];
  }
  if (entry.component) {
    return [{ key: `component://${entry.component}`, kind: "component", address: String(entry.component), inputs, describe: `component ${entry.component}` }];
  }
  if (entry.remote) {
    return [{ key: `remote://${entry.remote}`, kind: "remote", url: String(entry.remote), inputs, describe: `remote ${entry.remote}` }];
  }
  return [];
}

/**
 * Load one file's text into a single merged doc:
 * multi-doc `spec:` headers are applied (inputs interpolated), then its own
 * `include:` entries are resolved recursively and merged (includes first,
 * file body last — the includer wins on conflicts, like GitLab).
 */
function resolveText(text, files, { path = "(input)", inputs = {}, stack = [], warnings, unresolved = [] }) {
  let docs;
  try {
    docs = loadDocs(text);
  } catch (e) {
    warnings.push(`\`${path}\`: YAML error — ${e.message.split("\n")[0]}`);
    return {};
  }
  if (docs.length === 0) return {};

  let body;
  if (isObject(docs[0]) && isObject(docs[0].spec)) {
    const spec = docs[0].spec;
    const merged = { ...inputs };
    for (const [name, def] of Object.entries(spec.inputs ?? {})) {
      if (merged[name] === undefined && isObject(def) && def.default !== undefined) {
        merged[name] = def.default;
      }
    }
    body = docs.slice(1).reduce((acc, d) => mergeGitlab(acc, d), {});
    body = interpolateInputs(body, merged, warnings, path);
  } else {
    body = docs.reduce((acc, d) => mergeGitlab(acc, d), {});
  }
  if (!isObject(body)) return {};

  if (body.include === undefined) return body;

  let acc = {};
  for (const entry of normalizeIncludes(body.include)) {
    if (entry.local) {
      const target = String(entry.local).replace(/^\/+/, "");
      const key = `${target}::${JSON.stringify(entry.inputs ?? {})}`;
      if (stack.includes(key)) {
        warnings.push(`Circular include: ${target}`);
        continue;
      }
      if (!(target in files)) {
        warnings.push(`include \`${target}\` not found in loaded file set.`);
        continue;
      }
      if (entry.rules) {
        warnings.push(`include \`${target}\` is gated by rules — included anyway (the catalog shows all possible jobs).`);
      }
      const sub = resolveText(files[target], files, {
        path: target,
        inputs: entry.inputs ?? {},
        stack: [...stack, key],
        warnings,
        unresolved,
      });
      acc = mergeGitlab(acc, sub);
      continue;
    }
    for (const inc of includeKeys(entry)) {
      const stackKey = `${inc.key}::${JSON.stringify(inc.inputs)}`;
      if (stack.includes(stackKey)) {
        warnings.push(`Circular include: ${inc.describe}`);
        continue;
      }
      if (inc.key in files) {
        const sub = resolveText(files[inc.key], files, {
          path: inc.key,
          inputs: inc.inputs,
          stack: [...stack, stackKey],
          warnings,
          unresolved,
        });
        acc = mergeGitlab(acc, sub);
      } else {
        unresolved.push(inc);
        warnings.push(`include (${inc.describe}) not resolved — jobs from it are missing.`);
      }
    }
  }
  const own = { ...body };
  delete own.include;
  return mergeGitlab(acc, own);
}

// GitLab extends-merge: hashes merge deeply, everything else (arrays,
// scalars) is replaced by the child value.
function mergeGitlab(base, child) {
  if (base instanceof GitlabRef || child instanceof GitlabRef) return child;
  if (!isObject(base) || !isObject(child)) return child;
  const out = { ...base };
  for (const [k, v] of Object.entries(child)) {
    out[k] = k in base ? mergeGitlab(base[k], v) : v;
  }
  return out;
}

function resolveExtends(name, rawJobs, seen = []) {
  const def = rawJobs[name];
  if (!isObject(def)) {
    throw new Error(`\`${name}\` is not a job definition`);
  }
  if (seen.includes(name)) {
    throw new Error(`circular extends: ${[...seen, name].join(" → ")}`);
  }
  const parents = def.extends
    ? Array.isArray(def.extends)
      ? def.extends
      : [def.extends]
    : [];
  let acc = {};
  for (const parent of parents) {
    if (!(parent in rawJobs)) {
      throw new Error(`\`${name}\` extends unknown job \`${parent}\``);
    }
    acc = mergeGitlab(acc, resolveExtends(parent, rawJobs, [...seen, name]));
  }
  const merged = mergeGitlab(acc, def);
  delete merged.extends;
  return merged;
}

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
 * Parse .gitlab-ci.yml text into a pipeline model:
 * {
 *   stages: [name],            // ordered, only stages that have jobs (plus .pre/.post when used)
 *   jobs:   Map<name, job>,    // visible (non-hidden) resolved jobs
 *   templates: [name],         // hidden .jobs used via extends
 *   warnings: [string],
 * }
 */
export function parsePipeline(text, { files = {}, path = "(input)" } = {}) {
  const warnings = [];
  const unresolved = [];
  let doc = resolveText(text, files, { path, warnings, unresolved });
  if (!isObject(doc) || Object.keys(doc).length === 0) {
    const err = new Error("YAML root must be a mapping with content (empty or non-mapping document).");
    err.unresolved = unresolved;
    throw err;
  }
  doc = resolveReferences(doc, warnings);

  const defaults = isObject(doc.default) ? doc.default : {};
  // Legacy top-level defaults (image, before_script, …) still work in GitLab.
  for (const k of DEFAULTABLE_KEYS) {
    if (doc[k] !== undefined && defaults[k] === undefined) defaults[k] = doc[k];
  }

  const rawJobs = {};
  for (const [key, val] of Object.entries(doc)) {
    if (RESERVED_KEYS.has(key)) continue;
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

  if (jobs.size === 0) {
    const err = new Error("No jobs found. Hidden jobs (names starting with '.') are templates and never run.");
    err.unresolved = unresolved;
    throw err;
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

  return { stages, jobs, templates, warnings, unresolved, workflow: isObject(doc.workflow) ? doc.workflow : null };
}

export function dumpJobYaml(job) {
  return yaml.dump({ [job.name]: job.raw }, { lineWidth: 100, noRefs: true });
}
