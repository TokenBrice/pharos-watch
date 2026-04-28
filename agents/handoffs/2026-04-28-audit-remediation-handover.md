# Audit Remediation Implementation Handover

Date: 2026-04-28
Owner: handover-manager, documentation only
Primary plan: `agents/plans/2026-04-28-audit-remediation-implementation-plan.md`
Source audit: `agents/audits/2026-04-28-comprehensive-three-pillar-codebase-audit.md`

This document is the coordination handover for the audit-remediation implementation effort. It does not supersede the implementation plan. Use it to track what each major phase must leave behind before the next phase starts, and append reviewer notes after phase completion.

## Current Objective

Execute the audit-remediation plan in small, reviewable packages that address all 23 primary findings and 5 cross-cutting concerns from the three-pillar audit while preserving deployment safety.

Immediate implementation priority is **Track B / PR 1: harden KYC blacklist reconciliation scripts**. Until B1 lands and is reviewed, do not run the current-balance KYC reconciliation script against remote D1 because the source audit identifies it as the highest-risk destructive operational path.

Assumptions for this handover:

- The implementation plan is the source of truth for package order and validation.
- Production source edits belong to implementation agents, not this handover-manager role.
- Phase completion means findings are fixed, tests/docs are updated where applicable, and validation output is recorded in the PR or task notes.
- The codebase may have concurrent edits; reviewers should preserve unrelated work and append notes instead of rewriting prior phase history.

## Phase Map

| Major phase | Plan tracks / PRs | Primary findings | Purpose |
| --- | --- | --- | --- |
| Phase 0 - Baseline | Baseline validation before remediation | All | Capture starting status before changes and identify pre-existing failures. |
| Phase 1 - Operational safety first | B1 / PR 1 | Q004, R007, C001 | Make destructive KYC reconciliation dry-run-first, validated, timeout-bounded, and helper-backed. |
| Phase 2 - Low-risk quick wins | A1-A6 / PRs 2-4 | Q001, Q007, Q008, Q009, R006, S007, C005 | Fix cache, browser, local storage, shell-ref, policy, and advisory-tracking issues. |
| Phase 3 - Runtime boundary correctness | C1-C2 / PRs 5-6 | Q002, Q003, C002 | Classify fallback errors and validate Cloudflare D1 status payloads at runtime boundaries. |
| Phase 4 - Small source-of-truth cleanups | D1-D4 / PRs 7-9 | R004, R005, R003, R001, C003 | Remove small duplications and stale compatibility after required deployed-state checks. |
| Phase 5 - Validation tooling consolidation | E1 / PR 10 | R002, C005 | Consolidate validation command-running after shell interpolation is removed. |
| Phase 6 - Medium hotspot extractions | F1-F3 / PRs 11-13 | Q005, Q006, S004, C004 | Split medium hotspots with characterization coverage and no behavior changes. |
| Phase 7 - Cron capacity governance | G1 / PR 14 | S005 | Document and enforce headroom policy for near-full cron connection slots. |
| Phase 8 - High-risk runtime hotspot refactors | H1-H2 / PRs 15-20 | S002, S003, C002, C004 | Split depeg detection and stablecoin fallback sync into tested stages/phases. |
| Phase 9 - Stablecoin catalog migration | I1 / PRs 21-25 | S001, C003 | Complete migration to one stablecoin catalog source of truth with guardrails. |
| Phase 10 - Toolchain and dependency policy | J1-J2 / PR 26 and optional follow-ups | S006, S007, C005 | Decide Node baseline and batch routine dependency updates if justified. |

## Required State After Each Major Phase

### Phase 0 - Baseline

Must be true before implementation starts:

- `git status --short` is recorded so reviewers can separate pre-existing edits from remediation work.
- Baseline command results from plan Section 4 are recorded in the PR/task tracker.
- Any pre-existing validation failure is explicitly labeled as pre-existing, with owner or decision to pause.

Expected validation:

```bash
npm run lint
npm run typecheck
cd worker && npx tsc --noEmit
cd ..
npm run typecheck:worker-scripts
npm run check:unused-code
npm run check:shared-cycles
npm run check:worker-boundary
npm run check:hotspot-ratchet
npm run check:cron-sync
npm run check:cron-connections
npm run check:env-contract
npm run check:doc-sync
npm run check:verified-doc-links
npm run check:doc-source-paths
npm audit --json --audit-level=low
npm run audit:deps
```

### Phase 1 - Operational Safety First

Must be true after B1:

