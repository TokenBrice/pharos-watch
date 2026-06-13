# Broad Code-Health Review

Repo-wide code-health pass across `pharos-watch`, EXCLUDING the scoring layer (already covered by `agents/scores-compute-code-health.md`).

Created: 2026-06-13

This is a review handoff, not verified product documentation. Durable behavior, methodology, API, or deploy-process changes still belong in `/docs/` and the relevant methodology timeline when implementation actually changes the product contract.

## Scope & Method

- **Coverage:** 26 source domains across `src/` (components, hooks, lib, app routes), `shared/` (lib, types, classification, selector, redemption-backstop-configs, chains), `worker/` (api, cron, lib, handlers, routes), `functions/`, and `scripts/` (ci, maintenance, lib).
- **Pipeline:** each candidate finding went through a find -> adversarial-verify -> cluster pipeline. The verifier re-read each cited file, corrected line refs and counts, recalibrated severity/risk, and rejected or rescoped findings whose evidence did not hold. Verified findings were then clustered into cross-cutting themes and waves.
- **Counts:** 270 raw candidates -> 187 kept after verification. Severity: 180 low, 7 medium. By category: duplication 83, dead-code 23, consistency 21, simplification 15, maintainability 14, readability 11, type-safety 5, test-gap 5, performance 4, restructure 4, naming 2.
- **Scope discipline:** every recommendation below is output-preserving unless explicitly flagged otherwise. Items that change rendered pixels, persisted hashes, parse semantics, or error-propagation behavior carry an explicit caveat and are routed to Wave 4 (needs care / verify).

## Relationship to the Scores-Compute Audit

The scoring layer is owned by `agents/scores-compute-code-health.md` (and its remediation tasklist). Do NOT re-implement its cross-cutting themes here: grade->rank table duplicated on 3 incompatible scales; hand-rolled median/percentile with one upper-middle bug; missing `roundScore()` helper; methodology-version export naming + changelog path drift; duplicated compact-USD formatting and `isRecord`/`stringValue`/`numberValue` guards in the scoring layer; open-coded penalty/blend/band ladders; scattered scoring magic numbers; score-constant test gaps.

The following findings in THIS report overlap that audit. Cross-reference, do not double-implement:

- **`fviz-2` / `vm-1`** (frontend + offline median/percentile) overlap recs #2/#3 and `cross-math-7`. These members are out of that audit's file scope, but the same discipline applies: migrate price-sensitive sites first, leave `status-dashboard-model.percentile` alone.
- **`sel-2` / `sel-7` / `types-5`** (selector `GRADE_RANK` + `BLUECHIP_GRADE_VALUES` + `ReportCardGrade`) overlap the audit's grade->rank consolidation (`cross-math-1`). `selector/ranking.ts` is a NEW instance not catalogued there; coordinate so the shared rank table stays the single source.
- **`f-xcut-1` / `worker-infra-4`** (`isRecord` consolidation) partially overlap the audit's cross-cutting digest note about duplicated guards, but the status/cache/auth/UI sites here are out of its scope.
- **`f-xcut-5`** (inline `Math.max(0,Math.min(100,x))` clamp) overlaps the audit's open-coded-clamp finding for the ~13 score-compute sites; only the ~7 non-score UI/view-model sites are in scope here.
- **`worker-store-5`** (`asRecord`/`recordValue` 3x) partially overlaps the audit's helper-consolidation finding (~line 133); reuse the shared target.
- **`f-xcut-2`** (worker error-message coercion), **`f-xcut-4` / `worker-infra-5`** (number-coercion parsers), **`wapi-3`** (worst-row loop, distinct from scores `ddr-resolver-2`), and **`wapi-7`** (`86400`->`DAY_SECONDS`, mirrors accepted `safety-snapshot-worker-8`) are ingestion/util paths NOT owned by the scores audit — adjacent but separate.

## Executive Summary

- **`isRecord` and friends are redefined ~13+ times** across `src/lib`, `worker/src`, and `shared/lib` while `shared/lib/type-guards.ts` exports the canonical version. Bodies drift in clause order / `Boolean()` wrapping. Highest-reach single consolidation (`f-xcut-1`, `slu-4`, `worker-store-5`, `worker-infra-4`).
- **The error-message coercion idiom** `error instanceof Error ? error.message : String(error)` is hand-inlined **~206 times across ~135 worker files**, with two local wrappers already proving the need (`f-xcut-2`).
- **A cluster of dead/no-op exports is invisible to `check:unused-code`** because barrel star-exports and test imports both count as usage — ~10 genuinely-dead symbols that will otherwise accumulate (`cls-1`, `sel-1`, `sel-10`, `api-2`, `frontend-5`, `f-pharoswatchbot-1`, `vm-5`, `w-dispatch-3`, plus borderline `cls-6`, `api-3`).
- **Genuinely unreachable code and redundant no-op recomputes** sit in worker runtime paths: `assertNoAmbiguousNearbyIncident`, `buildLatestBlacklistRows`, `hasDetectedTelegramEvents`, double-computed `suppressedSafetyChangesAtSeed`, a throwaway `buildDiscrepancy` call (~14 findings).
- **Finite-number / number-coercion guards** (`isFiniteNumber`, `finiteOrNull`, `finiteNumber`, `parsePositiveNumber`) are duplicated in shared scope; one has a real `parseFloat`-vs-`Number()` divergence on the live CEX price-ingestion path (`cls-4`, `cls-5`, `slu-7`, `f-xcut-4`, `worker-infra-5`).
- **Time-unit and basis-point magic numbers** (`86400`, `86_400_000`, `60`, `3600`, `10_000`, INT32 `2147483647`) bypass the shared `time-constants` exports in ~15 sites (`slu-2`, `slu-3`, `slu-11`, `pc-7`, `pc-8`, `wapi-7`, `worker-infra-6`).
- **The smoke-api `REDEMPTION_ENUMS` block has ALREADY DRIFTED** from `shared/types/redemption.ts` (missing `fixed-buffer`) — the only finding with a materialized, not latent, divergence (`scr-4`).
- **A ~1298-line god-file** (`stablecoin-detail-view-model.ts`) bundles a self-contained Mint Authority slice (~178-665) that has sibling split-files establishing the convention (`f-xcut-6`, `vm-11`, `frontend-7`).
- **Cross-file constant lists driven by the same domain set** (backing-diversity types, grade enums, mint-path labels, benchmark orders) are independently restated and can silently drift (`chains-7`, `vm-4`, `sel-2`, `types-5`).


## Top Recommendations

| Rank | Recommendation | Area | Category | Effort | Risk | Why |
| --- | --- | --- | --- | --- | --- |
| 1 | Consolidate the ~13+ private `isRecord`/`asRecord`/`isPlainObject`/`UnknownRecord` copies onto canonical `@shared/lib/type-guards` `isRecord` (exclude `scripts/*` and the deliberate provider-dir barrel). | shared/lib, src/lib, worker/src | duplication | small | low | Highest reach (13+ files across all three runtime boundaries), body-equivalent so behavior-preserving, worker already imports `@shared/lib` widely. The clause-order/`Boolean()` drift is exactly the hazard a single source removes. |
| 2 | Delete the cluster of dead/no-op exports that `check:unused-code` structurally cannot see: `GOVERNANCE_TIER_COLORS`, `redistributeWeights`, `sha256Hex` selector re-export, `DEFAULT_SITE/OPS_UI_ORIGIN`, `TIER_BORDER`, the pharoswatchbot aliases, `const sections = baseSections`, `MAX_MESSAGES_PER_RUN`. | shared/lib, functions/lib, src/app | dead-code | trivial | none | Pure subtractive deletions, zero behavior change, high confidence; CI is blind to all of them so they accumulate. Best leverage-per-effort in the set. |
| 3 | Extract one `toErrorMessage(error)` helper for the `error instanceof Error ? .message : String(error)` idiom inlined ~206 times across ~135 worker files, folding in the two existing local wrappers; migrate incrementally. | worker/src | duplication | medium | low | By far the widest single duplication in the codebase; two wrappers already prove the need; identical output, so the only cost is the mechanical migration (batchable). |
| 4 | Consolidate the trivial `sleep(ms)` promise-setTimeout helper: export a plain `sleep` from `worker/src/lib/abort.ts` (import direction avoids the cron-logger->cron-lease cycle) and from `smoke-runtime.mjs` for the four maintenance scripts; leave abort-aware variants alone. | worker/src/lib, scripts/maintenance | duplication | trivial | low | Multiple verified byte-identical copies; function is hoisted so no reordering risk; the correct import direction (flagged to avoid a cycle) makes it a clean win. |
| 5 | Reconcile the smoke-api `REDEMPTION_ENUMS` drift now (already missing `fixed-buffer` vs `shared/types/redemption.ts`) and add a generated `check:redemption-enums` guard — without importing the Zod `.ts`, since smoke-api runs under plain `node`. | scripts/maintenance, shared/types | test-gap | medium | medium | The one finding with an ALREADY-MATERIALIZED divergence: the smoke gate is silently stale, so a redemption-API contract change can pass it. The naive Zod-import fix is infeasible. |
| 6 | Consolidate the shared `isFiniteNumber`/`finiteOrNull`/`finiteNumber` finite-number guards by adding an exported `isFiniteNumber` predicate to `type-guards.ts` and routing the value-returning copies to `numberValue`; scope strictly to `shared/lib`. | shared/lib | duplication | small | low | Several byte-identical copies in shared scope; the predicate does not yet exist there (`numberValue` is a different shape), so this also fixes the false assumption that one exists. |
| 7 | Replace bare time-unit and INT32/`86400`/`3600` magic numbers with the shared `time-constants` exports (`DAY_SECONDS`, `DAY_MS`, `SECONDS_PER_MINUTE`, `HOUR_SECONDS`) across relative-time, format, og.tsx, fetch-tbill-rate; per-file named consts for the rest. | shared/lib, src/app, worker/src | consistency | small | low | Many trivial value-identical drop-ins into constants that already exist and are partially imported; broad readability payoff, effectively zero risk. Only `BPS_PER_UNIT` needs a thoughtful neutral home. |
| 8 | Remove genuinely unreachable code and redundant no-op recomputes in worker runtime paths: `assertNoAmbiguousNearbyIncident`, `buildLatestBlacklistRows`, `hasDetectedTelegramEvents`, double-computed `suppressedSafetyChangesAtSeed`, the throwaway `buildDiscrepancy` call, the snapshot-chain-supply dead inner guard. | worker/src | dead-code | small | low | Each is verified unreachable/redundant with the corrected single-source-of-truth identified; deleting removes code implying live paths/contracts that do not exist. |
| 9 | Migrate the four single-task slot-group handlers to `runSingleScheduledJob` and apply adjacent cron cleanups (`cacheKeySegment` export, mint-burn `onSettledSuccess` wrapper, `CronResult` casts) — but do NOT migrate the error-propagating pattern-(c) handlers without confirming intent. | worker/src/handlers/scheduled, worker/src/lib | duplication | small | low | Tightens a real inconsistency (3 dispatch patterns) onto the existing helper with preserved best-effort semantics; the flag on pattern (c) prevents a silent fail-vs-swallow regression. |
| 10 | Make shared types derive from existing Zod schemas / canonical enums instead of restating literals: export `StatusHealthValue`, `BLUECHIP_GRADE_VALUES`, infer `StressSignalDetailResponse`, tighten `CronRun.status` to a closed union. | shared/types, worker/src | type-safety | small | low | Type-only changes that add compile-time exhaustiveness (future enum additions fail the build instead of yielding silent `undefined`); Zod schemas stay the runtime authority — no wire/behavior change. |

## Prioritized Implementation Waves

Status legend: `[ ]` not started · `[x]` done · `[G]` guarded (needs before/after parity or owner sign-off).

### Wave 1 — Safe Foundations & Dead Code

