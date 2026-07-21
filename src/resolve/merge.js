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

// `include:` accumulation and the includer-wins final merge. Oracle-verified
// GitLab-exact (2026-07-21, CI Lint probes against a real instance): GitLab
// deep-merges includes at the job level, top-level `variables`, and
// `default` — sibling keys from the include survive a main-file override.
// See test/include-merge-probe.mjs and ADR-0002.
export const mergeInclude = deepMerge;

// Multiple YAML documents in one file (with or without a `spec:` header).
export const mergeDocs = deepMerge;
