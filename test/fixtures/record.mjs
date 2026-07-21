#!/usr/bin/env node
// Re-record expected.json for every corpus case from the resolver's current
// behavior. Run only when a behavior change is intended; the diff of the
// recorded snapshots is the reviewable statement of what changed.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePipeline } from "../../src/resolve/index.js";
import { serializeModel } from "../../src/serialize.js";
import { loadCases, snapshot } from "./corpus.mjs";

for (const c of loadCases()) {
  const snap = snapshot(resolvePipeline(c.entry, { files: c.files, path: "entry.yml" }), serializeModel);
  writeFileSync(join(c.dir, "expected.json"), JSON.stringify(snap, null, 2) + "\n");
  console.log(`recorded ${c.name}${snap.model ? "" : " (error case)"}`);
}
