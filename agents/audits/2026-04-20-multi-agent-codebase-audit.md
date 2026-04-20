# Multi-Agent Codebase Audit - 2026-04-20

Scope: `src/`, `shared/`, `worker/src/`, `functions/`, `scripts/`, `worker/scripts/`, `.github/`, root configs, and verified docs. Excluded generated/runtime output: `node_modules/`, `.next/`, `out/`, `dist/`, `coverage/`, `worker/.wrangler/`, `.worktrees/`, and previously generated `agents/` reports except as documentation corpus evidence.

Method: three `gpt-5.4` / `xhigh` agents audited redundancy, code quality, and sustainability in parallel. I independently ran repo guardrails, clone detection, TypeScript AST hotspot scans, dependency audit/outdated checks, coverage, and manual validation of the strongest findings.

## 1. Executive Summary

### Finding Counts

| Pillar | Total | Critical | High | Medium | Low |
| --- | ---: | ---: | ---: | ---: | ---: |
| Redundancy elimination | 13 | 0 | 0 | 8 | 5 |
| Code quality improvement | 11 | 0 | 1 | 7 | 3 |
| Sustainability and maintainability | 8 | 0 | 1 | 4 | 3 |
| Cross-cutting compound issues | 6 | 0 | 3 | 3 | 0 |

### Top 5 Highest Priority Findings

1. `Q-01` API-key auth/rate-limit D1 failures can escape the documented JSON/503 contract.
2. `S-01` Production deploy concurrency can cancel post-promotion smoke/rollback after production has changed.
3. `Q-02` `yield-rankings` can serve schema-invalid cached JSON as HTTP 200.
4. `S-02` Cron lease timeout is cooperative, but several leased jobs ignore or drop abort signals.
5. `Q-04` Root remote-D1 repair scripts are outside SQL-safety guardrails and are live by default unless `--dry-run` is supplied.

### Health Ratings

| Pillar | Rating | Justification |
| --- | ---: | --- |
| Redundancy | 8/10 | Clone density is low overall: `jscpd` found 0.99% duplicated lines across 2,178 analyzed files. Most clones are tests. The remaining production duplication is localized and easy to consolidate. |
| Code quality | 7/10 | Lint, typecheck, SQL safety, full tests, and full coverage pass. The main risks are boundary behavior: API auth dependency failures, malformed cached payloads, unconsumed non-OK responses, and large waived hotspots. |
| Sustainability | 7/10 | Architecture guardrails are strong: cycles, worker boundary, env contract, migrations, docs, cron sync, and connection budgets pass. The largest long-term risks are deploy cancellation semantics, cooperative cron cancellation, and documentation drift around isolate-local state. |

### Technical Debt Profile

Significant findings affect roughly 10-15% of the active source surface by operational risk, not raw line count. Raw duplication is only about 1%, but high-change hotspots and cron/API/deploy safety issues touch core operational paths. The most affected areas are Worker auth/rate limiting, cron orchestration, DEX/yield cache handling, remote repair scripts, methodology/UI copy modules, and test fixture duplication.

## 2. Findings by Pillar

### Pillar 1 - Redundancy Elimination

#### `R-01` Medium - Stablecoin taxonomy hub pages are near-clones

Locations:
- `src/app/stablecoins/backing/page.tsx:45-75`
- `src/app/stablecoins/governance/page.tsx:45-75`
- `src/app/stablecoins/infrastructure/page.tsx:45-75`

Problem: The three route pages repeat the same JSON-LD list and card-grid render structure, differing only by taxonomy array, list name, metadata copy, and shell labels.

Consolidation: Extract a small `StablecoinTaxonomyHubPage` server component that accepts taxonomy pages, JSON-LD list name, and shell metadata. Keep route-specific metadata exports local.

#### `R-02` Medium - Report-card `rawInputs` default object is repeated across runtime and tests

Locations:
- `worker/src/lib/report-cards-snapshot-finalize.ts:52-78`
- `src/app/portfolio/client.tsx:348-365`
- `src/components/__tests__/report-card.test.tsx:50-75`
- `src/hooks/__tests__/use-stress-test.test.ts:44-70`
- `src/hooks/__tests__/use-portfolio.test.ts:48-70`

Problem: The long `rawInputs` shape is repeatedly hand-built. Adding a new raw input now requires touching production and multiple fixtures, which increases schema drift risk.

Consolidation: Add a shared factory such as `createDefaultReportCardRawInputs(overrides)` in a runtime-neutral shared module, or a production helper plus test-only wrapper if fixture defaults need looser values.

#### `R-03` Medium - DEX liquidity drift summary type is duplicated

Locations:
- `worker/src/cron/dex-liquidity/orchestrator-drift.ts:47-67`
- `worker/src/cron/dex-liquidity/orchestrator-analysis.ts:240-258`

Problem: `qualityDriftMetrics` and `topAssetCoverageDeltas` are manually repeated in the analysis metadata type, so future drift-metric fields can diverge.

Consolidation: Reuse `DexLiquidityDriftSummary` directly or export subtypes for `qualityDriftMetrics` and watchlist deltas.

