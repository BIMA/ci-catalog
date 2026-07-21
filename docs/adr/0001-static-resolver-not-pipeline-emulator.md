# Static resolver, not pipeline emulator

Job rules frequently depend on variables that only exist in GitLab's project/group settings (e.g. `$KUBECONFIG` gating `deploy-to-prod`), which a local parser can never see. Rather than guessing, the tool's default mode is Static Resolution: it expands `include`/`extends`/`!reference` into fully resolved rules and labels each referenced variable with its Variable Provenance (repo-defined, GitLab-predefined, or external-unknown), but never claims a job will or won't run. Rule evaluation exists only as opt-in Simulation under a user-supplied Scenario Profile, always presented as the user's assumptions — a tool that confidently answers "this job runs" and is wrong once loses all trust, which is worse than being modest.

## Considered Options

1. **Full simulation by default** — requires GitLab API access or mandatory variable input; kills the local/offline dbt-style story and still can't see masked values reliably.
2. **Display-only** — never wrong, but abandons the "which event triggers this job" promise entirely.
3. **Hybrid (chosen)** — Static Resolution always; Simulation opt-in via Scenario Profiles.

## Consequences

- Scenario Profiles are YAML files committed in the Template Project (`name`, `description`, `variables:`), so shared scenarios double as onboarding documentation. Local-only or override profiles were deliberately deferred until someone asks.
- The manifest must carry provenance metadata for every variable a Resolved Rule references.
