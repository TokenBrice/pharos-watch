# Stablecoin Dashboard Maintainability Audit

Date: 2026-03-29

Scope: full repository maintainability review across `src/`, `shared/`, `functions/`, `worker/src/`, `scripts/`, `docs/`, `.github/workflows/`, `package.json`, and `worker/package.json`.

Verification performed during this audit:

- `npm run audit:deps` and `cd worker && npm audit --omit=dev --json` returned `0` vulnerabilities.
- `npm outdated --json` reported lag on `eslint`, `lucide-react`, and `typescript`.
- `npm run check:unused-code` passed.
- `npm run check:shared-cycles` passed.
- `npm run check:hotspot-ratchet` passed.
- `npm run test:merge-gate` skipped cleanly because there were no local changes.
- `npm run lint` passed.
- `npm test` passed: `362` files, `3525` tests, `1` todo.
- `npm run build` passed.
- `cd worker && npx tsc --noEmit` passed.

## 1. Executive Summary

### Findings Count

| Area | Total | High | Medium | Low |
| --- | ---: | ---: | ---: | ---: |
| Maintainability | 4 | 0 | 2 | 2 |

### Top Findings

1. `S4` Doc-sync checks still derive truth from regex scraping of source/docs, which is fragile and hard to extend.
2. `S5` Several large operational and methodology modules remain accepted as long-lived hotspot exceptions rather than being actively decomposed.
3. `S6` Canonical origin handling is mostly centralized, but a few runtime and metadata paths still hardcode or re-resolve host URLs independently.
4. `S7` Core tooling packages are behind current majors, which increases the future cost of upgrading the repo’s build and lint toolchain.

### Health Snapshot

| Subarea | Score | Notes |
| --- | ---: | --- |
| Architecture / boundaries | 8/10 | The repo has strong boundary checks and the biggest contract risks are already documented or guarded. |
| Config / env management | 7/10 | Runtime origins are centralized, but a few host-dependent call sites still bypass the shared source. |
| Documentation state | 6/10 | The docs corpus is unusually strong, but doc-sync still relies on brittle parsing heuristics. |
| Build / deploy pipeline | 8/10 | Merge gate, smoke tests, and change-scoped deploy workflows are solid. |
| Dependency health | 7/10 | No vulnerability signal, but toolchain majors are lagging. |
| Scalability / operational posture | 7/10 | Guardrails are strong, yet a few large operational modules remain concentrated hotspots. |
| Overall maintainability | 7/10 | The repo is disciplined and well-guarded, but there are still a few structural debt pockets that will compound if left static. |

Estimated technical debt profile: roughly `8-10%` of the maintainability-relevant runtime / operational surface is affected by significant findings, concentrated in docs tooling, hotspot modules, origin/config helpers, and dependency currency.

### What Is Working Well

- `npm run check:worker-boundary`, `npm run check:shared-cycles`, `npm run check:duplicate-exports`, `npm run check:unused-code`, `npm run check:cron-sync`, `npm run check:doc-counts`, `npm run check:doc-sync`, and `npm run check:hotspot-ratchet` exist and are wired into the repo’s validation story.
- `shared/lib/runtime-origins.ts` provides a canonical host/origin source, which reduces drift compared with ad hoc string literals.
- The docs corpus has a strong index structure and the deploy pipeline already includes merge-gate, SEO, and smoke coverage.
- `npm audit` is clean for production dependencies.

## 2. Findings

### `S4` Medium - Doc-sync still depends on regex-based source scraping

Locations:

