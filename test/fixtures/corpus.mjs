// Shared loader for the resolve fixture corpus. Each case directory under
// resolve/ holds an entry.yml, any *.yml/*.yaml files as its include file map
// (keyed by posix-relative path), an optional files.json for canonical-key
// entries (project://…), and the recorded expected.json snapshot.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), "resolve");

export function loadCases() {
  return readdirSync(CORPUS_DIR)
    .filter((n) => statSync(join(CORPUS_DIR, n)).isDirectory())
    .sort()
    .map((name) => {
      const dir = join(CORPUS_DIR, name);
      const entry = readFileSync(join(dir, "entry.yml"), "utf8");
      const files = {};
      const recurse = (cur) => {
        for (const f of readdirSync(cur)) {
          const full = join(cur, f);
          if (statSync(full).isDirectory()) {
            recurse(full);
            continue;
          }
          const rel = relative(dir, full).split(sep).join("/");
          if (rel === "entry.yml") continue;
          if (rel.endsWith(".yml") || rel.endsWith(".yaml")) files[rel] = readFileSync(full, "utf8");
        }
      };
      recurse(dir);
      const extra = join(dir, "files.json");
      if (existsSync(extra)) Object.assign(files, JSON.parse(readFileSync(extra, "utf8")));
      return { name, dir, entry, files };
    });
}

// Snapshot policy: the serialized model when resolution produced one;
// warnings only for successful resolutions (the legacy throw contract lost
// them on error, so error-case snapshots must not depend on them);
// unresolved reduced to canonical keys.
export function snapshot({ model, errors, warnings, unresolved }, serializeModel) {
  return {
    model: model ? serializeModel(model) : null,
    errors,
    warnings: model ? warnings : undefined,
    unresolved: unresolved.map((i) => i.key),
  };
}