#### `R-04` Medium - Blacklist sync repeats post-fetch processing for Tron and EVM branches

Locations:
- `worker/src/cron/sync-blacklist.ts:231-253`
- `worker/src/cron/sync-blacklist.ts:296-317`

Problem: Both chain branches call `processFetchedBlacklistRows()` and then manually add the same counter fields. Any future counter or persistence result can be missed in one branch.

Consolidation: Extract `applyProcessedBlacklistRows(processed)` or wrap fetch+process into per-chain strategy functions that return a single normalized result object.

#### `R-05` Medium - Documentation guard scripts duplicate markdown traversal helpers

Locations:
- `scripts/check-doc-source-paths.mjs:39-56`
- `scripts/check-verified-doc-links.mjs:13-30`

Problem: Both scripts maintain local `collectMarkdownFiles()` and line splitting behavior.

Consolidation: Add `scripts/lib/doc-files.mjs` with `collectVerifiedMarkdownFiles()` and `splitLines()`.

#### `R-06` Medium - Cemetery date sorting logic is duplicated and subtly divergent

Locations:
- `src/lib/cemetery.ts:12-60`
- `scripts/generate-cemetery-dataset.ts:57-82`

Problem: Both paths parse death month and sort dead stablecoins. Runtime sorting gives major collapses a special tie-breaker while dataset generation does not, so visible order and exported order can diverge.

Consolidation: Move date parsing and sort comparators into a shared runtime-neutral cemetery utility used by both the page model and dataset generator.

#### `R-07` Medium - API-key rate-limit policy is duplicated between Worker and admin UI

Locations:
- `worker/src/lib/api-key-core.ts:14-16`
- `src/components/status/api-keys-panel.tsx:33-35`
- `src/components/status/api-keys-panel.tsx:81-96`
- `src/components/status/api-keys-panel.tsx:263-266`
- `src/components/status/api-keys-panel.tsx:408-411`

Problem: Server and UI both define min/max/default API-key rate limits. A future server policy change can leave the UI rejecting valid inputs or submitting invalid ones.

Consolidation: Move the public API-key policy constants to `shared/lib/ops-limits.ts` or a dedicated `shared/lib/api-key-policy.ts`.

#### `R-08` Medium - Root depeg repair scripts duplicate remote-D1 mutation and replay patterns

Locations:
- `scripts/fix-non-usd-depeg-fx.ts:63-90`
- `scripts/fix-non-usd-depeg-fx.ts:159-178`
- `scripts/fix-commodity-depeg-median.ts:132-188`
- `scripts/lib/remote-d1.ts:9-45`
- Related runtime replay logic: `worker/src/api/backfill-depegs-replay.ts:32-170`

Problem: One-off root scripts duplicate query, update/delete, and remote D1 execution patterns outside the main Worker API/admin repair flow.

Consolidation: Retire bootstrap-only scripts after confirmation, or make them call shared replay/query helpers and the same safer remote-D1 primitive.

#### `R-09` Low - Site header metric pills are repeated for mobile and desktop

Locations:
- `src/components/site-header.tsx:76-89`
- `src/components/site-header.tsx:92-107`

Problem: The same three metric pills are hand-rendered twice with only container layout differences.

Consolidation: Extract a `MetricPills` helper receiving the metric tuple list and container class.

#### `R-10` Low - Safety score card grid rendering is duplicated between grouped and flat modes

Locations:
- `src/app/safety-scores/client.tsx:708-723`
- `src/app/safety-scores/client.tsx:728-742`

Problem: The `LazyCard` + `ReportCardMini` prop block is identical in grouped and flat branches.

Consolidation: Extract `renderMiniCard(card, index)` or a small `SafetyScoreMiniCard` local component.

#### `R-11` Low - DEWS methodology pipeline diagram duplicates signal cards for desktop and mobile

Locations:
- `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx:264-331`
- `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx:334-380`

Problem: Signal names/weights and threat bands are duplicated across desktop and mobile diagrams, risking content drift in methodology copy.

Consolidation: Define arrays for DEWS signals and threat bands, then render them with layout-specific wrappers.

#### `R-12` Low - Commented strict bridge-validation block is stale dead code

Location:
- `worker/src/lib/mint-burn-contracts.ts:713-719`
- `worker/src/lib/mint-burn-contracts.ts:721-728`

Problem: The code explains a deferred stricter validation approach but still depends on `as any` and local comments instead of an explicit typed path or tracked rollout. The current guard is active, but the documented "future" state is embedded in code instead of a plan.

Consolidation: Replace the `as any` sweep with typed optional-field access helpers, or remove future-state comments and track any stricter rollout in `agents/tasks/`.

#### `R-13` Low - High-density test fixture duplication

Representative locations:
- `worker/src/cron/reserve-adapters/__tests__/evm-branch-balances.test.ts:36-64`, `135-163`, `388-411`
- `worker/src/lib/__tests__/report-cards-snapshot.test.ts:256-328`, `341-416`, `550-650`
- `worker/src/api/__tests__/health.test.ts:249-282`, `299-332`, `386-419`
- `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts:233-305`, `424-487`