- KYC current-balance reconciliation defaults to dry-run and requires explicit `--apply` for remote writes.
- External `kyc.rip` payloads are runtime-validated before destructive SQL is generated.
- Fetch timeout, bounded retry, minimum-row guard, and operator summary are implemented and tested.
- Current-balance replacement cannot delete/replace rows until the accepted payload passes validation.
- D1 helper duplication is removed or an intentional worker-script helper exists with parity.
- Operator docs or `--help` output make dry-run/apply behavior clear.

Validation/commit expectation:

- Run the targeted worker-script tests and `npm run typecheck:worker-scripts`.
- Run `npm run lint`.
- If behavior reaches blacklist methodology surfaces, update methodology/timeline docs in the same PR.
- Commit independently as PR 1 before lower-risk quick wins unless the team explicitly changes sequence.

### Phase 2 - Low-Risk Quick Wins

Must be true after A1-A6:

- Site-data cache writes are best-effort and cannot fail otherwise healthy upstream responses.
- LocalStorage readers reject valid JSON with wrong shapes without throwing through render.
- Download object URLs are revoked asynchronously after click dispatch.
- Git commands use argument arrays, not shell-interpolated refs.
- Bridge validation policy is explicit; stale commented strict code is gone or a tested explicit switch exists.
- Next/PostCSS advisory triage is documented with reachability, current dependency path, and revisit/update decision.

Validation/commit expectation:

- Keep PRs split as planned: browser/runtime quick wins, shell-safety cleanup, then policy/advisory docs.
- Run each package's targeted Vitest files, plus `npm run typecheck` or worker type-check as applicable.
- Run `npm run coverage:critical` for A4 because it changes critical coverage git-ref handling.
- Run `npm run audit:deps` for A6.

### Phase 3 - Runtime Boundary Correctness

Must be true after C1-C2:

- `getPriceCache()` falls back only for known schema-drift/missing-column errors.
- Unexpected D1/network/decode failures are visible instead of silently downgrading metadata.
- Cloudflare REST and GraphQL D1 usage payloads are parsed from `unknown` with explicit guards.
- Malformed or partial D1 status payloads return the existing degraded/unavailable status shape or a typed error consistent with current callers.

Validation/commit expectation:

- Run `db-cache`, `mint-burn-price-heal`, and D1 usage fixture tests.
- Run `cd worker && npx tsc --noEmit`.
- Run `npm run lint`.
- Include operational notes if an unexpected error behavior changes observability.

### Phase 4 - Small Source-of-Truth Cleanups

Must be true after D1-D4:

- Blacklist public API response shape has one shared/public type boundary.
- Stablecoin taxonomy route wrappers preserve metadata and rendered output while removing page-level duplication.
- FX cadence rules are owned by one canonical helper and covered by parity tests.
- Mint/burn legacy sync-key fallback is removed only after production and preview D1 verification confirms migration `0093` and zero legacy keys.
- Applied migrations remain in place as historical records.

Validation/commit expectation:

- Run targeted blacklist, taxonomy, FX, and mint/burn tests for the relevant packages.
- Run frontend and worker type-checks when shared/worker boundaries are touched.
- Record the exact Wrangler verification commands and results for D4 in the PR description.

### Phase 5 - Validation Tooling Consolidation

Must be true after E1:

- Shared validation command runner preserves exit codes, timing/labels, env merge behavior, and CI readability.
- Script-specific policy and flags remain local unless behavior is truly identical.
- Clone detection no longer reports the known validation command-runner duplication.

Validation/commit expectation:

- E1 must happen after A4.
- Run `scripts/__tests__/test-merge-gate.test.ts` and `scripts/__tests__/command-runner.test.ts`.
- Run `npm run lint`.
- Run `npm run test:merge-gate` before pushing because this changes local deploy validation infrastructure.

### Phase 6 - Medium Hotspot Extractions

Must be true after F1-F3:

- DEX discovery provider stages are extracted without changing provider order, thresholds, filters, fallback policy, or result shape.
- Contagion graph responsibilities are split while preserving keyboard behavior, accessibility labels, layout, palette, and interaction semantics.
- Environment contract registry and renderers are split while preserving public exports and byte-for-byte generated output unless a docs correction is intentional.
- Hotspot waivers are reduced or updated only after tests and ratchets pass.

Validation/commit expectation:

- Add or confirm characterization tests before moving code.
- Run each package's targeted tests and `npm run check:hotspot-ratchet`.
- Run `npm run check:env-contract` and `npm run check:doc-sync` for F3.
- Run frontend and worker type-checks according to touched surfaces.

