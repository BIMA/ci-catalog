// Bundled starter pipelines for local development.
// Drop a repo of `.gitlab-ci.yml` templates under `starters/example/` (this
// directory is gitignored). Root-level files are selectable starters; the whole
// tree (library/…) is available to the parser for `include: local:` resolution.
// Dev-only convenience. In a production build `import.meta.env.DEV` is the
// literal `false`, so this branch is dead-code-eliminated and these templates
// are NOT bundled into the shipped viewer (the generate/catalog workflow
// replaces them). Never ship these in dist.
const modules = import.meta.env.DEV
  ? import.meta.glob("../starters/example/**/*.yml", {
      query: "?raw",
      import: "default",
      eager: true,
    })
  : {};

const PREFIX = "../starters/example/";

/** Map of repo-root-relative path → file text, e.g. "library/rules/vcs.yml". */
export const starterFiles = {};
for (const [key, text] of Object.entries(modules)) {
  starterFiles[key.slice(PREFIX.length)] = text;
}
// GitLab local includes resolve against the repo root where the real file is
// named `.gitlab-ci.yml`; the bundled copy is `gitlab-ci.yml` (dotfiles don't
// survive glob imports), so alias it.
if (starterFiles["gitlab-ci.yml"]) {
  starterFiles[".gitlab-ci.yml"] = starterFiles["gitlab-ci.yml"];
}

/** Selectable starters: root-level template files, sorted. */
export const starterNames = Object.keys(starterFiles)
  .filter((p) => !p.includes("/") && !p.startsWith(".") && p !== "gitlab-ci.yml")
  .sort();
if (starterFiles["gitlab-ci.yml"]) starterNames.unshift(".gitlab-ci.yml");