Problem: Most clone density is in tests. This is lower risk than production duplication, but it makes fixture changes expensive and can obscure intent.

Consolidation: Introduce focused builders for reserve branch balances, report-card snapshot rows, health cache rows, and DEX staging rows.

### Pillar 2 - Code Quality Improvement

#### `Q-01` High - API-key auth/rate-limit D1 failures can escape JSON error handling

Locations:
- `worker/src/handlers/http/gates.ts:92-112`, function `evaluateAccessGate`
- `worker/src/lib/api-key-auth.ts:32-83`, function `authenticateApiKey`
- `worker/src/lib/api-key-rate-limit.ts:11-52`, function `checkApiKeyRateLimit`
- `worker/src/lib/api-key-rate-limit.ts:54-72`, function `recordApiKeyUsage`
- `worker/src/handlers/http/request-dispatch.ts:23-44`, function `handleHttpRequestImpl`

Problem: Protected public API auth, per-key limiter writes, and usage bookkeeping call D1 directly. If D1 throws during key lookup, limiter insert, pepper rotation update, or usage update, the exception escapes `evaluateAccessGate()`. `handleHttpRequestImpl()` has no top-level JSON/CORS error wrapper around the gate call. This conflicts with `docs/api-reference.md`, which documents limiter/auth dependency failures as `503`.

Remediation: Contain API-key auth and limiter dependency failures inside `evaluateAccessGate()`. Return `503 Public API temporarily unavailable` with `Retry-After` for auth/limiter storage failures. Make usage updates best-effort through `ctx.waitUntil()` or a contained `catch`. Add tests for D1 throws from `lookupApiKeyByPrefix`, `checkApiKeyRateLimit`, pepper migration update, and `recordApiKeyUsage`.

#### `Q-02` Medium - `yield-rankings` serves schema-invalid cache payloads as 200

Location:
- `worker/src/api/cache-handlers.ts:169-196`, function `handleYieldRankings`

Problem: `readCachedJsonOr503()` rejects malformed JSON, but schema validation only gates live safety hydration. If JSON parses but fails `YieldRankingsResponseSchema`, `body` remains `parsed.data`; object-shaped invalid payloads then receive `_meta` and are returned as HTTP 200.

Remediation: Mirror stricter cache handlers: when `!validation.ok`, return `errorResponse(503, "Cached yield-rankings payload is malformed")`. Add a test with valid JSON but missing required schema fields.

#### `Q-03` Medium - Passthrough non-OK upstream responses can leave bodies unread

Locations:
- `worker/src/lib/fetch-retry.ts:49-60`, function `fetchWithRetry`
- `worker/src/cron/sync-bluechip.ts:111-119`, function `syncBluechip`
- `worker/src/lib/fx-realtime.ts:37-44`, function `fetchRealtimeFxRates`

Problem: `fetchWithRetry()` cancels bodies for retryable/non-passthrough failures, but returns passthrough non-OK `Response` objects without consuming/canceling them. `syncBluechip()` then returns `null` on a 404/non-OK response without cleanup. `fetchRealtimeFxRates()` also returns on non-OK without draining. This conflicts with the documented Worker connection-budget rule.

Remediation: Either make passthrough returns structured diagnostics instead of raw responses, or enforce caller cleanup. Immediate fixes: call `cancelResponseBodyQuietly(res)` before non-OK returns in `syncBluechip()` and `fetchRealtimeFxRates()`.

#### `Q-04` Medium - Root remote-D1 repair scripts are outside SQL guardrails and live by default

Locations:
- `scripts/check-sql-interpolation-safety.mjs:6-8`
- `scripts/fix-non-usd-depeg-fx.ts:16-24`
- `scripts/fix-non-usd-depeg-fx.ts:85-88`
- `scripts/fix-commodity-depeg-median.ts:9-18`
- `scripts/lib/remote-d1.ts:9-45`

Problem: The SQL safety checker scans `worker/src` and `worker/scripts`, not root `scripts/`. The root repair scripts run live unless `--dry-run` is supplied and use string-built SQL through `remote-d1.ts`. `remote-d1.ts` shells out with interpolated command strings.

Remediation: Add root `scripts/` to SQL safety roots, require `--apply` for mutating remote D1 repair scripts, validate enum-like interpolated values before SQL construction, and replace `execSync(string)` with `execFileSync("npx", ["wrangler", ...])`.

#### `Q-05` Medium - DEX top-pool JSON normalization trusts parsed shape

Location:
- `worker/src/api/dex-liquidity-response.ts:102-117`, function `normalizeTopPools`

Problem: `safeJsonParse<DexLiquidityPoolResponse[]>(json, [])` is a type assertion, not validation. If valid JSON is an object, `parsed.map` throws. If the array contains `null` or primitives, `pool.extra` and `pool.source` can throw.

Remediation: Parse as `unknown`, require `Array.isArray(parsed)`, filter to non-null objects, then pick allowed keys. Add tests for `{}`, `null`, `[null]`, `[1]`, and objects with invalid `extra`.

