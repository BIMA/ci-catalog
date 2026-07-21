# CI Catalog

A local, offline tool that parses a GitLab CI template project into a manifest and visualizes the pipeline as a DAG with full job context (rules, variables, scripts), for the DevOps engineers who maintain the templates.

## Language

**Template Project**:
A GitLab repository of CI templates maintained by DevOps and consumed by developer repos via `include`.
_Avoid_: pipeline repo, CI repo

**Entrypoint**:
A YAML file parsed as the root of one pipeline DAG. Discovered by convention (root-level files; nested dirs are include-only) unless the Catalog Config overrides.
_Avoid_: root file, main template

**Catalog Config**:
Optional `ci-catalog.yml` at the Template Project root that overrides Entrypoint discovery and declares Scenario Profiles.
_Avoid_: project config, settings file

**Manifest**:
The JSON artifact produced by parsing a Template Project locally — the single source the viewer reads, analogous to dbt's `manifest.json`.
_Avoid_: catalog file, index

**Static Resolution**:
The default mode: expanding `include`, `extends`, and `!reference` into fully resolved job definitions without claiming whether a job will run.
_Avoid_: evaluation, execution

**Resolved Rule**:
A job's rule after Static Resolution — one readable expression in place of a chain of cross-file references.
_Avoid_: computed rule, final rule

**Variable Provenance**:
The classification of every variable a Resolved Rule references: repo-defined (in parsed YAML), GitLab-predefined (e.g. `CI_PIPELINE_SOURCE`), or external-unknown (exists only in GitLab settings).
_Avoid_: variable source, origin

**Scenario Profile**:
A named set of assumed variable values supplied by the user (e.g. `merge_request`, `prod-deploy`) used to run a Simulation.
_Avoid_: env file, variable set

**Simulation**:
Opt-in evaluation of Resolved Rules under a Scenario Profile, always labeled as the user's assumptions — never presented as ground truth.
_Avoid_: prediction, dry run

**Manifest Diff**:
The machine-computed comparison of two Manifests — added/removed jobs, changed edges, changed Resolved Rules — which is what "impact analysis" means in this project.
_Avoid_: impact report, change detection
