# CI Catalog — GitLab CI DAG Viewer

A dbt-Catalog-style explorer for GitLab CI/CD pipelines: load a `.gitlab-ci.yml`
and get an interactive dependency graph with per-job metadata, documentation,
and lineage.

> **Unofficial.** Not affiliated with, endorsed by, or sponsored by GitLab Inc.
> "GitLab" is a trademark of GitLab Inc. This project parses the CI/CD YAML
> format for visualization only. Config resolution is a best-effort
> approximation of GitLab's semantics (see [What it understands](#what-it-understands)),
> not a substitute for GitLab's own pipeline evaluation.

**[Live demo »](https://BIMA.github.io/ci-catalog/)** — loads a sample Java +
Kubernetes pipeline; switch ref contexts, click jobs, explore lineage.

Two ways to use it, like dbt:

- **Generate a catalog** from a project of templates, then open the static
  output — the recommended flow for a repo of pipelines (see below).
- **Ad-hoc** — run the dev server and paste/open/fetch a single pipeline.

> Update the demo link above to your Pages URL. To host it: push to GitHub,
> then **Settings → Pages → Source: GitHub Actions**. The included
> [`deploy-pages`](.github/workflows/deploy-pages.yml) workflow builds and
> publishes `dist/` on every push to `main`. With no catalog present the hosted
> build auto-loads the sample pipeline.

## Generate a catalog (dbt-docs style)

Parse a whole project of `.gitlab-ci.yml` templates into a static, shareable
catalog. Every root-level `*.yml` becomes a pipeline entrypoint; nested dirs
(`library/`, `templates/`, …) are resolved as `include: local` only.

```sh
npm install
npm run docs:generate -- /path/to/pipeline-repo    # builds viewer + parses project
npx serve pipeline-docs                             # open the catalog
```

Output in `pipeline-docs/`:

- `manifest.json` — every pipeline pre-parsed (model, stages, jobs, warnings)
- `index.html` + assets — the viewer, which loads `manifest.json` on open

The shipped viewer does **no** YAML parsing — all parsing happens once at
generate time. The build excludes the dev-only starter templates, so the
catalog only contains the project you pointed it at.

Options: `-o <dir>` output directory (default `pipeline-docs`), `--no-build`
reuse an existing `dist/` instead of rebuilding the viewer.

## Ad-hoc (dev server)

```sh
npm install
npm run dev
```

- **Sample pipeline** — built-in realistic example
- **Local templates** — dev-only dropdown of templates dropped under
  `starters/example/` (gitignored); excluded from production builds
- **Paste YAML / Open file** — any `.gitlab-ci.yml`
- **Connect GitLab…** — fetches the CI config and the latest pipeline's job
  statuses from a GitLab instance via the REST API (token optional for public
  projects, needs `read_api` scope, kept in memory only). Job statuses are
  overlaid on the graph and job list.

## What it understands

- `stages` ordering (plus `.pre` / `.post`), jobs grouped into stage lanes
- `needs` — explicit DAG edges, including `optional:` and `needs: []`
  (starts immediately); cross-pipeline/project needs are flagged, not drawn
- Implicit stage-ordering dependencies for jobs without `needs`
  (dashed wires, toggleable in the top bar)
- `extends` chains with GitLab merge semantics (hashes deep-merge, arrays
  replace), YAML anchors and `<<:` merge keys
- `default:` section and legacy top-level defaults (`image`,
  `before_script`, …)
- Hidden `.template` jobs, `parallel` / `parallel:matrix`, `trigger`,
  `when: manual`, `allow_failure`, `rules` / `only` / `except`, artifacts,
  cache, services, environments
- `include: local:` resolved against the bundled starter file set (recursive,
  with include-level `inputs:`); `spec: inputs:` template headers with
  `$[[ inputs.x ]]` interpolation; `!reference [job, key]` tags resolved
  against the merged config. `template:` / `project:` / `remote:` includes are
  flagged as unresolved

## Ref contexts

Tabs above the canvas simulate which jobs run per ref: **All jobs · Merge
request · Default branch · Feature branch · Tag · Schedule**. Job `rules:if`,
`only`/`except` (refs + variables) and `workflow:` are evaluated with
three-valued logic against each context's predefined CI variables. Jobs whose
conditions depend on project variables (or `changes:`/`exists:`) are kept and
drawn dashed with a "conditional" badge. The default-branch context matches
`main` *and* `master` (union), since templates target both.

## Explore

- Click a job (graph or sidebar) → detail drawer: overview, direct +
  transitive lineage (clickable), execution context, scripts, run conditions,
  artifacts, variables, and the fully resolved YAML definition
- Selecting a job highlights lineage directionally — upstream teal, downstream
  indigo, selected red (legend bottom-left); transitive lists expandable in
  the drawer
- `/` focuses the job filter; `Esc` clears selection; drag to pan,
  scroll to zoom, **Fit view** to reset

## Stack

Vite + vanilla JS + `js-yaml`. Custom layered layout (stage columns,
barycenter crossing reduction) and SVG rendering — no graph library.

## License

[MIT](LICENSE) © Bimantara Hanumpraja