#### `Q-06` Medium - Large hotspots still concentrate too many responsibilities

Locations:
- `src/components/contagion-graph.tsx:44-641`, component `ContagionGraph`
- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:458-787`, function `fetchPrimaryPrices`
- `worker/src/cron/confirm-pending-depegs.ts:67-447`, function `confirmPendingDepegs`
- `worker/src/cron/dex-discovery/crawl-sources.ts:60-496`, function `crawlCoin`

Problem: The hotspot ratchet passes, but these functions/components still have large line counts and high branch counts. They mix orchestration, data shaping, policy decisions, and rendering/fetch details.

Remediation: Split by responsibility. Suggested first cuts: graph data model vs SVG/rendering for `ContagionGraph`; provider fetch plan vs merge/scoring for `fetchPrimaryPrices`; evidence collection vs promotion decision vs persistence for `confirmPendingDepegs`; source-specific crawlers for `crawlCoin`.

#### `Q-07` Medium - Coverage blind spots remain in specific high-change modules

Evidence:
- Full coverage: 83.67% lines, 70.04% branches.
- `worker/src/cron/dex-liquidity/subgraph-source-families.ts`: 0.0% lines.
- `worker/src/cron/dex-liquidity/crawl-helpers.ts`: 0.0% lines.
- `worker/src/cron/dex-liquidity/subgraph-helpers.ts`: 0.0% lines.
- `worker/src/api/og.tsx`: 7.3% lines.
- `src/components/dews-summary.tsx`: 1.3% lines.
- `src/components/dews-detail.tsx`: 9.1% lines.
- `worker/src/cron/blacklist/amount-recovery.ts`: 29.3% lines.

Problem: Overall coverage is solid, but several modules around DEX subgraph integration, OG rendering, DEWS UI, and blacklist recovery have limited direct characterization. These are exactly the areas where upstream shape changes can create regressions.

Remediation: Add focused tests before large refactors: DEX subgraph family mapping, crawl helper malformed payloads, OG route fallback paths, DEWS summary render states, and blacklist amount-recovery edge cases.

#### `Q-08` Low - Telegram webhook logs auth misconfiguration for ordinary missing-secret requests

Locations:
- `worker/src/api/telegram-webhook.ts:78-88`
- `worker/src/lib/auth.ts:147-150`, function `timingSafeCompare`

Problem: A public request missing `X-Telegram-Bot-Api-Secret-Token` passes an empty string into `timingSafeCompare()`, which logs "possible misconfiguration". This is caller-controlled noise on a public endpoint that intentionally returns 200 to avoid Telegram retry storms.

Remediation: In the webhook handler, return `ok()` before timing comparison when the presented secret is blank. Keep `timingSafeCompare()` strict for internal callers.

#### `Q-09` Low - OG card classification labels are locally redefined

Locations:
- `worker/src/lib/og-templates/stablecoin-card.tsx:53-75`
- Shared source of truth: `shared/lib/classification.ts:24-67`

Problem: `formatBacking()` and `formatGovernance()` define local label maps, despite the repo rule that classification labels live in `shared/lib/classification.ts`.

Remediation: Import `BACKING_LABELS_SHORT` and `GOVERNANCE_LABELS_SHORT`. Type OG card backing/governance fields to shared unions where possible.

#### `Q-10` Low - Compare share toast timers are not cleaned up on unmount

Locations:
- `src/hooks/use-compare-share-actions.ts:119-120`
- `src/hooks/use-compare-share-actions.ts:161-170`
- Good local pattern: `src/components/share-button.tsx:35-42`

Problem: `setTimeout(() => setToast(null), ...)` is called without storing or clearing timer handles. Navigating away after share actions can trigger stale state updates.

Remediation: Use `useRef<ReturnType<typeof setTimeout> | null>` and cleanup in `useEffect`, matching `ShareButton`.

#### `Q-11` Low - Feedback `pageUrl` validation allows protocol-relative strings

Location:
- `worker/src/api/feedback/types.ts:19`

Problem: `z.string().startsWith("/")` accepts values like `//example.com`. The value is not used for redirecting, but it is written into GitHub issues and can create misleading external-looking links in operator triage.

Remediation: Require `pageUrl` to match an internal path such as `^/(?!/)[^\r\n]*$`, or validate with `new URL(value, SITE_URL)` and reject if the resolved origin differs.

### Pillar 3 - Sustainability and Maintainability

#### `S-01` High - Production deploy cancellation can bypass post-deploy smoke and rollback

Locations:
- `.github/workflows/deploy-cloudflare.yml:7-9`
- `.github/workflows/deploy-cloudflare.yml:130-184`
- `.github/workflows/pages-publish.yml:58-96`
- `docs/deployment-process.md:212-214`

Problem: The production deploy workflow uses `cancel-in-progress: true`. If a new push lands after Worker or Pages promotion but before smoke/rollback jobs finish, GitHub can cancel the in-flight workflow and leave production changed without the intended canary/rollback sequence.

