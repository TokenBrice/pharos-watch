# Live Reserve Sync

> **Agent navigation** — Current invariants and interfaces are below. Bounded family evidence, accounting and recovery references are in the [appendix](./process/live-reserves-appendix.md). Read routed sections rather than either file wholesale.

Dedicated documentation for the live reserve-composition subsystem that powers `GET /api/stablecoin-reserves/:id`, the stablecoin-detail reserve card, and `/status` reserve-sync health.


---

## Metadata Contract

Every provenance field below is an evidence claim about the current run, not a feed-family label — rule R6 (ADR-33 in [architecture.md](./architecture.md#adr-33)), enforced for route attribution by `buildRedemptionSnapshotMetadata` in `worker/src/cron/reserve-adapters/redemption.ts`.

Live reserve support is declared per coin in `StablecoinMeta.liveReservesConfig` (`shared/types/live-reserves.ts`, authored under `shared/data/stablecoins/coins/*.json` and validated by `shared/lib/stablecoins/schema.ts`). Producer, recovery, adapter lookups, and snapshot-store reads/writes use `shared/lib/stablecoins/worker-runtime-registry.ts`: configured feeds retain lossless `liveReservesConfig`, `flags`, `reserves`, and `reserveReview` inputs, while unconfigured entries keep only bounded classification/structural slices. `ReserveAdapterCoin` in `shared/types/core.ts` defines the adapter's metadata contract.

The `worker/src/lib/live-reserves/store.ts` barrel contains only producer-safe storage and overview functions. Public `resolveReserveResult` callers import `store-views.ts` directly; that presentation layer owns curated-reserve fallback templates and uses the Worker runtime registry. Only an unconfigured/retired coin's fallback lazily imports the full registry. Producer storage imports do not initialize the evidence-heavy catalog.

Snapshot-scoped provenance belongs to the accepted composition, never mutable latest-attempt metadata. A later failed attempt cannot replace its observation clocks, source generation or evidence envelope. `ReserveSliceSchema` validates the complete output before replacement, including namespace-qualified `sourceKey`, linked target identity and explicit `depType`; self-held assets cannot become self-dependencies. V9 compilation owns cycle handling and falls back or fails closed independently of detail/status presentation.

Stable source keys identify upstream categories, contracts or fixed bucket IDs, never percentages or display labels. Producer and reviewed sidecar keys change together. A reviewed join requires a unique matching key on each side; explicit mismatch/collision fails closed. Classification-only reviews may enrich eligible keyed facts within the review-age window, but certify neither whole-book weights nor liability attribution. Unkeyed compatibility captures require a unique normalized-name join under a full-composition review. Live weights remain measured weights; an aggregate fund-share key cannot be assigned to constituent holdings. Adapter mapping reviews live in `shared/data/coverage-dispositions/dependency-target-dispositions.ts`; that registry reviews mapping rules, not substitute asset identities.

### Registry-Defined Adapter Classes

`shared/types/live-reserve-adapter-declarations.ts` owns adapter definitions; `shared/lib/live-reserve-adapter-descriptors.ts` publishes `LIVE_RESERVE_ADAPTER_DEFINITIONS` as the shared consumer map. [Adapter maintenance](process/live-reserves-appendix.md#adapter-maintenance-entry) owns authoring and derived-type details. These definition properties are not user-configured per coin:

Equivalent complete descriptors may select explicit named profiles; shared telemetry objects are immutable exact capacity/fee combinations, not inferred capabilities. Per-adapter origin and no-capacity rationale remain explicit, and params-gated telemetry stays at its declaration so a generic profile cannot grant it accidentally. These authoring aids introduce no second schema surface or policy/fingerprint change.

`shared/types/live-reserve-core.ts` owns reusable input-kind and base configuration schemas, deriving their TypeScript shapes with `z.output` without loading adapter declarations. `shared/lib/live-reserve-adapters.ts` composes adapter-key, supported-input and params variants plus policy refinements; suspension dates retain their supported format-only validation, while supply-bootstrap review dates require valid calendar dates.

| Property              | Meaning                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `sourceModel`         | Distinguishes `dynamic-mix`, `validated-static`, and `single-bucket` reserve shapes                          |
| `evidenceClass`       | Distinguishes scoring-eligible `independent` feeds from `static-validated` and `weak-live-probe` feeds       |
| `sourceOriginClass`   | Records who produced the evidence without changing its admission, liveness, or scoring strength             |
| `sharedSourceMode`    | Distinguishes per-coin fetches (`none`) from explicitly source-invariant result sharing (`source-invariant`) |
| `redemptionTelemetry` | Declares whether the adapter can emit direct/proxy redemption capacity and current-fee telemetry             |

- `dynamic-mix`: measured multi-bucket reserve compositions. These can be `independent` evidence for scoring when the retained snapshot passes admission.
- `validated-static`: live validation/probe adapters over curated/static slices. These remain authoritative for the reserve detail API, but they are tagged `static-validated` and do not count as independent live collateral inputs for report-card scoring.
- `single-bucket`: one-slice live proofs/attestations; this shape alone does not establish independent evidence. Read each adapter's `evidenceClass` in `LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS`, rather than maintaining a second roster here.
- `independent`: scoring-eligible live evidence when the retained snapshot is fresh, authoritative, config-matched, and has no unexcused snapshot degradation; a later failed attempt does not revoke it.
- `static-validated`, `weak-live-probe`: detail/status-visible evidence classes that never override curated collateral scoring. Nested same-run redemption telemetry (`live-direct`, `live-direct-bounded`, `live-queue`, `live-proxy-validated`, or `documented-bound` with `same-run-onchain`, `same-run-api`, or `verified-source-timestamp`) may still bound the holder-facing exit route independently of either non-scoring composition class; legacy `immediateRedeemableUsd` on those classes stays rejected.
- `sourceOriginClass` is orthogonal to `evidenceClass`. It records `issuer-attested`, `onchain-observation`, `independent-assurance`, `reviewed-curation`, or `unknown` for diagnostic provenance. Unreviewed adapters resolve explicitly to `unknown`; the registry never guesses origin from an adapter name or input kind. Origin does not change reserve admission, standalone reserve facts, V9 facts, scores, or public API fields. The private V9 evidence-journal schema can carry the resolved value when journal writers are enabled.
- `source-invariant`: opt-in within-run result sharing for coin-invariant payloads. The result key canonicalizes adapter/version/semantics/inputs/params and omits coin ID; coin-dependent results must declare `none`. Reservoir runs per coin: srUSD reads the SavingModule leg/fee, while wsrUSD uses the deployed direct-rUSD branch. HTTP request sharing and block/resource-keyed PSM inventory deduplicate physical reads without summing shared cash across routes.

Instrument identity, complete measurement perimeter and matching units constrain every class. A fund-share NAV is not portfolio composition; a token-supply probe is not bank reserves; issuer signatures, PDF hashes, render clocks and reachable endpoints do not establish assurance, custody or executable liquidity. Permanent static/AUP/weak tiers require new independently supported source evidence, not a class flip. Ratios require a reproducible gross or reviewed-net backing/liability denominator; share prices, leverage headlines and incomplete-chain totals remain diagnostics. Unknown holdings stay measured/unlinked where quantifiable; unreadable material scope cannot become a normalized known-only whole book. Family-specific applications and source owners are in [adapter-specific evidence boundaries](process/live-reserves-appendix.md#adapter-specific-evidence-boundaries).

Adapter-specific completeness, unit, source-clock and binding-version rules live in the [packet admission details](process/live-reserves-appendix.md#packet-admission-details); HCHF's [versioned ownership boundary](process/live-reserves-appendix.md#adapter-specific-evidence-boundaries) also governs retained-snapshot admission. Every class still obeys the shared gates below.

Liquity V2 branches may declare reviewed `kind: plain-token` to value the configured direct balance/decimals without ERC4626 probes (including Felix WHYPE and Base Dollar WETH). Declared `erc4626` branches require readable asset identity even on an executed revert; undeclared branches retain strict introspection, where only an executed aggregate-member revert proves a nonreceipt. Funded receipts require readable conversion totals and underlying decimals; missing evidence withholds whole-book valuation through the existing partial-book contract, never raw-share or share-decimal substitution.

### Snapshot admission gates

The shared result is `{ eligible, reasons: LiveReserveAdmissionRejectionCode[], freshness }`, where `freshness` is the `assessReserveSnapshotFreshness()` result that decided the `stale` gate (`null` without a snapshot or coin). All gates must pass for independent reserve scoring:

| Gate | Rejection code | Rule |
| --- | --- | --- |
| Current configuration | `unconfigured`, `suspended` | The coin must have an unsuspended live configuration. |
| Snapshot authority and integrity | `missing-snapshot`, `inconsistent-snapshot` | Strict slices and warnings (including count parity); matching positive success/fetch timestamps and nonempty attempt IDs when stamped. Warning corruption yields `invalid-warnings` at decoding and quarantines that asset. |
| Semantic configuration identity | `config-mismatch` | Stored fingerprint must be 64 lowercase hex and equal SHA-256 of canonical `{adapter, version, semantics, inputs, params}` (`params` defaults to `{}`). Display/scoring edits do not change it. Missing, malformed or mismatched bindings are not current live detail or redemption evidence; nullable historical decoding is not admission. |
| Evidence class | `non-independent` | Only `independent` reserve evidence qualifies. |
| Fetch and source age | `stale` | Fetch age is at most 48 hours; verified source age uses the tighter coin/adapter cap, falling back to 48 hours. A future Worker fetch is stale with `invalid-fetch-clock`, preserves its negative age, and also rejects admission as `invalid-freshness`; no source-skew allowance applies to fetch clocks. |
| Explicit freshness | `invalid-freshness` | Require `verified` plus a finite positive timestamp no more than ten minutes ahead, or explicit `not-applicable`. Absent/malformed modes or timestamps cannot become verified through decoding. |
| Snapshot warnings | `degraded-snapshot` | Reject every fatal warning, regardless of severity or per-coin allowlists; apply the current per-coin policy only to degraded warnings on the retained snapshot, not the newest attempt. |
| Slice count | `insufficient-slices` | At least the requested count (one by default). |

`shared/lib/live-reserve-freshness.ts` owns `resolveLiveReserveSourceAgeBudget` and the 600-second `MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC`: scoring wins equal caps and the caller supplies the fallback. Producer validation, serving and nested redemption admission share this authority; `validate.ts` does not export a compatibility skew constant. Source skew and Worker fetch-clock integrity are independent.

A later node-disagreement or other attempt error does not revoke a clean retained snapshot. Redemption capacity consumes the same structural, configuration-identity and freshness rejections, but retains its separate evidence-class and degraded-telemetry policy; independent reserve composition is not a prerequisite for valid same-run redemption telemetry.

`ReserveSyncStatusSchema` and its derived `ReserveSyncStatus` in `shared/types/live-reserves.ts` own reserve-attempt status admission for detail wire views, accepted generations, Worker records/history and the Node coverage audit. Accepted-generation absence remains nullable, and unknown audit statuses remain unavailable. Scheduler execution/disposition vocabularies are independent even where literals coincide.

The accepted metadata projection reuses `evaluateLiveReserveAdmission` with `sliceCount` instead of decoded slices. Producer writes validate composition; the seal is not a second composition validator. Direct scoring and sealing share strict warning integrity: malformed JSON, types, members or count discrepancies cannot become clean warnings. NULL/empty arrays and valid legacy members with absent severity/effect retain supported defaults. A decoded fatal warning still rejects admission; sealing retains that census member with `snapshot: null`, and detail falls back rather than presenting impossible accepted live evidence. Every consumer reassesses configuration, warnings and original clocks; sealing or fresh redemption never refreshes reserve evidence.

`inputs.fallbacks` are ordered retries of the same adapter after throws, not after normally returned fatal warnings. A successful but score-ineligible fallback cannot overwrite a still-admissible score-grade snapshot on the same assessment clock: record a degraded `fallback-withheld-score-grade-retained` attempt with primary failure and fallback rejection evidence, preserving success linkage. Once the retained snapshot fails admission, normal fallback persistence resumes. Credential-bearing URLs are redacted before errors or I/O labels.

Warning `severity` is display; `effect` controls execution: `info` may remain clean, `degraded` stores evidence but blocks independent scoring unless the current warning policy permits it, and `fatal` rejects replacement and retained-snapshot authority. Fatal warnings and shared unallowlistable degraded warnings cannot be excused per coin. Observed shortfalls, genuine non-positive liabilities and paused routes publish readable adverse evidence with degradation; malformed/unverifiable inputs fail closed and undefined ratios are omitted. `validateAdapterOutput()` enforces the complete slice/raw-sum, clock, unknown-exposure and declared-capability policies; source age uses the oldest material clock with complete coverage.

Nested redemption claims distinguish absent from invalid-present. Invalid claims are quarantined whole, never partially salvaged or rescued by legacy flat fields; accepted-generation sealing retains the member as `snapshot: null`. Historical null amounts stay unavailable, measured zero survives. Same-run `onchain`/`protocol-api` route attribution requires an executable route predicate and the builder's explicit `routeObserved: true`, not balances, capacity or config. Failed predicates yield unknown without live attribution; observed closures retain adverse status.

Producer writes use attempt/deadline/ownership fences and atomically commit composition, success linkage and both histories. Ambiguous acknowledgements require authoritative readback; failed writes never manufacture success clocks. Only an exhausted, checkpoint-owned full cohort may seal the digest-validated accepted generation before lease release; invalid/unavailable members remain in its complete census. Consumers preserve original evidence clocks. Migration `0239_live_reserve_config_fingerprint.sql` precedes activation; rollback retains additive columns. [Producer and recovery reference](process/live-reserves-appendix.md#cron-behavior) owns bounded operational details, including the sequential two-operation adapter limiter within the trigger's six-connection budget.

Feed acknowledgement changes health cohorts, never raw counts, freshness, admission, scoring or listing status. `worker/src/lib/reserve-feed-reviews.ts` owns exact cause matching, dated evidence, owner and expiry. [Review renewal](runbooks/review-renewal.md#reserve-feed-reviews) owns review constraints; [source boundaries](process/live-reserves-appendix.md#issuer-balance-sheets-and-reviewed-reports) details mTBILL's v2 integrity review. [Status health](./status-dashboard.md#live-reserve-sync-health) owns cohorts and expiry reminders.

Retired bindings return 404 while the coin, curated research and retained evidence remain; STBT's complete retirement receipt is in `shared/data/coverage-dispositions/retired-reserve-adapters/matrixdock-stbt/`.

`computeReserveCompositionOverview()` and the [status reserve-health contract](./status-dashboard.md#live-reserve-sync-health) own the overview fields, strict-corruption fail-closed count, attempt-over-stale priority, acknowledgement cohorts and recovery-cursor presentation.

Follow-up continuation is normal, not a degraded reserve attempt. The four-hour producer and one-minute recovery lane (historical durable key `fiveMinuteReserveRecovery`) share one checkpoint frontier; admitted work is sliced by remaining wall time and the physical invocation's CPU class. Untouched checkpoint-owned suffixes do not overwrite per-coin attempt health. Redemption and the watchdog run as a fresh-budget cohort tail after queue exhaustion, never repeatedly behind partial heads. The persisted checkpoint completion clock includes that tail. `STATUS_RESERVE_COHORT_SLO` in `shared/lib/status-thresholds.ts` owns the 30-minute full-cohort target, 24-hour recovery window and recovered-p95 info severity: ops warns on over-budget open/recent completed cohorts and seven-day nearest-rank completion p95.

---

## API Contract

`handleStablecoinReserves()` in `worker/src/api/stablecoin-reserves.ts` requires a readable tracked ID with an effective unsuspended `liveReservesConfig`. Presentation, feed acknowledgement and freshness use the same loaded sync state and assessment clock; the endpoint performs no second sync-state SELECT.

404 behavior:

- Unknown stablecoin ID
- Tracked coin without live reserve support
- Pre-launch or effectively suspended coin

Known live-enabled IDs with no usable snapshot or curated/template fallback return HTTP `200` with `mode: "unavailable"`, empty `reserves`, and live `sync` state. This distinguishes supported coins awaiting usable data from unknown or unsupported IDs.

When a review matches current attempt evidence, `sync.acknowledgedFeed` publishes the complete dated review. It does not change response mode, cache admission, reserves, provenance, or freshness; absence means no currently valid matching acknowledgement.

Successful responses return `StablecoinReservesResponse` with one of these modes:

| Mode                | Meaning                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `live`              | Fresh live snapshot from `reserve_composition`                                             |
| `live-stale`        | Stored fetch is older than 48 hours, or verified source evidence exceeds its configured/adapter reporting allowance (48-hour fallback only when neither declares one) |
| `curated-fallback`  | Live snapshot unavailable; falling back to curated `StablecoinMeta.reserves`               |
| `template-fallback` | Live snapshot unavailable; falling back to reserve templates from `getReserves()`          |
| `unavailable`       | Coin is live-enabled, but neither live data nor fallback reserve presentation is available |

`live` / `live-stale` only apply when the stored snapshot matches the latest successful sync state by `fetched_at` / `attempt_id` and passes strict integrity validation. Staleness independently checks the stored fetch time against 48 hours and verified upstream source age against the source-specific allowance. The detail response, overview freshness counts, and scoring snapshot loader share this decision; refreshing an old document never resets its source age. Orphaned partial writes or corrupt stored snapshots fail closed to the fallback modes.

Per ADR-30, `sync.freshness` copies the evaluator's output: served snapshots reuse admission's assessment; fallback/unavailable responses judge the newest consistent generation (else `sync.lastSuccessAt`) by fetch age alone. `fetchBudgetSec` names the route's actual budget (`LIVE_RESERVE_FRESHNESS_SEC` here). Recompute `stale` as a non-null `fetchAgeSec < 0` or `fetchAgeSec > fetchBudgetSec`, or `sourceAgeSec > sourceAgeBudgetSec` when both source fields are non-null. Both ages use `assessedAt`; a future Worker fetch is stale despite its negative age.

`StablecoinReservesResponseSchema` in `shared/types/live-reserves.ts` is the runtime contract for successful `200` responses, including `unavailable`, and is used by the frontend reserve API client. Adapter-specific `metadata`, `metadata.details`, and nested redemption telemetry remain passthrough. Internal instrumentation lives in declared `metadata.diag`, which `resolveReserveResult()` removes before public serialization.

Cache control:

| Response mode                               | Cache-Control                        |
| ------------------------------------------- | ------------------------------------ |
| `live` (sync `ok`, no uncertain write)      | `public, s-maxage=3600, max-age=300` |
| `live` (sync not `ok`, or `uncertainWrite`) | `public, s-maxage=300, max-age=60`   |
| `live-stale`                                | `public, s-maxage=1800, max-age=120` |
| fallback / unavailable modes                | `public, s-maxage=300, max-age=60`   |

The optional `provenance` object is present only when the response is serving an authoritative `live` or `live-stale` snapshot:

| Field             | Meaning                                                                               |
| ----------------- | ------------------------------------------------------------------------------------- |
| `evidenceClass`   | `independent`, `static-validated`, or `weak-live-probe`                               |
| `sourceModel`     | `dynamic-mix`, `validated-static`, or `single-bucket`                                 |
| `freshnessMode`   | Optional explicit freshness policy (`verified`, `unverified`, `not-applicable`)       |
| `scoringEligible` | Whether the current snapshot is eligible for V9 Backing/dependency fact compilation right now |
| `scoringRejectionReasons` | Admission gate codes behind `scoringEligible` (see [Snapshot admission gates](#snapshot-admission-gates)); empty when eligible. `stale` is explained by `sync.freshness` |

The optional `displayBadge` object is also present only for authoritative `live` / `live-stale` snapshots:

| Field   | Meaning                                                                                      |
| ------- | -------------------------------------------------------------------------------------------- |
| `kind`  | `live`, `curated-validated`, or `proof`                                                      |
| `label` | User-facing badge text rendered on the detail page (`Live`, `Curated-Validated`, or `Proof`) |

`displayBadge` is intentionally separate from `mode` and `provenance`:

- `mode` answers whether an authoritative snapshot exists and whether it is stale
- `provenance` answers scoring/evidence semantics
- `displayBadge` answers the honest user-facing reserve label

The optional `displayUrl` and `evidenceUrls` fields are also intentionally separate:

- `displayUrl` is the curated reserve-card destination configured in `liveReservesConfig.display.url`
- `evidenceUrls` are adapter-emitted URLs tied to the authoritative live snapshot metadata
- the detail page can show both when a coin has a curated overview page plus narrower evidence links for the exact live snapshot

The optional `metadata` object is also present only for authoritative `live` / `live-stale` snapshots. It exposes the adapter snapshot metadata already stored with the reserve snapshot row so the UI can surface feed-specific context without re-querying D1. For example, `crvusd` now exposes `yieldBasisCollateralPct` when Yield Basis positions account for part of the live reserve mix.

The optional `sync` object exposes the last operational state:

| Field             | Meaning                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`         | Effective live configuration exists; this does not mean the coin is scheduled                                                        |
| `collectionEligibility` | Current `{ scheduled, reason }` policy; successful responses permit only `active`, `quarantined`, `frozen`, `delisted`, with `scheduled: true` only for active |
| `status`          | Last sync status (`ok`, `degraded`, `error`, `skipped`)                                                                             |
| `stale`           | Fetch/source age exceeds its budget, or the Worker fetch clock is invalid (including a future fetch; negative age is retained)       |
| `bootstrap`       | No successful live snapshot has been recorded yet                                                                                   |
| `lastAttemptedAt` | Latest attempt timestamp, when present                                                                                              |
| `lastSuccessAt`   | Latest success timestamp, when present                                                                                              |
| `warnings[]`      | Warning messages surfaced by the latest attempt and, when relevant, storage-integrity warnings injected by the fail-closed resolver |
| `lastError`       | Most recent adapter error message (truncated to 200 chars), when present                                                            |
| `failureCategory` | Machine-readable failure class from attempt metadata, when present                                                                  |
| `uncertainWrite`  | `true` when the latest attempt hit the D1 write-timeout / finalize-rejection path and authoritative state could not be proven       |
| `freshness`       | The budgets, clock, and generation behind `stale` (table below)                                                                     |

For an active newly configured feed, `status: "skipped"`, `bootstrap: true` with no attempt/failure evidence is awaiting its first scheduled sync and receives the neutral **Live reserve sync pending** notice. A readable inactive configuration may expose the same synthetic bootstrap without any attempt clock; `collectionEligibility.scheduled: false` explains lifecycle exclusion, not circuit/budget deferral or a persisted skipped attempt. Historical snapshots keep their original clocks and admission verdicts; collection diagnostics neither refresh nor re-admit them. Attempt or failure evidence keeps its separate degraded/error presentation.

Suspended, unconfigured and pre-launch assets return `404` from the reserve endpoint rather than inventing successful-response eligibility reasons.

`sync.freshness` fields (added 2026-09-27; additive and optional in `StablecoinReservesResponseSchema`, so older payloads still parse):

| Field                | Meaning |
| -------------------- | ------- |
| `stale`              | Same verdict as `sync.stale` |
| `staleReasons[]`     | `fetch-age`, `source-age`, or `invalid-fetch-clock`; empty when fresh |
| `assessedAt`         | Unix seconds: the evaluation clock for both ages |
| `fetchedAt`          | Worker fetch time of the judged generation; `null` when no successful fetch is known |
| `attemptId`          | Sync attempt of the judged generation; `null` for legacy rows written before attempt IDs |
| `fetchAgeSec`        | `assessedAt - fetchedAt`, or `null` |
| `fetchBudgetSec`     | Fetch-age budget the serving route used |
| `freshnessMode`      | Original snapshot mode (`verified`, `unverified`, `not-applicable`), or `null`; fetch-only fallback assessments have no snapshot metadata |
| `sourceFreshnessInvalid` | Whether the assessed generation's metadata carries `diag.invalidFreshness`; independent of age-based `stale` |
| `sourceTimestamp`    | Upstream disclosure time judged. `null` when source age was not part of the verdict: non-`verified` freshness, no finite timestamp, or a fallback response |
| `sourceAgeSec`       | `assessedAt - sourceTimestamp`, or `null` |
| `sourceAgeBudgetSec` | Effective source-age budget: `min(scoring.maxSourceAgeSec, adapter validation.maxSourceAgeSec)`, else the fetch budget; `null` when source age was not judged |
| `sourceAgeBudgetCap` | Which cap won: `scoring` (per-coin cap, including ties), `adapter`, or `fetch-budget`; `null` when source age was not judged |

Uncertain write attempts are intentionally exposed as `sync.uncertainWrite = true` instead of being collapsed into generic stale/error narration. The API may still serve the last consistent snapshot or fallback presentation, but operators can tell that the latest attempted write is ambiguous until a clean follow-up run resolves it. Detail-page polling uses the normal 4-hour reserve cadence only for clean live responses; live responses with `sync.status !== "ok"` or `sync.uncertainWrite = true` use recovery polling and render the active status, failure category, and last error above the reserve card footer.

### Reviewed liability scopes

Every catalog deployment must have exactly one reviewed liability-scope classification; an unclassified chain withholds the ratio (`liability-scope-unclassified-chain`). Native liabilities and bridged representations are not additive. Original reserve and supply clocks must fit the adapter's reviewed skew bound. The [dated TUSD and USD1 scope review](process/live-reserves-appendix.md#reviewed-liability-scopes) retains chain tables, conservation evidence and USD1's unresolved publication-delay limitation.

### Adding a New Adapter

Research intake uses `npm run audit:coverage -- --domain=reserve-coverage`. It is a permanent advisory report, not an adapter admission evaluator, and rejects unsupported `--check`. `--prod` reads report-card and stablecoin catalog snapshots only. Supply `--reserve-states <file>` separately for reserve-sync observations and retain the supplied state generation; without that file, runtime state is unknown rather than inferred from configuration or a successful catalog fetch.

To register a new adapter for a coin's `liveReservesConfig.adapter`, edit the surfaces below in order; reuse an existing params schema when appropriate. The shared schema and Worker registry tests fail if definition or fetcher coverage drifts.

1. **Params schema + descriptor declaration** — both live in `shared/types/live-reserve-adapter-declarations.ts`. Define the Zod params schema as a const above the table (or reuse `noParamsSchema` / an existing schema), then add one entry to `LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS` whose `paramsSchema` **references that schema object directly** — there is no separate schema module and no string identifier to register. Declare accepted primary input kinds, source/evidence class, source-sharing policy, supported semantics/versions, redemption telemetry, validation policy, and only non-default provenance or display metadata. Prefer a named validation tier from `shared/types/live-reserve-adapter-policy.ts` (`LATEST_STATE_VALIDATION`, `DASHBOARD_VALIDATION`, `DASHBOARD_WITH_UNKNOWN_CAP_VALIDATION`, `MONTHLY_VERIFIED_VALIDATION`, `LATE_MONTHLY_VERIFIED_VALIDATION`, `DISCLOSURE_VALIDATION`, …); an inline `validation` block should carry a comment explaining why the adapter is an exception. EVM addresses use `EvmAddressSchema`, never a bare `z.string()`. The key union, `LIVE_RESERVE_ADAPTER_KEYS`, and the enriched `LIVE_RESERVE_ADAPTER_DEFINITIONS` map all derive from this entry.
2. **Adapter fetch function** — add `worker/src/cron/reserve-adapters/<key>.ts` exporting `async function fetch<Name>Reserves(coin, config, signal, ctx?): Promise<AdapterResult>`. Adapter contract lives in `worker/src/cron/reserve-adapters/types.ts` (`AdapterFn`, `AdapterContext`, `ReserveAdapterDefinition` — the last is a `Pick<>` of the shared declaration, so declaration fields reach the Worker without being re-declared). Use helpers from `./helpers` rather than rebuilding fetch/parse/freshness primitives. Reuse `evm-observation-plan.ts` for labeled EVM decoding and identity checks; transport, pins and source-specific rejection policy remain adapter-owned.
   Sanitize assembled upstream warning messages with `redactProviderUrls` from `worker/src/lib/safe-error-message.ts` (including fetch labels and error detail). It preserves nonsecret issuer context and uses `[redacted]` for known-provider paths and credential queries; do not introduce an adapter-local sanitizer.
3. **Worker fetcher wiring** — add a `lazyAdapter(() => import("./<key>").then((mod) => mod.fetch<Name>Reserves))` entry to `LIVE_RESERVE_ADAPTER_FETCHERS` in `worker/src/cron/reserve-adapters/index.ts`. This stays a hand-written map because Worker implementations cannot enter the runtime-neutral shared registry and several keys deliberately share one fetcher; its `Record<LiveReserveAdapterKey, AdapterFn>` annotation makes a missing key or invalid named export a compile error, and `registry.test.ts` fails on the same coverage gap. Keep implementation imports inside these factories so inspecting the registry does not initialize the entire adapter graph.
4. **Coin config** — bind the coin's `liveReservesConfig` in `shared/data/stablecoins/coins/<id>.json`. A `params` block is required whenever the adapter's schema rejects `{}`.
5. **Adapter test and fixture** — add `worker/src/cron/reserve-adapters/__tests__/<key>.test.ts` and capture an HTTP-html fixture when applicable. HTML, JSON, and txt fixtures are all age-gated by `scripts/ci/check-html-fixture-age.ts` under the same `captured-at` stamp rule; a JSON or txt fixture that cannot carry the HTML-comment header is exempted in that script with a documented reason.

Changed reserve capture files select `npm run check:html-fixture-metadata` in the PR static guard plan. It validates canonical UTC second-precision stamps (`YYYY-MM-DDTHH:MM:SSZ`), real calendar dates, recorded provenance or explicit legacy exemptions, and refresh-inventory integrity without consulting calendar age. The weekly `check:html-fixture-age` retains the 90-day expiry and future-clock checks. The HTML capture writer truncates milliseconds rather than rounding; JSON captures can record the same comment in a `_capture` field without changing the captured payload's own clocks.

Docs are not a per-adapter step: the Adapter Registry notes above are for non-obvious semantics only, and the roster/counts are derived from the declaration table rather than copied.

**Report-backed assurance registration** (reuse the shared engine when it owns the transport/parser contract):

1. **Review the engagement first.** `shared/lib/independent-assurance.ts` derives `assuranceTier` from `conclusion` and rejects contradictory tiers; record examiner identity (`attestorIdentification` for reviewed inference), examined scope, original as-of instant/time zone, liabilities and adjustments. Hash-pinning establishes artifact identity, not assurance quality.
2. **Register both owners independently.** Add the product to that schema if needed, the reviewed JSON to `shared/data/live-reserves/independent-assurance/index.ts`, and an extraction profile to `scripts/lib/independent-assurance-profiles/registry.ts`. Profiles own required/rejected text, row extraction and reviewed totals; do not derive them from the manifest. Reviewed rounding bounds belong in `shared/lib/independent-assurance-tolerances.ts`.
3. **Compile offline from official PDF bytes.** Use `npx tsx scripts/maintenance/refresh-independent-assurance-reports.ts --product <PRODUCT> --pdf /path/report.pdf` for a candidate; review before explicit `--write`. Poppler `pdftotext -layout`/`pdfinfo` records parser version, text hash and page count alongside PDF SHA-256/byte length. Adding `--check` requires exact recompilation, including provenance; bare `--check` checks registrations/profile metadata/rows/reconciliation without PDF re-extraction. The Worker never parses PDFs.
4. **Bind the runtime profile and descriptor.** Use `IndependentAssuranceProfile` in `types.ts` for discovery/date/classification and wire the existing engine. Favorable assurance uses `independent` / `independent-assurance`; AUP or issuer conclusions require `static-validated` / `issuer-attested`. Pin official index, exact report URL, SHA-256, byte length and reviewed hosts; reject undated/newer unreviewed reports and unknown positive asset rows. Freshness uses examined time, never download time.
5. **Target owner checks.** Run both compiler check modes, `worker/src/cron/reserve-adapters/__tests__/independent-assurance.test.ts`, `registry.test.ts` in that directory, and the product's adapter/profile tests. Cover tier/descriptor mismatch, discovery ambiguity/newer report, artifact drift, reconciliation and original-clock freshness.

New material-clock consumers must submit every material contributor to the coverage summary and name any reviewed zoneless policy; do not drop all-bad coverage or manufacture a verified clock.

---

## Frontend Consumers

Reserve composition and collateralization footers separate the source/report-as-of date from the last checked time, retain a stale label for out-of-window evidence, and never label a refreshed historical attestation as a new live measurement. Attestation-mix snapshots use the proof badge with an `Attestation` label. A source-age-only degradation explains that evidence is out of date; collection failures retain their separate sync-error notice.

The checked-time formatter preserves present finite `liveAt` values, including epoch zero (`1970-01-01 00:00 UTC`). Only an absent or non-finite checked timestamp uses the previous-successful-run fallback; source/report dates and stale status remain separate.

`buildReserveFeedStatus()` appends reviewed exclusion reason, evidence date/URL, owner, reviewed date and expiry to stale/error/bootstrap/fallback disclosure rows. The status card distinguishes raw evidence coverage from health-cohort exclusions; neither surface claims acknowledgement makes evidence fresh.

- `src/hooks/use-stablecoin-reserves.ts` uses mode-aware polling: clean `live` responses follow the 4-hour reserve producer cadence (`staleTime = 4 hours` / `refetchInterval = 8 hours`); all other modes and `live` responses with non-`ok` sync status or `uncertainWrite` use `1 minute` / `2 minutes`
- `src/hooks/use-stablecoin-detail-view-model.ts` injects the reserve result into the detail-page view model
- `src/lib/coverage.ts` uses the adapter badge taxonomy in `shared/lib/live-reserve-display.ts` so `/coverage` distinguishes true `Live` reserve feeds from `Curated-Validated` and `Proof` reserve-sync paths
- `worker/src/api/status.ts` uses `computeReserveCompositionOverview()` to surface reserve-sync health on `/status`

---

