#!/usr/bin/env node
// Pipeline docs generator — dbt-docs-style.
//
//   node bin/generate.mjs <projectDir> [-o outDir] [--no-build]
//
// Walks <projectDir> for **/*.yml, parses every root-level file as a pipeline
// entrypoint (nested dirs like library/ are resolved as includes only), and
// writes a static catalog the viewer can open:
//
//   <outDir>/manifest.json   — parsed pipeline models
//   <outDir>/<viewer files>  — the built viewer (copied from dist/)
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
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { out: "pipeline-docs", build: true, project: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") args.out = argv[++i];
    else if (a === "--no-build") args.build = false;
    else if (a === "-h" || a === "--help") args.help = true;
    else if (!a.startsWith("-")) args.project = a;
  }
  return args;
}

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.project) {
    console.log("Usage: node bin/generate.mjs <projectDir> [-o outDir] [--no-build]");
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

  const pipelines = [];
  for (const path of entrypoints) {
    try {
      const model = parsePipeline(files[path], { files, path });
      pipelines.push({
        name: path.replace(/\.ya?ml$/, ""),
        path,
        jobCount: model.jobs.size,
        stageCount: model.stages.length,
        warningCount: model.warnings.length,
        model: serializeModel(model),
      });
    } catch (e) {
      pipelines.push({ name: path.replace(/\.ya?ml$/, ""), path, error: e.message });
    }
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    project: basename(projectDir.replace(/[/\\]+$/, "")) || "project",
    fileCount: Object.keys(files).length,
    pipelines,
  };

  if (args.build) {
    console.log("Building viewer (vite build)…");
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  }

  const outDir = args.out;
  mkdirSync(outDir, { recursive: true });
  const dist = join(repoRoot, "dist");
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

main();