Remediation: Split deploy into cancellable pre-deploy validation and non-cancellable production promotion, or set the production deploy concurrency group to queue once promotion starts. Keep PR validation cancellable.

#### `S-02` Medium - Cron timeout/lease cancellation is cooperative and inconsistently honored

Locations:
- `worker/src/lib/cron-logger.ts:125-133`
- `worker/src/lib/cron-lease.ts:428-447`
- `worker/src/cron/compute-dews.ts:69-77`
- `worker/src/cron/snapshot-psi.ts:6-30`
- `worker/src/handlers/scheduled/daily-0300.ts:5-17`

Problem: `logCronRun()` races jobs against a timeout signal, and `runCronWithLease()` releases the lease in `finally` after the race. If the underlying job ignores the abort signal, work can continue after timeout while the lease is released. Several jobs accept `_signal` or drop the signal entirely.

Remediation: Make abort propagation an explicit cron contract. Add `throwIfAborted(signal)` between D1 phases in DB-only jobs. Add a guardrail for `_signal` in leased cron entrypoints unless explicitly waived. For non-abortable jobs, keep the lease until the job settles or use bounded phase-level timeouts.

#### `S-03` Medium - Edge cache writes ignore `Cache-Control: no-store`

Locations:
- `worker/src/handlers/http/edge-cache.ts:20-27`
- `worker/src/api/chains.ts:96-100`
- `worker/src/lib/api-freshness.ts:384-394`

Problem: `writeEdgeCache()` only checks `skipCache` and `response.ok`. Several successful degraded/stale responses intentionally set `Cache-Control: no-store`. Cloudflare documents that its Cache API respects response `Cache-Control` on `cache.put()`; attempting to put no-store responses is unnecessary work and can add background noise.

Remediation: Skip edge cache writes when `Cache-Control` contains `no-store`, `no-cache`, or `private`; add a `.catch()` on the `waitUntil()` promise for low-rate logging. Add a unit test for 200 + no-store.

Reference: https://developers.cloudflare.com/workers/runtime-apis/cache/

#### `S-04` Medium - Root repair scripts are not integrated into the same safety envelope as Worker operations

Locations:
- `scripts/fix-non-usd-depeg-fx.ts:16-24`
- `scripts/fix-commodity-depeg-median.ts:9-18`
- `scripts/lib/remote-d1.ts:9-45`
- `docs/scripts.md:44-50`

Problem: The scripts are documented, but their execution safety differs from admin endpoints and Worker scripts: live-by-default, outside SQL safety roots, and string-shell D1 invocations. These are operationally high-impact because they mutate production D1 history.

Remediation: Standardize remote repair operations: require `--apply`, log a dry-run summary by default, use `execFileSync`, and add root `scripts/` to the SQL guard.

#### `S-05` Medium - Hotspot waiver backlog has several route/client and cron modules queued but not yet decomposed

Locations:
- `scripts/lib/hotspot-ratchet-waivers.json:1-88`
- `src/components/contagion-graph.tsx:44-641`
- `src/components/stablecoin-detail/hero-card.tsx:387-865`
- `src/components/kpi-bar.tsx:271-601`
- `worker/src/cron/daily-digest/prompt.ts:195-423`
- `worker/src/cron/confirm-pending-depegs.ts:67-447`

Problem: The ratchet prevents further growth, but many waivers are marked `queued-p4` or `deferred`. This is sustainable only if the backlog remains actively owned; otherwise the ratchet becomes a documentation artifact rather than a reduction plan.

Remediation: Pick one frontend hotspot and one Worker hotspot per cleanup cycle, reduce target budgets after each extraction, and add owner/date metadata to waiver entries.

#### `S-06` Low - Worker infrastructure docs understate isolate-local mutable state

Locations:
- `docs/worker-infrastructure.md:307-318`
- `worker/src/lib/rate-limit.ts:23-31`
- `worker/src/lib/api-key-core.ts:96-101`
- `functions/lib/request-attribution.ts:14-15`
- `worker/src/lib/isolate-local-state.ts:1-10`

Problem: The docs say the remaining intentional module-level mutable state is only `jwksCache`, but runtime code also has isolate-local rate-limit, API-key, and Pages attribution state. The code is mostly intentional; the doc drift is the issue.

Remediation: Update the docs with an allowlisted inventory of module-level state, purpose, TTL/reset behavior, and multi-isolate caveat. Optionally add a static guardrail for new top-level `let`/`IsolateLocalState`.

#### `S-07` Low - Dependency drift is low risk today but needs a planned major-upgrade lane

Locations:
- `package.json:75-76`
- `package.json:104-114`
- `worker/package.json:15-22`

Evidence:
- `npm audit --json`: 0 vulnerabilities.
- `npm outdated --json`: patch/minor drift for `@cloudflare/workers-types` `4.20260416.2 -> 4.20260420.1`, `@tanstack/react-query` `5.99.0 -> 5.99.2`, `@tanstack/react-virtual` `3.13.23 -> 3.13.24`, `viem` `2.48.0 -> 2.48.1`; major drift for `eslint` `9.39.4 -> 10.2.1` and `typescript` `5.9.3 -> 6.0.3`.