- [scripts/lib/doc-sync/shared.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/lib/doc-sync/shared.ts#L35-L38)
- [scripts/lib/doc-sync/shared.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/lib/doc-sync/shared.ts#L64-L78)
- [scripts/lib/doc-sync/shared.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/lib/doc-sync/shared.ts#L86-L127)
- [scripts/lib/doc-sync/shared.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/lib/doc-sync/shared.ts#L150-L159)
- [scripts/lib/doc-sync/checks.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/lib/doc-sync/checks.ts#L25-L30)
- [scripts/lib/doc-sync/checks.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/lib/doc-sync/checks.ts#L33-L95)
- [scripts/lib/doc-sync/checks.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/lib/doc-sync/checks.ts#L97-L180)
- [scripts/lib/doc-sync/checks.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/lib/doc-sync/checks.ts#L182-L279)

Problem:

The doc-sync guardrail is implemented as a set of regex-driven extractors over source and markdown. It is effective today, but it is structurally fragile: reformatting or rewording the source can break the check without any semantic change, while some drift can still sneak through if it does not match the exact scraped pattern.

Why it matters:

This creates a recurring maintenance tax for docs edits and code refactors. The more the repo relies on exact prose and exact syntax shapes, the more doc checks become a source of false positives and silent blind spots.

Remediation:

Move toward exported manifests or structured metadata for the versioned docs surfaces, and keep regex parsing only as a fallback. The current helper layer should shrink over time rather than expanding.

### `S5` Medium - Hotspot management is explicit, but the backlog still concentrates too much logic in a few files

Locations / scope:

- [scripts/lib/hotspot-ratchet-baseline.json](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/lib/hotspot-ratchet-baseline.json#L122-L186)
- [docs/testing.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/testing.md#L126-L126)
- [worker/src/cron/daily-digest.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/daily-digest.ts)
- [worker/src/cron/daily-digest/collectors.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/daily-digest/collectors.ts)
- [worker/src/lib/live-reserves-store.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/live-reserves-store.ts)
- [worker/src/cron/yield-sync/sources.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/sources.ts)
- [src/app/methodology/sections/core-sections.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/methodology/sections/core-sections.tsx#L1-L16)
- [src/app/methodology/sections/monitoring-sections.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/methodology/sections/monitoring-sections.tsx#L1-L16)

Problem:

The repo already treats these files as a decomposition queue, which is better than silent growth. The maintainability issue is that the queue still contains several very large operational modules and large methodology composition surfaces, so change locality remains poor and review cost stays high.

Why it matters:

Concentrated logic slows onboarding, makes changes harder to reason about, and increases the odds that a local fix has surprising effects elsewhere in the same oversized module.

Remediation:

Keep the ratchet, but push it from passive ceiling into active simplification work: add owners, target budgets, and actual split plans for the largest operational modules first, then shrink the methodology composition surfaces further if they remain hot.

### `S6` Low - Canonical origin handling is only partially centralized

Locations:

- [shared/lib/runtime-origins.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/runtime-origins.ts#L1-L55)
- [src/lib/site-config.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/site-config.ts#L1-L1)
- [src/lib/api.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/api.ts#L9-L22)
- [scripts/serve-static-export.mjs](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/serve-static-export.mjs#L55-L74)
- [worker/src/cron/status-self-check.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/status-self-check.ts#L47-L143)
- [worker/src/lib/telegram-webhook-registration.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/telegram-webhook-registration.ts#L1-L27)
- [functions/lib/ops-origin.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/functions/lib/ops-origin.ts#L1-L8)
- [functions/lib/ops-env.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/functions/lib/ops-env.ts#L1-L65)
- [src/lib/page-metadata.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/page-metadata.ts#L117-L123)
- [src/app/depeg/page.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/depeg/page.tsx#L18-L23)
- [src/app/stability-index/page.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/stability-index/page.tsx#L13-L18)
- [src/app/safety-scores/page.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/safety-scores/page.tsx#L18-L23)

Problem:

The repo has a shared runtime-origin source, but several runtime and metadata call sites still re-resolve or hardcode host URLs independently. The most visible examples are the OG image URLs for dynamic pages and a few script/runtime fallbacks.

Why it matters:

Host or deployment topology changes will continue to require multi-file edits, which is exactly the kind of low-grade drift that grows into routine maintenance friction.

Remediation:

Push all host/origin decisions through the shared runtime-origin helpers. Add a small OG-image helper for `api/og/*` URLs and make the static-export smoke server, metadata helpers, and Pages Functions consume the same source of truth.

### `S7` Low - Dependency currency lags the latest majors in the toolchain

Locations:

- [package.json](/Users/ahirice/Documents/git/stablecoin-dashboard/package.json#L83-L92)
- [worker/package.json](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/package.json#L11-L14)

Evidence:

- `npm outdated --json` reported `eslint` `9.39.4 -> 10.1.0`
- `npm outdated --json` reported `lucide-react` `0.577.0 -> 1.7.0`
- `npm outdated --json` reported `typescript` `5.9.3 -> 6.0.2`
- `npm audit --omit=dev` was clean in both the root and worker packages

Problem:

The dependency posture is healthy from a vulnerability standpoint, but the repo is still sitting behind the latest major toolchain releases in a few high-leverage packages.

Why it matters:

Deferring major toolchain upgrades usually feels cheap until multiple major versions accumulate. At that point, the migration cost is higher and upgrade bugs are harder to isolate.

Remediation:

Schedule separate upgrade passes for `typescript`, `eslint`, and `lucide-react`. Keep the runtime surface stable, and validate each upgrade against the existing merge gate rather than batching them with unrelated behavior changes.

## 3. Cross-Cutting Concerns

### `C1` Documentation drift and hotspot concentration reinforce each other

References: `S4`, `S5`

The repo’s documentation checks are already good, but they are still regex-driven while the biggest maintained content surfaces remain oversized. That combination means the same change can affect prose, metadata, and code shape at once.

### `C2` Host/origin drift is spread across runtime, scripts, and page metadata

References: `S6`

Canonical origins are centralized in one place, but the remaining bypasses are distributed across worker fallbacks, smoke tooling, Pages Functions, and page metadata. Any host migration would still be a cross-cutting edit.

### `C3` Toolchain lag is manageable now, but it compounds into maintenance debt

References: `S7`

The repo is safe to ship today, but delaying major upgrades on `typescript`, `eslint`, and `lucide-react` until a larger refactor lands would just move cost into the future.

## 4. Prioritized Remediation Roadmap

### Phase 1 - Quick Wins

| Ref | Action | Files / modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `S7` | Refresh the smallest safe dependency set first; stage the bigger majors separately. | `package.json`, `worker/package.json`, lockfile | Small | None |
| `S6` | Replace the remaining hardcoded OG / host literals with a helper built on the shared origin source. | `src/lib/page-metadata.ts`, `src/app/depeg/page.tsx`, `src/app/stability-index/page.tsx`, `src/app/safety-scores/page.tsx` | Small | None |

### Phase 2 - Targeted Refactoring

| Ref | Action | Files / modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `S4` | Replace regex scraping with exported manifests or structured metadata for versioned docs. | `scripts/lib/doc-sync/*`, `scripts/check-doc-counts.mjs`, docs surfaces | Medium | None |
| `S6` | Standardize runtime origin helpers across scripts, smoke servers, worker utilities, and Pages Functions. | `scripts/serve-static-export.mjs`, `worker/src/cron/status-self-check.ts`, `worker/src/lib/telegram-webhook-registration.ts`, `functions/lib/*` | Medium | `S6` quick-win helper extraction |

### Phase 3 - Structural Improvements

| Ref | Action | Files / modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `S5` | Convert the hotspot list into an explicit simplification program with owners, budgets, and split plans. | `scripts/lib/hotspot-ratchet-baseline.json`, `docs/testing.md`, hotspot files | Large | None |

### Phase 4 - Strategic Overhauls

No maintainability finding in the current tree justifies a full re-architecture beyond the structural work above. If a Phase 4 item is later needed, it should be defined only after the hotspot backlog shrinks and the remaining pain points are measurable.

## 5. Appendices

### File-by-File Finding Index

| File / module | Findings |
| --- | --- |
| `scripts/lib/doc-sync/shared.ts` | `S4` |
| `scripts/lib/doc-sync/checks.ts` | `S4` |
| `scripts/lib/hotspot-ratchet-baseline.json` | `S5` |
| `docs/testing.md` | `S5` |
| `worker/src/cron/daily-digest.ts` | `S5` |
| `worker/src/cron/daily-digest/collectors.ts` | `S5` |
| `worker/src/lib/live-reserves-store.ts` | `S5` |
| `worker/src/cron/yield-sync/sources.ts` | `S5` |
| `src/app/methodology/sections/core-sections.tsx` | `S5` |
| `src/app/methodology/sections/monitoring-sections.tsx` | `S5` |
| `shared/lib/runtime-origins.ts` | `S6` |
| `src/lib/site-config.ts` | `S6` |
| `src/lib/api.ts` | `S6` |
| `scripts/serve-static-export.mjs` | `S6` |
| `worker/src/cron/status-self-check.ts` | `S6` |
| `worker/src/lib/telegram-webhook-registration.ts` | `S6` |
| `functions/lib/ops-origin.ts` | `S6` |
| `functions/lib/ops-env.ts` | `S6` |
| `src/lib/page-metadata.ts` | `S6` |
| `src/app/depeg/page.tsx` | `S6` |
| `src/app/stability-index/page.tsx` | `S6` |
| `src/app/safety-scores/page.tsx` | `S6` |
| `package.json` | `S7` |
| `worker/package.json` | `S7` |

### Dependency Audit Summary

| Package | Current | Wanted | Latest | Scope | Assessment |
| --- | --- | --- | --- | --- | --- |
| Production deps | n/a | n/a | n/a | root / worker | `npm audit --omit=dev` found `0` vulnerabilities |
| `eslint` | `9.39.4` | `9.39.4` | `10.1.0` | root tooling | Major upgrade pending |
| `lucide-react` | `0.577.0` | `0.577.0` | `1.7.0` | frontend UI | Major upgrade pending |
| `typescript` | `5.9.3` | `5.9.3` | `6.0.2` | root + worker tooling | Major compiler upgrade pending |

### Glossary

| Term | Meaning here |
| --- | --- |
| Hotspot | A large or high-change file that is intentionally tracked and should not keep growing without an explicit plan. |
| Drift | Behavior, docs, or configuration diverging across multiple sources of truth. |
| Manifest | Structured metadata exported from code instead of scraped from prose or syntax. |
| Boundary | A module seam that should keep implementation details from leaking into shared types or callers. |

