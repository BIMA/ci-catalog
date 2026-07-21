// `include:` resolution against an in-memory file map, plus `spec: inputs:`
// interpolation for included templates.

import { isObject, UNSAFE_KEYS } from "./util.js";
import { loadDocs } from "./yaml.js";
import { mergeInclude, mergeDocs } from "./merge.js";

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

/**
 * Load one file's text into a single merged doc:
 * multi-doc `spec:` headers are applied (inputs interpolated), then its own
 * `include:` entries are resolved recursively and merged (includes first,
 * file body last — the includer wins on conflicts, like GitLab).
 */
export function resolveIncludes(text, files, { path = "(input)", inputs = {}, stack = [], warnings, unresolved = [] }) {
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
      if (UNSAFE_KEYS.has(name)) continue;
      if (merged[name] === undefined && isObject(def) && def.default !== undefined) {
        merged[name] = def.default;
      }
    }
    body = docs.slice(1).reduce((acc, d) => mergeDocs(acc, d), {});
    body = interpolateInputs(body, merged, warnings, path);
  } else {
    body = docs.reduce((acc, d) => mergeDocs(acc, d), {});
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
      const sub = resolveIncludes(files[target], files, {
        path: target,
        inputs: entry.inputs ?? {},
        stack: [...stack, key],
        warnings,
        unresolved,
      });
      acc = mergeInclude(acc, sub);
      continue;
    }
    for (const inc of includeKeys(entry)) {
      const stackKey = `${inc.key}::${JSON.stringify(inc.inputs)}`;
      if (stack.includes(stackKey)) {
        warnings.push(`Circular include: ${inc.describe}`);
        continue;
      }
      if (inc.key in files) {
        const sub = resolveIncludes(files[inc.key], files, {
          path: inc.key,
          inputs: inc.inputs,
          stack: [...stack, stackKey],
          warnings,
          unresolved,
        });
        acc = mergeInclude(acc, sub);
      } else {
        unresolved.push(inc);
        warnings.push(`include (${inc.describe}) not resolved — jobs from it are missing.`);
      }
    }
  }
  const own = { ...body };
  delete own.include;
  return mergeInclude(acc, own);
}
