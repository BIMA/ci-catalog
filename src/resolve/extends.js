// `extends:` chains — recursive multi-parent resolution, parents merged
// left-to-right, the extending job merged last.

import { isObject } from "./util.js";
import { mergeExtends } from "./merge.js";

export function resolveExtends(name, rawJobs, seen = []) {
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
    acc = mergeExtends(acc, resolveExtends(parent, rawJobs, [...seen, name]));
  }
  const merged = mergeExtends(acc, def);
  delete merged.extends;
  return merged;
}
