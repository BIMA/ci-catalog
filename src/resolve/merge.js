// The merge primitives of Static Resolution, named per merge site so each can
// be moved toward GitLab-exact semantics independently (ADR-0002) without the
// others in its blast radius. Today all three share one behavior: hashes
// merge deeply, everything else (arrays, scalars) is replaced by the child.

import { isObject, UNSAFE_KEYS } from "./util.js";
import { GitlabRef } from "./yaml.js";

function deepMerge(base, child) {
  if (base instanceof GitlabRef || child instanceof GitlabRef) return child;
  if (!isObject(base) || !isObject(child)) return child;
  const out = { ...base };
  for (const [k, v] of Object.entries(child)) {
    if (UNSAFE_KEYS.has(k)) continue;
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

// `extends:` chains — GitLab documents this as a reverse deep merge.
export const mergeExtends = deepMerge;

// `include:` accumulation and the includer-wins final merge. Known divergence
// from GitLab (main file overrides included top-level keys) — fixing this is
// the reason this site has its own name.
export const mergeInclude = deepMerge;

// Multiple YAML documents in one file (with or without a `spec:` header).
export const mergeDocs = deepMerge;