Problem: There is no current vulnerability issue. The sustainability risk is that TypeScript 6 and ESLint 10 will likely require coordinated config/code updates.

Remediation: Track a dependency-upgrade issue for TypeScript 6 and ESLint 10; batch patch-level runtime dependency updates separately.

#### `S-08` Low - Full coverage is strong overall, but branch coverage remains weaker than line coverage

Evidence:
- Full coverage: statements 81.5%, branches 70.04%, functions 83.78%, lines 83.67%.
- Critical coverage gate passed.

Problem: Branch coverage lags line coverage by about 13.6 points. The lowest modules are concentrated, but branch-sensitive paths are where malformed upstream payloads and fallback policies usually fail.

Remediation: Set per-directory branch ratchets for Worker API/cache parsing and cron provider helpers rather than only global line coverage.

## 3. Cross-Cutting Concerns

### `X-01` API-key policy drift across Worker, UI, and ops docs

Connects: `R-07`, `S-07`, `Q-01`.

Risk: Server policy, admin UI validation, and API dependency failure behavior are not fully centralized. This raises both correctness and operations risk as API-key support evolves.

Action: Centralize API-key policy constants, harden D1 failure containment, and add API-key dependency-failure tests.

### `X-02` Cron cancellation and connection-budget discipline

Connects: `Q-03`, `S-02`, `S-03`.

Risk: The codebase documents strict connection and timeout rules, but a few non-OK responses and signal-ignored jobs still bypass those assumptions. These are rare until an upstream is degraded, exactly when they matter.

Action: Add static/runtime guardrails for response draining and abort propagation; start with `sync-bluechip`, `fetchRealtimeFxRates`, DEWS/PSI snapshots, and edge cache no-store skips.

### `X-03` Remote repair scripts are both redundant and outside safety guardrails

Connects: `R-08`, `Q-04`, `S-04`.

Risk: Production D1 repair logic exists in one-off scripts, runtime helpers, and admin paths. The scripts are powerful but do not inherit the same SQL safety and apply/dry-run posture.

Action: Consolidate remote-D1 execution, require `--apply`, and expand SQL guard coverage before adding new repair scripts.

### `X-04` DEX-liquidity evolution has duplicated contracts, parser fragility, and test gaps

Connects: `R-03`, `Q-05`, `Q-07`, `S-08`.

Risk: DEX liquidity is active, complex, and upstream-dependent. Type duplication and parser assumptions can become production incidents when provider payloads drift.

Action: Reuse drift summary types, harden `normalizeTopPools()`, and add coverage for subgraph helpers/source families.

### `X-05` Hotspot modules are acknowledged but still costly to change

Connects: `Q-06`, `S-05`, `R-10`, `R-11`.

Risk: The ratchet prevents worsening, but repeated UI blocks and large components still make reviews expensive and increase regression risk.

Action: Pair each feature change touching a hotspot with one small extraction that lowers the budget.

### `X-06` Documentation guardrails are strong, but docs/check scripts duplicate their own plumbing

Connects: `R-05`, `S-06`.

Risk: Verified docs are well guarded, but helper duplication and module-state doc drift make the guardrail surface itself harder to maintain.

Action: Extract shared docs-check helpers and update module-level state docs.

## 4. Prioritized Remediation Roadmap

### Phase 1 - Quick Wins

| Finding | Action | Files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `Q-02` | Return 503 on schema-invalid `yield-rankings` cache and add a regression test. | `worker/src/api/cache-handlers.ts` | Small | None |
| `Q-05` | Harden `normalizeTopPools()` against non-array and primitive entries. | `worker/src/api/dex-liquidity-response.ts` | Small | None |
| `Q-08` | Skip timing compare when Telegram secret header is blank. | `worker/src/api/telegram-webhook.ts`, `worker/src/lib/auth.ts` | Small | None |
| `Q-10` | Add timer cleanup to compare share actions. | `src/hooks/use-compare-share-actions.ts` | Small | None |
| `R-05` | Extract docs traversal helpers. | `scripts/check-doc-source-paths.mjs`, `scripts/check-verified-doc-links.mjs`, `scripts/lib/` | Small | None |
| `R-09` | Extract site-header metric pill helper. | `src/components/site-header.tsx` | Small | None |
| `R-10` | Extract safety-score mini-card renderer. | `src/app/safety-scores/client.tsx` | Small | None |
| `S-06` | Update module-level state docs. | `docs/worker-infrastructure.md` | Small | None |

### Phase 2 - Targeted Refactoring

