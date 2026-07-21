// Resolve every GitlabRef in the doc against the doc itself (GitLab resolves
// them against the fully merged configuration). Refs that resolve to arrays
// are flattened one level when they sit inside an array, matching how GitLab
// splices `!reference [.job, script]` into a script list.

import { isObject, UNSAFE_KEYS } from "./util.js";
import { GitlabRef } from "./yaml.js";

export function resolveReferences(doc, warnings) {
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
      for (const [k, v] of Object.entries(node)) {
        if (UNSAFE_KEYS.has(k)) continue;
        out[k] = walk(v, depth);
      }
      return out;
    }
    return node;
  };
  return walk(doc);
}
