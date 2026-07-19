#!/usr/bin/env node
// Pipeline docs generator — dbt-docs-style.
//
//   ci-catalog [generate] <projectDir> [-o outDir] [options]
//
// Walks <projectDir> for **/*.yml, parses every root-level file as a pipeline
// entrypoint (nested dirs like library/ are resolved as includes only), and
// writes a static catalog the viewer can open:
//
//   <outDir>/manifest.json   — parsed pipeline models
//   <outDir>/<viewer files>  — the built viewer (copied from dist/)
//
// Non-local includes (project / template / remote / component) are fetched
// over the network at generate time and fed back into the parser until no
// unresolved includes remain. Use --offline to skip fetching.
//
// Then: npx serve <outDir>

import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { join, relative, dirname, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { parsePipeline } from "../src/parser.js";
import { serializeModel } from "../src/serialize.js";

const SCHEMA_VERSION = 1;
const IGNORE_DIRS = new Set(["node_modules", ".git", ".idea", "dist", "pipeline-docs"]);
const MAX_FETCH_ROUNDS = 5;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = {
    out: "pipeline-docs",
    build: null, // null = auto: build only when dist/ is missing (dev checkout)
    project: null,
    gitlabUrl: process.env.CI_SERVER_URL || "https://gitlab.com",
    offline: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") args.out = argv[++i];
    else if (a === "--build") args.build = true;
    else if (a === "--no-build") args.build = false;
    else if (a === "--gitlab-url") args.gitlabUrl = argv[++i];
    else if (a === "--offline") args.offline = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else if (!a.startsWith("-")) positional.push(a);
  }
  // allow `ci-catalog generate <dir>` — dbt-style subcommand is optional
  if (positional[0] === "generate") positional.shift();
  args.project = positional[0] ?? null;
  return args;
}

const USAGE = `Usage: ci-catalog [generate] <projectDir> [options]

Options:
  -o, --out <dir>       output directory (default: pipeline-docs)
  --gitlab-url <url>    GitLab instance for project/component/template
                        includes (default: $CI_SERVER_URL or https://gitlab.com)
  --offline             don't fetch non-local includes over the network
  --build / --no-build  force / skip rebuilding the viewer (default: build
                        only when no prebuilt dist/ ships with the package)

Environment:
  GITLAB_TOKEN          token for private project/component includes
                        (read_api + read_repository scope)`;

function walkYaml(dir) {
  // → Map<posixRelativePath, text>, skipping IGNORE_DIRS
  const files = {};
  const recurse = (cur) => {
    for (const name of readdirSync(cur)) {
      const full = join(cur, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!IGNORE_DIRS.has(name)) recurse(full);
      } else if (name.endsWith(".yml") || name.endsWith(".yaml")) {
        files[relative(dir, full).split(sep).join("/")] = readFileSync(full, "utf8");
      }
    }
  };
  recurse(dir);
  return files;
}

// ---- fetching non-local includes ----

async function gitlabRaw(gitlabUrl, projectPath, file, ref, token) {
  const base = gitlabUrl.replace(/\/+$/, "");
  const proj = encodeURIComponent(projectPath.replace(/^\/+|\/+$/g, ""));
  const url = `${base}/api/v4/projects/${proj}/repository/files/${encodeURIComponent(file)}/raw?ref=${encodeURIComponent(ref)}`;
  const headers = token ? { "PRIVATE-TOKEN": token } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${base}/${projectPath} @ ${ref}: ${file}`);
  return res.text();
}

function sameHost(a, b) {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

async function resolveComponentVersion(gitlabUrl, projectPath, version, token) {
  // `~latest` → the project's latest release tag; anything else is used as a
  // ref directly (tag, branch, sha, or shorthand the instance can resolve).
  if (version !== "~latest") return version;
  const base = gitlabUrl.replace(/\/+$/, "");
  const proj = encodeURIComponent(projectPath.replace(/^\/+|\/+$/g, ""));
  const headers = token ? { "PRIVATE-TOKEN": token } : {};
  const res = await fetch(`${base}/api/v4/projects/${proj}/releases/permalink/latest`, { headers });
  if (!res.ok) throw new Error(`cannot resolve ~latest for ${projectPath} (${res.status})`);
  return (await res.json()).tag_name;
}

/**
 * Fetch one unresolved include (from parser includeKeys()) → YAML text.
 *   project://<project>@<ref>/<file>
 *   template://<name>          — from gitlab-org/gitlab's bundled templates
 *   component://<host>/<project>/<name>@<version>
 *   remote://<url>
 */
async function fetchInclude(inc, { gitlabUrl, token }) {
  if (inc.kind === "remote") {
    const res = await fetch(inc.url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${inc.url}`);
    return res.text();
  }
  if (inc.kind === "project") {
    return gitlabRaw(gitlabUrl, inc.project, inc.file, inc.ref, token);
  }
  if (inc.kind === "template") {
    const url = `https://gitlab.com/gitlab-org/gitlab/-/raw/master/lib/gitlab/ci/templates/${inc.name}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} — template ${inc.name}`);
    return res.text();
  }
  if (inc.kind === "component") {
    // <host>/<project-path>/<component>@<version>
    const m = /^([^/]+)\/(.+)\/([^/@]+)@(.+)$/.exec(inc.address);
    if (!m) throw new Error(`bad component address: ${inc.address}`);
    const [, host, project, component, version] = m;
    const base = `https://${host}`;
    // The host comes from the YAML being cataloged — only send GITLAB_TOKEN
    // to the configured GitLab instance, never to an address the config chose.
    const hostToken = sameHost(base, gitlabUrl) ? token : null;
    const ref = await resolveComponentVersion(base, project, version, hostToken);
    // components live at templates/<name>.yml or templates/<name>/template.yml
    try {
      return await gitlabRaw(base, project, `templates/${component}.yml`, ref, hostToken);
    } catch {
      return gitlabRaw(base, project, `templates/${component}/template.yml`, ref, hostToken);
    }
  }
  throw new Error(`unknown include kind: ${inc.kind}`);
}