| Finding | Action | Files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `Q-01` | Contain API-key D1 failures and test 503/error contracts. | `worker/src/handlers/http/gates.ts`, `worker/src/lib/api-key-*`, tests | Medium | None |
| `Q-03` | Drain/cancel passthrough non-OK responses. | `worker/src/lib/fetch-retry.ts`, `sync-bluechip.ts`, `fx-realtime.ts` | Medium | None |
| `S-03` | Skip edge cache writes for `no-store`/private responses. | `worker/src/handlers/http/edge-cache.ts` | Small | None |
| `R-03` | Compose DEX analysis metadata from drift summary type. | `worker/src/cron/dex-liquidity/*` | Small | None |
| `R-04` | Normalize blacklist post-fetch processing counters. | `worker/src/cron/sync-blacklist.ts` | Medium | None |
| `R-06` | Share cemetery sort/date utilities. | `src/lib/cemetery.ts`, `scripts/generate-cemetery-dataset.ts` | Small | None |
| `R-07` | Move API-key policy constants to shared. | `shared/lib`, `worker/src/lib/api-key-core.ts`, `src/components/status/api-keys-panel.tsx` | Small | Coordinate with `Q-01` |
| `Q-09` | Use shared classification labels in OG cards. | `worker/src/lib/og-templates/stablecoin-card.tsx` | Small | None |

### Phase 3 - Structural Improvements

| Finding | Action | Files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `Q-04` / `S-04` | Bring root repair scripts under SQL guardrails, `--apply`, and `execFileSync`. | `scripts/fix-*`, `scripts/lib/remote-d1.ts`, SQL safety checker | Medium | None |
| `S-02` | Enforce abort propagation in cron jobs and leased wrappers. | `worker/src/lib/cron-*`, cron entrypoints | Medium | Add focused tests first |
| `R-01` | Introduce taxonomy hub component. | `src/app/stablecoins/*/page.tsx`, new component | Medium | None |
| `R-02` | Add report-card raw-input factory. | shared helper plus fixtures/runtime callers | Medium | Avoid changing schema semantics |
| `Q-07` / `S-08` | Add tests for DEX subgraph helpers, OG paths, DEWS UI, blacklist recovery. | targeted tests | Medium | None |
| `S-07` | Plan TypeScript 6 / ESLint 10 migration. | package/config/tooling | Medium | Separate from feature work |

### Phase 4 - Strategic Overhauls

| Finding | Action | Files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `S-01` | Split production deploy into cancellable predeploy and non-cancellable promotion/smoke/rollback. | `.github/workflows/*`, deployment docs | Large | Needs CI design review |
| `Q-06` / `S-05` | Decompose one Worker hotspot and one frontend hotspot per cleanup cycle. | `contagion-graph`, `fetchPrimaryPrices`, `confirmPendingDepegs`, `crawlCoin`, large route clients | Large | Update hotspot budgets after each split |
| `X-02` | Add systematic response-body/abort guardrails. | worker lint/static scripts plus tests | Large | Depends on Phase 2 response-drain fixes |

## 5. Appendices

### A. File-by-File Finding Index

| File | Findings |
| --- | --- |
| `.github/workflows/deploy-cloudflare.yml` | `S-01` |
| `.github/workflows/pages-publish.yml` | `S-01` |
| `docs/deployment-process.md` | `S-01` |
| `docs/worker-infrastructure.md` | `S-06` |
| `package.json` | `S-07` |
| `worker/package.json` | `S-07` |
| `scripts/check-doc-source-paths.mjs` | `R-05` |
| `scripts/check-verified-doc-links.mjs` | `R-05` |
| `scripts/check-sql-interpolation-safety.mjs` | `Q-04` |
| `scripts/fix-non-usd-depeg-fx.ts` | `R-08`, `Q-04`, `S-04` |
| `scripts/fix-commodity-depeg-median.ts` | `R-08`, `Q-04`, `S-04` |
| `scripts/generate-cemetery-dataset.ts` | `R-06` |
| `scripts/lib/remote-d1.ts` | `R-08`, `Q-04`, `S-04` |
| `src/app/portfolio/client.tsx` | `R-02` |
| `src/app/safety-scores/client.tsx` | `R-10` |
| `src/app/stablecoins/backing/page.tsx` | `R-01` |
| `src/app/stablecoins/governance/page.tsx` | `R-01` |
| `src/app/stablecoins/infrastructure/page.tsx` | `R-01` |
| `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx` | `R-11` |
| `src/components/contagion-graph.tsx` | `Q-06`, `S-05` |
| `src/components/dews-detail.tsx` | `Q-07` |
| `src/components/dews-summary.tsx` | `Q-07` |
| `src/components/kpi-bar.tsx` | `S-05` |
| `src/components/share-button.tsx` | `Q-10` |
| `src/components/site-header.tsx` | `R-09` |
| `src/components/stablecoin-detail/hero-card.tsx` | `S-05` |
| `src/hooks/use-compare-share-actions.ts` | `Q-10` |
| `src/lib/cemetery.ts` | `R-06` |
| `worker/src/api/cache-handlers.ts` | `Q-02` |
| `worker/src/api/chains.ts` | `S-03` |
| `worker/src/api/dex-liquidity-response.ts` | `Q-05` |
| `worker/src/api/feedback/types.ts` | `Q-11` |
| `worker/src/api/telegram-webhook.ts` | `Q-08` |
| `worker/src/cron/blacklist/amount-recovery.ts` | `Q-07` |
| `worker/src/cron/compute-dews.ts` | `S-02` |
| `worker/src/cron/confirm-pending-depegs.ts` | `Q-06`, `S-05` |
| `worker/src/cron/dex-discovery/crawl-sources.ts` | `Q-06` |
| `worker/src/cron/dex-liquidity/crawl-helpers.ts` | `Q-07` |
| `worker/src/cron/dex-liquidity/orchestrator-analysis.ts` | `R-03` |
| `worker/src/cron/dex-liquidity/orchestrator-drift.ts` | `R-03` |
| `worker/src/cron/dex-liquidity/subgraph-helpers.ts` | `Q-07` |
| `worker/src/cron/dex-liquidity/subgraph-source-families.ts` | `Q-07` |
| `worker/src/cron/snapshot-psi.ts` | `S-02` |
| `worker/src/cron/sync-blacklist.ts` | `R-04` |
| `worker/src/cron/sync-bluechip.ts` | `Q-03` |
| `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` | `Q-06`, `S-05` |
| `worker/src/handlers/http/edge-cache.ts` | `S-03` |
| `worker/src/handlers/http/gates.ts` | `Q-01` |
| `worker/src/handlers/http/request-dispatch.ts` | `Q-01` |
| `worker/src/handlers/scheduled/daily-0300.ts` | `S-02` |
| `worker/src/lib/api-freshness.ts` | `S-03` |
| `worker/src/lib/api-key-auth.ts` | `Q-01` |
| `worker/src/lib/api-key-core.ts` | `R-07`, `S-06` |
| `worker/src/lib/api-key-rate-limit.ts` | `Q-01` |
| `worker/src/lib/auth.ts` | `Q-08` |
| `worker/src/lib/cron-lease.ts` | `S-02` |
| `worker/src/lib/cron-logger.ts` | `S-02` |
| `worker/src/lib/fetch-retry.ts` | `Q-03` |
| `worker/src/lib/fx-realtime.ts` | `Q-03` |
| `worker/src/lib/isolate-local-state.ts` | `S-06` |
| `worker/src/lib/mint-burn-contracts.ts` | `R-12` |
| `worker/src/lib/og-templates/stablecoin-card.tsx` | `Q-09` |
| `worker/src/lib/report-cards-snapshot-finalize.ts` | `R-02` |