### Phase 7 - Cron Capacity Governance

Must be true after G1:

- `fiveMinuteTelegramAlerts`, `fourHourlyYieldSupplemental`, and `daily0805Utc` are documented as 5/6 connection-budget slots.
- Future fetch-heavy cron work has explicit connection-budget review guidance.
- If checks are changed, current state still passes or warns as designed without hiding full slots.

Validation/commit expectation:

- Run `npm run check:cron-connections`.
- Run `npm run check:cron-sync`.
- Run `npm run check:doc-sync`.
- Run `npm run typecheck` if cron metadata or shared types change.

### Phase 8 - High-Risk Runtime Hotspot Refactors

Must be true after H1-H2:

- Depeg detection has characterization fixtures for representative normal, depeg, recovery, duplicate, and orphan cases before extraction.
- Depeg hydration, decision, persistence, and repair/cleanup responsibilities are separated without threshold or corroboration changes in extraction PRs.
- CoinGecko fallback sync has characterization tests for degraded-mode behavior before extraction.
- Fallback intake, stale-cache restoration, FX hydration, price enrichment, publication, tracked-additions notification, and depeg integration are split into typed phases.
- Any behavior change is separated from extraction and includes methodology/timeline docs.

Validation/commit expectation:

- Split H1 and H2 across multiple PRs as planned.
- Run targeted depeg/frozen-depeg/sync-stablecoins tests, worker type-check, lint, cron connection checks, and hotspot ratchet checks.
- Run `npm run test:merge-gate` for behavior-changing or deploy-impacting final PRs.

### Phase 9 - Stablecoin Catalog Migration

Must be true after I1:

- One editable stablecoin catalog source of truth is chosen and documented.
- Guardrails fail clearly when contributors edit generated/read-only artifacts or create source-shape drift.
- Registry runtime reads the chosen source only, except for deliberate generator/build compatibility.
- Data migration preserves IDs, symbols, contracts, classifications, reserves, and metadata semantically.
- Obsolete category/generated artifacts are removed from runtime imports or clearly marked generated/legacy.
- Contributor docs and task templates point to the final editable format.

Validation/commit expectation:

- Keep the migration split into planning, guardrail, reader, generator, data migration, cleanup, and post-migration PRs.
- Run `npm run check:stablecoin-data`, catalog source tests, `npm run typecheck`, worker type-check, `npm run lint`, `npm test`, and `npm run build` for the data migration PR.
- Do not delete old files until the new reader has been stable for one PR.

### Phase 10 - Toolchain and Dependency Policy

Must be true after J1-J2:

- Node baseline is either aligned to Node 24 LTS or the Node 25 requirement is documented with the concrete reason.
- The Node 24 validation lane remains only if it proves a meaningful compatibility contract.
- Routine dependency updates are batched by cluster and not mixed with TypeScript 6 or ESLint 10 major upgrades.
- Next/PostCSS advisory status is re-checked after any supported Next.js patch.

Validation/commit expectation:

- For J1, run `npm run validate:lts`, lint, type-checks, worker type-check, and `npm test`.
- For dependency clusters, run `npm install`, `npm audit --json --audit-level=low`, `npm run audit:deps`, lint, type-checks, targeted tests, and full test/build for framework/toolchain updates.

## Validation and Commit Expectations

- Every implementation package should be independently mergeable.
- Use the targeted validation listed in the implementation plan for each work package.
- For deploy-impacting diffs, run `npm run test:merge-gate` before push.
- Record skipped validation with a reason and the residual risk.
- Update docs in the same PR when behavior, APIs, pipelines, methodology, environment variables, deployment, or operator workflows change.
- Do not combine high-risk runtime refactors with broad formatting, dependency churn, or unrelated cleanup.
- Keep commit scope aligned to the planned PR breakdown unless reviewers explicitly approve a different split.

## Known Blockers and Risks

