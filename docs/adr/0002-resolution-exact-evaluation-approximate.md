# Resolution exact, evaluation approximate

Static Resolution output (the resolved YAML the tool states as fact) must match real GitLab semantics exactly — the correctness harness / oracle comparison is the gate, and any divergence is a bug, not a documentable approximation. This includes fixing the current `include` merge behavior (deep-merge everywhere) to match GitLab's main-file-overrides-included-top-level-keys rule. Approximations are only permitted in the Simulation layer, where the tri-state (true/false/unknown) evaluator already labels uncertainty explicitly (e.g. `changes:`/`exists:` always unknown, default-branch treated as {main, master} union).

## Considered Options

1. **Exact parity everywhere** — includes evaluating `changes:`/`exists:` and regex parity; rejected as pipeline-emulator territory (see ADR-0001).
2. **Documented approximations** — rejected: users trust the rendered graph, not a divergence list in the README.
3. **Chosen: exact resolution, approximate evaluation** — everything presented as fact is exact; everything conditional lives behind Simulation's uncertainty labels.

## Consequences

- "Exact" means exact to the latest stable GitLab semantics — not a per-version dialect table. The Manifest records which GitLab version the oracle harness verified against. Version dialects are deferred until a user reports a real divergence on an older instance; drift risk is concentrated in rules evaluation, which is already quarantined as approximate.
- The gate runs offline: the CI suite replays recorded fixtures (synthetic templates, one semantic claim each) rather than hitting a live GitLab lint API, so forks and PRs can run it. A recorder script refreshes fixtures against a real GitLab instance; a scheduled live-drift job can be layered on later.
- Resolution failures ("empty document", "no visible jobs") are values in the resolver's result, not thrown exceptions — empty/include-only files are normal inputs in a Template Project, and the generator's fetch loop consumes `unresolved` from the same result instead of a property smuggled on a thrown Error.
- The merge-semantics fix ships as its own commit on top of a behavior-identical restructure commit, so fixture diffs attribute every output change to the semantic fix alone.