### B. Dependency Audit Summary

| Check | Result |
| --- | --- |
| `npm audit --json` | 0 total vulnerabilities |
| Production dependency advisories | 0 high/critical |
| `npm outdated --json` patch/minor drift | `@cloudflare/workers-types`, `@tanstack/react-query`, `@tanstack/react-virtual`, `viem` |
| `npm outdated --json` major drift | `eslint` 9 -> 10, `typescript` 5.9 -> 6 |
| Redundant dependency candidates | No strong candidate found. Tooling dependencies with zero source imports are used by configs/scripts (`tailwindcss`, `@tailwindcss/postcss`, `jsdom`, `npm-run-all2`, `tsx`, `wrangler`, `vitest`, `prettier`). |

### C. Verification Commands Run

Passed:

- `npm run lint`
- `npm run typecheck`
- `cd worker && npx tsc --noEmit`
- `cd worker && npx tsc --noEmit -p tsconfig.scripts.json`
- `npm test`
- `npm run test:coverage`
- `npm run coverage:critical`
- `npm audit --json`
- `npm outdated --json` (exited 1 because updates exist; output reviewed)
- `npm run check:unused-code`
- `npm run check:shared-cycles`
- `npm run check:worker-boundary`
- `npm run check:hotspot-ratchet`
- `npm run check:env-contract`
- `npm run check:sql-safety`
- `npm run check:migrations`
- `npm run check:doc-counts`
- `npm run check:doc-sync`
- `npm run check:doc-source-paths`
- `npm run check:verified-doc-links`
- `npm run check:cron-sync`
- `npm run check:cron-connections`
- `npm run check:stablecoin-data`
- `npm run check:redemption-backstops`
- `npm run check:duplicate-exports`
- `npm run audit:pricing-providers`
- `npx --yes jscpd@4.0.5 --min-lines 12 --min-tokens 80 ...`

Not run: `npm run build`. No application code or docs under the verified public corpus were changed; this audit only adds an internal `agents/audits/` report.

### D. Glossary

| Term | Meaning |
| --- | --- |
| Structural clone | Code with the same logic but superficial differences in variable names or formatting. |
| DTO | Data transfer object; the shape moved across module/API boundaries. |
| Guardrail | A repo check that prevents a known class of regression. |
| Isolate-local state | Mutable module state that persists only inside one Cloudflare Worker isolate and is not shared globally. |
| Cooperative cancellation | Timeout/abort only stops work if the callee checks or passes the abort signal. |
| Cache passthrough | API handler pattern that reads a serialized payload from D1 cache and returns it to clients. |
| Hotspot | A large or branch-heavy file/function that is costly to review and risky to modify. |
| Backward-compatible migration | D1 migration that remains safe when applied before the new Worker version is promoted. |
