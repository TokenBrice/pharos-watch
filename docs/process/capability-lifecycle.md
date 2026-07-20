# Capability Lifecycle Reviews

Capability lifecycle reviews are a lightweight quarterly check that Pharos is still investing in the right product surfaces. The review combines declared product intent with bounded usage, repository footprint, and recent maintenance activity. It does not compute a score or make an automatic recommendation.

## Source Of Truth

[`scripts/maintenance/capability-registry.ts`](../../scripts/maintenance/capability-registry.ts) is the reviewed registry. Keep it small: a capability should represent a product outcome, not an individual route, component, cron job, or API endpoint.

Each entry records:

- purpose and strategic rationale;
- relevant public routes, code paths, analytics events, API route names, and cron job IDs;
- the current lifecycle state, last review date, next review date, and decision rationale.

Mappings are intentionally coarse and may overlap. The report describes evidence associated with a capability; it does not allocate usage, code, or cost exclusively between capabilities.

Lifecycle states are:

- `unreviewed`: no explicit lifecycle decision has been recorded;
- `incubating`: too early to judge, with a dated evaluation point;
- `invest`: evidence or strategy supports meaningful additional work;
- `maintain`: value is established and current cost is proportionate;
- `consolidate`: reduce duplication or absorb the outcome elsewhere;
- `retiring`: an approved retirement is in progress;
- `retired`: the user-facing and supporting runtime footprint is removed or intentionally archived.

## Generate A Review

Run the repository-only report:

```bash
npm run review:capabilities
```

Add the local control-center database for bounded aggregate usage evidence:

```bash
npm run review:capabilities -- \
  --control-center-db /home/ahirice/Documents/local/pharos-control-center/data/control-center.db \
  --write
```

`--write` creates the ignored scratch report `agents/capability-review-YYYY-MM-DD.md`. Use `--as-of` and `--since` for a deterministic review window. The database is opened read-only. The collector reads aggregate tables and extracts only route totals from API JSON; raw API payloads are not loaded into application memory.

Missing, stale, or incompatible control-center evidence is reported as unavailable or partial, never as zero. Git activity and approximate code footprint remain available without the database. These measures are context: traffic does not establish strategic value, code size is not cost, and recent commits do not distinguish planned investment from operational burden.

Missing evidence creates measurement work, not a retirement case. Low traffic alone cannot override a documented core, trust, safety, or public-interest role.

## Review Process

1. Generate a fresh report and select at most three due or attention-worthy capabilities.
2. Read the capability's purpose and strategic rationale before interpreting the evidence.
3. Inspect the mapped product and operational surfaces when the report exposes a material gap or surprising signal.
4. Record one owner-approved state, `reviewedAt`, `reviewAfter`, and a concise rationale in the registry.
5. Commit the registry decision with any follow-up issue, implementation change, or durable documentation it requires.

Review at least quarterly, but change `reviewAfter` to match the decision: shorter for incubation, consolidation, or retirement; longer for stable maintained capabilities. The initial `unreviewed` entries are a real queue, not implied decisions.

Retirement is always a separate implementation and rollout. Before moving to `retiring`, identify user-facing migration or notice needs, data/API consumers, cron and storage cleanup, documentation changes, and the production observation required by the affected subsystem. Worker jobs and D1 data follow the existing coordinated rollout rules. Mark `retired` only after that work is complete.
