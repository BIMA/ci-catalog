/**
 * Catalog Config — the optional `ci-catalog.yml` at a Template Project root.
 *
 *   entrypoints:              # which files are pipeline roots
 *     - java-k8s.yml
 *     - "reactjs-*.yml"       # `*` within a segment, `**` across segments
 *   scenarios:                # Scenario Profiles to load
 *     - scenarios/            # a directory (all *.yml inside), or
 *     - scenarios/prod.yml    # individual files
 *
 * Both keys are optional. Without the file, entrypoint discovery falls back
 * to the convention (root-level *.yml; nested dirs are include-only) and only
 * the built-in scenarios are offered.
 */

import yaml from "js-yaml";

export const CATALOG_CONFIG_FILE = "ci-catalog.yml";

function globToRegExp(pattern) {
  // Escape regex metacharacters (`*` is not among them), then restore glob
  // semantics. `**/` matches zero or more directories, so `**/*.yml` covers
  // root-level files too; a lone `*` never crosses a `/`.
  const DIRS = "\u0000";
  const ANY = "\u0001";
  const body = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, DIRS)
    .replace(/\*\*/g, ANY)
    .replace(/\*/g, "[^/]*")
    .replaceAll(DIRS, "(?:[^/]*/)*")
    .replaceAll(ANY, ".*");
  return new RegExp(`^${body}$`);
}

function asList(value) {
  if (value === undefined || value === null) return null;
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

/**
 * Parse `ci-catalog.yml`. Returns { config, warnings } — config is always
 * usable, with nulls meaning "not configured, use the convention".
 */
export function parseCatalogConfig(text, { path = CATALOG_CONFIG_FILE } = {}) {
  const warnings = [];
  const empty = { entrypoints: null, scenarios: null };
  let doc;
  try {
    doc = yaml.load(text);
  } catch (e) {
    return { config: empty, warnings: [`\`${path}\`: YAML error — ${e.message.split("\n")[0]}`] };
  }
  if (doc === null || doc === undefined) return { config: empty, warnings };
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return { config: empty, warnings: [`\`${path}\`: must be a mapping.`] };
  }
  const known = new Set(["entrypoints", "scenarios"]);
  for (const key of Object.keys(doc)) {
    if (!known.has(key)) warnings.push(`\`${path}\`: unknown key \`${key}\` — ignored.`);
  }
  return {
    config: { entrypoints: asList(doc.entrypoints), scenarios: asList(doc.scenarios) },
    warnings,
  };
}

/** Paths (in `files`) that hold Scenario Profiles, per the config. */
export function scenarioPaths(files, config) {
  if (!config?.scenarios) return [];
  const all = Object.keys(files);
  const out = [];
  for (const entry of config.scenarios) {
    const target = entry.replace(/^\.\//, "").replace(/\/+$/, "");
    if (all.includes(target)) {
      out.push(target); // an individual file
      continue;
    }
    const inDir = all.filter((p) => p.startsWith(`${target}/`) && /\.ya?ml$/.test(p)).sort();
    if (inDir.length > 0) out.push(...inDir);
    else if (entry.includes("*")) out.push(...all.filter((p) => globToRegExp(target).test(p)).sort());
  }
  return [...new Set(out)];
}

/**
 * Which files are pipeline entrypoints. With `entrypoints:` configured, the
 * patterns decide; otherwise the convention applies (root-level files only).
 * Scenario Profiles and the config file itself are never entrypoints.
 */
export function selectEntrypoints(files, config, { scenarios = [] } = {}) {
  const excluded = new Set([CATALOG_CONFIG_FILE, ...scenarios]);
  const candidates = Object.keys(files).filter((p) => !excluded.has(p));
  if (config?.entrypoints) {
    const matchers = config.entrypoints.map((p) => globToRegExp(p.replace(/^\.\//, "")));
    return candidates.filter((p) => matchers.some((re) => re.test(p))).sort();
  }
  return candidates.filter((p) => !p.includes("/")).sort();
}

/** Load the declared Scenario Profiles as [{ path, doc }] for buildScenarios. */
export function scenarioDocs(files, paths) {
  const docs = [];
  const warnings = [];
  for (const path of paths) {
    try {
      docs.push({ path, doc: yaml.load(files[path]) });
    } catch (e) {
      warnings.push(`\`${path}\`: YAML error — ${e.message.split("\n")[0]}`);
    }
  }
  return { docs, warnings };
}