function parseAll(files, entrypoints) {
  const results = new Map(); // path → {model} | {error, unresolved}
  const unresolved = new Map(); // key → inc
  for (const path of entrypoints) {
    try {
      const model = parsePipeline(files[path], { files, path });
      results.set(path, { model });
      for (const inc of model.unresolved) unresolved.set(inc.key, inc);
    } catch (e) {
      results.set(path, { error: e.message });
      for (const inc of e.unresolved ?? []) unresolved.set(inc.key, inc);
    }
  }
  return { results, unresolved };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.project) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  const projectDir = args.project;
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    console.error(`Not a directory: ${projectDir}`);
    process.exit(1);
  }

  const files = walkYaml(projectDir);
  const entrypoints = Object.keys(files)
    .filter((p) => !p.includes("/"))
    .sort();

  if (entrypoints.length === 0) {
    console.error(`No root-level *.yml files found in ${projectDir}`);
    process.exit(1);
  }

  const token = process.env.GITLAB_TOKEN || null;
  const fetchFailures = new Map(); // key → error message

  // Parse; fetch whatever was unresolved; repeat until fixpoint (fetched
  // files can themselves include more remote files).
  let { results, unresolved } = parseAll(files, entrypoints);
  for (let round = 0; round < MAX_FETCH_ROUNDS && unresolved.size > 0 && !args.offline; round++) {
    const pending = [...unresolved.values()].filter((inc) => !(inc.key in files) && !fetchFailures.has(inc.key));
    if (pending.length === 0) break;
    await Promise.all(
      pending.map(async (inc) => {
        try {
          files[inc.key] = await fetchInclude(inc, { gitlabUrl: args.gitlabUrl, token });
          console.log(`  ↓ fetched ${inc.describe}`);
        } catch (e) {
          fetchFailures.set(inc.key, e.message);
          console.warn(`  ✗ could not fetch ${inc.describe}: ${e.message}`);
        }
      })
    );
    ({ results, unresolved } = parseAll(files, entrypoints));
  }
  if (args.offline && unresolved.size > 0) {
    console.warn(`  (offline) ${unresolved.size} non-local include(s) left unresolved`);
  }

  const pipelines = [];
  for (const path of entrypoints) {
    const r = results.get(path);
    if (r.error) {
      pipelines.push({ name: path.replace(/\.ya?ml$/, ""), path, error: r.error });
    } else {
      pipelines.push({
        name: path.replace(/\.ya?ml$/, ""),
        path,
        jobCount: r.model.jobs.size,
        stageCount: r.model.stages.length,
        warningCount: r.model.warnings.length,
        model: serializeModel(r.model),
      });
    }
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    project: basename(projectDir.replace(/[/\\]+$/, "")) || "project",
    fileCount: Object.keys(files).length,
    pipelines,
  };

  const dist = join(repoRoot, "dist");
  const shouldBuild = args.build ?? !existsSync(dist);
  if (shouldBuild) {
    console.log("Building viewer (vite build)…");
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  }

  const outDir = args.out;
  mkdirSync(outDir, { recursive: true });
  if (existsSync(dist)) {
    cpSync(dist, outDir, { recursive: true });
  } else {
    console.warn("dist/ not found — wrote manifest.json only. Run `npm run build`, then re-run with --no-build after copying viewer files.");
  }
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const ok = pipelines.filter((p) => !p.error).length;
  const failed = pipelines.length - ok;
  console.log(`\n${manifest.project}: ${ok} pipeline${ok === 1 ? "" : "s"} parsed${failed ? `, ${failed} failed` : ""} (${manifest.fileCount} yml files scanned)`);
  for (const p of pipelines) {
    console.log(
      p.error ? `  ✗ ${p.path} — ${p.error}` : `  ✓ ${p.path.padEnd(28)} ${p.jobCount} jobs · ${p.stageCount} stages${p.warningCount ? ` · ${p.warningCount} notes` : ""}`
    );
  }
  console.log(`\nWrote ${join(outDir, "manifest.json")}`);
  console.log(existsSync(dist) ? `Serve it:  npx serve ${outDir}` : `Manifest only (no viewer copied).`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
