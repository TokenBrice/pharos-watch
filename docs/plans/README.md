# Plans Directory

`docs/plans/` contains planning artifacts, not canonical implementation documentation.

## Intent

- `future/` and active plan files describe proposed work.
- `implemented/` preserves implementation plans and rollout notes as historical snapshots.
- `newID/` contains identifier-migration research and task tracking.

## Important Caveat

Historical plan documents can reference file paths, endpoint names, and constants that were correct at the time of writing but are no longer current.

For current behavior, always treat these as source-of-truth references first:

- `docs/api-reference.md`
- `docs/architecture.md`
- `docs/worker-infrastructure.md`
- `docs/data-flow-map.md`

If a plan and current docs disagree, current docs + code win.
