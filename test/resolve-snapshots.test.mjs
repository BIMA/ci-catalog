// Behavior lock for Static Resolution: every corpus case must resolve to the
// recorded snapshot exactly. A legitimate behavior change (e.g. an ADR-0002
// merge-semantics fix) re-records via test/fixtures/record.mjs and reviews
// the snapshot diff; anything else failing here is a regression.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolvePipeline } from "../src/resolve/index.js";
import { serializeModel } from "../src/serialize.js";
import { loadCases, snapshot } from "./fixtures/corpus.mjs";

for (const c of loadCases()) {
  test(`resolve snapshot: ${c.name}`, () => {
    const expected = JSON.parse(readFileSync(join(c.dir, "expected.json"), "utf8"));
    const actual = JSON.parse(
      JSON.stringify(snapshot(resolvePipeline(c.entry, { files: c.files, path: "entry.yml" }), serializeModel))
    );
    assert.deepEqual(actual, expected);
  });
}