- **B1 destructive-write risk:** Current KYC current-balance reconciliation should not be run against remote D1 until dry-run/apply, validation, timeout, retry, and minimum-row guards are merged.
- **D4 deployed-state dependency:** Mint/burn legacy sync-key removal is blocked until production and preview D1 confirm migration `0093` and zero legacy colon-delimited keys.
- **A4 before E1:** Validation runner consolidation should wait until git-ref shell interpolation is removed.
- **Hotspot refactor regression risk:** F1, F2, F3, H1, and H2 need characterization tests before movement and should not include behavior changes in extraction PRs.
- **Methodology documentation risk:** Changes to depeg, fallback sync, pricing/fallback behavior, mint/burn, PSI, PegScore/DEWS, LiquidityScore, Report Cards, blacklist tracker, yield intelligence, or Chain Health must update `/methodology` and the relevant timeline/changelog doc.
- **Catalog migration review load:** I1 is strategic and multi-PR. Reviewers need a clear source-of-truth decision before accepting guardrail or reader changes.
- **Dependency advisory ambiguity:** S007 is an investigation item unless a supported Next.js patch or proven reachability changes the risk.
- **Concurrent work:** The working tree may include unrelated edits. Do not revert or overwrite files outside the active package; append notes here instead of rewriting prior reviewer records.

## Phase Completion Notes

Append notes below this line after each major phase completes. Prefer adding a new dated entry rather than editing prior entries.

### Template

```markdown
### Phase N - <name> completion, YYYY-MM-DD

- Reviewer:
- PRs/commits:
- Findings addressed:
- Validation run:
- Docs updated:
- Deferred items or follow-ups:
- Residual risks:
```

### Phase 0 - Baseline completion

_No notes yet._

### Phase 1 - Operational safety first completion

### Phase 1 - Operational safety first completion, 2026-04-28

- Reviewer: phase reviewer
- PRs/commits: `7fe84bc3a` (`fix: harden kyc blacklist reconciliation scripts`)
- Findings addressed: B1 / Phase 1; Q004, R007, C001
- Validation run: B1 focused Vitest, `npm run typecheck:worker-scripts`, `npm run lint`, `npm run check:doc-sync`, `npm run check:sql-safety`, `npm run check:worker-boundary`, `npm run check:unused-code`
- Docs updated: handover record updated; implementation commit handled B1 scope
- Deferred items or follow-ups: next planned audit-remediation phase may proceed
- Residual risks: no remaining blockers reported after the D1 transaction issue was fixed

### Phase 2 - Low-risk quick wins completion

### Phase 2 - Low-risk quick wins completion, 2026-04-28

- Reviewer: phase reviewer
- PRs/commits: `0b4c667f6` site-data cache writes, `1645d70d5` localStorage shape safety, `07196f258` download URL revocation, `782b1313d` git-ref script hardening, `4d0f09753` mint-burn bridge validation policy cleanup, `7a3fe955d` Next/PostCSS advisory triage
- Findings addressed: A1-A6 / Phase 2; Q001, Q007, Q008, Q009, R006, S007, C005
- Validation run: combined targeted Vitest for 9 files, `npm run typecheck`, `cd worker && npx tsc --noEmit`, `npm run coverage:critical`, `npm run lint`, `npm run audit:deps`; `npm audit --json --audit-level=low` still exits 1 only for the documented 2 moderate Next/PostCSS vulnerabilities
- Docs updated: handover record updated; `7a3fe955d` recorded the Next/PostCSS advisory triage
- Deferred items or follow-ups: continue to the next planned audit-remediation phase
- Residual risks: no blockers reported; the remaining low-level audit exit is the documented Next/PostCSS advisory tracked by A6

### Phase 3 - Runtime boundary correctness completion, 2026-04-28

- Reviewer: phase reviewer
- PRs/commits: `fa7f2d32a` price cache schema fallback classification, `9bf342867` Cloudflare D1 usage payload validation
- Findings addressed: C1-C2 / Phase 3; Q002, Q003, C002
- Validation run: `npx vitest run worker/src/lib/status/__tests__/d1-usage.test.ts`, `cd worker && npx tsc --noEmit`, `npm run lint`
- Docs updated: handover record updated
- Deferred items or follow-ups: ensure new C1/C2 test files were included before commit if not already verified; optional future parser/fallback edge coverage
- Residual risks: no blockers reported; next focus is Phase 4 D1-D4 redundancy cleanup with deployed-state verification before removing compatibility paths

### Phase 4 - Small source-of-truth cleanups completion

_No notes yet._

### Phase 5 - Validation tooling consolidation completion

_No notes yet._

### Phase 6 - Medium hotspot extractions completion

_No notes yet._

### Phase 7 - Cron capacity governance completion

_No notes yet._

### Phase 8 - High-risk runtime hotspot refactors completion

_No notes yet._

### Phase 9 - Stablecoin catalog migration completion

_No notes yet._

### Phase 10 - Toolchain and dependency policy completion

_No notes yet._