| Theme | Members | Combined action | Effort | Risk |
| --- | --- | --- | --- | --- |
| `[x]` Trivial `sleep(ms)` helper consolidation | `f-xcut-8`, `w-cron-2`, `scr-8`, `scr-1` | Export plain `sleep` from `worker/src/lib/abort.ts`; import in cron-lease + cron-logger (source from abort.ts, NOT cron-logger — would cycle). Leave `sleepWithSignal` / `sleepWithAbort`. In scripts, import `sleep` from `smoke-runtime.mjs` in run-pages-smoke, wait-pages-release-marker, rollback-pages-deployment, smoke-ui. | trivial | low |
| `[x]` Time-unit & basis-point magic numbers | `slu-2`, `slu-3`, `slu-11`, `pc-7`, `pc-8`, `wapi-7`, `worker-infra-6` | Shared `time-constants` drop-ins (relative-time, format, og.tsx 86400->DAY_SECONDS, fetch-tbill-rate 86_400_000->DAY_MS). Per-file consts for cache-age 1200 and INT32 2147483647. `BPS_PER_UNIT` in a neutral math-constants module (NOT format.ts), skip the dollar literal at redemption-backstop-cost.ts:46. | small | low |
| `[x]` Dead exports masked from check:unused-code | `cls-1`, `sel-1`, `sel-10`, `api-2`, `frontend-5`, `f-pharoswatchbot-1`, `vm-5`, `w-dispatch-3`, `cls-6`, `api-3` | Delete the genuinely-dead exports/aliases; regenerate agent-code-map after site-data-origin. Borderline (flag, don't blind-delete): classification-pegs.ts facade and getStrictContractPaths (in-file constant dedup only — allowlisted + mocked). | trivial | none |
| `[x]` Unreachable code & no-op recomputes (worker) | `worker-store-1`, `worker-6`, `pc-4`, `pc-9`, `w-dispatch-2`, `wrouter-3`, `wrouter-4`, `w-cron-3`, `worker-11`, `w-dispatch-1`, `w-status-1`, `w-status-3`, `ci-2`, `ci-3` | Delete unreachable functions + redundant recomputes; `parseBoeSoniaCsv` is flag-don't-delete (comment + owner confirm). | small | low |
| `[x]` Repeated single-array scans collapse to one pass | `w-status-2`, `wapi-2`, `chains-8`, `worker-8`, `chains-4`, `sel-5`, `sel-6`, `f-hooks-4`, `f-hooks-6`, `f-hooks-7`, `scr-10`, `scr-5` | Cache `ADMIN_PROBE_PATHS.includes`, hoist `Math.floor(Date.now()/1000)`, single-pass aggregator/buildSymbolLookups, `continue`->`break`, inline Set literals, single lazy useState, drop redundant `enabled:true`, hoist helpers. | small | none |
| `[x]` Cross-boundary type re-derivations & import nits | `sd-4`, `types-3`, `vm-9`, `slu-2` | Export `HeroSectionBaseProps` (intersect `reportCard` back), import `DdrAssessmentCheckpoint` from `@shared/types/depeg-resolver`, merge split type-import lines in compare-derive.ts. | trivial | none |

**Wave 1 status — SHIPPED 2026-06-13** (6 commits `466d8e2d5`..`8e8efe0bb` on `main`, by 9 parallel Opus agents re-partitioned by disjoint file sets). Verified green: root + worker `typecheck`, `eslint` (changed files), `check:shared-cycles`, `check:duplicate-exports`, `check:shared-types-imports`, `check:worker-boundary`, `check:cron-abort-contract`, `check:sql-safety`, `check:unused-code`, and 745 targeted tests.

- **Held / changed during execution:**
  - `pc-9` — HELD per flag-don't-delete: `parseBoeSoniaCsv` kept, added a "spot-SONIA fallback, not wired in" comment for owner decision.
  - `f-hooks-6` — REVERTED: dropping `enabled: true` broke `query-polling-policy.test.ts:327` (test pins the explicit value as a contract); kept `enabled: true`.
  - `slu-11` — the `redemption-backstop-cost.ts` BPS site was **deferred** (file under concurrent edit by another session); the other 4 BPS sites done. `BPS_PER_UNIT` placed in `shared/lib/math.ts`.
  - `worker-infra-6` — `D1_INT32_MAX` placed in a **new leaf module `worker/src/lib/d1-constants.ts`** instead of `api-key-core.ts`, which would have closed an `api-key-core → api-utils → api-cache-read` import cycle (caught by `check:shared-cycles`).
  - `cls-6` / `api-3` (borderline) — both done safely: `cls-6` stub deleted + test repointed; `api-3` in-file dedup only (kept the allowlisted/mocked `getStrictContractPaths`).
- **Pre-push follow-up:** regenerate `docs/agent-code-map.md` (`node scripts/maintenance/generate-agent-code-map.mjs`) — it still lists removed symbols (api-2 site-data-origin, cls-6 classification-pegs). Deferred to avoid sweeping concurrent WIP into the diff; run when the tree is quiescent, before `npm run test:merge-gate`.

### Wave 2 — Localized Refactors

| Theme | Members | Combined action | Effort | Risk |
| --- | --- | --- | --- | --- |
| `[ ]` `isRecord` guard consolidation | `f-xcut-1`, `slu-4`, `worker-store-5`, `worker-infra-4` | Delete local copies; import canonical `isRecord` from `@shared/lib/type-guards`. Swap selector `isPlainObject` (20 sites), publication-store `recordValue`. Keep address-price-providers barrel. EXCLUDE `scripts/*` and divergent `UnknownRecord` aliases. | small | low |
| `[ ]` Finite-number guard consolidation (shared) | `cls-4`, `cls-5`, `slu-7` | Add + export `isFiniteNumber` predicate to `type-guards.ts` (does not exist there today). Swap byte-identical copies in format.ts + selector/snapshot.ts; route royco `finiteNumber` / yield-scoring `finiteOrNull` to existing `numberValue`. Shared-only scope. | small | low |
| `[ ]` Worker error-message coercion helper | `f-xcut-2` | Add `toErrorMessage(error)` to a worker lib util; fold redstone `errorMessage` + pricing-provider-diagnostics `errorMessageFor`; migrate the ~206 inline ternaries in batches. NOT in shared/lib. | medium | low |
| `[x]` Inline clamp -> shared clampScore (non-score UI) | `f-xcut-5` | Done 2026-06-13: replaced the non-score UI/view-model clamp sites with `clampScore` from `@shared/lib/math`, including the extra `telegram-pulse-strip.tsx` site found during implementation. Score-compute and worker runtime clamps stayed out of scope. | small | none |
| `[x]` Cross-component JSX/markup extraction | `sd-5`, `fe-4`, `fe-11`, `sd-2`, `sd-11`, `sd-1`, `sd-6` | `ScoringBreakdownDisclosure`, `RiskSourceLinks`, `AmountBadges`, `deriveContractInfo` (plain fn, not a hook), `AttestorTierBadge`, `shouldShowVerdict`. SCOPE DOWN sd-11 to ~4-5 cls-driven Link badges only (static-color spans must NOT be unified). | small | low |
| `[ ]` RSS/route/event-handler boilerplate | `f-feed-1`, `fe-1`, `frontend-2`, `frontend-3`, `frontend-1` | `rssResponse(feed)`, `useSortColumnEvent(resolvedColumns, toggleSort)`, `formatEpochSecondsLocale`, hoist page-metadata derivations, export `normalizeWhitespace` ONLY (summarizeText diverges via stripTermMarkup). | small | low |
| `[ ]` Telegram command/callback boilerplate | `tw-1`, `tw-2`, `tw-3`, `tw-5`, `w-dispatch-4`, `w-cron-5` | Delete passthrough wrappers (replyToChat, isGroupChat), `replyWithOptionalMiniApp(ctx, msg, markup)` (accept markup), route quicksub console.error to logTelegramEvent, `runTelegramReconciliation` extractor. LEAVE the 3 cron progress wrappers (w-dispatch-4). | small | low |
| `[ ]` Scheduled-handler dispatch consolidation | `w-cron-4`, `w-cron-1`, `w-cron-7`, `w-cron-9`, `w-cron-10`, `wrouter-1` | Migrate 4 single-task handlers to `runSingleScheduledJob`; export `cacheKeySegment` from cron-lease; drop mint-burn wrapper; CronResult casts; migrate 2 admin routes (accept route-* label change). DO NOT auto-migrate pattern-(c) error-propagating handlers. | small | low |
| `[ ]` Shared types derive from Zod schemas / enums | `types-1`, `types-5`, `types-6`, `types-2`, `types-3`, `types-4`, `types-7`, `fe-6`, `chains-9` | Export `StatusHealthValue`, `BLUECHIP_GRADE_VALUES`, `ChainMeta`; infer `StressSignalDetailResponse` + `ParsedTelegramDispatchEventsDetected`; tighten `CronRun.status`; import confidence unions. Leave `TelegramDispatchCronMetadata` explicit; DeadStablecoin.contracts left out. | small | low |
| `[ ]` Single-source cross-file constant lists | `chains-7`, `vm-4`, `rbc-10`, `pc-2`, `wapi-6`, `worker-store-7`, `types-8` | Real fix: export `ACTIVE_BACKING_DIVERSITY_TYPES`, build aggregator `backingTotals` from it. Rest comment-only cross-refs. DeadStablecoin.contracts skipped. | trivial | low |
| `[ ]` Pure helpers out of component/client files | `fe-10`, `f-compare-2`, `f-stablecoin-detail-2`, `sd-1` | Move `gradeBandLabel`, `buildCompareSelectionInsights`, `buildYieldStoryCallouts` to lib; inline the `const s` alias. Single-consumer moves — pursue when the file is otherwise touched. | trivial | none |
| `[ ]` Targeted test-gap fills | `frontend-11`, `cls-8`, `worker-store-9`, `wapi-12`, `w-recap-2`, `wrouter-5`, `scr-4` | changelog completeness test, getDewsRiskLevel WATCH->calm pin, gates preview-branch test, handler-aggregation + repair-auth-expired gaps, leaderboard tiebreak test. scr-4 highest priority (drift + generated check). | small | low |

### Wave 3 — Structural / Decomposition

| Theme | Members | Combined action | Effort | Risk |
| --- | --- | --- | --- | --- |
| `[ ]` CI/maintenance script walker + helper consolidation | `ci-1`, `ci-8`, `ci-7`, `ci-5`, `ci-4`, `scr-2`, `scr-3`, `scr-6`, `scr-7`, `scr-9`, `ci-9` | Migrate ONLY the plain source-file walkers to `collectSourceFiles` (pass each script's `excludedDirs`); EXCLUDE the symlink + async walkers. `fetchWithRetry`, `normalizeRoute` (smoke only, not lighthouse), import shared isRecord/parsePositiveInt, `writeOutputFile`. Add argv[1] guard (ci-4). DO NOT do a repo-wide entrypoint-idiom rename (ci-7). | medium | low |
| `[ ]` Redemption-backstop config date + boilerplate | `rbc-1`, `rbc-2`, `rbc-3`, `rbc-4`, `rbc-7`, `rbc-6`, `rbc-5` | `review-dates.ts` shared dates; base fragments via `cloneRedemptionBackstopConfig` (clones MUST stay independent — registry mutates in place). Leave mre7yield/inalpha-nest inline. Narrow rbc-7 to 3 sites. rbc-5 notes diverge — leave inline. Offline only, no score impact. | medium | low |
| `[G]` God-file decomposition (Mint Authority VM) | `f-xcut-6`, `vm-11`, `frontend-7` | Move MA types + builders (~178-665) + `shortenAddress` into `stablecoin-detail-mint-authority-view-model.ts`. CRITICAL: move `labelFromMap` to a shared spot (do NOT orphan/duplicate). Pure code-motion; defer unless the file is actively worked. | medium | low |

### Wave 4 — Needs Care / Verify (not clean no-ops)

| Theme | Members | Combined action | Effort | Risk |
| --- | --- | --- | --- | --- |
| `[x]` Number-coercion parsers onto number-utils.ts | `f-xcut-4`, `worker-infra-5` | Consolidated strict `Number()`-based `parsePositiveNumber` into `worker/src/lib/number-utils.ts`; address-price provider shared utils re-export it. Lenient `parseFloat` paths left untouched. Guarded by `number-utils`, address-provider, Moralis, and CEX tests. | small | medium |
| `[x]` Hand-rolled median/percentile (frontend + offline) | `fviz-2`, `vm-1` | Radar and yield view-model now use shared `median`; contagion/yield scatter use `percentileLinear` without the dead manual branches. Empty-median fallback remains `0` where the UI contract requires a number. | small | medium |
| `[x]` GRADE_RANK / BLUECHIP_GRADE_VALUES tables | `sel-2`, `sel-7`, `types-5` | Selector ranking now delegates to shared report-card rank; selector snapshot derives bluechip grades from `BluechipGradeSchema.options` and pins the `NR` safety-grade exception in tests. | small | low |
| `[x]` Local stableJsonStringify (hash-input boundary) | `worker-store-2` | Store path verified on `stableJsonStringifyV1`; ddrv2-store tests snapshot the persisted source fingerprint and incident key for the current payload. | small | medium |
| `[x]` Inline ternary/value duplication (worker + components) | `wapi-1`, `tw-7`, `wapi-10`, `f-stablecoin-detail-1`, `w-recap-1`, `w-cron-6`, `w-cron-8`, `worker-store-6`, `worker-infra-2`, `worker-infra-3`, `worker-infra-7`, `worker-infra-9`, `fe-5`, `fe-7` | Hoisted the safe confidence-tier/variant/count/config-key/API-key/filter helpers; imported existing `DEWS_BAND_RANK`; preserved the blacklist `toLowerCase` behavior. Verified existing frontend row cleanup before leaving it unchanged. | medium | medium |
| `[x]` Chart-component consistency | `fviz-4`, `fviz-3`, `fviz-5`, `fviz-6`, `fviz-1`, `f-pharoswatchbot-2`, `f-pharoswatchbot-4`, `sd-7` | Chart gradient IDs now use sanitized `useId`; comparison chart uses `externalRange`; shared reduced-motion hook keeps live `change` subscription and both component copies are removed. Optional ResponsiveContainer migration remains out of scope. | medium | medium |
| `[x]` Divergent-hue design flags (owner sign-off) | `cls-9`, `cls-10` | Accepted in Wave 4: VAR chart hue aligned to sky and centralized governance table color aligned to the badge yellow. | trivial | medium |
| `[x]` Sentinel/SQL-param readability (scoped) | `tw-10`, `worker-store-6`, `f-pharoswatchbot-3`, `rbc-12`, `f-pharoswatchbot-1` | Scoped safe item done: `loadFirstPublicationMembership` now uses `filterSql`. GATED_SENTINEL and optional CSS/comment cleanups remain intentionally deferred outside Wave 4's verified code paths. | small | low |
| `[x]` Design-consistency flags (left-stripe) | `sd-7` | MobileRiskSnapshot retired left-stripe removed after design-language cross-check; card keeps the existing responsive visibility and content structure. | trivial | low |

**Wave 4 status — SHIPPED 2026-06-13**. Verified green: focused Vitest suite (14 files / 198 tests), root `typecheck`, worker `typecheck`, and `lint`. Full `test:merge-gate` is deferred until the concurrent Wave 1/2/3 worktree is quiescent because `main` is already ahead of `origin/main` and unrelated files remain dirty.


## Findings by Domain — Full Detail

All 187 kept findings, grouped by domain prefix. Each block lists `[category | severity | effort | risk]`, the verified Problem, the Recommendation, Files, and the verifier's note + checks where present.

### Chart & Visualization (`fviz-*`)

**`fviz-1` — usePrefersReducedMotion duplicated in flow-chart and mobile-utility-dock instead of the shared hook** `[duplication | low | trivial | low]`
- Problem: flow-chart.tsx (66-82) and mobile-utility-dock.tsx (13-27) each define a private `usePrefersReducedMotion`. The canonical hook at `src/hooks/use-prefers-reduced-motion.ts` is NOT a drop-in equivalent: the two local copies add a `change` event listener (useEffect) so they react live to OS setting changes, while the shared hook is lazy-init-only. Swapping loses live reactivity — not the pure no-op the candidate implied. mobile-utility-dock also calls `window.matchMedia` without optional chaining.
- Recommendation: legitimate dedup but NOT behavior-preserving as written. Either (a) extend the shared hook to optionally subscribe to `change`, or (b) accept the loss of live reactivity and import as-is. Decide explicitly. `flow-chart`'s `useMotionDurationMs` is genuinely single-use — leave inline.
- Files: `src/components/flow-chart.tsx:66-82`, `src/components/mobile-utility-dock.tsx:13-27`, `src/hooks/use-prefers-reduced-motion.ts:16-21`.
- Verifier: confirmed 3 implementations; corrected line refs; demoted medium->low because the swap is not the clean no-op claimed. Checks: `npm run typecheck`, `npm run lint`.

**`fviz-2` — computeMedian defined twice in frontend slice while shared/lib/stats.ts exports median()** `[duplication | low | small | medium]`
- Problem: radar-chart.tsx (24-29) and yield-view-model.ts (885-890) each define a private `computeMedian`. Empty-case semantics differ and matter: radar returns null on empty (cohort bails if null); yield-view-model returns 0 on empty, typed `number` (`medianApy: 0` is a displayed value). Shared `median()` returns `number | null`, so the yield-view-model swap requires `?? 0` or the consumer breaks.
- Recommendation: radar -> `import { median }` (null contract matches). yield-view-model -> `median(apys) ?? 0`. Same migration the scores audit (recs #2/#3) governs — these two are display-only and out of its file list but pin behavior with the existing stats tests. Candidate's claim that median is "already imported in yield-scatter/contagion-layout" is FALSE (those import `percentileLinear`).
- Files: `src/components/radar-chart.tsx:24-29`, `src/lib/yield-view-model.ts:885-890`, `shared/lib/stats.ts:18-24`.
- Verifier: both copies confirmed; raised risk low->medium (typed `number` + display). Already covered: scores audit recs #2/#3 (cautious, no-bulk-migrate). Checks: `npm run typecheck`, `npm run test`.

**`fviz-3` — Static SVG linearGradient IDs risk ID collisions** `[maintainability | low | trivial | low]`
- Problem: four chart components use hard-coded SVG gradient IDs (`mcapGradient`, `destroyedGradient`, `dewsGrad`, `psiScoreGradient`). Collision risk is largely theoretical — each renders as a single instance per page. Candidate overstated the SSR-flush/hydration corruption scenario.
- Recommendation: low-priority hardening. If done, follow ACTUAL prior art: peg-gauge.tsx and row-sparkline.tsx use `useId()` and SANITIZE it (`gauge-${rawId.replace(/:/g,'')}`) because React's `useId` returns colon-containing strings invalid in SVG `url(#…)`. The candidate's bare-`useId()` prescription is WRONG. Skip dews-detail/cemetery unless touched anyway.
- Files: `src/components/mcap-chart.tsx:217`, `src/components/cemetery-charts.tsx:468`, `src/components/dews-detail.tsx:324`, `src/components/psi-history-chart.tsx:144`.
- Verifier: all 4 static IDs confirmed; corrected the recommendation to sanitized useId. Checks: `npm run typecheck`.

**`fviz-4` — CHART_HEIGHT re-declared or hard-coded across chart files** `[consistency | low | trivial | none]`
- Problem: chart-colors.ts exports `CHART_HEIGHT = 'h-[250px] sm:h-[350px]'`. mcap-chart hardcodes the literal twice (186, 267); cemetery-charts (41) and peg-deviation-chart (270) re-declare local consts; psi-history-chart (104) hardcodes it conditionally. flow-chart already imports the shared constant. psi-history-chart's non-header branch uses a DIFFERENT value (`h-[250px] sm:h-[336px]`).
- Done 2026-06-13: imported `CHART_HEIGHT` in mcap-chart, cemetery-charts, and peg-deviation-chart for the exact `h-[250px] sm:h-[350px]` sites. Left psi-history-chart's deliberate `sm:h-[336px]` branch untouched.
- Files: `src/components/mcap-chart.tsx:186,267`, `src/components/cemetery-charts.tsx:41`, `src/components/psi-history-chart.tsx:104`, `src/components/peg-deviation-chart.tsx:270`, `src/lib/chart-colors.ts:43`.
- Verifier: corrected scope; severity/effort/risk confirmed. Checks: `npm run typecheck`, `npm run lint`.

**`fviz-5` — comparison-chart manually re-implements range sync that useTimeRangeFilter's externalRange provides** `[simplification | low | small | low]`
- Problem: ComparisonChart keeps `localRange` + a useEffect that writes the external `range` prop into local state, plus `activeRange = range ?? localRange`. `useTimeRangeFilter` supports `config.externalRange` (29, 42-43). ComparisonChart IS used in controlled mode at compare/client.tsx:506-507 — live dual-write path.
- Recommendation: pass `{ externalRange: range }` (4th arg), remove the useEffect sync (61-65), drop `activeRange`, keep `handleRangeChange` calling `onRangeChange`. When `range` is undefined, externalRange is undefined and the hook falls back to internal state — semantics preserved.
- Files: `src/components/comparison-chart.tsx:48-65`, `src/hooks/use-time-range-filter.ts:29-43`.
- Verifier: externalRange + live controlled caller confirmed; demoted medium->low (taste, no observed bug). Checks: `npm run typecheck`, `npm run test`, `npm run lint`.

**`fviz-6` — cemetery-charts, comparison-chart, flow-comparison-chart still use ResponsiveContainer vs useChartContainerReady** `[consistency | low | medium | medium]`
- Problem: three files use Recharts ResponsiveContainer (cemetery 4, comparison 1, flow-comparison 1 = 6 total, not 7) while 15 components use the explicit `useChartContainerReady` hook. Real stylistic inconsistency, but ResponsiveContainer is fully supported — no bug. Migrating risks layout regressions (cemetery's donut/pie use percent-based sizing).
- Recommendation: optional consistency cleanup, not a defect. Migrate one file at a time and visually verify each (especially `CauseOfDeathDonutChart`). Do NOT batch all 6. Reasonable to leave as-is given the risk/effort ratio.
- Files: `src/components/cemetery-charts.tsx:92,236,324,465`, `src/components/comparison-chart.tsx:166`, `src/components/flow-comparison-chart.tsx:90`.
- Verifier: confirmed 6 usages (candidate said 7); raised risk low->medium. Checks: `npm run typecheck`, `npm run test:smoke-ui`.

### Stablecoin Detail (`sd-*`)

**`sd-1` — IIFE for PoR attestor-tier badge in key-info-card** `[readability | low | small | none]`
- Status: Closed 2026-06-13. Extracted `AttestorTierBadge({ proofOfReserves })` with the same pill class, pill text, Popover details, and fallback span behavior.
- Problem: the PoR attestor-tier pill is built with a raw IIFE inside JSX (207-248) deriving `tierStyle`, `pillClass`, `pillText`, a `details[]` array, then branching between a plain `<span>` and a Popover. Densest block in the file, nested ~5 conditionals deep, cannot be named or unit-tested.
- Recommendation: extract a named local `AttestorTierBadge({ proofOfReserves })`. Reproduce `pillClass`/`pillText` verbatim; keep `POR_TIER_STYLES` imported from `@shared/lib/classification` (hard rule). Pure JSX refactor.
- Files: `src/components/key-info-card.tsx:206-248`.
- Verifier: verified IIFE; demoted medium->low. Checks: `npm run check:lint`, `npm run check:types`.

**`sd-2` — Duplicate chain-meta lookup and copy-icon markup in ContractDetailRow vs ContractLabeledRow** `[duplication | low | small | low]`
- Status: Closed 2026-06-13. Added a plain `deriveContractInfo(contract)` helper for chain metadata, chain display name, and explorer URL derivation while leaving the intentionally different button shells inline.
- Problem: `ContractDetailRow` (521-527) and `ContractLabeledRow` (588-594) each compute `CHAIN_META[contract.chain]`, `chainName`, and the identical `buildExplorerUrl(...)` — character-for-character. Copy/Check icon-toggle markup repeats at 552-557 and 627-632, but the buttons differ in icon size (h-4 vs h-3.5), container classes, and the mobile variant's extra wrapper span. Only the inner Copy/Check pair + pharos-copy-ring is truly shared.
- Recommendation: extract a PLAIN function `deriveContractInfo(contract)` (NOT a hook — the "useDerivedContractInfo" framing is wrong and would trip rules-of-hooks lint). Optionally `CopyCheckIcons({ copied, size })` with a static-string size prop from a fixed map. Keep the differing button shells inline.
- Files: `src/components/key-info-card.tsx:521-527,552-557,588-594,627-632`.
- Verifier: derivation duplication verified verbatim; corrected hook->plain function; demoted to low. Checks: `npm run check:lint`, `npm run check:types`, `npm test -- key-info-card`.

**`sd-4` — HeroSectionBaseProps is not exported; hero-card.tsx re-derives it from Parameters<>** `[type-safety | low | trivial | none]`
- Problem: `interface HeroSectionBaseProps` (hero-card-sections.tsx:73) is NOT exported. hero-card.tsx:20 reconstructs it as `Omit<Parameters<typeof HeroCardMobileSection>[0], 'tertiaryMetrics'>`. The Omit also drops `tertiaryMetrics` but RETAINS `reportCard`. Correct today but brittle.
- Recommendation: export `HeroSectionBaseProps` and import it. CAUTION: the exported interface does NOT include `reportCard` (it lives on the Mobile-section intersection), so the direct import must be `HeroSectionBaseProps & { reportCard: ReportCard | null }` to type-check — a plain swap surfaces a type error.
- Files: `src/components/stablecoin-detail/hero-card-sections.tsx:73-99`, `src/components/stablecoin-detail/hero-card.tsx:20`.
- Verifier: verified both sites; sharpened the reportCard intersection requirement. Checks: `npm run check:types`.

**`sd-5` — Duplicate scoring-breakdown details/summary markup across MintAuthoritySection and RedemptionBackstopCard** `[duplication | low | small | none]`
- Status: Closed 2026-06-13. Added `ScoringBreakdownDisclosure` for the shared details/summary shell and left each card's unique breakdown body inline as children.
- Problem: character-for-character identical `<details className="group">` + `<summary class="...">` with the same dashed-underline "Scoring breakdown" label and `<ChevronDown ... group-open:rotate-180>`. Only the inner `<div>` body diverges.
- Recommendation: extract `ScoringBreakdownDisclosure({ children })` rendering the `<details>`/`<summary>` shell with the static class string and ChevronDown, taking the breakdown grid as `children`.
- Files: `src/components/stablecoin-detail/mint-authority-section.tsx:96-100`, `src/components/stablecoin-detail/redemption-backstop-card.tsx:162-166`.
- Verifier: verified identical shells. Checks: `npm run check:lint`, `npm run check:types`.

**`sd-6` — isHeroVerdictEnabled() called and showVerdict computed twice (three sites total)** `[duplication | low | trivial | low]`
- Status: Closed 2026-06-13. Added the local `shouldShowVerdict(verdict)` helper and routed the standalone, mobile, and desktop hero verdict checks through it.
- Problem: `HeroMobileIdentity` (355-356) and `HeroDesktopIdentity` (427-428) each run `const heroVerdictEnabled = isHeroVerdictEnabled(); const showVerdict = heroVerdictEnabled && verdict.archetype !== 'uncategorized';`. The standalone `HeroVerdict` (337-338) applies the same two guards inline — a third site. The flag is build-inlined, so no perf angle.
- Recommendation: a tiny local helper `shouldShowVerdict(verdict)` used at all three sites. Threading a prop from hero-card-sections is over-engineered.
- Files: `src/components/stablecoin-detail/hero-card-identity.tsx:337-338,355-356,427-428`.
- Verifier: verified 3 sites; downgraded prop-threading to a one-line helper. Checks: `npm run check:lint`, `npm run check:types`.

**`sd-7` — MobileRiskSnapshot uses a retired colored left-stripe border** `[consistency | low | trivial | low]`
- Problem: line 58 `<Card className="border-l-[3px] border-l-frost-blue lg:hidden" ...>`. The flat-card harmonization memory retired the decorative colored left-stripe, reserving `border-l-[3px]` + semantic color for DATA-DRIVEN indicators only. This stripe is `frost-blue` regardless of risk level — decorative chrome under the retired pattern.
- Recommendation: remove `border-l-[3px] border-l-frost-blue`, leaving `className="lg:hidden"`. NOTE: governing source is an 18-day-old memory (self-flagged as possibly stale); `docs/design-language.md` "Accent Border Palette (Live)" is canonical — confirm MobileRiskSnapshot is not whitelisted there before removing.
- Files: `src/components/stablecoin-detail/mobile-risk-snapshot.tsx:58`.
- Verifier: line + memory verified; demoted to low / medium confidence (taste call). Checks: `npm run check:lint`.

**`sd-11` — Repeated inline badge pill class string in key-info-card JSX** `[duplication | low | medium | low]`
- Status: Closed 2026-06-13. Extracted `ClassificationBadgeLink` for the cls-driven governance, backing, peg-link, and MiCA badge links only; static-color spans remain inline.
- Problem: 12 occurrences of `inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold`, but heterogeneous: 150/159/169/410 are `Link` with focus-ring + `transition-colors hover:brightness-110` + a `${cls}` color; 175 is a bare `span`; 195/200/257 are spans with fully STATIC inline color modifiers; 396/401 are jurisdiction spans with their own static colors; 209/251 are inside the IIFE (sd-1). The 7 static-color spans do NOT share enough to fold without prop-driven class assembly.
- Recommendation: DOWNGRADE. Extract ONLY the cls-driven LINK badges (gov, backing, peg-with-href, mica) into `ClassificationBadgeLink({ href, cls, label, ariaLabel })` (static literal + `${cls}`). Do NOT unify the 7 static-color spans — bespoke literal colors would force FORBIDDEN dynamic Tailwind assembly. Realistic win is ~4-5 sites, not 12. Overlaps sd-1.
- Files: `src/components/key-info-card.tsx:146-260,393-414`.
- Verifier: count of 12 verified but scoped down to the Link badges; flagged hard-rule risk. Checks: `npm run check:lint`, `npm run check:types`, `npm test -- key-info-card`.


### Frontend Components — report-card / tables (`fe-*`)

**`fe-1` — SORT_COLUMN_EVENT handler duplicated across stablecoin-table and screener-table** `[duplication | low | small | low]`
- Problem: both tables wire a useEffect on `SORT_COLUMN_EVENT` that reads `detail.columnNumber`, indexes a column-def array, and calls `toggleSort`. NOT verbatim: stablecoin-table filters `STABLECOIN_HEADER_DEFS` by `visibleSet` then indexes the visible subset; screener-table indexes the static `COLUMNS`. Listener registration/cleanup and the `columnNumber` guard are identical.
- Done 2026-06-13: extracted `useSortColumnEvent(resolvedColumns, toggleSort)` in `src/hooks/use-sort-column-event.ts`; stablecoin-table now passes its memoized visible headers, and screener-table passes its static `COLUMNS`.
- Files: `src/components/stablecoin-table.tsx:432-443`, `src/components/screener/screener-table.tsx:183-192`.
- Verifier: confirmed only these two callsites; corrected "identical" claim. Checks: `npm run typecheck`, `npm run lint`.

**`fe-4` — Source-link list rendering duplicated between OracleRiskPanel and BridgeRouteRiskPanel** `[duplication | low | trivial | none]`
- Problem: both panels end with an identical `sourceLinks.map()` rendering an anchor with the same className, `rel='noreferrer'`, `target='_blank'`, `key=source.url`. Byte-identical; both locals are even named `sourceLinks`.
- Done 2026-06-13: extracted module-private `RiskSourceLinks({ links })` and replaced both byte-identical source-link blocks without changing the static class string.
- Files: `src/components/report-card.tsx:128-142,181-195`.
- Verifier: byte-identical confirmed. Checks: `npm run typecheck`, `npm run lint`.

**`fe-5` — Dead props yieldRankings and mintBurnFlows on StablecoinVirtualRowProps** `[dead-code | low | trivial | none]`
- Problem: `StablecoinVirtualRowProps` declares `yieldRankings?` and `mintBurnFlows?`; the body destructures both into `_yieldRankings`/`_mintBurnFlows` (underscore = lint-tolerated). The sole call site never passes either. The `YieldRanking`/`MintBurnCoinFlow` type imports are used ONLY by these props.
- Done 2026-06-13: removed the two unused prop declarations, their destructured placeholders, and the orphaned type imports.
- Files: `src/components/stablecoin-table-row.tsx:20-21,51-52,104-105`.
- Verifier: confirmed via Read of the call site (576-597) and grep. Checks: `npm run typecheck`, `npm run lint`.

**`fe-6` — Confidence label maps re-derive types instead of importing canonical core.ts types** `[type-safety | low | small | none]`
- Problem: report-card.tsx locally derives `OracleRiskConfidence`/`BridgeRouteRiskConfidence` via `NonNullable<...>` off the display types, then keys `Record<...,string>` label maps. core.ts already exports both named types (482, 517) plus the `*_VALUES` tuples.
- Done 2026-06-13: imported both confidence unions from `@shared/types` and removed the local `NonNullable<...>` derivations while keeping the keyed label maps.
- Files: `src/components/report-card.tsx:48-65`, `shared/types/core.ts:481-482,516-517`.
- Verifier: both types + tuples confirmed exported; type-hygiene not a runtime bug. Checks: `npm run typecheck`.

**`fe-7` — isNestedInteractiveTarget recreated on every render of the virtualized row** `[performance | low | trivial | none]`
- Problem: `isNestedInteractiveTarget` is declared inside `StablecoinVirtualRowBase`, closes over nothing, called once (155), reallocated every render of a frequently-rendered virtual row.
- Done 2026-06-13: hoisted `isNestedInteractiveTarget` to module scope with the same logic and call site.
- Files: `src/components/stablecoin-table-row.tsx:136-143`.
- Verifier: confirmed no props/state refs, invoked once. Checks: `npm run typecheck`, `npm run lint`.

**`fe-10` — gradeBandLabel score-band helper lives in the component file** `[maintainability | low | trivial | none]`
- Problem: `gradeBandLabel` encodes the 90/75/60/40 band thresholds, called 5x in report-card.tsx, with no component-scope dependencies. `src/lib/report-card-ui.ts` already owns related grade-band metadata.
- Done 2026-06-13: moved `gradeBandLabel` to `src/lib/report-card-ui.ts` and imported it from the report card component.
- Files: `src/components/report-card.tsx:28-36`.
- Verifier: confirmed 5 callsites + right home; trimmed speculative justification. Checks: `npm run typecheck`, `npm run lint`.

**`fe-11` — Amount source/status badge pair duplicated between desktop row and mobile card in blacklist-table** `[duplication | low | small | low]`
- Status: Closed 2026-06-13. Extracted `AmountBadges({ event, badgeClassName })` and kept the desktop/mobile badge class strings at their call sites.
- Problem: the `amountSource`/`amountStatus` Tooltip badge pair renders in both `BlacklistAmount` (283-312) and `BlacklistEventCard` (368-401), same guards and same `AMOUNT_SOURCE_LABELS`/`AMOUNT_SOURCE_TOOLTIPS`/`AMOUNT_STATUS_TOOLTIPS` lookups; only the badge span className differs.
- Recommendation: extract `AmountBadges({ event, badgeClassName })`; pass distinct static className strings per caller. `formatBlacklistAmountCell(evt)` stays outside the component.
- Files: `src/components/blacklist-table.tsx:283-312,368-401`.
- Verifier: guards + 3 Record lookups identical; demoted to low. Checks: `npm run typecheck`, `npm run lint`.

### Feed Routes (`f-feed-*`)

**`f-feed-1` — RSS response boilerplate duplicated verbatim in all 4 feed routes** `[duplication | low | small | low]`
- Problem: each of the 4 GET handlers repeats the identical tail — `lastBuildDate = items[0]?.pubDate ?? toRfc822(new Date())`, `renderRss20`, and a Response with the exact same `Content-Type: application/rss+xml; charset=utf-8` and `Cache-Control: public, max-age=3600`. The real shared block is the whole GET tail, not just the Response literal.
- Done 2026-06-13: added `rssResponse(feed)` to `src/lib/rss.ts`; it owns the lastBuildDate fallback and fixed RSS headers. The four feed routes now build the feed object and return `rssResponse(...)`.
- Files: `src/app/feed/cemetery/route.ts:42-61`, `src/app/feed/depeg/route.ts:66-85`, `src/app/feed/digest/route.ts:34-53`, `src/app/feed/methodology/route.ts:141-160`, `src/lib/rss.ts`.
- Verifier: boilerplate confirmed identical; corrected the cited line ranges. Checks: `npm run lint`, `npm run typecheck`, `npm test -- feed`.

### pharoswatchbot Page (`f-pharoswatchbot-*`)

**`f-pharoswatchbot-1` — Three pointless module-level aliases inflate the import surface** `[dead-code | low | trivial | none]`
- Problem: `COIN_COUNT = TRACKED_STABLECOIN_COUNT` (69), `BOT_URL = PHAROSWATCHBOT_BOT_URL` (70), `RECOMMENDED_FIRST_COMMAND = RECOMMENDED_SETUP_COMMAND` (128) are pure same-value re-bindings. Used 1x/1x/3x respectively; none exported.
- Recommendation: optional cleanup. Delete the 3 aliases and inline the imported names. Counter-argument: aliases shorten long names at dense JSX call sites — taste, low priority.
- Files: `src/app/pharoswatchbot/page.tsx:69-70,128`.
- Verifier: use sites verified; counts corrected (RECOMMENDED_FIRST_COMMAND 3x). Checks: `npm run lint`, `npm run typecheck`.

**`f-pharoswatchbot-2` — SurfaceCard builds className via template literal** `[consistency | low | trivial | none]`
- Problem: the central claim that this "violates the static Tailwind class rule" is FALSE. 277-279 select between two fully-static string literals via a ternary, then 284 interpolates. No `bg-${x}` patterns — purging unaffected. The only real point is consistency: `cn()` (used in 42 files) is the preferred helper and is not imported here.
- Recommendation: optional consistency tidy — import `cn` and replace the manual ternary+interpolation. Do NOT justify as a hard-rule fix. Low priority.
- Files: `src/app/pharoswatchbot/page.tsx:277-285`.
- Verifier: refuted the hard-rule framing (21 app files use the same pattern); demoted medium->low. Checks: `npm run lint`, `npm run typecheck`.

**`f-pharoswatchbot-3` — 41-line inline <style> block for the Mini App carousel could be a colocated CSS file** `[maintainability | low | small | low]`
- Problem: a single inline `<style>` block (636-677) defines carousel keyframes/classes; the only inline style block in the file. The codebase has colocated `.css` files for complex animations, so a `.css` home is established. This is a server component, so it can import a `.css` file directly.
- Recommendation: optional — extract to `telegram-carousel.css` and `import './telegram-carousel.css'`. Class names are unique and globally scoped, so no scoping change. Pure taste; weigh against the surgical-changes bias.
- Files: `src/app/pharoswatchbot/page.tsx:636-677`.
- Verifier: verified the only inline style + sibling .css pattern; demoted medium->low. Checks: `npm run lint`, `npm run build`.

**`f-pharoswatchbot-4` — Prose inline-link class string repeated 4 times with no named constant** `[consistency | low | trivial | none]`
- Problem: `rounded-sm underline underline-offset-4 transition-colors hover:text-foreground` appears at 314, 513, 805, 968 on plain prose anchors/Links. `TelegramLink` (207-219) handles EXTERNAL links with a deliberately divergent class string, correctly not reused.
- Recommendation: optional micro-DRY — `const PROSE_LINK_CLASS = '...'` referenced at all 4 sites (must be a plain literal). Marginal value; do only if already editing the file.
- Files: `src/app/pharoswatchbot/page.tsx:314,513,805,968`.
- Verifier: 4 exact occurrences verified; TelegramLink legitimately different. Checks: `npm run lint`, `npm run typecheck`.

### Compare / Yield Clients (`f-compare-*`)

**`f-compare-2` — Pure functions buildCompareSelectionInsights/buildYieldStoryCallouts live in 'use client' files** `[restructure | low | small | low]`
- Problem: both are pure, DOM-free functions exported from `'use client'` modules; their tests import from the client module; matching lib files already exist. The framing "pulling in the entire client boundary for unit tests" overstates impact — Vitest tree-shakes and the tests pass today.
- Recommendation: optional, low value. Move `buildCompareSelectionInsights` (+ types) to `src/lib/compare-derive.ts` and `buildYieldStoryCallouts` (+ type) to `src/lib/yield-view-model.ts`; update imports. Weigh against the no-unrequested-refactors guidance.
- Files: `src/app/compare/client.tsx:129-187`, `src/app/yield/client.tsx:43-68`.
- Verifier: confirmed purity + test imports + target lib files exist; removed the unsubstantiated cost claim. Checks: `npm run typecheck`, `npm test -- compare yield`.

### Stablecoin Detail Client (`f-stablecoin-detail-*`)

**`f-stablecoin-detail-1` — 16 sections-bundle dynamic() imports repeat the same path + skeleton pattern** `[duplication | low | medium | medium]`
- Problem: 16 `dynamic(() => import('@/components/stablecoin-detail/sections-bundle').then((mod) => mod.X), { loading: ... })` calls, only 4 distinct skeleton heights. BUT line 56 carries a load-bearing comment: a static import re-attaches the whole recharts chunk to the eager first load of all 400+ coin pages. The dynamic-import call shape is what next/dynamic statically analyzes for code-splitting; a generic `bundleSection<K>()` doing `mod[key]` risks defeating per-section chunk splitting.
- Recommendation: low priority, verify-don't-assume. If attempted, the helper MUST preserve a literal `.then((mod) => mod.Name)` per call and you MUST confirm via `npm run build` that per-section chunks and first-load JS are unchanged. A `mod[key]` form should be rejected.
- Files: `src/app/stablecoin/[id]/client.tsx:51-143`.
- Verifier: verified 16 imports + 4-height count; raised risk/effort and flagged the line-56 perf comment. Checks: `npm run build`, `npm run typecheck`.

**`f-stablecoin-detail-2` — Single-use one-letter alias `const s = DETAIL_SECTION_DEFS`** `[readability | low | trivial | none]`
- Problem: line 309 `const s = DETAIL_SECTION_DEFS` exists only to shorten line 310's array literal; `s` is referenced solely on 310. Mildly cryptic.
- Done 2026-06-13: removed the single-use alias and referenced `DETAIL_SECTION_DEFS` directly in the detail-section array.
- Files: `src/app/stablecoin/[id]/client.tsx:309-310`.
- Verifier: verified `s` used only at 310. Checks: `npm run lint`, `npm run typecheck`.


### View-Model / lib (`vm-*`)

**`vm-1` — Local percentile helpers in contagion-layout + yield-scatter duplicate @shared/lib/stats.percentileLinear** `[duplication | low | small | low]`
- Problem: `contagion-layout.percentile` (113) and `yield-scatter.percentile` (28) are byte-for-byte equivalent: empty -> 0, a manual linear-interpolation block ONLY when q is non-finite or out of [0,1], otherwise `percentileLinear(values, q*100) ?? 0`. For every real call site the manual block is dead (contagion passes 0.9/0.8/0.75/0.65). Both already import `percentileLinear`.
- Recommendation: consolidate ONLY these two. Replace both bodies with `return percentileLinear(values, q * 100) ?? 0;`. Do NOT touch `status-dashboard-model.percentile` (0-100 nearest-rank, null feeds latency display) — scores audit `cross-math-7` warns against it. Do NOT fold `computeMedian` here.
- Files: `src/lib/contagion-layout.ts:113-125`, `src/lib/yield-scatter.ts:28-40`.
- Verifier: bodies identical, manual branch dead; dropped the status-dashboard sub-rec. Already covered: scores audit `cross-math-7`. Checks: `npm run lint:typed`, `npm run test`, `npm run test:merge-gate`.

**`vm-4` — MINT_PATH_LABELS / MINT_PATH_PASSPORT_LABELS enumerate the same 11 keys** `[maintainability | low | small | low]`
- Problem: both records (284, 301) enumerate the identical 11 mint-path keys, consumed at 651-652 via `labelFromMap` (full + short). Adding a path requires updating both; a miss silently produces an inconsistent short label.
- Recommendation: optional low-value cleanup. Merging into one `Record<string,{full;short}>` would require changing `labelFromMap` (used by 9 other maps) or two thin wrappers. Values deliberately diverge (full prose vs authored-short) — only the key list is the hazard.
- Files: `src/lib/stablecoin-detail-view-model.ts:284-313`.
- Verifier: both maps + 11 keys confirmed; honest framing (key-sync hazard, not duplicated logic). Checks: `npm run lint:typed`, `npm run test`.

**`vm-5` — `const sections = baseSections` is a dead no-op alias** `[dead-code | low | trivial | none]`
- Problem: line 508 `const sections = baseSections;` creates a no-op alias immediately before the return object spreads `sections,`. `baseSections` is not referenced after 508 except through the alias.
- Recommendation: remove line 508 and write `sections: baseSections,` in the return object.
- Files: `src/lib/status-dashboard-model.ts:508`.
- Verifier: confirmed alias is pure noise; `check:unused-code` does NOT flag it (only finds dead modules/exports), so genuinely uncaught. Checks: `npm run lint:typed`.

**`vm-9` — Split @shared/types vs @shared/types/core type-imports in compare-derive.ts** `[consistency | low | trivial | none]`
- Problem: lines 7-9 are three separate `import type` lines: 7 pulls four types from the barrel, 8 pulls `MintBurnPerCoinResponse` from the same barrel, 9 pulls `StablecoinMeta` from the `@shared/types/core` sub-path. The barrel re-exports `./core`, so the sub-path is inconsistent. Lines 7 AND 8 also both merge.
- Recommendation: merge 7-9 into one barrel `import type`. All three are `import type`, so `check:shared-types-imports` (restricts only runtime VALUE imports) is satisfied.
- Files: `src/lib/compare-derive.ts:7-9`.
- Verifier: barrel re-export + type-only confirmed; corrected candidate's overlooking line 8. Checks: `npm run lint:typed`, `npm run check:shared-types-imports`.

**`vm-10` — formatTimestampSeconds and formatTimestampMs differ only by unit + null-guard style** `[duplication | low | trivial | low]`
- Problem: `formatTimestampSeconds` (`seconds == null` guard) and `formatTimestampMs` (`!ms` guard, non-nullable param) are the same `toLocaleString` call modulo `*1000`. The `!ms` guard treats `ms===0` (epoch) as missing.
- Recommendation: optional. If unified, make `formatTimestampMs(ms: number | null | undefined)` with `== null` and define `formatTimestampSeconds` as a delegate. NOTE behavior change: literal `ms===0` would format as 1970-01-01 instead of "—". Only caller (public-status-hero.tsx:192) never passes 0, so safe, but NOT strictly behavior-preserving; line 172 comments these are status-dashboard-scoped.
- Files: `src/lib/status-dashboard-model.ts:173-181`.
- Verifier: confirmed the `!ms` vs `== null` divergence; corrected behaviorPreserving=false. Checks: `npm run lint:typed`, `npm run test`.

**`vm-11` — stablecoin-detail-view-model.ts is 1298 lines mixing mint-authority, snapshot, hero, and orchestrator concerns** `[restructure | low | medium | low]`
- Problem: 1298 LOC bundling 9+ mint-authority constant blocks (284-419) + `buildMintAuthorityDetailViewModel` (622-705); market/peg snapshot builders; the hero-card builder; and the orchestrator (1193-1298). Sibling files already establish the split pattern.
- Recommendation: lowest-value-of-the-restructure-tier. Extract the mint-authority constants + builder into `stablecoin-detail-mint-authority-vm.ts`. CAVEAT: the generic `labelFromMap` helper (439) is shared by ALL label maps — move it to a shared spot, do not duplicate. Defer unless actively worked.
- Files: `src/lib/stablecoin-detail-view-model.ts:1-1298`.
- Verifier: confirmed LOC + concern blocks + siblings; added the labelFromMap caveat. Checks: `npm run lint:typed`, `npm run test`, `npm run check:shared-cycles`, `npm run test:merge-gate`.

### Frontend Cross-cutting / lib (`frontend-*`)

**`frontend-1` — Duplicated normalizeWhitespace in static-seo-content.tsx; divergent summarizeText is intentional** `[duplication | low | trivial | low]`
- Problem: `normalizeWhitespace` is byte-for-byte identical in both files. `summarizeText` has a real, intentional divergence: the static-seo copy calls `stripTermMarkup(text)` (mandatory — renders `{{term:...}}` markup), has no first-sentence shortcut, uses `'...'` not `'…'`, a 0.7 threshold, a different trailing-punctuation set, and `maxLength 280`.
- Done 2026-06-13: exported `normalizeWhitespace` from `page-metadata.ts` and imported it in static SEO content. Left the divergent `summarizeText` implementation intact.
- Files: `src/lib/page-metadata.ts:54-56,110-120`, `src/components/stablecoin-detail/static-seo-content.tsx:37-50`.
- Verifier: normalizeWhitespace identical; summarizeText divergence confirmed; scoped to normalizeWhitespace only. Checks: `npm run test:merge-gate`.

**`frontend-2` — Triplicated epoch-to-locale-string helper across three API-key view models** `[duplication | low | trivial | none]`
- Problem: `new Date(epochSeconds * 1000).toLocaleString()` is inlined at three sites: `formatApiKeyRequestTime` (62), `formatSelfServeExpiry` (170), and inside `formatExpirySummary` (141).
- Done 2026-06-13: extracted `formatEpochSecondsLocale(epochSeconds: number)` into `src/lib/api-key-format.ts`; the three callers now share the epoch-to-locale conversion while keeping their existing null sentinel wording (`"never"`, `"No expiry"`, and `"Non-expiring exception"`).
- Files: `src/lib/api-key-format.ts`, `src/lib/api-key-request-admin-view-model.ts:60-63`, `src/lib/api-key-request-form-view-model.ts:168-171`, `src/lib/api-key-admin-view-model.ts:137-146`.
- Verifier: all three sites verified; corrected the admin-view-model location (inside formatExpirySummary). Checks: `npm run test:merge-gate`.

**`frontend-3` — Duplicated flag-derivation in buildStablecoinDetailDescription pre-launch branch** `[duplication | low | trivial | none]`
- Problem: `governancePhrase`, `pegLabel`, `backingPhrase` are derived with character-identical statements in both the pre-launch early-return branch (205-207) and the main branch (222-224). The early return hides the duplication.
- Done 2026-06-13: hoisted the three const declarations above the `if (coin.status === "pre-launch")` block. Template strings below stayed branch-specific.
- Files: `src/lib/page-metadata.ts:205-207,222-224`.
- Verifier: identical confirmed; both branches read `coin.flags` identically, neither mutates. Checks: `npm run test:merge-gate`.

**`frontend-5` — TIER_BORDER exported from severity-colors.ts but only referenced by its own test** `[dead-code | low | trivial | low]`
- Problem: `TIER_BORDER` (ScoreTier->`border-l-*` map) has no production consumer; the only import is `severity-colors.test.ts`. A value-snapshot of an unused constant.
- Recommendation: delete `TIER_BORDER` + its two test assertions, or leave it. NOT flagged by `check:unused-code` (test imports count as usage), so no CI pressure. Do NOT touch `TIER_TEXT` (consumed by `SCORE_TEXT_THRESHOLDS`). grep confirms no dynamic `border-l-*` construction, so removal is safe.
- Files: `src/lib/severity-colors.ts:84-89`.
- Verifier: referenced only in its def + test; safe. Checks: `npm run test:merge-gate`, `npm run check:unused-code`.

**`frontend-7` — stablecoin-detail-view-model.ts hosts the entire MintAuthority view model (~400 lines)** `[restructure | low | medium | low]`
- Problem: the 1298-line file carries ~15 mint-authority label maps + `buildMintAuthorityDetailViewModel` (exported, called once at 1235), a self-contained concern with sibling files already.
- Recommendation: optional cohesion refactor — extract the constants + builder into `stablecoin-detail-mint-authority-view-model.ts`. Verify no moved label map is referenced elsewhere in the parent. Lower urgency than a defect; file size is the only driver. (Pairs with `vm-11` / `f-xcut-6`.)
- Files: `src/lib/stablecoin-detail-view-model.ts:265-665`.
- Verifier: builder + sibling precedent confirmed; demoted to low (taste). Checks: `npm run test:merge-gate`, `npm run check:unused-code`.

**`frontend-11` — changelogs index.ts manually lists entries; no completeness validation** `[maintainability | low | small | low]`
- Problem: every new changelog file must be hand-imported and pushed into the array. `index.test.ts` checks only ordering/fields, not that all date files are registered — a forgotten registration silently omits an entry.
- Done 2026-06-13: added a completeness test that reads the changelog directory's `YYYY-MM-DD.ts` files and asserts `changelogs.length` equals the count. The static barrel remains unchanged for the static-export build.
- Files: `src/data/changelogs/index.ts:1-35`.
- Verifier: 13 files -> 13 entries today; drift risk real; a test is the build-safe mitigation. Checks: `npm run test:merge-gate`.

**`frontend-12` — formatTimestampSeconds / formatTimestampMs differ only by *1000, but null guards differ** `[duplication | low | trivial | low]`
- Problem: both share the same `toLocaleString(undefined, { timeZoneName: 'short' })` and differ only by `* 1000`. The file comment says "Not a candidate for shared extraction", but in-file dedup is possible. Guards are NOT identical: `formatTimestampSeconds` returns "—" for `null | undefined`; `formatTimestampMs` returns "—" for any falsy including `0`.
- Recommendation: if touched, normalize at the call site OR add a private `formatLocaleTimestampMs(ms)` core. Any merge must preserve both sentinel behaviors. Marginal — keep as a trivial in-file tidy. (Same as `vm-10` from a different scan.)
- Files: `src/lib/status-dashboard-model.ts:172-181`.
- Verifier: shared options confirmed; guards differ. Checks: `npm run test:merge-gate`.

### Hooks (`f-hooks-*`)

**`f-hooks-1` — QueryControlOverrides duplicates PollingQueryControlOptions exactly** `[duplication | low | small | none]`
- Problem: `QueryControlOverrides` (api-hooks.ts:45-50) and `PollingQueryControlOptions` (use-api-query.ts:16-27) declare the identical four optional fields with identical types. api-hooks.ts already imports from ./use-api-query. PollingQueryControlOptions carries a JSDoc the duplicate lacks.
- Done 2026-06-13: exported `PollingQueryControlOptions` from `use-api-query.ts` and made `QueryControlOverrides` a direct alias, preserving the canonical `keepPreviousData` JSDoc at the exported interface.
- Files: `src/hooks/api-hooks.ts:45-50`, `src/hooks/use-api-query.ts:16-27`.
- Verifier: field-for-field match; both within src/. Checks: `npm run typecheck`, `npm run lint`.

**`f-hooks-4` — parseInitialStressSelection() called twice in separate useState initializers** `[simplification | low | trivial | none]`
- Problem: two lazy useState initializers each call `parseInitialStressSelection()` (reads/parses `window.location.search`). Both run once on mount but parse the same search string twice.
- Recommendation: simplest behavior-preserving form: `const [initial] = useState(parseInitialStressSelection); const [targetCoinId,setTargetCoinId]=useState(initial.coinId); const [targetGrade,setTargetGrade]=useState(initial.grade);`. Do NOT move the call into the render body unguarded (would parse every render).
- Files: `src/hooks/use-stress-test.ts:66-67`.
- Verifier: two lazy initializers re-parsing confirmed; flagged the render-body trap. Checks: `npm run typecheck`, `npm run test -- use-stress-test`.

**`f-hooks-6` — enabled: true passed redundantly in useEndpointProbes and usePublicEndpointProbes** `[simplification | low | trivial | none]`
- Problem: both pass `{ enabled: true, retry: 0 }`. `createPollingQueryOptions` sets `enabled: opts?.enabled`; when undefined TanStack treats the query as enabled — so `enabled:true` is a no-op.
- Recommendation: drop `enabled: true`, leaving `{ retry: 0 }` at both sites.
- Files: `src/hooks/use-endpoint-probes.ts:285,294`.
- Verifier: redundant via createPollingQueryOptions:87. Checks: `npm run test -- query-polling-policy`, `npm run typecheck`.

**`f-hooks-7` — PUBLIC_ENDPOINTS is an unnecessary spread of ENDPOINT_GROUPS.public** `[dead-code | low | trivial | none]`
- Problem: `PUBLIC_ENDPOINTS` spreads `ENDPOINT_GROUPS.public` with no transformation, used once. The candidate's "readonly tuple" evidence is WRONG: `getProbePaths` returns a fresh mutable `string[]`, so the spread is redundant because the source is already fresh. `collectEndpointProbes` accepts `readonly string[]`.
- Recommendation: replace with `const PUBLIC_ENDPOINTS = ENDPOINT_GROUPS.public;` or inline at 292. Leave `ALL_ENDPOINTS` (legitimately spreads two groups).
- Files: `src/hooks/use-endpoint-probes.ts:25-27`.
- Verifier: single redundant spread + single consumer; corrected evidence. Checks: `npm run typecheck`.

**`f-hooks-9` — AdminPollingOptions duplicates a subset of ApiQueryOptions/PollingQueryControlOptions fields** `[duplication | low | small | low]`
- Problem: `AdminPollingOptions<T>` declares `enabled?`, `retry?`, `schema?`. enabled/retry overlap `PollingQueryControlOptions`; schema overlaps `ApiQueryOptions`. Caller count corrected to 6 (excludes use-endpoint-probes). PRECONDITION: neither `ApiQueryOptions` nor `PollingQueryControlOptions` is currently exported from use-api-query.ts.
- Done 2026-06-13: exported `ApiQueryOptions` and replaced `AdminPollingOptions<T>` with `Pick<ApiQueryOptions<T>, "enabled" | "retry" | "schema">`, keeping the admin hook's accepted option surface unchanged.
- Files: `src/hooks/use-admin-polling-query.ts:9-13`, `src/hooks/use-api-query.ts:16-34`.
- Verifier: duplication confirmed; caller count + export precondition corrected. Checks: `npm run typecheck`, `npm run lint`.


### Classification (`cls-*`)

**`cls-1` — GOVERNANCE_TIER_COLORS + TierColors exported with zero real consumers** `[dead-code | low | trivial | none]`
- Problem: `GOVERNANCE_TIER_COLORS` (a `TierColors` record keyed by `GovernanceType`) and its private `TierColors` interface have zero consumers; grep finds only the definition. Genuinely dead.
- Recommendation: delete both the `TierColors` interface (122-125) and `GOVERNANCE_TIER_COLORS` (127-131).
- Files: `shared/lib/classification/badges.ts:122-131`.
- Verifier: zero consumers; NOT flagged by `check:unused-code` because `export *` from index.ts credits barrel star-exports as consumption. Deletion safe. Checks: `npm run check:unused-code`, `npm run lint:typed`.

**`cls-4` — finiteOrNull / finiteNumber duplicate type-guards.numberValue (shared scope)** `[duplication | low | small | low]`
- Problem: `royco-tranche-safety.finiteNumber(value: unknown)` is byte-identical to `numberValue`. `yield-scoring.finiteOrNull(value: number|null|undefined)` has the same body with a narrower param. Both private.
- Recommendation: replace royco's with `numberValue` (drop-in). For yield-scoring, alias `const finiteOrNull = numberValue` or replace call sites (numberValue accepts unknown). Scope to these two shared files only — identical copies in src/lib and worker/src are OUTSIDE this slice (worker excluded from root TS graph).
- Files: `shared/lib/yield-scoring.ts:73-75`, `shared/lib/royco-tranche-safety.ts:9-11`, `shared/lib/type-guards.ts:15-17`.
- Verifier: bodies identical; scope note added (don't pull in src/worker copies). Checks: `npm run lint:typed`, `npx vitest run shared/lib/__tests__`.

**`cls-5` — isFiniteNumber boolean guard defined twice in shared/lib** `[duplication | low | small | low]`
- Problem: format.ts and selector/snapshot.ts each define a private `isFiniteNumber(value): value is number` with identical body — the boolean sibling of `numberValue`.
- Recommendation: add `export function isFiniteNumber(value: unknown): value is number` to type-guards.ts and import in both, deleting the copies. Worker has its own copies — leave those (separate runtime boundary).
- Files: `shared/lib/format.ts:5-7`, `shared/lib/selector/snapshot.ts:137-139`.
- Verifier: bodies identical; worker scope excluded. Checks: `npm run lint:typed`, `npx vitest run shared/lib/__tests__`.

**`cls-6` — classification-pegs.ts re-export stub serves only a test** `[dead-code | low | trivial | low]`
- Problem: `classification-pegs.ts` is one line (`export * from './classification/pegs'`) consumed only by its test. All four forwarded symbols are reachable via the barrel or `@shared/lib/classification/pegs`.
- Recommendation: optional low-value cleanup — point the test at `@shared/lib/classification/pegs` and delete the stub. Marginal; defer unless doing a broader entrypoint-surface sweep.
- Files: `shared/lib/classification-pegs.ts:1`, `shared/lib/__tests__/classification-pegs.test.ts:2-7`.
- Verifier: single test-only consumer; NOT flagged by `check:unused-code` (test imports count). A compatibility facade, borderline taste.

**`cls-8` — getDewsRiskLevel maps WATCH into calm with no test coverage** `[test-gap | low | trivial | none]`
- Problem: `DewsRiskLevel` has no 'watch' member, and `getDewsRiskLevel` only thresholds at ALERT(2)/WARNING(3)/DANGER(4), so WATCH(order 1) returns 'calm' — same as CALM(0). Single consumer feeds a homepage risk indicator. Zero tests.
- Recommendation: add a unit test asserting `getDewsRiskLevel(['WATCH'])==='calm'` and `(['CALM'])==='calm'` to lock the 2-tier collapse, plus a one-line comment. Do NOT add 'watch' to the enum (a product decision, out of scope).
- Files: `shared/lib/classification/risk.ts:60-72`.
- Verifier: verified type/thresholds/no test/single consumer; test-only rec is behavior-preserving. Checks: `npx vitest run shared/lib/__tests__`.

**`cls-9` — VAR peg badge (sky) and chart (slate) use different hue families** `[consistency | low | trivial | medium]`
- Problem: `VAR.badge.cls` uses sky-500/sky-700 while `VAR.chart` uses slate-500/slate-700/#64748b. Scanned every peg with both — all others share one hue family. VAR is the sole divergence.
- Recommendation: design observation, NOT an auto-fix. Aligning VAR to one hue is a one-token change but changes rendered color and must get design sign-off. Flag to the owner.
- Files: `shared/lib/classification/pegs.ts:373-383`.
- Verifier: claim verified true; risk recalibrated none->medium (changes pixels). Not a safe mechanical refactor.

**`cls-10` — GOVERNANCE_COLORS.centralized text-yellow-600 vs GOVERNANCE_BADGE_STYLES.centralized text-yellow-700** `[consistency | low | trivial | medium]`
- Problem: `GOVERNANCE_COLORS.centralized` uses text-yellow-600 (19) while `GOVERNANCE_BADGE_STYLES.centralized.cls` uses text-yellow-700 (41); the other two tiers match. The table badge renders a lighter yellow than the detail-page pill.
- Recommendation: design observation, not an auto-fix. yellow-700 matches every other entry, so harmonizing is the likely-correct one-token change — but alters rendered color; confirm with the owner.
- Files: `shared/lib/classification/badges.ts:18-22,38-51`.
- Verifier: divergence verified (600 vs 700); risk low->medium (changes pixels). Flag for design.

### Chains (`chains-*`)

**`chains-2` — getL2BeatSafetyScoreAudit called twice per chain in buildL2BeatStablecoinSafetyAudit** `[duplication | low | small | none]`
- Problem: `contractChains` is walked twice — a flatMap (413) calls `getL2BeatSafetyScoreAudit` per chain to build `auditsForCoin`, then a for-loop (419) calls it (420) and `getL2BeatInfrastructureContext` (421) again for the same chainIds. Each call allocates a fresh object + notes array. Runs ONLY from an offline candidate-generation script, never at runtime.
- Recommendation: build a `Map<chainId, audit>` in the first pass, iterate it in the second. Behavior-preserving.
- Files: `shared/lib/chains/l2beat-audit.ts:413-422`.
- Verifier: double call confirmed; demoted from performance/medium -> duplication/low (offline). Checks: `npm run typecheck`, `npx vitest run shared/lib/__tests__/l2beat-audit.test.ts`.

**`chains-3` — stablecoinRouteSearchText built twice per coin in buildL2BeatBridgeRouteReviewAudit** `[duplication | low | small | none]`
- Problem: `buildL2BeatBridgeRouteReviewAudit` calls `stablecoinRouteSearchText(coin)` (588), then passes coin into `bridgeRouteReviewReasons` which calls it again (550). The function is non-trivial (traverses id/symbol/name/links/notices/mintAuthority/bridge protocols/sources). Offline only.
- Recommendation: compute once at 588 and thread it through (`bridgeRouteReviewReasons` accepts the precomputed searchText or a precomputed boolean).
- Files: `shared/lib/chains/l2beat-audit.ts:543-592`.
- Verifier: redundant internal call confirmed; demoted to low (offline). Checks: `npm run typecheck`, `npx vitest run shared/lib/__tests__/l2beat-audit.test.ts`.

**`chains-4` — suggestBridgeRouteRiskTierFromL2BeatProtocol called twice per protocol; `ordered` map re-allocated** `[simplification | low | trivial | none]`
- Problem: `weakestSuggestedBridgeTier` calls the tier function (537), and the `protocols.map` (608) calls it again per protocol; the `ordered` weight literal (525-534) is reallocated each call. Double-call cost negligible (string comparisons, offline). The genuine win is hoisting `ordered`.
- Recommendation: hoist `ordered` to a module-level const. The protocol re-call dedup is optional and low value.
- Files: `shared/lib/chains/l2beat-audit.ts:524-541,602-610`.
- Verifier: confirmed; demoted to simplification/low-trivial; primary piece is the const hoist. Checks: `npm run typecheck`.

**`chains-7` — ACTIVE_BACKING_DIVERSITY_TYPES duplicated between health.ts and aggregator.ts** `[duplication | low | trivial | low]`
- Problem: health.ts:37 defines `ACTIVE_BACKING_DIVERSITY_TYPES = ['rwa-backed','crypto-backed']` (used in `computeBackingDiversityScore`), while aggregator.ts:147 hardcodes `backingTotals = { 'rwa-backed': 0, 'crypto-backed': 0 }` independently. aggregator already imports from ./health, so adding a third backing type would silently leave aggregator seeding it to 0.
- Recommendation: export `ACTIVE_BACKING_DIVERSITY_TYPES` and build `backingTotals` via `Object.fromEntries(ACTIVE_BACKING_DIVERSITY_TYPES.map((t) => [t, 0]))`. Runs at Worker runtime — keep allocation-light.
- Files: `shared/lib/chains/health.ts:37`, `shared/lib/chains/aggregator.ts:147`.
- Verifier: both definitions + the existing import confirmed; genuine single-source-of-truth fix. Checks: `npm run typecheck`, `npx vitest run shared/lib/chains`, `npm run check:duplicate-exports`.

**`chains-8` — Four separate reduce() passes over the accumulator map in aggregator.ts Phase 2** `[simplification | low | trivial | low]`
- Problem: 110-113 run four separate `Array.from(accumulators.values()).reduce(...)` passes (totalUsd/prevDay/prevWeek/prevMonth), each re-materializing the values array. On a runtime path, but the map holds at most ~40 chains, so cost is negligible.
- Recommendation: OPTIONAL — replace the four reduces with a single `for (const a of accumulators.values())` accumulating all four. Clarity, not perf.
- Files: `shared/lib/chains/aggregator.ts:110-113`.
- Verifier: confirmed; "performance" framing misleading at ~40 chains. Checks: `npm run typecheck`, `npx vitest run shared/lib/chains`.

**`chains-9` — ChainMeta interface not exported — chain-hero.tsx re-derives it locally** `[maintainability | low | trivial | low]`
- Problem: chains/index.ts:11 declares `interface ChainMeta` without export; chain-hero.tsx:31 derives `type ChainMeta = (typeof CHAIN_META)[string]` locally. The "diverges if changed to a class" justification is overstated — today no correctness risk, but exporting is cleaner.
- Done 2026-06-13: exported `ChainMeta` from `shared/lib/chains` and imported it directly in the chain hero, deleting the local `(typeof CHAIN_META)[string]` re-derivation.
- Files: `shared/lib/chains/index.ts:11-20`, `src/app/chains/[chain]/chain-hero.tsx:31`.
- Verifier: unexported interface + local re-derivation verified; correctness risk overstated; cleanup valid. Checks: `npm run typecheck`, `npm run check:unused-code`.

### Pages Functions / API endpoints (`api-*`)

**`api-1` — isHtmlResponse duplicated between _middleware.ts and ops-asset-host-gate.ts** `[duplication | low | trivial | none]`
- Problem: `isHtmlResponse` is byte-identical in both files (`response.headers.get("Content-Type")?.toLowerCase().includes("text/html") ?? false`). Genuine duplication of a trivial guard.
- Recommendation: add `export function isHtmlResponse(...)` to `functions/lib/proxy-utils.ts` (already exports `jsonError`/`buildProxyResponse`) and import in both, deleting the copies.
- Files: `functions/_middleware.ts:137-139`, `functions/lib/ops-asset-host-gate.ts:16-18`.
- Verifier: identical confirmed; proxy-utils.ts is the existing shared module; `check:duplicate-exports` only catches same-file dupes. Checks: `npm run lint`, `npm run check:unused-code`, `npm run check:duplicate-exports`.

**`api-2` — DEFAULT_OPS_UI_ORIGIN/DEFAULT_SITE_UI_ORIGIN exported but unused from site-data-origin.ts** `[dead-code | low | trivial | none]`
- Problem: `DEFAULT_SITE_UI_ORIGIN` and `DEFAULT_OPS_UI_ORIGIN` have zero non-test/non-doc consumers (the live `DEFAULT_OPS_UI_ORIGIN` is in ops-origin.ts). Trivial pass-through aliases of `@shared/lib/runtime-origins` constants.
- Recommendation: delete both lines from site-data-origin.ts. Do NOT touch ops-origin.ts's live one. Regenerate `docs/agent-code-map.md` after (line 311 lists these names).
- Files: `functions/lib/site-data-origin.ts:10-11`.
- Verifier: grep confirms unused; `check:unused-code` PASSES without flagging (scanner blind spot), so genuinely actionable. Checks: `npm run check:unused-code`, `npm run typecheck`.

**`api-3` — getStrictContractPaths() is a no-op wrapper over STRICT_CONTRACT_PATHS** `[dead-code | low | trivial | low]`
- Problem: `getStrictContractPaths()` returns module-level `STRICT_CONTRACT_PATHS` with no transformation; `STRICT_CONTRACT_PATHS_LIST = getStrictContractPaths()`. The function has ZERO runtime callers, but is re-exported from index.ts, on the unused-code EXPORT_ALLOWLIST, and mocked in a test — not free to delete blindly.
- Recommendation: smallest safe change — keep the public function (allowlisted + mocked) but make `STRICT_CONTRACT_PATHS_LIST = STRICT_CONTRACT_PATHS;` directly. Full removal requires index.ts + allowlist + test-mock edits (more than "one test").
- Files: `shared/lib/api-endpoints/definitions.ts:794-819`, `shared/lib/api-endpoints/index.ts:9,12`.
- Verifier: no runtime caller, but mocked + allowlisted; risk none->low; rec narrowed to in-file dedup. Checks: `npm run check:unused-code`, `npm test -- query-polling-policy`, `npm test -- api-endpoints router-contract`.

**`api-5` — statusImpact computed via hardcoded job-name comparison in CRON_JOB_DEFINITIONS map()** `[maintainability | low | small | low]`
- Problem: `statusImpact` is resolved by comparing `definition.job` against 4 literals inside the `.map()`. Adding a critical job means editing the map, not the definition.
- Recommendation: add optional `statusImpact?: CronStatusImpact` to `CronJobDefinitionInput`, set `statusImpact: "critical"` inline on the 4 critical job objects, and change the map to `definition.statusImpact ?? "watch"`. Declaration-site, byte-identical. Not a frozen-invariant surface.
- Files: `shared/lib/cron-jobs.ts:549-563`.
- Verifier: 4-literal comparison + type confirmed; not in check-frozen-invariants; demoted medium->low. Checks: `npm run typecheck`, `npm test -- cron`, `npm run check:cron-connections`, `npm run check:cron-sync`.

**`api-8` — Private getSiteDataAccess/getPublicApiAccess in definitions.ts shadow public exports in validation.ts** `[naming | low | trivial | none]`
- Problem: definitions.ts defines private `getSiteDataAccess(endpoint)` (763) and `getPublicApiAccess(endpoint)` (768); validation.ts EXPORTS public `getSiteDataAccess(path)` (44) and `getPublicApiAccess(path)` (28). Same names, different signatures, sibling modules.
- Recommendation: rename the PRIVATE helpers to `resolveEndpointSiteDataAccess` / `resolveEndpointPublicApiAccess`; update their two call sites in the ENDPOINT_DEFINITIONS map. Module-private, fully local. Leave the public names.
- Files: `shared/lib/api-endpoints/definitions.ts:763-770`, `shared/lib/api-endpoints/validation.ts:28-54`.
- Verifier: both private (absent from index.ts exports); 2 call sites; demoted medium->low. Checks: `npm run typecheck`, `npm test -- api-endpoints`.


### Selector (`sel-*`)

**`sel-1` — Dead `redistributeWeights` export — never called outside the slice** `[dead-code | low | trivial | none]`
- Problem: `redistributeWeights` has zero call sites (grep finds only the declaration + the barrel re-export). The scoring path redistributes weights inline in `scoreRow` via `(slot.baseWeight / totalBase) * 100`. CI `check:unused-code` does NOT flag it because a barrel re-export counts as a named dependency.
- Recommendation: delete `redistributeWeights` (weights.ts:194-222) and remove its name from the `./weights` re-export in index.ts:17.
- Files: `shared/lib/selector/weights.ts:194-222`, `shared/lib/selector/index.ts:17`.
- Verifier: zero call sites across src/functions/worker/shared + tests; CI structurally blind to barrel-masked re-exports. Checks: `npm run typecheck`, `npm run check:unused-code`, `npm run test -- shared/lib/selector`.

**`sel-2` — `GRADE_RANK` in `ranking.ts` duplicates the ordering of shared `REPORT_CARD_GRADE_RANK`** `[duplication | low | small | low]`
- Problem: ranking.ts:38-51 declares a private 12-entry `GRADE_RANK` (A+=0 … NR=11), the inverse of shared `REPORT_CARD_GRADE_RANK` (NR=-1 … A+=10). Used only in `compareScored` with fallback 99. A NEW instance NOT catalogued in the scores audit's `cross-math-1`.
- Recommendation: import `getReportCardGradeRank` and compute `const aGrade = -(getReportCardGradeRank(a.row.safetyGrade, -99) ?? -99)` (NR returns -1; null/undefined -> -99 -> 99). Delete the local table. Coordinate with the audit's broader grade-rank consolidation. Add a comment that selector ordering is the negation of the report-card rank.
- Files: `shared/lib/selector/ranking.ts:38-51`, `shared/lib/report-card-core.ts:49-72`.
- Verifier: inversion math verified by hand; selector/ranking.ts absent from the scores audit; ranking-only so no score-pipeline impact. Checks: `npm run typecheck`, `npm run test -- shared/lib/selector/__tests__/ranking`, `npm run lint`.

**`sel-3` — `pegYieldScore` in `normalization.ts` is byte-identical to `identity`** `[duplication | low | trivial | low]`
- Problem: the body is identical to `identity` (`if (x==null) return null; return clamp(x,0,100)`). But this is intentional naming-as-documentation: `pegYieldScore` is the normalizer for the `pharosYieldScore` slot and its JSDoc documents the PYS-exceeds-100 clamp. Deletion also requires updating the dedicated test block (28-31).
- Recommendation: marginal-value cleanup. If pursued: replace the scoring.ts:148 call with `identity`, fold the PYS note into `identity`'s JSDoc, delete `pegYieldScore` from normalization.ts + index.ts + its test. Equally defensible to KEEP — the name encodes intent.
- Files: `shared/lib/selector/normalization.ts:37-41`, `shared/lib/selector/scoring.ts:148`.
- Verifier: identical bodies + single call site; found the extra test dependency; reframed as optional. Checks: `npm run typecheck`, `npm run test -- shared/lib/selector/__tests__/normalization`.

**`sel-4` — Three identical `peg-score-floor` `fail()` blocks in `exclusions.ts`** `[duplication | low | trivial | none]`
- Problem: the guard+return block is byte-identical across `treasuryExclusions`, `yieldExclusions`, `tradingExclusions`. Only the preceding floor *computation* differs (treasury/yield/trading floor).
- Recommendation: extract `function failPegScoreFloor(row, pegScoreFloor): ExclusionRecord | null` returning the `fail(...)` record; replace each block with `const hit = failPegScoreFloor(...); if (hit) return hit;`. Keep the per-profile floor computation at each site.
- Files: `shared/lib/selector/exclusions.ts:189-196,232-239,251-258`.
- Verifier: byte-for-byte identity verified; demoted medium->low. Checks: `npm run typecheck`, `npm run test -- shared/lib/selector/__tests__/exclusions`.

**`sel-5` — `buildRecommendationPhase` loop continues instead of breaking after 3 slots fill** `[performance | low | trivial | none]`
- Problem: once `recommended.length >= 3` the loop body is a no-op `continue` for the remaining ranked entries. IS behavior-preserving: `recommended` only grows, so once it hits 3 every later iteration does nothing — `break` yields identical outputs.
- Recommendation: replace `continue` (318) with `break`. Provably identical. Micro-optimization on ~400 rows; cleanup more than measurable perf.
- Files: `shared/lib/selector/engine.ts:315-338`.
- Verifier: traced the loop; corrected behaviorPreserving false->true. Checks: `npm run typecheck`, `npm run test -- shared/lib/selector/__tests__/engine`.

**`sel-6` — `CRITICAL_SIGNALS_BY_PROFILE` array exists only to build the Set version** `[simplification | low | trivial | none]`
- Problem: `CRITICAL_SIGNALS_BY_PROFILE` (58-75) is read only at 78-80 to construct `CRITICAL_SIGNAL_SET_BY_PROFILE`. Only the Set version is used downstream (`criticalSignals.has(...)`).
- Recommendation: inline the three arrays into `new Set([...])` literals and delete the intermediate.
- Files: `shared/lib/selector/scoring.ts:58-81`.
- Verifier: array is module-private, feeds only the Set constructors. Checks: `npm run typecheck`, `npm run test -- shared/lib/selector/__tests__/scoring`.

**`sel-7` — `BLUECHIP_GRADES` set in `snapshot.ts` hardcodes the grade list — recommendation as written will not compile** `[duplication | low | small | low]`
- Problem: snapshot.ts:69 hardcodes the 11 grades that core.ts:777 enumerates in `BLUECHIP_GRADE_VALUES`. BUT `BLUECHIP_GRADE_VALUES` is a non-exported `const` (only `BluechipGrade` + `BluechipGradeSchema` are exported), so the candidate's import recommendation fails typecheck. snapshot.ts:70 also derives `SAFETY_GRADES` from `BLUECHIP_GRADES`.
- Recommendation: either (a) add `export` to `BLUECHIP_GRADE_VALUES`, then `new Set<string>(BLUECHIP_GRADE_VALUES)`; or (b) derive from the exported schema: `new Set<string>(BluechipGradeSchema.options)`. Prefer (b). Keep `SAFETY_GRADES` as-is.
- Files: `shared/lib/selector/snapshot.ts:69-70`, `shared/types/core.ts:777-779`.
- Verifier: confirmed the const is NOT exported (candidate's rec would fail); corrected to two viable options. Checks: `npm run typecheck`, `npm run test -- shared/lib/selector/__tests__/snapshot`, `npm run check:duplicate-exports`.

**`sel-8` — `_components` parameter in `selectLowestSubDimension` is unused (intentional API-symmetry placeholder)** `[dead-code | low | trivial | low]`
- Problem: `_components` is never read; the body uses `row` directly. But this is DELIBERATE: the `_`-prefix is eslint-whitelisted and the JSDoc documents it as accepted "for API symmetry with the engine pipeline". One non-test caller passes `entry.components`; 6 test calls pass `[]`.
- Recommendation: low value — recommend NOT pursuing unless the team wants to retire the placeholder. If removed: drop from the signature, update the call site + 6 test calls + JSDoc.
- Files: `shared/lib/selector/lowest-sub-dimension.ts:148-152`, `shared/lib/selector/recommendation.ts:168`.
- Verifier: unused param + call/test counts confirmed; the `_`-prefix is an intentional lint-sanctioned signal. Flagged low/optional. Checks: `npm run typecheck`, `npm run lint`, `npm run test -- shared/lib/selector/__tests__/lowest-sub-dimension`.

**`sel-9` — Reading vs lowest-sub-dimension label tables differ in only 1 of 17 keys** `[duplication | low | small | low]`
- Problem: `SELECTOR_COMPONENT_READING_LABELS` (80-98) and `SELECTOR_COMPONENT_LOWEST_SUB_DIMENSION_LABELS` (100-118) differ on exactly one key — `safetyOverall` ('Safety Score' vs 'Safety'). The prose/score tables diverge more substantially.
- Recommendation: optional, low value. Scope ONLY the reading/lowest pair: `SELECTOR_COMPONENT_LOWEST_SUB_DIMENSION_LABELS = { ...SELECTOR_COMPONENT_READING_LABELS, safetyOverall: "Safety" }`. Do NOT fold in prose/score tables.
- Files: `shared/lib/selector/selector-labels.ts:80-118`.
- Verifier: diffed all four tables; narrowed to the genuinely-duplicate pair; demoted to low. Checks: `npm run typecheck`, `npm run test -- shared/lib/selector`.

**`sel-10` — `sha256Hex` re-exported from the selector barrel with no barrel consumer** `[dead-code | low | trivial | none]`
- Problem: every real consumer imports `sha256Hex` directly (from `@shared/lib/sha256` or `../sha256`). No file imports it via the selector barrel. The re-export (index.ts:65) is dead surface; `check:unused-code` can't catch it (the re-export counts as a use).
- Recommendation: remove `export { sha256Hex } from "../sha256";`. It is a generic crypto primitive unrelated to the selector domain.
- Files: `shared/lib/selector/index.ts:65`.
- Verifier: no barrel import resolves it; direct-import sites confirmed. Same barrel-masking blind spot as sel-1. Checks: `npm run typecheck`, `npm run check:unused-code`.

**`sel-11` — `rowsById` Map rebuilt independently in `lower-ranked.ts` and `output-helpers.ts`** `[duplication | low | small | low]`
- Problem: both build a `Map<string, MergedRow>` from a row array each engine run, both from `universe`. `SelectorData.rows` is a ReadonlyMap, but `universe` is a FILTERED subset (drops Howey + peg-currency mismatches), so threading `data.rows` would change lookups — NOT equivalent.
- Recommendation: low value. If pursued: build `rowsById` once from `universe` in runSelector and pass the prebuilt map into both, adjusting signatures. Do NOT substitute `data.rows`. Two O(n) scans over ~400 rows is negligible — tidiness, not perf.
- Files: `shared/lib/selector/lower-ranked.ts:109-110`, `shared/lib/selector/output-helpers.ts:99`.
- Verifier: both rebuilt from the same `universe`; corrected the `data.rows` suggestion (unfiltered superset). Checks: `npm run typecheck`, `npm run test -- shared/lib/selector`.

### Redemption-Backstop Configs (`rbc-*`)

**`rbc-1` — Cross-file duplicate REVIEWED_AT date constants (5 files each)** `[duplication | low | medium | low]`
- Problem: `REVIEWED_STABLECOIN_AUDIT_AT="2026-05-12"` declared in 5 files; `REVIEWED_REMEDIATION_AT="2026-03-30"` in 5; `REVIEWED_FOLLOWUP_REMEDIATION_AT="2026-05-13"` in 4; the 2026-03-23 first-wave date appears under 4 different names across 5 files. Two of the five already centralize and EXPORT their constants.
- Recommendation: create `redemption-backstop-configs/review-dates.ts` exporting the four cross-cutting dates. Have the 5 files import them. Keep per-domain aliases (basket/queue/direct) as local re-bindings if the naming carries domain meaning. Byte-identical values.
- Files: `shared/lib/redemption-backstop-configs/collateral-redeem.ts:14-19`, `.../psm-and-basket.ts:13-18`, `.../queue-redeem.ts:12-18`, `.../offchain-issuer/shared.ts:3-10`, `.../stablecoin-redeem/shared.ts:9-16`.
- Verifier: declaration counts confirmed; demoted medium->low, effort small->medium (intentional alias names). Checks: redemption-backstop consistency + helper tests, `npm run check:redemption-backstops`, `npm run check:shared-cycles`.

**`rbc-2` — 5 Midas LYT configs are near-identical boilerplate; 6th (mre7yield) diverges** `[duplication | low | small | low]`
- Problem: FIVE configs (mf-one, mglobal, mhyper, mmev, mapollo) ARE near-identical (date "2026-05-14", settlementModel days, outputAssetType nav, shared liquid-yield-token doc). The SIXTH (mre7yield-midas) is NOT: different date (REVIEWED_STABLECOIN_AUDIT_AT), different doc, different note. The candidate's "6 identical" is wrong.
- Recommendation: extract a base for the 5 identical configs via a `[id, ticker, productUrl]` table + a `midasLytBase` fragment, using `cloneRedemptionBackstopConfig` so each entry stays an independent clone (the registry mutates in place via `applyTrackedReviewedDocs`). Leave mre7yield-midas inline.
- Files: `shared/lib/redemption-backstop-configs/offchain-issuer/coverage-and-stablecoin-audit.ts:166-276`.
- Verifier: liquid-yield-token ref appears 5x; mre7yield diverges; corrected count 6->5; demoted high->low. Checks: redemption-backstop consistency, `npm run check:redemption-backstops`, `npm run check:redemption-coverage-audit`.

**`rbc-3` — 8 Spiko fund configs repeat the same shared doc refs verbatim** `[duplication | low | small | low]`
- Problem: deposits_withdrawals URL appears 8x, SICAV prospectus 8x. The candidate's "redemption-orders URL appears 16 times" is WRONG: 8 total — 5 use the standard `create-redemption-order`, 3 (EUR funds) use `create-instant-redemption-order`.
- Recommendation: define `SPIKO_BASE_DOCS` (deposits + standard redemption ref) and `SPIKO_EUR_BASE_DOCS` (deposits + instant redemption ref) + `SPIKO_PROSPECTUS`. Each entry spreads the matching base, then appends its fund-specific product-page ref (some lack one) + prospectus. Build via `sourceRef()`; preserve each entry's exact docs ORDER and per-fund tail.
- Files: `shared/lib/redemption-backstop-configs/offchain-issuer/coverage-and-stablecoin-audit.ts:432-689`.
- Verifier: 8/8 confirmed; corrected the false 16; preserve order/tail. Checks: redemption-backstop consistency, `npm run check:redemption-backstops`.

**`rbc-4` — 4 near-identical Nest NAV vault configs differ only in token name and window note** `[duplication | low | trivial | low]`
- Problem: ntbill vs nbasis/nopal/nwisdom differ in exactly 3 places (id, feeDescription token name, notes[0] window). The docs[] (single Nest available-vaults ref) is byte-identical across all 4. The 5th (inalpha-nest) has a 3-ref docs[] and different shape — correctly excluded.
- Recommendation: define `nestNavVaultBase` + a `[id, ticker, windowNote]` table; generate the 4 entries with `cloneRedemptionBackstopConfig` + per-entry feeDescription/note. Leave inalpha-nest inline. ~64 lines removed.
- Files: `shared/lib/redemption-backstop-configs/queue-redeem.ts:702-819`.
- Verifier: diff confirmed 3-place divergence + identical docs[]; demoted medium->low. Checks: redemption-backstop consistency, `npm run check:redemption-backstops`.

**`rbc-5` — syrupUSDC and syrupUSDT configs are copy-pasted but diverge in more than the asset name** `[duplication | low | trivial | low]`
- Problem: the candidate's "3 lines changed, notes byte-identical" is INACCURATE. The actual diff shows 4 divergent regions: id, feeDescription, AND BOTH notes — notes[1] differs by an extra clause ("on Uniswap or Balancer" in USDC), notes[2] differs by USDC vs USDT. A naive `[id, assetName]` table would silently drop/add the venue clause.
- Recommendation: DO NOT table-ize via a simple two-field substitution. If consolidated, the data table must carry the full per-entry notes (removing most savings). With only 2 entries + divergent notes, the smallest-root-cause stance is to leave both inline (or harmonize the notes deliberately).
- Files: `shared/lib/redemption-backstop-configs/queue-redeem.ts:101-162`.
- Verifier: diff proved notes are NOT identical; corrected the 3-line claim; extraction harder than implied. Checks: redemption-backstop consistency.

**`rbc-6` — defineRecordEntries (offchain) and defineCollateralRecordEntries share a core transform** `[duplication | low | small | low]`
- Problem: both wrap `Object.entries(configs).map(...)` into `RedemptionBackstopRegistryEntry[]`. They differ: offchain applies a uniform overrideReason+sourceFilePath to EVERY entry; collateral applies overrideReason ONLY to a fixed id set with a constant sourceFilePath. The shared part is just the map skeleton.
- Recommendation: add `defineRecordEntries(configs, { overrideReason?, overrideReasonForIds?, sourceFilePath })` to factory.ts handling the uniform case + an optional id->reason predicate. Marginal LOC win — optional.
- Files: `shared/lib/redemption-backstop-configs/offchain-issuer/index.ts:12-18`, `.../collateral-redeem.ts:35-45`.
- Verifier: differing signatures confirmed; divergent override logic limits benefit. Checks: redemption-backstop helper + consistency tests, `npm run check:redemption-backstops`, `npm run check:duplicate-exports`.

**`rbc-7` — Bare date string literals where a same-file named constant exists** `[consistency | low | trivial | low]`
- Problem: CONFIRMED actionable: queue-redeem.ts:81 `reviewedAt:"2026-03-23"` while `REVIEWED_QUEUE_REDEMPTION_AT="2026-03-23"` is on line 12 of the same file; usde-ethena.ts:15 and jupusd-jupiter.ts:15 use bare "2026-03-23" while shared.ts EXPORTS `REVIEWED_DIRECT_REDEMPTION_AT`. NOT actionable: psm-and-basket.ts 2026-05-11 (no constant of that value) and sdai-sky.ts 2026-05-17 (not imported).
- Recommendation: scope STRICTLY to the 3 confirmed sites. Do NOT touch psm-and-basket or sdai-sky (no matching constant; inventing one is scope creep).
- Files: `shared/lib/redemption-backstop-configs/queue-redeem.ts:81`, `.../stablecoin-redeem/usde-ethena.ts:15`, `.../stablecoin-redeem/jupusd-jupiter.ts:15`.
- Verifier: confirmed 3 sites map to existing constants; refuted the psm/sdai sites; narrowed scope. Checks: redemption-backstop consistency, `npm run check:redemption-backstops`.

**`rbc-10` — RedemptionCostScenarioConfig interface and RedemptionCostShapeSchema mirror the same 7 fields without a cross-reference** `[maintainability | low | trivial | low]`
- Problem: the interface (shared.ts:20-28) and `RedemptionCostShapeSchema` (schema.ts:91-99) both enumerate the same 7 optional fields with no structural link. A full `z.infer` would pull zod into the runtime type surface (schema.ts is test-only, shared.ts is runtime source of truth).
- Recommendation: LOW-risk option only — add a cross-ref comment on each side. Do NOT invert to `z.infer` (keeps runtime/validator separation). Comment-only.
- Files: `shared/lib/redemption-backstop-configs/shared.ts:20-28`, `.../schema.ts:91-99`.
- Verifier: field lists match, no cross-ref; rejected the z.infer path. Checks: redemption-backstop helper test.

**`rbc-11` — feeDescriptionLooksUndisclosed substring heuristic is fragile; auto-classification can silently misroute** `[maintainability | low | medium | medium]`
- Problem: 8 hardcoded substring checks; a novel phrasing falls through to `feeModelKind=documented-variable`. BUT the candidate's claims are inaccurate: (1) "no test coverage" is WRONG — `documentedVariableFee()` (the only public caller) IS tested including the auto-detect path; (2) "remove auto-detection" is a BEHAVIOR-CHANGING refactor touching ~20 call sites that flows into fee-confidence scoring — NOT behavior-preserving, risks moving live scores.
- Recommendation: demote to a low-priority note. Smallest safe improvement: add a direct unit test for `feeDescriptionLooksUndisclosed`'s boundary phrasings. Do NOT rip out the auto-detection — it is load-bearing; that is a separate score-impacting change requiring a re-baseline.
- Files: `shared/lib/redemption-backstop-configs/shared.ts:178-203`.
- Verifier: confirmed auto-detect IS tested; refuted "untested" and the remove-heuristic rec (score-changing); reframed to boundary tests only. Checks: redemption-backstop helper test.

**`rbc-12` — applyTrackedReviewedDocs call-sites lack cohort comments** `[readability | low | trivial | none]`
- Problem: taste-only. offchain-issuer/index.ts has 3 `applyTrackedReviewedDocs` calls: the first passes 23 ids with NO reviewedAt, the second uses `REVIEWED_REMEDIATION_AT`, the third `REVIEWED_NON_USD_BATCH_AT`. A reader cannot tell why ids are partitioned. Same in stablecoin-redeem + collateral-redeem.
- Recommendation: add a one-line comment above each call naming the review cohort and date. Comment-only. Bundle with rbc-1 if the review-dates module lands.
- Files: `shared/lib/redemption-backstop-configs/offchain-issuer/index.ts:49-95`, `.../collateral-redeem.ts:649-668`, `.../queue-redeem.ts:848`, `.../stablecoin-redeem/index.ts:134-138`.
- Verifier: 3 calls with mixed/absent date args confirmed; corrected line refs; pure readability. Checks: redemption-backstop consistency.


### Shared Types (`types-*`)

**`types-1` — StatusHealthValue type not exported; status-health literal union repeated across status.ts** `[duplication | medium | small | low]`
- Problem: `StatusHealthValueSchema = z.enum(["healthy","degraded","stale"])` is defined (880) but its inferred type is never exported. The literal `"healthy" | "degraded" | "stale"` appears 16 times: 13 as the bare 3-member union, 3 embedded in a 4-member `... | "unknown"` union (one of which is the already-named `YieldHealthFieldStatus`).
- Done 2026-06-13: exported `StatusHealthValue = z.infer<typeof StatusHealthValueSchema>`, added `StatusHealthOrUnknown`, and replaced the repeated status-health unions. Type-only; the Zod schemas remain the runtime authority.
- Files: `shared/types/status.ts:115-116,142,154,199-201,545,796-799,865,1059,1085,1158,880`.
- Verifier: schema is const not exported; no type exists; 16 hits verified; demoted high->medium (cosmetic). Checks: `npm run typecheck`, `npm run typecheck:worker`, `npm run lint`.

**`types-2` — TelegramDispatchCronMetadata partially mirrors TelegramDispatchCronResult; ParsedTelegramDispatchEventsDetected is a clean derivation candidate** `[duplication | low | small | low]`
- Problem: the "uniform 1:1 number->number|null clone" claim is INACCURATE: booleans stay non-null, `skipped` stays string|null, `safetyAlertSourceState` becomes enum|null, and `eventsDetected`/`perAlertType` become whole-object|null. A generic `NullableNumbers<T>` would mis-handle those.
- Done 2026-06-13: replaced only the clean all-number mirror with `type ParsedTelegramDispatchEventsDetected = { [K in keyof TelegramDispatchEventsDetected]: number | null }`. `TelegramDispatchCronMetadata` remains explicit because its nullability is mixed.
- Files: `shared/types/status.ts:405-414,480-489,491-527`.
- Verifier: read both + the parser; the 38-field 1:1 claim is wrong; only the ParsedTelegramDispatchEventsDetected derivation is clean. Checks: `npm run typecheck`, `npm run typecheck:worker`.

**`types-3` — Identical 7-element checkpoint array defined three times (DDR, DDRR, worker store)** `[duplication | low | trivial | low]`
- Problem: `DDR_ASSESSMENT_CHECKPOINT_VALUES` (depeg-resolver.ts:159) and `DDRR_CHECKPOINT_VALUES` (depeg-resolver-review.ts:26) are byte-identical 7-element `as const` tuples. The worker file redefines the same set as a hand-written union (`DdrAssessmentCheckpoint`).
- Done 2026-06-13: the worker store imports `DdrAssessmentCheckpoint` from `@shared/types/depeg-resolver`, and DDRR re-exports `DDRR_CHECKPOINT_VALUES = DDR_ASSESSMENT_CHECKPOINT_VALUES` with a semantic-domain comment.
- Files: `shared/types/depeg-resolver.ts:159-168`, `shared/types/depeg-resolver-review.ts:26-35`, `worker/src/lib/depeg-resolver-assessment-store.ts:4-11`.
- Verifier: all three byte-identical; worker import path verified; DDRR re-export is a tradeoff worth a comment. Checks: `npm run typecheck`, `npm run typecheck:worker`.

**`types-4` — Three DDRR review row schemas repeat ~5 identical publication fields** `[duplication | low | small | low]`
- Problem: the three row schemas each repeat publicPredictionId, assessmentId, predictionMethodologyVersion, predictionPolicyVersion, lockedAt. The "7-8 shared fields" count is OVERSTATED: `predictionState` differs per row, and `publishedAt`/`publicationSnapshotToken` are nullable in the invalidated row — only 5 fields are genuinely identical.
- Done 2026-06-13: extracted private `DdrrPublicationCoreSchema` for the five truly-identical fields and spread it into the three row schemas. The per-row divergent fields stayed inline.
- Files: `shared/types/depeg-resolver-review.ts:238-259,262-277,305-321`.
- Verifier: shared set is 5 fields, not 7-8; borderline against the simplicity rule; demoted medium->low. Checks: `npm run typecheck`, `npx vitest run shared/lib/depeg-resolver-review/__tests__/depeg-resolver-review.test.ts`.

**`types-5` — ReportCardGrade hand-copies BluechipGrade values + "NR"; BLUECHIP_GRADE_VALUES not exported** `[duplication | low | trivial | none]`
- Problem: `REPORT_CARD_GRADE_VALUES` is the 11 `BLUECHIP_GRADE_VALUES` + "NR", hand-copied; `ReportCardGrade` likewise restates the 11 members + "NR". `BLUECHIP_GRADE_VALUES` is file-private `const` in core.ts.
- Done 2026-06-13: exported `BLUECHIP_GRADE_VALUES`, derived `REPORT_CARD_GRADE_VALUES` from it plus `"NR"`, and changed `ReportCardGrade` to `BluechipGrade | "NR"`. No methodology label/version touched.
- Files: `shared/types/core.ts:777`, `shared/types/report-cards.ts:37-39`.
- Verifier: const not `export const`; 11+NR superset exact; clean trivial. Checks: `npm run typecheck`, `npm run typecheck:worker`.

**`types-6` — StressSignalDetailResponse interface manually restates its own Zod-inferred shape** `[simplification | low | trivial | none]`
- Problem: `StressSignalDetailResponseSchema` and the hand-written interface describe the same shape; `history[].signals` matches `SignalDetailSchema` (passthrough index signature), `amplifiers` matches `AmplifiersSchema`, `methodology` resolves to `MethodologyEnvelope`. `z.infer` is structurally identical.
- Done 2026-06-13: replaced the manual interface with `export type StressSignalDetailResponse = z.infer<typeof StressSignalDetailResponseSchema>`. The schema remains the runtime authority.
- Files: `shared/types/market.ts:791-814`.
- Verifier: field-by-field verified; switching to z.infer cannot change wire behavior; demoted medium->low. Checks: `npm run typecheck`, `npm run typecheck:worker`.

**`types-7` — CronRun.status typed as plain `string` despite a closed status enum** `[type-safety | low | small | low]`
- Problem: `CronRun.status` is `string`, but persisted values are a closed set: "ok"/"degraded"/"error" (cron-logger.ts:219 already types these) plus "skipped_locked"/"skipped_duplicate"/"skipped_running". cron-health.ts compares against these literals with no type guard.
- Recommendation: add `export type CronRunStatus = ...` and set `CronRun.status: CronRunStatus`. Point cron-logger.ts and the cron-lease local unions at it. CAUTION: `status` is heavily overloaded across the worker — scope strictly to CronRun. Verify all three configs typecheck.
- Files: `shared/types/status.ts:38-45`, `worker/src/lib/cron-logger.ts:219`, `worker/src/lib/status/cron-health.ts:403,407-409,436,439,451-452`.
- Verifier: closed set confirmed; tightening is behavior-preserving at runtime; corrected the cited path; demoted medium->low. Checks: `npm run typecheck`, `npm run typecheck:worker`.

**`types-8` — DeadStablecoin.contracts uses an anonymous {chain,address}[] instead of deriving from ContractDeployment** `[consistency | low | trivial | none]`
- Problem: `DeadStablecoin.contracts` is `{ chain: string; address: string }[]`, while `ContractDeployment` is `{chain,address,decimals}`. The "silent divergence" framing is weak — DeadStablecoin is a frozen graveyard record where decimals are irrelevant; decoupling is arguably correct.
- Recommendation: optional consistency tidy: `contracts?: Omit<ContractDeployment, "decimals">[]`. But NO existing `Omit<ContractDeployment>` precedent exists, and coupling a dead-coin record to the live shape may be undesirable. Taste-only — acceptable to leave as-is.
- Files: `shared/types/market.ts:129`, `shared/types/core.ts:425-429`.
- Verifier: shapes verified; no Omit precedent; divergence plausibly intentional; borderline taste, not a defect. Checks: `npm run typecheck`.

### Shared lib utilities (`slu-*`)

**`slu-2` — relative-time.ts redefines MINUTE_SECONDS/HOUR_SECONDS already exported from time-constants** `[duplication | low | trivial | none]`
- Problem: relative-time.ts:3-4 declare private `MINUTE_SECONDS=60` and `HOUR_SECONDS=3600`; time-constants.ts exports `SECONDS_PER_MINUTE=60` and `HOUR_SECONDS=3600`. relative-time.ts already imports `DAY_SECONDS` from there.
- Recommendation: extend the import to `{ DAY_SECONDS, HOUR_SECONDS, SECONDS_PER_MINUTE }`, delete the two consts, replace the ~6 `MINUTE_SECONDS` refs with `SECONDS_PER_MINUTE`.
- Files: `shared/lib/relative-time.ts:3-4`, `shared/lib/time-constants.ts:1,6`.
- Verifier: matching values confirmed; relative-time already imports from that module. Checks: `npm run test:unit -- relative-time`, `npm run typecheck`.

**`slu-3` — format.ts uses raw 60/3600 instead of imported time constants** `[readability | low | trivial | none]`
- Problem: `formatDuration` (184-185), `formatElapsedSeconds` (210-215), and `timeAgo` (223-227) use literal 60 and 3600; format.ts already imports only `DAY_SECONDS` from time-constants (which exports HOUR_SECONDS + SECONDS_PER_MINUTE).
- Recommendation: extend the import, replace the literals. Taste-level readability; `DAY_SECONDS` already imported so consistency is the only argument. Low priority.
- Files: `shared/lib/format.ts:181-228`.
- Verifier: literals + import confirmed; demoted to consistency tidy. Checks: `npm run test:unit -- format`, `npm run typecheck`.

**`slu-4` — isPlainObject in selector/snapshot.ts duplicates isRecord from type-guards.ts** `[duplication | low | trivial | none]`
- Problem: character-identical bodies (`value !== null && typeof === 'object' && !Array.isArray(value)`). `isPlainObject` is used 20 times; snapshot.ts does not import type-guards. type-guards `isRecord` uses `value != null` (loose) vs snapshot's `!== null` — semantically equivalent for the object narrowing.
- Recommendation: import `isRecord` from `@shared/lib/type-guards`, delete the local, rename the 20 call sites. The `Record<string,unknown>` return matches.
- Files: `shared/lib/selector/snapshot.ts:129-131`, `shared/lib/type-guards.ts:5-7`.
- Verifier: 20 usages + equivalent bodies; loose-vs-strict null behaviorally identical here. Checks: `npm run typecheck`, `npm run test:unit -- snapshot`.

**`slu-5` — timeAgo overlaps formatRelativeAgeSeconds — but the proposed wrapper is a risky rewrite of a tested public API** `[duplication | low | small | medium]`
- Problem: the overlap is real but `timeAgo` has 5 src call sites (not 2) plus a dedicated test suite pinning exact strings ('just now','5m ago',…). The proposed one-line wrapper passes a fractional value without the floor `timeAgo` applies — a non-obvious equivalence that must be proven against the tests.
- Recommendation: optional. If pursued, reimplement `timeAgo` as a wrapper over `formatRelativeAgeSeconds` and confirm the test cases pass byte-for-byte (watch the floor-to-minute and 'just now' threshold). Treat as a behavior-equivalence refactor; low ROI, defensible to skip.
- Files: `shared/lib/format.ts:220-229`, `shared/lib/relative-time.ts:53-84`.
- Verifier: corrected caller count (5, not 2); exact-string test suite exists; risk raised to medium. Checks: `npm run test:unit -- format`, `npm run test:unit -- relative-time`.

**`slu-7` — isFiniteNumber duplicated between format.ts and selector/snapshot.ts** `[duplication | low | trivial | low]`
- Problem: both define identical private `isFiniteNumber(value): value is number`. snapshot.ts uses it 6 times. type-guards.ts does NOT export `isFiniteNumber` (only `numberValue`, which returns number|null — a different shape, not a type predicate), so the "type-guards already encodes it" framing is partly misleading.
- Recommendation: add and export `isFiniteNumber` from type-guards.ts (new type predicate), import in both, delete the copies. Keep `numberValue` as-is. (Same shared addition as `cls-5`.)
- Files: `shared/lib/format.ts:5-7`, `shared/lib/selector/snapshot.ts:137-139`, `shared/lib/type-guards.ts:15-17`.
- Verifier: type-guards lacks an exported predicate; requires a NEW export. Checks: `npm run typecheck`, `npm run check:duplicate-exports`, `npm run test:unit -- format snapshot`.

**`slu-11` — BPS_PER_UNIT (10_000) defined privately in format.ts; raw 10_000 repeated in chains/health.ts and worker BPS sites** `[consistency | low | small | low]`
- Problem: format.ts:3 has private `BPS_PER_UNIT=10_000`; chains/health.ts:73 and three worker files hard-code 10_000 as the BPS denominator. (redemption-backstop-cost.ts:46 uses 10_000 as an unrelated dollar amount — must NOT be touched.) Two caveats: exporting from a display module into a scoring module + worker is awkward; worker is outside the root TS config.
- Recommendation: if pursued, define `BPS_PER_UNIT` once in a runtime-neutral math-constants module (NOT format.ts) and import into chains/health.ts + the three worker BPS sites — skipping the dollar literal. Low priority; weigh the multi-file/boundary churn.
- Files: `shared/lib/format.ts:3`, `shared/lib/chains/health.ts:73`, `worker/src/lib/native-peg-implied-prices.ts:41`, `worker/src/lib/price-divergence.ts:6`, `worker/src/lib/redemption-backstop-cost.ts:100,102`.
- Verifier: all BPS sites + the false-positive dollar literal confirmed; flagged format.ts is the wrong home + worker boundary. Checks: `npm run typecheck`, `npm run test:unit -- chains health`, `npm run test:merge-gate`.


### Worker API (`wapi-*`)

**`wapi-1` — Confidence-tier ternary duplicated inside buildAuditVerdictProvenanceStmt** `[duplication | low | trivial | none]`
- Problem: `verdict === "confirmed" || verdict === "repaired" ? "high" : verdict === "no_data" ? "low" : "medium"` is written character-for-character twice — once in the JSON payload (160) and once as the `confidence_tier` bind (180). A future mapping change must hit both or the persisted column and `public_json.confidenceTier` silently diverge.
- Recommendation: hoist `const confidenceTier = ...` before the `JSON.stringify` and reference it in both the payload and the bind.
- Files: `worker/src/api/audit-depeg-history.ts:158-184`.
- Verifier: identical ternary at 160 + 180; persisted-vs-payload divergence risk real; demoted medium->low. Checks: `npm run lint:typed`.

**`wapi-2` — Repeated Math.floor(Date.now()/1000) inside the auditEvents per-event loop** `[simplification | low | trivial | none]`
- Problem: `Math.floor(Date.now()/1000)` is recomputed at 1061/1086/1095/1107 — once per verdict branch inside the per-event loop — each passed as `nowSec`. Events in the same batch get slightly different timestamps.
- Recommendation: add `const nowSec = Math.floor(Date.now()/1000);` before the loop and pass it at all four sites. Do NOT touch line 800 (already hoisted, not in the loop).
- Files: `worker/src/api/audit-depeg-history.ts:1061-1107`.
- Verifier: 4 in-loop sites; only one branch fires per event so drift is sub-second; loop capped at 25; corrected the line-800 claim. Checks: `npm run lint:typed`.

**`wapi-3` — Worst-row accumulation loop inlined three times in audit-depeg-history.ts** `[duplication | low | small | none]`
- Problem: `let worst = keeper; for (const row of group) { if (Math.abs(row.peak_deviation_bps) > Math.abs(worst.peak_deviation_bps)) worst = row; }` is repeated verbatim in three functions.
- Recommendation: extract `pickWorstByAbsPeak(rows, seed)`. NOTE `projectSyntheticSplitDepegEvents` also sets `removedIds` in the same loop — keep that loop and replace only the worst-tracking lines, or call the helper before the removedIds loop. Distinct from scores `ddr-resolver-2`.
- Files: `worker/src/api/audit-depeg-history.ts:424-429,537-541,732-737`.
- Verifier: three verbatim sites confirmed; demoted medium->low. Checks: `npm run lint:typed`, `npx vitest run worker/src/api/__tests__/audit-depeg-history.test.ts`.

**`wapi-5` — INSERT OR REPLACE INTO supply_history statement duplicated four times** `[duplication | low | small | none]`
- Problem: the SQL `INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)` is written identically at 395/484/561/801. Each `.bind(...)` legitimately differs.
- Recommendation: extract `upsertSupplyHistoryStmt(db, coinId, snapshotDate, circulatingUsd, price)` returning the prepared+bound statement. Bind args pass through unchanged. No hard-rule impact (still circulating_usd, no price multiply).
- Files: `worker/src/api/backfill-supply-history.ts:394-398,481-487,558-564,798-804`.
- Verifier: four identical strings + divergent binds confirmed. Checks: `npm run lint:typed`, `npx vitest run worker/src/api/__tests__/backfill-supply-history.test.ts`.

**`wapi-6` — AUDIT_DEPEG_HISTORY_DEFAULT_LIMIT and AUDIT_DEPEG_HISTORY_MAX_LIMIT are identical (both 25)** `[naming | low | trivial | none]`
- Problem: both constants are 25, used only together in `parseAuditRequest`. A reader cannot tell whether default==max is a deliberate hard cap or accidental drift.
- Recommendation: lowest-risk action is a one-line comment stating the endpoint deliberately fixes default and max to the same 25-event cap. Collapsing to one constant is optional; prefer the comment.
- Files: `worker/src/api/audit-depeg-history.ts:31-32`.
- Verifier: both equal 25, referenced only in parseAuditRequest; leaning comment over collapse. Checks: `npm run lint:typed`.

**`wapi-7` — Magic literal 86400 used four times in og.tsx instead of the shared DAY_SECONDS constant** `[consistency | low | trivial | none]`
- Problem: `86400` appears raw four times (227 `7 * 86400`, 395 `now - 86400`, 495 `7 * 86400`, 510 `now - 86400`). `DAY_SECONDS` is the established constant; og.tsx neither imports nor uses it.
- Recommendation: `import { DAY_SECONDS } from "@shared/lib/time-constants";` and replace: 227/495 -> `7 * DAY_SECONDS`, 395/510 -> `now - DAY_SECONDS`.
- Files: `worker/src/api/og.tsx:227,395,495,510`.
- Verifier: 4 literals confirmed; mirrors accepted scores `safety-snapshot-worker-8`. Checks: `npm run lint:typed`.

**`wapi-9` — loadClosedDepegEvents and loadAllDepegEvents repeat the same 13-column projection** `[duplication | low | small | none]`
- Problem: both select the identical 13-column projection from `depeg_events`; they differ only in `WHERE ended_at IS NOT NULL` vs none and `ORDER BY`. Adding a column means editing two strings.
- Recommendation: extract `const DEPEG_ROW_COLUMNS = "..."` and build each query as `SELECT ${DEPEG_ROW_COLUMNS} FROM depeg_events ...` with the per-function WHERE/ORDER appended.
- Files: `worker/src/api/audit-depeg-history.ts:251-267`.
- Verifier: identical column lists confirmed. Checks: `npm run lint:typed`, `npx vitest run worker/src/api/__tests__/audit-depeg-history.test.ts`.

**`wapi-10` — og.tsx variantKind->label ternary duplicates src/lib/variant-display.ts shortLabel strings** `[duplication | low | small | low]`
- Problem: og.tsx (276-284) hard-codes the variant labels "Savings"/"Strategy"/"Risk-Abs"/"Bond" in a 4-branch ternary; the same strings are the `shortLabel` values in variant-display.ts. A rename requires editing two files.
- Recommendation: lowest-risk — add a comment pointing at variant-display.ts. A fuller fix (extract a runtime-neutral `VARIANT_SHORT_LABEL` map keyed by VariantKind) is viable but touches a frontend file and creates a module for four strings. NOT classification labels (no hard-rule conflict). Do NOT move the Tailwind badge/chip classes.
- Files: `worker/src/api/og.tsx:276-284`, `src/lib/variant-display.ts:12-35`.
- Verifier: four shortLabel strings duplicated; not classification labels; prefer the comment. Checks: `npm run lint:typed`.

**`wapi-12` — handleDepegOg and handleStabilityIndexOg DB-aggregation logic has no unit tests** `[test-gap | low | medium | none]`
- Problem: og.test.tsx renders the DepegCard/StabilityIndexCard COMPONENTS with hand-built data, but never invokes `handleDepegOg`/`handleStabilityIndexOg`, so the DB-aggregation is untested: the band switch + `coinsAtPeg` clamp, recoveredToday/newToday counting, the sparkline `< 2` pad, and ATH/ATL/avg fallbacks to psiScore.
- Recommendation: add handler-level tests (mock the D1 db like the existing peg-analytics cache-hit tests) for the band distribution, coinsAtPeg clamp, sparkline pad, and null-fallbacks. Reuse the satori font setup.
- Files: `worker/src/api/og.tsx:393-487,493-567`, `worker/src/api/__tests__/og.test.tsx:382-403,464-490`.
- Verifier: card-level coverage exists but the handler aggregation gap is genuine; demoted medium->low. Checks: `npx vitest run worker/src/api/__tests__/og.test.tsx`.

### Telegram Webhook (`tw-*`)

**`tw-1` — Duplicate same-signature replyToChat wrapper in action-runner and telegram-webhook** `[duplication | low | small | low]`
- Problem: both files define a private `replyToChat(db, chatId, message, botToken, options)` that is a pure passthrough to `sendAuditedTelegramReply`, which both already import. Identical arity — saves no arguments, pure indirection.
- Recommendation: delete both wrappers and inline `sendAuditedTelegramReply`. NOT one-line deletions: ~6 call-site edits (action-runner 306/309/338/360, telegram-webhook 342/345) plus 2 deletions.
- Files: `worker/src/api/webhook-commands/action-runner.ts:388-396`, `worker/src/api/telegram-webhook.ts:977-985`.
- Verifier: both pure passthroughs; corrected the "trivial" framing (6 call sites); demoted medium->low. Checks: `typecheck:worker`, `lint`.

**`tw-2` — Repeated private-chat conditional mini-app-keyboard idiom across 7+ command handlers** `[duplication | low | small | low]`
- Problem: 7+ handlers repeat `if (ctx.chatType === 'private') { await ctx.replyToChatWithMarkup(msg, { replyMarkup: <builder> }); return; } await ctx.replyToChat(msg)`. The branch decision is duplicated; a change must touch every file.
- Recommendation: add `replyWithOptionalMiniApp(ctx, message, markup)` performing the branch, taking the already-built markup as a parameter (the builder differs per handler). Replace the 7+ sites.
- Files: `worker/src/api/webhook-commands/{mute,unsnooze,help,why,coverage,unmutehours,timezone}.ts`.
- Verifier: idiom real, branch structurally identical, markup differs per handler so the helper must accept markup; demoted medium->low. Checks: `typecheck:worker`, `lint`.

**`tw-3` — isGroupChat local wrapper is a pure passthrough over imported isGroupChatType** `[dead-code | low | trivial | none]`
- Problem: `isGroupChat` returns `isGroupChatType(chatType)` with no transformation; `isGroupChatType` is already imported. 4 call sites.
- Recommendation: delete `isGroupChat` and replace its 4 call sites (360, 525, 530, 649) with direct `isGroupChatType(chatType)`.
- Files: `worker/src/api/telegram-webhook.ts:701-703`.
- Verifier: pure passthrough; 4 sites confirmed. Checks: `typecheck:worker`, `lint`.

**`tw-5` — console.error in quicksub callback bypasses the structured logTelegramEvent convention** `[consistency | low | trivial | none]`
- Problem: quicksub.ts:52 uses `console.error(...)` on the D1-write failure path — the only `console.error` among webhook-callbacks. Every other mutating callback routes failures through `logTelegramEvent`. quicksub doesn't use `runCallbackMutation`, so it logs out-of-band, invisible to the structured layer.
- Recommendation: replace `console.error` with `logTelegramEvent({ message: 'quicksub write failed', chatId, userId: cb.from?.id ?? null, action: 'quicksub', err: ... })`. Mirror `_shared.ts:180-186`. Optional additive telemetry gated on owner intent.
- Files: `worker/src/api/webhook-callbacks/quicksub.ts:52`.
- Verifier: sole console.error confirmed; observability gap not a runtime defect; demoted medium->low. Checks: `typecheck:worker`, `lint`.

**`tw-7` — variantKind-to-OG-label mapping is a local chained ternary with no exhaustiveness guard** `[maintainability | low | small | low]`
- Problem: og.tsx:276-284 maps variantKind to an OG label via a 4-branch ternary. `VARIANT_KIND_VALUES` has exactly those 4 values, so currently complete, but adding a 5th yields a silent null.
- Recommendation: extract to a typed `const Record<VariantKind, string | null>` (forces a compile error on new values). NOT classification labels and differs from filter-tags.ts labels — keep local, not a hard-rule violation.
- Files: `worker/src/api/og.tsx:276-284`.
- Verifier: 4-branch ternary + 4-member enum confirmed; filter-tags has a separate map; genuine but low-value. Checks: `typecheck:worker`.

**`tw-10` — GATED_SENTINEL string is a hidden cross-function reply-suppression protocol in action-runner** `[readability | low | medium | medium]`
- Problem: `GATED_SENTINEL = '\0__gated__'` is returned by `persistAndPromptBulkConfirm`/`onComplete` and checked in the reply closure to suppress a duplicate send. The contract spans two functions, documented only in a comment. The `\0` prefix makes a user-visible leak impossible.
- Recommendation: optional readability refactor — have `onComplete`/`persistAndPromptBulkConfirm` return `string | null` (null = "already replied"). BLAST-RADIUS CAVEAT: `onComplete`'s return type is consumed by `runCoinResolutionFlow` (a separate module) — changing the contract touches that module's typing + tests. Medium risk; pursue only if that contract is being revised anyway.
- Files: `worker/src/api/webhook-commands/action-runner.ts:270-380`.
- Verifier: sentinel definition + uses confirmed; understated blast radius corrected; demoted to low/medium-risk. Checks: `typecheck:worker`.

### Price / Cron jobs (`pc-*`)

**`pc-2` — BENCHMARK_PROVIDER_ORDER and BENCHMARK_DEGRADATION_ORDER diverge in AUD position without a comment** `[maintainability | low | trivial | none]`
- Problem: `BENCHMARK_PROVIDER_ORDER` lists AUD at index 5; `BENCHMARK_DEGRADATION_ORDER` lists AUD at index 7. Both contain the same 11 keys; only AUD's position differs. No comment explains the deliberate difference.
- Recommendation: add a one-line comment above `BENCHMARK_DEGRADATION_ORDER` noting it intentionally differs only in AUD's rank (the two serve fetch-order vs reporting/degradation priority). Do NOT derive one from the other. Confirm the AUD rationale before asserting it.
- Files: `worker/src/cron/fetch-tbill-rate.ts:1021-1047`.
- Verifier: both arrays + AUD divergence verified (index 5 vs 7, not 5 vs 8); comment-only fix safe; rationale should be confirmed.

**`pc-3` — snapshot-chain-supply inlines daily-dedup cache read instead of a shared helper** `[consistency | low | small | low]`
- Problem: snapshot-supply.ts uses `getCompletedSupplySnapshot()` (error-safe JSON.parse + numeric snapshotDate validation). snapshot-chain-supply.ts hand-rolls getCache + try/JSON.parse + snapshotDate extraction against a different cache key, with no `Number.isFinite` check and discarding `updatedAt`.
- Recommendation: generalize `getCompletedSupplySnapshot` to accept a `cacheKey` parameter and reuse it with `'snapshot-chain-supply:last-write'`. Behavior-preserving for the equality check, additionally hardens chain-supply.
- Files: `worker/src/cron/snapshot-chain-supply.ts:32-43`, `worker/src/lib/supply-snapshot-completion.ts`.
- Verifier: read all three; inline copy genuinely duplicates parse/validate; low-severity, behavior-preserving. Checks: `npm run check:cron-abort-contract`, worker vitest.

**`pc-4` — snapshot-chain-supply has a redundant if (stmts.length > 0) guard after an empty-guard early return** `[dead-code | low | trivial | none]`
- Problem: line 74 returns early when `stmts.length === 0`. Lines 83-91 then wrap batchExecute/setCache in `if (stmts.length > 0)`, which can never be false (stmts not mutated between 74 and 83). snapshot-supply.ts has the same guard but it is NOT preceded by an empty-return — that one is live.
- Recommendation: in snapshot-chain-supply.ts only, remove the `if (stmts.length > 0)` wrapper (83) + closing brace (91), de-indenting the body. Do NOT touch snapshot-supply.ts.
- Files: `worker/src/cron/snapshot-chain-supply.ts:74-91`.
- Verifier: early return makes 83 unreachable-false; verified the look-alike guard in snapshot-supply is live. Worker vitest after.

**`pc-7` — cache-staleness threshold 1200 is an unnamed magic number in two snapshot crons** `[maintainability | low | trivial | none]`
- Problem: snapshot-supply.ts:62 and snapshot-chain-supply.ts:21 both hard-code `cacheAge > 1200` with the value echoed in log strings. Two independent crons with independent freshness budgets that happen to share 1200; snapshot-supply also has its own 600s threshold.
- Recommendation: lowest-touch — a module-level `const CACHE_MAX_AGE_SEC = 1200;` in each file. Do NOT over-engineer into a shared cross-file constant (the budgets are not necessarily coupled). Marginal; acceptable to skip.
- Files: `worker/src/cron/snapshot-supply.ts:62`, `worker/src/cron/snapshot-chain-supply.ts:21`.
- Verifier: both literals + the 600 threshold verified; recommend the per-file (not shared) form.

**`pc-8` — 86_400_000 ms-per-day literal in parseBoeSoniaCompoundedIndexCsv not using shared DAY_MS** `[readability | low | trivial | low]`
- Problem: lines 186, 190 use the literal `86_400_000`. `DAY_MS` (= 86_400_000) is exported from time-constants and importable via `@shared/lib/time-constants`; fetch-tbill-rate.ts doesn't import it.
- Recommendation: `import { DAY_MS } from '@shared/lib/time-constants';` and replace both literals. Value-identical, respects the @shared boundary.
- Files: `worker/src/cron/fetch-tbill-rate.ts:186-190`.
- Verifier: `DAY_MS===86_400_000` confirmed; trivial value-preserving. Checks: fetch-tbill-rate.test.ts, `npm run check:shared-types-imports`.

**`pc-9` — parseBoeSoniaCsv is exported but has no production callsite (only its own test)** `[dead-code | low | trivial | none]`
- Problem: `parseBoeSoniaCsv` (spot SONIA) is referenced only by its definition + the test file. GBP now resolves via `parseBoeSoniaCompoundedIndexCsv`. `check:unused-code` does NOT flag it (test imports count as usage).
- Recommendation: do NOT delete on a verifier's word — flag pre-existing dead code per project rules. Lowest-risk: add a comment noting it is the spot-SONIA fallback currently not wired in. If the owner confirms it is superseded, delete it + its test block.
- Files: `worker/src/cron/fetch-tbill-rate.ts:148-160`.
- Verifier: no non-test callsite; CI won't catch; flag-don't-delete per surgical-changes rule.


### Worker Cron — blacklist / dex-liquidity (`worker-*`)

**`worker-4` — backfillAmounts has near-identical `UPDATE blacklist_events` attempt-tracking fragments** `[duplication | low | small | low]`
- Problem: only TWO of the three cited fragments genuinely share shape: the wasLegacyDerived path (661-668) and the regular failure path (670-680) differ only by the trailing `amount_status = ?` SET clause. The no-config path (571) is NOT a true peer (runs before `attemptAt` is defined, different binds/scope). The "3 identical fragments" claim is overstated.
- Recommendation: if extracted, scope a small private helper to the two failure-path UPDATEs only: `buildAttemptUpdateStmt(db, id, attemptAt, errorClass, provider, status?)` appending `amount_status` when `status` is provided. Leave the no-config path alone. Marginal value.
- Files: `worker/src/cron/blacklist/amount-recovery.ts:656-681`.
- Verifier: corrected count (2 peers, not 3) + line range. Checks: `check:sql-safety`, `typecheck`.

**`worker-6` — buildLatestBlacklistRows is dead production code** `[dead-code | low | trivial | low]`
- Problem: `buildLatestBlacklistRows` is referenced only by its own declaration + `row-preparation.test.ts`. The live current-balance path uses `buildCurrentBalanceSnapshotRows`. Its own JSDoc admits it is "retained for narrow historical tests". `check:unused-code` does not catch test-only exports.
- Recommendation: either inline `buildLatestBlacklistRows` into the test and drop the export, or update the one test to assert against `buildCurrentBalanceSnapshotRows` and delete the function.
- Files: `worker/src/cron/blacklist/row-preparation.ts:24-34`.
- Verifier: only non-test reference is the test; CI won't flag; risk none->low (consuming test must migrate). Checks: `check:unused-code`, `typecheck`, `test:merge-gate`.

**`worker-8` — buildSymbolLookups third ACTIVE_STABLECOINS pass can fold into a flat O(n) map walk** `[performance | low | small | low]`
- Problem: the third loop (391-397) re-scans ACTIVE_STABLECOINS and re-calls `getTrackedContracts(meta)` only to read back `globalAddressOwners` (populated in the second loop) and set `addressToId` for single-owner addresses — a third full traversal of 400+ coins recoverable from a single pass over the already-built map.
- Recommendation: replace with a flat walk: `for (const [address, owners] of globalAddressOwners) if (owners.size === 1) addressToId.set(address, [...owners][0]);`. Behavior-identical. Do NOT touch the second loop's source/precedence logic.
- Files: `worker/src/cron/dex-liquidity/pool-helpers.ts:391-398`.
- Verifier: third loop only consumes globalAddressOwners keyed by address; rewrite preserves output; runs once per cron. Checks: `typecheck`, `check:worker-boundary`.

**`worker-11` — inferHistoricalBalanceProvider called redundantly at function entry and in fall-through** `[simplification | low | trivial | low]`
- Problem: in `recoverEvmAmountFromEventOrHistory`, `lastProvider` is assigned `inferHistoricalBalanceProvider(...)` at 401, then unconditionally reassigned at 428 with identical arguments. The line-401 value is never read on any path that doesn't overwrite it.
- Recommendation: remove the redundant call at 401 (keep the single call at 428 where it is consumed). Verify line 405's `onProviderAttempt?.(lastProvider)` in the destroy branch still fires with `'event_receipt'` (set at 404).
- Files: `worker/src/cron/blacklist/amount-recovery.ts:399-429`.
- Verifier: traced both branches; 401's result is dead on every path; risk low (must not disturb destroy-branch ordering). Checks: `typecheck`.

### Worker Cron — dispatch / status / recap (`w-dispatch-*`, `w-status-*`, `w-recap-*`)

**`w-dispatch-1` — suppressedSafetyChangesAtSeed computed twice with identical inputs** `[duplication | low | small | low]`
- Problem: `countSuppressedSafetyChangesAtSeed(snapshotState, getSymbol)` is a pure function called twice with the same args: dispatch-telegram-alerts.ts:256 and dispatch-telegram-events.ts:83 (inside `buildTelegramDispatchEvents`). events.ts returns the value, but neither destructuring site in alerts.ts reads it back — the line-256 local is used everywhere.
- Recommendation: drop the internal compute at events.ts:83 and remove the field from the `TelegramDispatchEvents` interface + return object. Do NOT have alerts.ts destructure it: the eventless fast path needs the value without calling `buildTelegramDispatchEvents`, so the line-256 compute is the correct single source.
- Files: `worker/src/cron/dispatch-telegram-alerts.ts:256`, `worker/src/cron/dispatch-telegram-events.ts:83,270`.
- Verifier: pure double-call confirmed; corrected the candidate's backwards destructure recommendation. Checks: `typecheck:worker`, `npm run test --silent -- dispatch-telegram`.

**`w-dispatch-2` — hasDetectedTelegramEvents helper is redundant with eventCount > 0** `[dead-code | low | trivial | none]`
- Problem: `eventCount` (341-347) sums the lengths of the exact same six arrays that `hasDetectedTelegramEvents` checks for >0. Array lengths are non-negative, so `eventCount>0` is equivalent. `eventCount` is computed before the single `hasDetectedTelegramEvents` call.
- Recommendation: delete `hasDetectedTelegramEvents` (179-195) and replace the call at 368 with `const hasEvents = eventCount > 0;`.
- Files: `worker/src/cron/dispatch-telegram-alerts.ts:179-195,341-347,368-375`.
- Verifier: single call site; same six arrays; equivalence holds. Checks: `typecheck:worker`, `npm run test --silent -- dispatch-telegram`.

**`w-dispatch-3` — MAX_MESSAGES_PER_RUN is a single-use local alias for an imported constant** `[dead-code | low | trivial | none]`
- Problem: line 71 `const MAX_MESSAGES_PER_RUN = TELEGRAM_MAX_MESSAGES_PER_RUN;` used only at 684. `TELEGRAM_MAX_MESSAGES_PER_RUN` is already imported.
- Recommendation: delete line 71 and pass `maxMessagesPerRun: TELEGRAM_MAX_MESSAGES_PER_RUN` directly.
- Files: `worker/src/cron/dispatch-telegram-alerts.ts:71,684`.
- Verifier: appears only at definition + one use; not flagged by check:unused-code (used local). Checks: `typecheck:worker`.

**`w-dispatch-4` — Three cron progress wrappers inject providerFamily + phase into metadata** `[duplication | low | small | medium]`
- Problem: `reportTelegramDispatchProgress`, `reportDigestProgress`, `reportDexLiquidityProgress` each wrap `reportCronProgress`. NOT identical: the Telegram version makes `providerFamily` optional with a default; the digest version requires it; the dex version threads `ctx.reportProgress`. Three different subsystems.
- Recommendation: low priority, risky to over-consolidate. The divergent default semantics + ctx-threading mean a single helper needs an awkward signature. Per the no-speculative-abstraction rule, recommend keep-as-is unless a broader cron-progress refactor is undertaken.
- Files: `worker/src/cron/dispatch-telegram-alerts.ts:81-103`, `worker/src/cron/digest/progress.ts:4-26`, `worker/src/cron/dex-liquidity/orchestrator.ts:226-248`.
- Verifier: shapes similar but real divergences; severity/risk recalibrated down, reframed toward leaving it. Checks: `typecheck:worker`, `npm run test --silent -- dispatch-telegram digest dex-liquidity`.

**`w-status-1` — buildDiscrepancy called twice with identical params just to read .hasDivergence** `[duplication | low | small | low]`
- Problem: `buildDiscrepancy` is invoked at 679 with `consecutiveDivergent=0` only to read `discrepancyObservation.hasDivergence` for `updateDiscrepancyObservation`. The identical call repeats at 699 with the real `consecutiveDivergent`. `hasDivergence` is independent of `consecutiveDivergent` (depends only on overallStatus/probe/now).
- Recommendation: compute `hasDivergence` once without the throwaway call — inline the predicate (probe fresh AND `abs(SEVERITY[effectiveStatus]-SEVERITY[probeStatus])>=1`) or export a small `hasDivergence` helper, then keep only the single `buildDiscrepancy` at 699.
- Files: `worker/src/cron/status-self-check.ts:679-711`.
- Verifier: read status-discrepancy-view.ts; hasDivergence computed without consecutiveDivergent; redundancy accurate. Checks: `typecheck:worker`, `npm run test --silent -- status-self-check`.

**`w-status-2` — ADMIN_PROBE_PATHS.includes(path) evaluated three times in probePathInternally** `[simplification | low | trivial | none]`
- Problem: `ADMIN_PROBE_PATHS.includes(path)` is called three times (432, 434, 447); `path` and the array are not mutated between them.
- Recommendation: add `const isAdminPath = ADMIN_PROBE_PATHS.includes(path);` at the top of the try block and replace the three call sites.
- Files: `worker/src/cron/status-self-check.ts:432,434,447`.
- Verifier: three calls, no mutation between. Checks: `typecheck:worker`.

**`w-status-3` — percentile95 duplicates percentile(_, 0.95) with a single call site** `[simplification | low | trivial | none]`
- Problem: `percentile95` reimplements `percentile` with quantile hardcoded to 0.95, called once. The generic `percentile` sits directly above and clamps quantile to [0,1] (no difference for 0.95).
- Recommendation: delete `percentile95` and call `percentile(latencies, 0.95)`. Output identical.
- Files: `worker/src/cron/status-self-check.ts:112-117,132`.
- Verifier: one call site; same idx; no other caller. Checks: `typecheck:worker`, `npm run test --silent -- status-self-check`.

**`w-recap-1` — weekly-recap re-declares DEWS_BAND_RANK that already exists as a shared export** `[duplication | low | trivial | low]`
- Problem: the candidate's recommendation is WRONG. `DEWS_BAND_RANK` must NOT be replaced with `THREAT_BAND_ORDER`: the latter is `Record<ThreatBand, number>` while `dewsStress.bandChanges` from/to fields are typed `string` — indexing a `Record<ThreatBand,number>` with a string raises TS7053 under strict. The `Record<string, number>` annotation is load-bearing. The real issue: an identical exported `DEWS_BAND_RANK` already exists at `digest-intelligence-utils.ts:10`.
- Recommendation: do NOT reference `THREAT_BAND_ORDER` (breaks typecheck). If consolidating, import the existing `DEWS_BAND_RANK` from `./daily-digest/digest-intelligence-utils` and delete the local line 76. Optional; leaving it is defensible.
- Files: `worker/src/cron/weekly-recap.ts:76,356,357`, `worker/src/cron/daily-digest/digest-intelligence-utils.ts:10`.
- Verifier: reproduced TS7053; found the pre-existing exported const; the candidate's rec would break the build. Checks: `typecheck:worker`.

**`w-recap-2` — buildWeeklyRiskLeaderboard sort priority lacks a direct unit test** `[test-gap | low | small | low]`
- Done 2026-06-13: added an integration-style weekly recap fixture that inspects the generated prompt and locks the leaderboard order: unsuppressed signals before suppressed ones, critical depegs before higher-severity non-critical depegs, and suppressed rows retaining their suppression reason.
- Problem: the leaderboard sort (suppression last > critical first > severityScore desc > impactScore desc) decides the P1 lead. `buildWeeklyRiskLeaderboard` is not exported and is exercised only through integration tests. One test covers the critical-lead branch indirectly; the suppression-last tiebreak and severity-vs-impact ordering are not directly asserted.
- Recommendation: optional. Assert ordering via the prompt body in a new `generateWeeklyRecap` fixture (suppressed yield anomaly + non-critical depeg + critical depeg), matching the existing integration-test style (the function is file-private).
- Files: `worker/src/cron/weekly-recap.ts:446-452`, `worker/src/cron/__tests__/weekly-recap.test.ts`.
- Verifier: function never imported directly; critical-lead covered indirectly; tiebreaks untested; demoted to low. Checks: `npm run test --silent -- weekly-recap`.


### Worker Cron infrastructure — lease/logger/handlers (`w-cron-*`)

**`w-cron-1` — Identical cacheKeySegment() duplicated in cron-lease.ts and cron-logger.ts** `[duplication | low | trivial | none]`
- Problem: both files define a private `cacheKeySegment(value: string): string` with byte-for-byte identical bodies.
- Recommendation: export `cacheKeySegment` from cron-lease.ts (the dependency root) and import in cron-logger.ts. IMPORTANT: this direction, NOT the reverse — cron-logger already imports from cron-lease, so exporting from the logger would create a circular import.
- Files: `worker/src/lib/cron-lease.ts:251-254`, `worker/src/lib/cron-logger.ts:124-127`.
- Verifier: identical bodies; cron-logger imports from cron-lease so cron-lease is the source; candidate's direction would cycle. Checks: `npm run typecheck:worker`, `npm run lint`.

**`w-cron-2` — sleep() duplicated in cron-lease.ts and cron-logger.ts** `[duplication | low | trivial | none]`
- Problem: a private `sleep(ms)` returning `new Promise((resolve) => setTimeout(resolve, ms))` exists identically in both.
- Recommendation: export `sleep` from cron-lease.ts and import in cron-logger.ts. The candidate's "move sleep above sleepWithAbort" step is unnecessary (function declarations hoist). Do only the export/dedupe.
- Files: `worker/src/lib/cron-lease.ts:271-273`, `worker/src/lib/cron-logger.ts:56-58`.
- Verifier: identical bodies; hoisting makes the "move before" step moot. Checks: `npm run typecheck:worker`.

**`w-cron-3` — CRON_TIMEOUT_MS[job] lookup duplicated on adjacent lines in runCronWithLease** `[simplification | low | trivial | none]`
- Problem: 771 computes `timeoutMs = CRON_TIMEOUT_MS[job] ?? DEFAULT_CRON_TIMEOUT_MS`; 772 re-writes the same lookup inside `Math.ceil(... / 1000)`.
- Recommendation: on 772 reuse the local: `const timeoutSec = Math.ceil(timeoutMs / 1000);`.
- Files: `worker/src/lib/cron-lease.ts:771-772`.
- Verifier: verbatim duplication confirmed. Checks: `npm run typecheck:worker`.

**`w-cron-4` — Four single-task slot-group handlers should use runSingleScheduledJob** `[duplication | low | small | low]`
- Problem: daily-0810, monthly-yield-audit, half-hourly, yield-supplemental each define a private `build*SlotGroups` returning exactly one serial group with one task, then call `runScheduledSlotGroups`. `runSingleScheduledJob(runtime, slotLabel, task)` already encapsulates that.
- Recommendation: replace the `build*SlotGroups` + `runScheduledSlotGroups` pair with a direct `runSingleScheduledJob(...)`, preserving `job`/`run`/`errorMessage` (monthly-yield-audit + yield-supplemental carry an errorMessage). Do NOT touch the multi-job callers. Both paths funnel through `runBestEffortScheduledJobWithOutcome` so output is preserved.
- Files: `worker/src/handlers/scheduled/{daily-0810,monthly-yield-audit,half-hourly,yield-supplemental}.ts`.
- Verifier: each has exactly one `job:`; the rest are multi-job; output preserved; demoted medium->low. Checks: `npm run typecheck:worker`, `npm run check:cron-abort-contract`, `npm run check:cron-connections`.

**`w-cron-5` — Four copy-pasted try/catch reconciliation blocks in five-minute-telegram.ts** `[duplication | low | small | low]`
- Problem: four structurally identical try/catch blocks (commands, profile, menu, webhook) each call a `reconcile*` fn, log success via `logReconciliationSuccess` when `result.attempted`, and on catch call `logTelegramEvent` with a constant message + action slug.
- Recommendation: extract `runTelegramReconciliation(action, fn, onSuccessDetails?)`. NOT fully identical: menu and webhook success calls pass extra result-derived details, and the webhook fn takes additional options — so the helper must accept a success-details extractor `(result) => Record<string,unknown>`, not a fixed shape.
- Files: `worker/src/handlers/scheduled/five-minute-telegram.ts:113-177`.
- Verifier: four blocks confirmed; refined the extraction shape (menu/webhook thread details). Checks: `npm run typecheck:worker`.

**`w-cron-6` — PER_JOB_LEASE_OPTIONS constant declared mid-import-block in context.ts** `[readability | low | trivial | none]`
- Problem: `PER_JOB_LEASE_OPTIONS` (11-14, with doc comment 4-10) sits between the import on line 2 and the import block on 15-24, interrupting imports-first ordering.
- Recommendation: optional tidy — move the doc comment + declaration below all imports. No behavior change. No import-order lint rule enforces this, so genuinely optional.
- Files: `worker/src/handlers/scheduled/context.ts:11-14`.
- Verifier: the const breaks import grouping; no TDZ issue; an implementer may reasonably skip it. Checks: `npm run lint`.

**`w-cron-7` — Redundant onSettledSuccess async wrapper in mint-burn-slot.ts** `[simplification | low | trivial | none]`
- Problem: `onSettledSuccess: options.onSettledSuccess ? async (...) => options.onSettledSuccess?.(...) : undefined` wraps the callback in a new async arrow. The ternary already proves it is defined, and both option types have the identical signature.
- Recommendation: replace with `onSettledSuccess: options.onSettledSuccess`. Direct pass-through is type-correct and behavior-identical.
- Files: `worker/src/handlers/scheduled/mint-burn-slot.ts:37-39`.
- Verifier: both interfaces declare the identical signature; pure redundancy. Checks: `npm run typecheck:worker`.

**`w-cron-9` — digest-trigger-poll.ts uses anonymous structural casts where CronResult suffices** `[type-safety | low | trivial | none]`
- Problem: `result` is `CronResult | void`; the file casts it as `{ status?: string } | null | undefined` (85, 105) and `{ metadata?: unknown }` / `{ metadata: string }` (110-111) instead of the imported `CronResult`, which already declares both fields.
- Recommendation: replace the anonymous casts with `(result as CronResult | null | undefined)?.status` / `.metadata`. Keep the `null|undefined` union so the `void` case stays expressible; the `.startsWith` guard remains needed.
- Files: `worker/src/handlers/scheduled/digest-trigger-poll.ts:85,105,110-111`.
- Verifier: CronResult declares both fields; behavior-preserving (compile-time only); medium confidence (cosmetic, low payoff). Checks: `npm run typecheck:worker`.

**`w-cron-10` — Inconsistent single-job dispatch patterns across scheduled handlers** `[consistency | low | small | low]`
- Problem: three patterns coexist for single-job slots: (a) `runSingleScheduledJob`, (b) `build*SlotGroups` + `runScheduledSlotGroups` (the w-cron-4 files), (c) raw `runtime.runLeasedCron` + manual `buildScheduledSlotSummary` (hourly-blacklist, thirty-minute-dex-discovery). Pattern (c) has NO try/catch, so a thrown error propagates out — marking the scheduled event as failed; patterns (a)/(b) swallow it into a 'thrown' summary and the event succeeds.
- Recommendation: the (a)/(b) consolidation is covered by w-cron-4. For (c): the error-propagation difference is real but whether it is deliberate is unverified. Do NOT migrate (c) blindly (would silently change fail-the-event to swallow-and-degrade). Confirm intent; if intentional, add a one-line comment.
- Files: `worker/src/handlers/scheduled/{hourly-blacklist,thirty-minute-dex-discovery}.ts`.
- Verifier: pattern inventory verified; error-semantics divergence genuine; reduced to documentation-only (intent unconfirmed); (a)/(b) dropped as duplicate of w-cron-4. Checks: `npm run typecheck:worker`.

### Worker Stores — depeg-resolver / caches (`worker-store-*`)

**`worker-store-1` — assertNoAmbiguousNearbyIncident is unreachable dead code** `[dead-code | low | trivial | low]`
- Problem: `assertNoAmbiguousNearbyIncident` (515-553) runs only after `linkUnsealedNearbyIncident` returned null (809-814). Both queries use an identical SELECT with the same WHERE clause + binds. `linkUnsealedNearbyIncident` returns null ONLY when its `.first()` row is null; with identical predicate+binds, the assert's `.first()` must also be null, so its throw branch is unreachable.
- Recommendation: delete `assertNoAmbiguousNearbyIncident` (515-553) + its call at 814. Before deleting, confirm the sealed-tail error path is in `linkSealedNearbyIncidentTail` (it is). Purely subtractive (the throw is unreachable, so no existing test exercises it).
- Files: `worker/src/lib/depeg-resolver-incident-store.ts:515-553` (called at 814).
- Verifier: both queries share predicate + bind order; the assert's throw is structurally unreachable; risk none->low (confirm sealed-tail path). Checks: `npm run test:merge-gate`.

**`worker-store-2` — Local stableJsonStringify duplicates shared stableJsonStringifyV1** `[duplication | low | small | medium]`
- Problem: the local `stableJsonStringify` (251-271) overlaps `stableJsonStringifyV1` but they are NOT identical: the local throws on non-safe-integer numbers; the shared `assertPlainHashValue` accepts any finite number and rejects Date/Map/Set/bigint/non-plain-objects. For the ACTUAL inputs (strings + integers only) both produce byte-identical canonical JSON.
- Recommendation: replace the local with an import of `stableJsonStringifyV1` from `@shared/lib/depeg-resolver/hash` and delete 251-271. CAUTION: this string feeds `sha256Hex` to derive persisted `incident_key`/`source_fingerprint` — a hash-input boundary. Output-identical for current payloads, but any future non-integer number would hash instead of throw. Snapshot-verify incident keys via the ddrv2-store tests.
- Files: `worker/src/lib/depeg-resolver-incident-store.ts:251-271` (used 281 & 298), `shared/lib/depeg-resolver/hash.ts:56-79`.
- Verifier: read both; corrected "identical" to "diverge on non-safe-integer"; risk low->medium (hash-stability boundary); behavior-preserving for current inputs only. Checks: `npm run test:merge-gate`.

**`worker-store-5` — asRecord / recordValue helper defined three times across the slice** `[duplication | low | trivial | low]`
- Problem: grep finds exactly three definitions — `asRecord` in alert-safety-source-cache.ts + yield-history-cleanup.ts (identical), and `recordValue` in depeg-resolver-publication-store.ts (same body, different name).
- Recommendation: prefer reusing the shared `isRecord` from `@shared/lib/type-guards` rather than introducing a fourth worker-local `asRecord` (keeps shared/lib runtime-neutral). The scores audit (~line 133) steers toward the same target and excludes `depeg-resolver/utils.ts`'s `recordValue` as a different-signature case — coordinate.
- Files: `worker/src/lib/alert-safety-source-cache.ts:98-102`, `worker/src/lib/depeg-resolver-publication-store.ts:384-386`, `worker/src/lib/yield-history-cleanup.ts:9-13`.
- Verifier: exactly 3 identical-body definitions; added the shared-target preference to avoid a fourth copy; risk none->low. Checks: `npm run test:merge-gate`.

**`worker-store-6` — loadFirstPublicationMembership passes 'AND ...' fragments to a whereSql parameter** `[readability | low | trivial | none]`
- Problem: `readRows` names its parameter `whereSql`, but the static query already contains `WHERE r.first_published = 1`, so callers pass `AND ...` fragments, not WHERE clauses. Every other store passes `WHERE x IN (...)`. The mismatch is misleading.
- Recommendation: rename the `readRows` parameter to `filterSql` (or `extraConditionSql`) and add a one-line comment that the static WHERE is always present so filters are AND-appended. Rename-only.
- Files: `worker/src/lib/depeg-resolver-publication-store.ts:868-932`.
- Verifier: static WHERE + AND fragments vs WHERE-prefixed siblings confirmed; behavior-preserving. Checks: `npm run test:merge-gate`.

**`worker-store-7` — REPAIR_AUTHORIZATION_LONG_EXPIRY_AT magic number undocumented** `[readability | low | trivial | none]`
- Problem: `REPAIR_AUTHORIZATION_LONG_EXPIRY_AT = 4_102_444_800` is an opaque Unix timestamp (2100-01-01Z) used as a non-expiring sentinel for automated sealed-tail repair authorizations. No comment.
- Recommendation: add a single-line comment: `// Unix ts for 2100-01-01T00:00:00Z; far-future sentinel = effectively non-expiring`. Comment-only.
- Files: `worker/src/lib/depeg-resolver-incident-store.ts:46`.
- Verifier: constant + uses + the 2100-01-01Z arithmetic verified (also reused in the test fixture). Checks: `npm run test:merge-gate`.

**`worker-store-9` — No tests for depeg-resolver-publication-store or depeg-resolver-repair-store** `[test-gap | low | small | none]`
- Problem: the core claim is FALSE. Both stores ARE covered by `depeg-resolver-ddrv2-store.test.ts` (19 call sites: sealPublicPrediction, loadSealedPublicPredictions, writePublicationManifest, authorizeEventRepair, consumeEventRepairAuthorization, etc.) against a real migrated node:sqlite D1, including idempotency, hash-mismatch rejection, and double-consume. The candidate's grep only matched filenames.
- Recommendation: reframe + downscope. Do NOT create new files claiming zero coverage. OPTIONAL targeted gap-fill within the existing test: (a) `consumeEventRepairAuthorization` rejection when `expires_at < consumedAt`; (b) `writePublicationManifest` ordering edge cases. Use the existing `makeSqliteD1` harness.
- Files: `worker/src/lib/depeg-resolver-publication-store.ts`, `worker/src/lib/depeg-resolver-repair-store.ts`, `worker/src/lib/__tests__/depeg-resolver-ddrv2-store.test.ts`.
- Verifier: "zero tests" premise refuted (19 call sites); severity high->low, effort large->small; only a thin expired-authorization gap remains. Checks: `npm run test:merge-gate`.


### Worker Infrastructure — price providers / rate-limit / blacklist (`worker-infra-*`)

**`worker-infra-2` — `matchedCount` on per-batch/per-target diagnostics is cumulative, not per-batch** `[readability | low | small | none]`
- Problem: all five multi-request providers set `diagnostic.matchedCount = quotes.filter(q => q.source === <provider>).length` inside the loop, where `quotes` is the run-wide accumulator. So every diagnostic after the first reports the cumulative total — early diagnostics undercount, later overcount. dexscreener.ts:117 already does it correctly (`batchQuotes.length`).
- Recommendation: capture `const matchedBefore = quotes.length;` before processing and set `diagnostic.matchedCount = quotes.length - matchedBefore;`. Diagnostics-only; not consumed by circuit/outcome logic — behavior-preserving.
- Files: `worker/src/lib/address-price-providers/{moralis,coingecko-onchain,alchemy,dexpaprika,birdeye}.ts` (111, 90, 94, 71, 81).
- Verifier: cumulative filter confirmed in all 5; dexscreener correctly excluded; not read by circuit logic; severity medium->low. Checks: `npm run typecheck:worker`, `npm run test:merge-gate`.

**`worker-infra-3` — `emptyProviderResult` emits `ok: true, success: true` for a missing-credential failure** `[consistency | low | trivial | none]`
- Problem: `emptyProviderResult` (the missing-API-key guard) builds a diagnostic with `ok: true, success: true` while also populating `rejectionReasonCounts`. The sibling `buildBlockedProviderDiagnostic` uses `ok: false, success: false`. The success flags contradict the rejection counts.
- Recommendation: change to `ok: false, success: false`. Verified safe: the diagnostic carries `attemptedRequests: 0`, and `providerOutcomes` derives `neutral` from `attemptedRequests === 0`, so circuit state is unaffected. Leave `buildNoCandidatesDiagnostic` (legitimately `ok:true`).
- Files: `worker/src/lib/address-price-providers/shared.ts:161-184`.
- Verifier: contradiction confirmed; `attemptedRequests:0` keeps circuit state unchanged; no test asserts the flags; severity medium->low. Checks: `npm run typecheck:worker`, `npm run test:merge-gate`.

**`worker-infra-4` — `isRecord` privately redefined 6x across worker/src/lib when @shared/lib/type-guards exports it** `[duplication | low | small | none]`
- Problem: `isRecord` is privately redefined in at least 6 worker lib files (report-card-cache:64, status-probe-store:33, telegram-mini-app-auth:40, status/raw-snapshot:41, status/d1-usage:25 [named `UnknownRecord`, identical body], plus the exported one in address-price-providers/shared.ts:59). `@shared/lib/type-guards` exports the identical guard. Candidate undercounted (missed d1-usage).
- Recommendation: in the standalone status/cache/auth files, delete the private copy and import `isRecord` from `@shared/lib/type-guards`. For d1-usage keep its `UnknownRecord` alias if used but route the guard to the shared one. Leave address-price-providers/shared.ts:59 as the provider-dir barrel. Loose `!= null` is the mandated worker style and matches both. Partially referenced in the scores audit's cross-cutting digest (scoring layer), but these worker-lib sites are out of its scope.
- Files: `worker/src/lib/report-card-cache.ts:64`, `.../status-probe-store.ts:33`, `.../telegram-mini-app-auth.ts:40`, `.../status/raw-snapshot.ts:41`, `.../status/d1-usage.ts:25`, `shared/lib/type-guards.ts:5`.
- Verifier: 6 defs confirmed (candidate said 5, missed d1-usage); body-identical; loose-equality matches both. Checks: `npm run typecheck:worker`, `npm run lint`, `npm run test:merge-gate`.

**`worker-infra-5` — `parsePositiveNumber` duplicated in 3 worker lib files with a genuine parse-semantics divergence** `[duplication | low | small | medium]`
- Problem: three private `parsePositiveNumber` copies. shared.ts:49 and cex-orderbooks.ts:46 use `Number()` over `unknown`; cex-tickers.ts:65 uses `parseFloat()` over a narrowed type. `parseFloat` accepts trailing-garbage strings (`"1.5px" -> 1.5`) that `Number()` rejects as NaN.
- Recommendation: do NOT blindly unify to `Number()` — a behavior change in a live CEX price path. Safe scope: consolidate ONLY the two already-identical `Number()`-based copies by importing the shared.ts export into cex-orderbooks. Leave cex-tickers' `parseFloat` variant in place (or document why). Risk medium because the naive rec alters runtime parsing.
- Files: `worker/src/lib/address-price-providers/shared.ts:49-52`, `worker/src/lib/cex-orderbooks.ts:46-49`, `worker/src/lib/cex-tickers.ts:65-68`.
- Verifier: confirmed `parseFloat` vs `Number()` + narrowed input; naive unification is behavior-changing; scoped down, risk low->medium. Checks: `npm run typecheck:worker`, `npm run test:merge-gate`.

**`worker-infra-6` — Magic number `2147483647` (SQL/JS INT32 ceiling) repeated 3x without a named constant** `[maintainability | low | trivial | none]`
- Problem: `2147483647` appears exactly 3 times: api-key-rate-limit.ts:80 (inside a SQL `MIN(count + 1, 2147483647)` literal), api-key-rate-limit.ts:137 (JS `Math.min`), api-cache-read.ts:20 (JS `Math.min`). No named constant.
- Recommendation: declare `const D1_INT32_MAX = 2_147_483_647;` (export from api-key-core.ts). Reference it at the two JS sites. Line 80 is inside a SQL string literal — either interpolate `${D1_INT32_MAX}` (still no user input, safe) or add a `/* D1 INT32 cap */` comment.
- Files: `worker/src/lib/api-key-rate-limit.ts:80,137`, `worker/src/lib/api-cache-read.ts:20`.
- Verifier: exactly 3 occurrences; line 80 is a SQL literal (SQL-interpolation nuance corrected). Checks: `npm run typecheck:worker`, `npm run lint`.

**`worker-infra-7` — Blacklist config-key format inlined in 2 places when `buildBlacklistConfigKey` exists; proposed toLowerCase removal is unsafe** `[duplication | low | trivial | medium]`
- Problem: the key format `${chainId}-${address.toLowerCase()}` is inlined twice (684, 886); `buildBlacklistConfigKey` (889-891) is the canonical form. The candidate cited 684 vs 889 but MISSED the third inline copy at 886.
- Recommendation: extract via `buildBlacklistConfigKey(chainId, address)` at both inline sites. REJECT the candidate's second proposal to remove the `.toLowerCase()` at `getBlacklistConfigByKey` (894): all three callers pass `row.config_key` read from D1 (external input, no DB-level lowercase constraint) — the normalization is a defensive guard, not dead code; removing it risks lookup misses. Risk medium for that reason.
- Files: `worker/src/lib/blacklist-contracts.ts:684,886,889-901`.
- Verifier: confirmed the third inline copy + that line-894 normalizes D1-sourced input from 3 callers; rejected the unsafe half; risk none->medium. Checks: `npm run typecheck:worker`, `npm run test:merge-gate`.

**`worker-infra-9` — `checkIsolateLocalApiKeyRateLimit` linearly scans the whole fallback map on every call** `[performance | low | small | low]`
- Problem: the function iterates the entire `apiKeyFallbackRateLimitById` map (capped at 4_096) on every call to evict prior-bucket entries, even though buckets turn over once per minute. The D1 path avoids the equivalent via a `lastApiKeyRateLimitPruneBucket` guard. The local path has no such guard. Only matters under the rare D1-circuit-open fallback.
- Recommendation: add a new isolate-state field `lastLocalRateLimitPruneBucket` and guard the full-map sweep, then set it. Behavior preserved (the per-key check already resets stale entries; the map cap bounds memory). The candidate's field does NOT yet exist — must be added. Cold path, low value.
- Files: `worker/src/lib/api-key-rate-limit.ts:112-145`, `worker/src/lib/api-key-core.ts:179-185`.
- Verifier: unconditional full-map loop + the D1 guard confirmed; cap 4_096; the recommended field must be added; honestly low (cold path). Checks: `npm run typecheck:worker`, `npm run test:merge-gate`.

### Worker Router (`wrouter-*`)

**`wrouter-1` — Three admin/ops routes bypass the file-local define*AdminRoute helpers and carry a divergent "route-" log label** `[consistency | low | small | low]`
- Problem: the two admin routes `remediate-blacklist-amount-gaps` and `backfill-blacklist-current-balances` call `makeIdempotentAdminRoute` directly instead of the `defineIdempotentAdminRoute` helper, passing a `"route-<key>"` LABEL (consumed as the `route:` field of the `api_handler_error` log). Migrating WOULD change logged labels. The ops-routes case is weaker (no `defineAdminRoute` helper exists; adding one for a single call site is speculative).
- Recommendation: migrate ONLY the two admin routes to `defineIdempotentAdminRoute("<key>", handler)`, accepting the `route-` label change. Do NOT introduce a new `defineAdminRoute` helper for the single ops-routes call site.
- Files: `worker/src/routes/admin-routes.ts:73-89`, `worker/src/routes/ops-routes.ts:29-32`.
- Verifier: helper passes `(key, key)`; bypass passes `route-<key>`; only behavioral effect is the log label; chainRpcs dep supplied; ops-routes is a poor migration target. Checks: `npm run -w worker test`, `npm run typecheck`.

**`wrouter-2` — createRequestSourceRecorder is constructed twice in request-dispatch.ts with overlapping config** `[duplication | low | small | low]`
- Problem: the fast-gate path and the normal-gate path both build a `createRequestSourceRecorder` config. The "10 identical + 4 varying" count is wrong — the object has 11 fields: 6 constant, 5 varying. The two sites also read the varying fields differently, so it is not a clean spread.
- Recommendation: optionally extract `buildRequestSourceConfig({ request, env, ctx, pathname }, gate)` filling the 6 constants and mapping the 5 gate fields, normalizing the gate shape so both can pass. Keep it local. Minor DRY cleanup (~6 constant lines).
- Files: `worker/src/handlers/http/request-dispatch.ts:57-69,82-94`.
- Verifier: field count corrected (6 constant / 5 varying of 11); real but minor; demoted to low. Checks: `npm run -w worker test`.

**`wrouter-3` — Redundant edgeCache reassignment at request-dispatch.ts line 101** `[dead-code | low | trivial | low]`
- Problem: `createEdgeCacheContext(request, url)` is pure and neither input is mutated between line 48 and 101, so the line-101 reassignment is equivalent. (The candidate's inline quote of the function omits `{ method: "GET" }`, but the conclusion holds.) `let edgeCache` -> `const` is also safe (101 is the only reassignment).
- Recommendation: remove the `edgeCache = createEdgeCacheContext(...)` reassignment (101), keeping `cached = await readEdgeCache(edgeCache);`. Change `let` to `const` at 48. Taste-level; current code is harmless.
- Files: `worker/src/handlers/http/request-dispatch.ts:48,100-103`.
- Verifier: redundancy verified (pure factory, immutable inputs); candidate's inline quote inaccurate but verdict unchanged; cosmetic. Checks: `npm run -w worker test`, `npm run lint`.

**`wrouter-4` — Unreachable endpoint?.path fallback in getRouteErrorLabel** `[dead-code | low | trivial | none]`
- Problem: `getRouteErrorLabel` chains `routeMatch.endpoint?.key ?? routeMatch.endpoint?.path ?? path`. `EndpointDefinition.key` is a required non-optional string, so whenever `endpoint` is defined `endpoint.key` is present and `endpoint?.path` is never reached. The `?? path` tail IS still needed (endpoint is optional for dynamic routes).
- Recommendation: simplify to `return routeMatch.endpoint?.key ?? path;`.
- Files: `worker/src/router.ts:63-65`.
- Verifier: key required; `?? path` tail load-bearing for dynamic routes; middle fallback genuinely dead. Checks: `npm run typecheck`, `npm run -w worker test`.

**`wrouter-5` — No test for the preview-request site-proxy grant branch in evaluateAccessGate** `[test-gap | medium | small | none]`
- Problem: gates.ts:114-121 grants `{ isSiteProxy: true, requestLane: "site-api", response: null }` when a `*.workers.dev` preview request carries a valid site-proxy credential + allowed method/path. gates.test.ts has zero tests hitting the preview branch (no `workers.dev`/`isWorkerPreviewRequest` references); no existing test asserts `isSiteProxy: true` at all.
- Recommendation: add a gates.test.ts case — a GET to a `*.workers.dev` host (verify the exact `isWorkerPreviewRequest` hostname predicate first, don't assume `preview.pharos-watch.workers.dev`) with the site-proxy secret for an allowed path, asserting `isSiteProxy: true`, `requestLane: "site-api"`, `response: null`.
- Files: `worker/src/handlers/http/gates.ts:114-121`, `worker/src/handlers/http/__tests__/gates.test.ts`.
- Verifier: grant branch + zero preview coverage confirmed; sharpened the rec to verify the hostname predicate. Checks: `npm run -w worker test`.

**`wrouter-8` — Optionalize<T> duplicates the built-in Partial<T>** `[simplification | low | trivial | none]`
- Problem: `Optionalize<T>` is `{ [K in keyof T]?: T[K] }`, structurally identical to `Partial<T>`. Used at exactly two sites (104, 109), not three.
- Recommendation: replace the two usages with `Partial<AllRouteDependencyFields>` and delete the local alias (86-88). Pure type-level rename.
- Files: `worker/src/routes/shared.ts:86-88`.
- Verifier: identical to Partial; use count corrected to 2 (not 3). Checks: `npm run typecheck`.


### CI Scripts (`ci-*`)

**`ci-1` — Nine CI scripts each define a private recursive file-walker instead of the shared collectSourceFiles helper** `[duplication | medium | medium | low]`
- Problem: nine CI scripts each define their own recursive directory walker while ten others consume `collectSourceFiles` from `scripts/lib/source-files.mjs`. The walkers do NOT all do the same thing — check-agent-skill-symlinks walks for symlinks via lstatSync, check-selector-banned-phrases is async, check-script-entrypoints/check-client-registry-imports handle a file-OR-dir root, and skip-lists differ. Genuine duplication but NOT a uniform mechanical swap.
- Recommendation: migrate ONLY the plain source-file walkers (check-client-registry-imports, check-script-entrypoints, check-feature-flag-inlining, check-doc-counts), passing each script's existing `excludedDirs` explicitly so the scanned set is byte-for-byte unchanged. Use the check-cron-abort-contract.mjs file-vs-dir wrapper. Do NOT migrate check-agent-skill-symlinks (symlinks) or treat check-env-contract/check-unused-code under the ci-10 exclusion caveat.
- Files: 9 scripts under `scripts/ci/` + `scripts/lib/source-files.mjs:10-32`.
- Verifier: 9 private walkers + 10 consumers confirmed (candidate said 7); flagged divergent purpose/skip-lists. Checks: `npm run check:env-contract`, `npm run check:unused-code`, scripts tests, `npm run test:merge-gate`.

**`ci-2` — normalizeHookMode ends in a no-op ternary (both arms return the same value)** `[dead-code | low | trivial | none]`
- Problem: line 1293 `return HOOK_EVENT_NAMES.has(normalized) ? normalized : normalized` — both arms identical, so the `.has()` test is dead. The candidate's framing (unknown names "pass through instead of being rejected", return null is intended) is WRONG: tracing `runCli`, an unknown string falls through all `if (hookMode === ...)` branches to the normal classify path in either version. Returning null is NOT a meaningful fix.
- Recommendation: simplify to `return normalized;` (drop the no-op ternary + the unused `.has` check). Strictly behavior-preserving. Do NOT switch to `return null`.
- Files: `scripts/ci/pharos-change-contract.mjs:1290-1294`.
- Verifier: both arms identical; traced downstream dispatch; refuted the "return null is intended" claim and behaviorPreserving:false. Checks: `npm run test` (pharos-change-contract).

**`ci-3` — classifyUserPrompt filters PROMPT_ROUTES twice with the identical predicate** `[duplication | low | trivial | none]`
- Problem: `classifyUserPrompt` runs `PROMPT_ROUTES.filter(route => route.patterns.some(p => p.test(promptText)))` twice (290-291 for labels, 294-295 for familyIds). The two scans can drift.
- Recommendation: compute once: `const matched = PROMPT_ROUTES.filter(...)`, then derive `matchedRoutes = matched.map(r => r.label)` and `matched.flatMap(r => r.familyIds)`.
- Files: `scripts/ci/pharos-change-contract.mjs:288-297`.
- Verifier: two identical filter calls confirmed; demoted medium->low (cold-path single function). Checks: `npm run test` (pharos-change-contract).

**`ci-4` — check-shared-types-imports.mjs entrypoint guard omits the process.argv[1] null check** `[type-safety | low | trivial | low]`
- Problem: line 140 is `if (import.meta.url === pathToFileURL(process.argv[1]).href)` with no `process.argv[1] &&` guard. The file is imported by a test; under vitest `argv[1]` is defined so no crash occurs. Every sibling exportable script uses the guard. Defensive consistency, not an active bug.
- Recommendation: add the guard: `if (process.argv[1] && import.meta.url === ...)`. One-line, behavior-preserving.
- Files: `scripts/ci/check-shared-types-imports.mjs:140-142`.
- Verifier: missing guard confirmed; TypeError only theoretical; demoted medium->low. Checks: `npm run test` (check-shared-types-imports).

**`ci-5` — Four CI scripts import bare 'fs' / 'path' instead of the node: protocol prefix** `[consistency | low | trivial | none]`
- Problem: four scripts use bare imports (check-unused-code, check-duplicate-exports, check-reserve-fixture-freshness, check-cron-schedule-sync.ts); 37 others use the `node:` prefix. No eslint rule enforces it — purely stylistic.
- Recommendation: change the four to `from "node:fs"` / `from "node:path"`. Low priority.
- Files: `scripts/ci/check-unused-code.mjs:3-4`, `.../check-duplicate-exports.mjs:7-8`, `.../check-reserve-fixture-freshness.mjs:8-9`, `.../check-cron-schedule-sync.ts:1`.
- Verifier: count corrected 3->4; no eslint rule enforces. Checks: `npm run lint`.

**`ci-7` — Entrypoint guard uses three interchangeable idioms across the CI scripts** `[consistency | low | small | none]`
- Problem: multiple idioms (`const isCliEntrypoint`, `const isDirectRun`, inline `if (process.argv[1] && ...)`, the unguarded one, `path.resolve` variants). The `isCliEntrypoint`/`isDirectRun` names are semantically identical. Real cosmetic drift but spans ~18 files — a large mechanical rename with near-zero benefit and regression risk in a guard.
- Recommendation: do NOT do a blanket rename pass. Limit scope to the genuinely-unsafe unguarded form (already captured by ci-4). Leave the naming alone — a repo-wide rename is exactly the unrequested cross-file refactor the project rules discourage.
- Files: `scripts/ci/{pharos-change-contract,check-cron-abort-contract,check-shared-types-imports,check-seo-static,check-reserve-fixture-freshness}.mjs`.
- Verifier: idiom spread confirmed; down-scoped to ci-4 only; full standardization is churny taste-work. Overlaps ci-4. Checks: `npm run lint`.

**`ci-8` — check-selector-banned-phrases.mjs is the only file-scanning CI script using async fs/promises** `[consistency | low | small | low]`
- Problem: it imports from `node:fs/promises` and `walkDir` is async — the only async file-scanning CI script. The "~45 lines saved" is overstated: walkDir is ~18 lines and its skip rules differ (skips dotfiles, __tests__, .test/.spec, supports excludeBasenames). A swap is NOT a clean drop-in and risks changing which files are scanned.
- Recommendation: optional, low priority. If pursued, only the dir-kind branch can call `collectSourceFiles`, replicating the existing filters so the scanned set is unchanged. Leaving it async is defensible — recommend keep:false on the rewrite unless a broader cleanup is requested.
- Files: `scripts/ci/check-selector-banned-phrases.mjs:24,86-134`.
- Verifier: only async scanner confirmed; line savings overstated, filters diverge; guarded recommendation; overlaps ci-1. Checks: `npm run check:selector-banned-phrases`.

**`ci-9` — DIRECT_COIN_POOL triple-spreads the top-10 coins with no explanatory comment** `[readability | low | trivial | none]`
- Problem: lines 194-196 spread `HOT_COIN_IDS.slice(0,10)` three times then `slice(10)` once, giving the top-10 coins 3x weight. Intentional weighting, undocumented; could be misread as a copy-paste error. Test-only load simulator.
- Recommendation: add a one-line comment (e.g. `// top-10 coins appear 3x to mimic hot-coin subscription concentration`). Do NOT rewrite to `Array.from(...).flat()`. Comment-only.
- Files: `scripts/ci/check-telegram-load.ts:193-198`.
- Verifier: triple spread + intentional weighting confirmed; narrowed to the comment. Checks: none.

### Maintenance Scripts (`scr-*`)

**`scr-1` — smoke-ui.mjs redeclares readPositiveIntEnv/readNonNegativeIntEnv/sleep already exported by smoke-runtime.mjs** `[duplication | low | trivial | none]`
- Problem: smoke-ui.mjs imports only `assert, parseNonNegativeInt, parsePositiveInt` from smoke-runtime, then locally redefines `readPositiveIntEnv`, `readNonNegativeIntEnv`, and `sleep` — all byte-for-byte identical to smoke-runtime's exports.
- Recommendation: add the three to the existing import; delete the local definitions. After, smoke-ui still uses `parseNonNegativeInt`/`parsePositiveInt` in the deleted env wrappers — re-check those imports are still referenced.
- Files: `scripts/maintenance/smoke-ui.mjs:4,141-151`, `scripts/lib/smoke-runtime.mjs:32-38,77-79`.
- Verifier: bodies identical; flagged the potential now-unused parse imports. Checks: `npm run lint`, `npm run test:smoke-ui`.

**`scr-2` — fetchJsonWithRetry and fetchPngWithRetry in smoke-api.mjs are near-identical retry loops** `[duplication | low | small | low]`
- Problem: both share an identical retry skeleton (totalAttempts, isRetryableStatus/isRetryableError, warn-and-sleep, final throw); the only difference is `fetchJson(...)` vs `fetchPng(...)`. ~28 lines duplicated.
- Recommendation: extract `fetchWithRetry(fetcher, endpointPath, timeoutMs, retryCount, retryDelayMs)` where `fetcher(timeoutMs)` returns the result; both wrappers become one-liners. Preserve the exact `[smoke-api] WARN ...` log/error strings.
- Files: `scripts/maintenance/smoke-api.mjs:161-189,206-234`.
- Verifier: structurally identical aside from the inner fetch; risk none->low (asserted-on strings). Checks: `npm run lint`, `npm run test:smoke-api`.

**`scr-3` — normalizeRoute duplicated identically in smoke-ui.mjs and smoke-mobile-ui.mjs (lighthouse variant genuinely differs)** `[duplication | low | small | low]`
- Problem: smoke-ui and smoke-mobile-ui `normalizeRoute` are functionally identical (trim; `/` passthrough; prepend `/`). The lighthouse variant is DIFFERENT (`/${route.replace(/^\/+/, '')}` collapses leading slashes) — must NOT be folded in.
- Recommendation: export `normalizeRoute` from smoke-runtime.mjs and import it in smoke-ui + smoke-mobile-ui only; delete those two local copies. Leave lighthouse's variant.
- Files: `scripts/maintenance/smoke-ui.mjs:177-183`, `.../smoke-mobile-ui.mjs:107-111`, `.../lighthouse-static-export.mjs:97-100`.
- Verifier: smoke-ui/mobile identical; lighthouse divergent; corrected the 3-way framing to a 2-file dedup. Checks: `npm run lint`, `npm run test:smoke-ui`, `npm run test:smoke-ui:mobile`.

**`scr-4` — REDEMPTION_ENUMS in smoke-api.mjs has DRIFTED from shared/types/redemption.ts (not identical)** `[maintainability | medium | medium | medium]`
- Problem: the candidate's "every value matches exactly" is FALSE — already drifted: shared `RedemptionCapacityBasisSchema` includes `fixed-buffer`, ABSENT from smoke-api's `capacityBasis` set. The exact silent-staleness failure, already occurring.
- Recommendation: the proposed `new Set(Schema.options)` is NOT a drop-in: (a) smoke-api runs via plain `node`, not tsx, so it cannot import the Zod `.ts`; (b) deriving would CHANGE the accepted set (adds `fixed-buffer`). Two tasks: (1) immediate — reconcile the drift by adding `fixed-buffer` (and audit every set); (2) durable — replace the hand-kept block with a generated artifact under a new `check:redemption-enums`. Do NOT do the naive Zod-import rewrite.
- Files: `scripts/maintenance/smoke-api.mjs:298-363`, `shared/types/redemption.ts:5-162`.
- Verifier: confirmed the missing `fixed-buffer`; smoke-api runs under plain node (the import fix is infeasible); reframed duplication->maintenance, NOT behavior-preserving. Checks: `npm run test:smoke-api`, `npm run check:redemption-backstops`.

**`scr-5` — loadStrictContractPaths duplicates resolveContractSmokePaths('full')** `[dead-code | low | trivial | none]`
- Problem: `loadStrictContractPaths` (281-287) copies `STRICT_CONTRACT_SMOKE_PATHS` + the `/api/` prefix assertion — exactly what `resolveContractSmokePaths('full')` already returns. Called only once (823).
- Recommendation: delete `loadStrictContractPaths` and replace its single call with `resolveContractSmokePaths("full")`. Identical output.
- Files: `scripts/maintenance/smoke-api.mjs:281-296,823`.
- Verifier: both functions + sole call site confirmed. Checks: `npm run test:smoke-api`.

**`scr-6` — audit-price-source-depth.ts and audit-dex-pricing-source-gaps.ts redefine isRecord/UnknownRecord already in coverage-audit-cli** `[duplication | low | small | low]`
- Problem: the "5 maintenance scripts define their own isRecord" claim is FALSE — only 2 do. The `interface UnknownRecord` + `isRecord` in both ARE byte-identical to coverage-audit-cli and importable (both run under tsx). But the other proposed consolidations are unsafe: `fetchJson` differs (hardcoded Referer, no apiKey), and audit-dex's `formatUsd` produces DIFFERENT output.
- Recommendation: scope to the safe subset — import `isRecord` and `UnknownRecord` from `../lib/coverage-audit-cli` in both audit scripts and delete the two local copies. Do NOT consolidate `fetchJson` or audit-dex's `formatUsd`.
- Files: `scripts/maintenance/audit-price-source-depth.ts:58-60,207-209`, `.../audit-dex-pricing-source-gaps.ts:15-17,154-156`, `scripts/lib/coverage-audit-cli.ts:8-14`.
- Verifier: only 2 (not 5) define UnknownRecord; fetchJson/formatUsd diverge; narrowed to isRecord/UnknownRecord. Checks: `npm run audit:price-source-depth`, `npm run lint`.

**`scr-7` — writeOutput helper duplicated across reserve/dependency/l2beat coverage-audit generators** `[duplication | low | small | low]`
- Problem: reserve (728-733) and dependency (752-757) share `writeOutput(path, output, cwd)` (mkdirSync+writeFileSync) differing ONLY in the stdout message. l2beat (380-384) has a DIFFERENT signature (no `cwd`, uses `resolve(process.cwd(), path)`, no message); redemption (548-549) inlines just the two write lines.
- Recommendation: add `writeOutputFile(path, contents, cwd = process.cwd())` to coverage-audit-cli.ts. reserve/dependency call it and keep their distinct stdout message at the call site. l2beat + redemption can also call it. Low value.
- Files: `scripts/maintenance/generate-reserve-coverage-audit.ts:728-733`, `.../generate-dependency-coverage-audit.ts:752-757`, `.../generate-l2beat-snapshot-coverage-audit.ts:380-384`, `.../generate-redemption-coverage-audit.ts:548-549`.
- Verifier: reserve/dependency identical-except-message; l2beat no cwd/message; corrected the candidate framing. Checks: `npm run check:redemption-coverage-audit`, `npm run lint`.

**`scr-8` — sleep defined locally in run-pages-smoke / wait-pages-release-marker / rollback-pages-deployment (and smoke-ui)** `[duplication | low | trivial | none]`
- Problem: three pages-ops scripts each define `sleep(ms) => new Promise(r => setTimeout(r, ms))`, identical to smoke-runtime's export; none import smoke-runtime. smoke-ui's `sleep` is covered by scr-1.
- Recommendation: import `sleep` from `../lib/smoke-runtime.mjs` in the three scripts; delete the local definitions. Marginal value — acceptable to defer. wait-pages-release-marker should also adopt scr-9 in the same edit.
- Files: `scripts/maintenance/{run-pages-smoke,wait-pages-release-marker,rollback-pages-deployment}.mjs`, `scripts/lib/smoke-runtime.mjs:77-79`.
- Verifier: three identical bodies; none import smoke-runtime; removed smoke-ui from scope. Checks: `npm run validate:pages-smoke`.

**`scr-9` — wait-pages-release-marker.mjs redefines readPositiveInt identical to smoke-runtime parsePositiveInt** `[duplication | low | trivial | none]`
- Problem: local `readPositiveInt` (10-13) is byte-identical to smoke-runtime's exported `parsePositiveInt`, called 5 times in parseArgs. The file imports nothing from smoke-runtime today.
- Recommendation: import `parsePositiveInt` (and per scr-8, `sleep`) from smoke-runtime; remove the local and rename its 5 call sites. Pair with scr-8 in one edit.
- Files: `scripts/maintenance/wait-pages-release-marker.mjs:10-13`, `scripts/lib/smoke-runtime.mjs:7-10`.
- Verifier: identical bodies; no existing smoke-runtime import; both .mjs. Checks: `npm run validate:pages-smoke`.

**`scr-10` — Tautological failedWorker?.status === 'rejected' re-check after find() in smoke-ui** `[simplification | low | trivial | none]`
- Problem: `overflowResults.find((result) => result.status === 'rejected')` can only return a rejected element, so the guard `if (failedWorker?.status === 'rejected')` is always true when defined — the re-check + optional chain are redundant.
- Recommendation: replace with `const failedWorker = ...find(...); if (failedWorker) { throw failedWorker.reason; }`. (TS narrowing won't apply in a .mjs file, so this is clarity only.)
- Files: `scripts/maintenance/smoke-ui.mjs:1003-1006`.
- Verifier: predicate guarantees the property; re-check tautological. Checks: `npm run test:smoke-ui`.

**`scr-11` — captureHomepageSummary builds the same result object twice in smoke-ui** `[duplication | low | small | low]`
- Problem: inside the `page.evaluate`, the loop-success branch (296-311) and the post-timeout branch (317-332) construct nearly the same result object, differing only by `timedOut: false`/`true` and which flags were precomputed vs recomputed. The marker sentinel strings repeat and must stay in sync.
- Recommendation: extract a local `buildSummary(text, rows, timedOut)` INSIDE the evaluate (it runs in browser context — outer module helpers aren't available); call it in both branches. `recentEvents` is async, so keep it async/awaited.
- Files: `scripts/maintenance/smoke-ui.mjs:296-311,317-332`.
- Verifier: both branches build the same shape; helper must live inside the evaluate. Checks: `npm run test:smoke-ui`.


### Cross-cutting (`f-xcut-*`)

**`f-xcut-1` — isRecord type guard re-defined in 13 modules despite canonical shared helper** `[duplication | medium | small | low]`
- Problem: `isRecord(value): value is Record<string,unknown>` is defined locally in ~13 modules across src/lib and worker/src while `shared/lib/type-guards.ts:5` exports the canonical, runtime-neutral version. Bodies are behaviorally equivalent but DRIFT in form: most use `value != null && typeof === object`, but telegram-mini-app-auth and address-price-providers/shared.ts reorder clauses, and report-card-cache uses `Boolean(value && typeof === object ...)`. Worker is import-compatible (already imports `@shared/lib` 931x).
- Recommendation: delete the local copies in src/lib and worker/src and import `isRecord` from `@shared/lib/type-guards`. For address-price-providers/shared.ts (which re-EXPORTS isRecord), re-export from the shared module or update consumers. EXCLUDE the `scripts/*` and `worker/scripts/*` copies unless trivially compatible. The `Boolean(...)` variant is behaviorally identical for record inputs.
- Files: `shared/lib/type-guards.ts:5-7`, `src/lib/api.ts:139-141`, `src/lib/homepage-bootstrap.ts:38`, `src/lib/homepage-bootstrap-runtime.ts:42`, `worker/src/lib/status-probe-store.ts:33`, `.../telegram-mini-app-auth.ts:40`, `.../address-price-providers/shared.ts:59-61`, `.../report-card-cache.ts:64` (+ etherfuse-cetes, status/raw-snapshot, attestation-pdf-index).
- Verifier: confirmed 13 defs; read 7 bodies (clause-order/Boolean() drift); tightened to an explicit scoped list (script copies excluded). Checks: `npm run check:types`, `npm run lint`, `npm run test:merge-gate`.

**`f-xcut-2` — error-message coercion idiom inlined ~206 times across worker** `[duplication | medium | medium | low]`
- Problem: `error instanceof Error ? error.message : String(error)` is hand-inlined ~206 times across ~135 worker files (candidate's "140 across 91" undercounts; src has 3). Two local wrappers already exist: redstone.ts:246 `errorMessage(err)` (byte-identical) and pricing-provider-diagnostics.ts:79 `errorMessageFor(error)` (wraps the same ternary then sanitizes).
- Recommendation: add one `toErrorMessage(error: unknown): string` to a worker lib util. Replace redstone's `errorMessage`; have `errorMessageFor` call `toErrorMessage` before `sanitizeSnippet`. Migrate the inline ternaries incrementally. Do NOT place in shared/lib (only 3 src hits).
- Files: `worker/src/lib/pricing-provider-diagnostics.ts:79-82`, `worker/src/lib/redstone.ts:246-248`, `worker/src/lib/api-cache-read.ts:43-45` (representative; ~206 sites total).
- Verifier: re-counted 206 idiom occurrences in 135 files (NOT 140/91); both wrappers verified; medium effort given 200+ sites. Checks: `npm run check:types`, `npm run lint`, `npm run test:merge-gate`.

**`f-xcut-4` — number-coercion parsers scattered while number-utils.ts sits underused** `[duplication | low | small | low]`
- Problem: `parsePositiveNumber` is defined 3x (address-price-providers/shared.ts:49, cex-orderbooks.ts:46, cex-tickers.ts:65), `parseNonNegativeNumber` once, `parseFiniteNumber` once (etherfuse-cetes.ts:33) — all variations on `toFiniteNumber` plus a sign check. Bodies are NOT identical: cex-orderbooks/shared.ts use `Number(value)`, while cex-tickers and etherfuse-cetes use `parseFloat(value)`; cex-tickers accepts a narrower type.
- Recommendation: add `parsePositiveNumber`/`parseNonNegativeNumber` to number-utils.ts built on `toFiniteNumber` (Number(), not parseFloat). Before swapping the `parseFloat` call sites, confirm none rely on lenient trailing-garbage parsing — if they do, keep those local or normalize input first. Consumer-side dedupe NOT owned by the scores audit.
- Files: `worker/src/lib/number-utils.ts:1-15`, `.../address-price-providers/shared.ts:49-57`, `.../cex-tickers.ts:65-68`, `.../cex-orderbooks.ts:46-49`, `worker/src/cron/yield-sync/etherfuse-cetes.ts:33-38`.
- Verifier: read all five; parseFloat-vs-Number makes it not mechanical (behaviorPreserving:false correct). Checks: `npm run check:types`, `npm run lint`, `npm run test:merge-gate`.

**`f-xcut-5` — Inline Math.max(0,Math.min(100,x)) clamp duplicates shared clampScore in UI/view-model sites** `[duplication | low | small | none]`
- Status: Closed 2026-06-13. Implemented with `clampScore` at the non-score UI/view-model sites, plus the extra `src/app/pharoswatchbot/telegram-pulse-strip.tsx` clamp found during implementation. Score-compute and worker runtime clamps remain excluded.
- Problem: `Math.max(0, Math.min(100, x))` is inlined 20 times (candidate said 21). ~13 are score-compute (audit-owned); only ~7 are non-score UI/view-model sites. `clampScore()` in `shared/lib/math.ts:9` does exactly this. dews-badge.tsx:45 wraps the idiom in a local `clamp` arrow.
- Recommendation: in the non-score sites only, replace the inline clamp with `clampScore` from `@shared/lib/math`: stability-index/view-model.ts:75, psi-lighthouse-scene.tsx:34, yield-leaderboard-row-parts.tsx:48, pre-launch-detail.tsx:98, funding-page-sections.tsx:58, depeg-control-board.tsx:57, dews-badge.tsx:45 (replace the local `clamp`). EXCLUDE all score sites (audit-owned). Identical for finite inputs.
- Files: `shared/lib/math.ts:9-11`, `src/app/stability-index/view-model.ts:75`, `src/app/stability-index/psi-lighthouse-scene.tsx:34`, `src/components/dews-badge.tsx:45`, `src/components/yield-leaderboard-row-parts.tsx:48`, `src/components/pre-launch-detail.tsx:98`, `src/components/funding/funding-page-sections.tsx:58`, `src/components/depeg-control-board.tsx:57`.
- Verifier: 20 (not 21) sites; partitioned score-compute (excluded) from UI; clampScore identical for finite inputs; corrected the dews-badge detail. Checks: `npm run check:types`, `npm run lint`, `npm run test:merge-gate`.

**`f-xcut-6` — God-file: extract Mint Authority view-model from stablecoin-detail-view-model.ts** `[restructure | medium | medium | low]`
- Problem: the file is 1298 LOC. A self-contained Mint Authority slice spans ~178-665: 10+ MA interfaces (178-256), the NOT_REVIEWED constant + posture tones (265-403), and ~14 helpers ending with `buildMintAuthorityDetailViewModel` (622-665). Sibling files mint-authority-display.ts and stablecoin-detail-mint-authority-format.ts establish the split convention.
- Recommendation: move the MA types + builders (~178-665, plus the local `shortenAddress` at 473 used only by the MA path) into a new `src/lib/stablecoin-detail-mint-authority-view-model.ts`. Export `buildMintAuthorityDetailViewModel` and import it back (used at 1235). Pure code-motion; verify no other parent-file helper crosses the seam before cutting.
- Files: `src/lib/stablecoin-detail-view-model.ts:178-665`.
- Verifier: confirmed 1298 LOC, MA section 178-665, public entry at 622 used at 1235, siblings exist; shortenAddress part of this slice (ties to f-xcut-7). Checks: `npm run check:types`, `npm run lint`, `npm run test:merge-gate`.

**`f-xcut-7` — Divergent local shortenAddress instead of shared formatAddress** `[consistency | low | trivial | low]`
- Problem: stablecoin-detail-view-model.ts:473 defines a private `shortenAddress` (slice 0,8 / -6, threshold 18) while `shared/lib/format.ts:133` exports `formatAddress` (slice 0,6 / -4, threshold 12). Different truncation policies = different rendered ellipsis widths. `shortenAddress` has a single call site (596).
- Recommendation: taste/consistency only and NOT behavior-preserving — swapping changes the rendered address string (8/6 -> 6/4). Treat as a product decision: either accept the shorter form and import `formatAddress`, or keep 8/6. Do NOT auto-change without owner sign-off. If f-xcut-6 proceeds, move `shortenAddress` with the MA slice unchanged.
- Files: `src/lib/stablecoin-detail-view-model.ts:473-476`, `shared/lib/format.ts:133-136`.
- Verifier: both bodies confirmed (8/6 thresh 18 vs 6/4 thresh 12); single call site; NOT behavior-preserving (alters output). Checks: `npm run check:types`, `npm run lint`.

**`f-xcut-8` — Trivial sleep(ms) promise-setTimeout helper duplicated** `[duplication | low | trivial | low]`
- Problem: two byte-identical private `sleep(ms) = new Promise(resolve => setTimeout(resolve, ms))` (cron-lease.ts:271, cron-logger.ts:56). `abort.ts:33` already exports `sleepWithSignal(ms, signal?)` which degrades to the same behavior with signal undefined (plus an `ms <= 0` early-return). cron-lease.ts also has a THIRD variant `sleepWithAbort(ms, signal?)` (candidate missed this). ~17 inline setTimeout-promise sites exist worker-wide (candidate said 8).
- Recommendation: export a plain `sleep(ms)` from `worker/src/lib/abort.ts` (alongside `sleepWithSignal`) and have cron-lease + cron-logger import it. Leave abort-aware call sites (`sleepWithSignal` / `sleepWithAbort`) untouched.
- Files: `worker/src/lib/cron-lease.ts:271-273`, `worker/src/lib/cron-logger.ts:56-58`, `worker/src/lib/abort.ts:33-51`.
- Verifier: two identical bodies + `sleepWithSignal` confirmed; corrected two candidate errors (the third `sleepWithAbort` variant; ~17 inline sites not 8). Checks: `npm run check:types`, `npm run lint`.

## Suggested Checks After Each Wave

Union of the `check:*` / test commands referenced across the findings. Run the subset matching the files touched in a wave; run `npm run test:merge-gate` before pushing any wave.

- **Type/lint:** `npm run typecheck`, `npm run typecheck:worker`, `npm run lint`, `npm run lint:typed`, `npm run check:lint`, `npm run check:types`.
- **Merge gate / build:** `npm run test:merge-gate`, `npm run build`.
- **Targeted unit/integration tests:** `npm run test`, `npm run test:unit -- <name>`, `npm test -- key-info-card`, `npm test -- feed`, `npm test -- compare yield`, `npm test -- api-endpoints router-contract`, `npm test -- query-polling-policy`, `npm test -- cron`, `npm run test -- use-stress-test`, `npm run test -- shared/lib/selector`, `npx vitest run shared/lib/__tests__`, `npx vitest run shared/lib/chains`, `npx vitest run shared/lib/__tests__/l2beat-audit.test.ts`, `npx vitest run shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstop-config-helpers.test.ts`, `npx vitest run worker/src/api/__tests__/audit-depeg-history.test.ts`, `npx vitest run worker/src/api/__tests__/backfill-supply-history.test.ts`, `npx vitest run worker/src/api/__tests__/og.test.tsx`, `npm run test --silent -- dispatch-telegram`, `npm run test --silent -- status-self-check`, `npm run test --silent -- weekly-recap`, `npm run -w worker test`.
- **Smoke:** `npm run test:smoke-ui`, `npm run test:smoke-ui:mobile`, `npm run test:smoke-api`, `npm run validate:pages-smoke`, `npm run audit:price-source-depth`.
- **Domain check scripts:** `npm run check:unused-code`, `npm run check:duplicate-exports`, `npm run check:shared-types-imports`, `npm run check:shared-cycles`, `npm run check:redemption-backstops`, `npm run check:redemption-coverage-audit`, `npm run check:cron-connections`, `npm run check:cron-sync`, `npm run check:cron-abort-contract`, `npm run check:worker-boundary`, `npm run check:sql-safety`, `npm run check:env-contract`, `npm run check:selector-banned-phrases`.

After deleting dead exports (Wave 1), regenerate `docs/agent-code-map.md` via `node scripts/maintenance/generate-agent-code-map.mjs` (api-2 lists the removed names). For new shared modules (rbc-1 review-dates, BPS/math constants), run `npm run check:shared-cycles` to confirm no import cycle.
