# Yield Intelligence Operations

This note supplements [`docs/yield-intelligence.md`](./yield-intelligence.md) with runtime guardrails for the `sync-yield-data` cron.

## Slot Context

- `sync-yield-data` now runs on a dedicated hourly trigger at `20 * * * *`, after the `10,40 * * * *` DEX lane and `16,46 * * * *` charts lane have had time to settle. It does not depend on the separate `26,56 * * * *` DEWS / PSI lane.
- `sync-yield-supplemental` runs on its own slower `25 */4 * * *` trigger and feeds a cache snapshot that the hourly publisher consumes.
- The hourly publisher is now the freshness path for `yield-rankings`; optional upstream families are deliberately kept off that path.
- vaults.fyi is an optional gated supplemental source. It is disabled unless `VAULTS_FYI_ENABLED=true` and `VAULTS_FYI_API_KEY` are configured; without `VAULTS_FYI_RANKABLE_VAULTS`, it records audit-only inventory telemetry and emits no production candidates. Supplemental telemetry distinguishes `disabled`, `no-key`, and `invalid-config` skip reasons so ops can tell flag-off, missing secret, and malformed enable flag states apart.

## Runtime Guardrails

- Deterministic on-chain vault reads now run one asset at a time with a 6 second per-RPC timeout, explicit per-URL failover, and an explorer-proxy fallback for supported EVM chains when Worker RPC reads all return empty.
- When both a provider RPC and a public fallback are configured for a deterministic yield source, the reader probes the fallback/public URL first to avoid inheriting a sticky provider failure across the whole hourly slot.
- The hourly yield runtime forwards `ETHERSCAN_API_KEY` into deterministic reads so Ethereum-family explorer proxies can keep the publication path alive during transient Worker-to-RPC outages.
- Deterministic yield run metadata now splits RPC-vs-explorer failure buckets (for example `rpc-empty|etherscan-empty`) and records how many explorer fallbacks were attempted versus how many actually resolved.
- Repeated deterministic all-fail runs that are fully masked by non-onchain coverage now arm a 6-hour cooldown after the second consecutive masked failure. The cooldown skips the deterministic lane on the hourly publisher until either the cooldown expires or non-onchain coverage gaps reappear.
- Single-coin optional adapters are time-boxed to 12 seconds:
  - `BIMA sUSBD`
  - `Etherfuse CETES current-issuance`
  - `Hashnote USYC`
  - `Midas mMEV NAV oracle`
  - `Ondo USDY oracle`
  - `Zephyr ZYS`
  - `B.Protocol LQTY-only`
  - `Curve scrvUSD current-rate`
- `sync-yield-supplemental` owns the heavier best-effort families. It writes the backward-compatible aggregate cached snapshot plus per-family cache rows (`yield:supplemental-sources:v1:<family>`) and does not overwrite the last good snapshot with an empty result.
- `sync-yield-data` now also respects the operator pause guard `cache["yield-history-cleanup:writer-pause"]`. When that key is armed for a cleanup window, the hourly publisher returns a degraded no-op result instead of purging or rewriting parent-owned history during the operator mutation.
- supplemental candidate dedupe now keys on source identity plus asset identity, not bare `sourceKey` alone, so same-chain families such as Aave V3 cannot collapse multiple coins into one cached row.
- `sync-yield-supplemental` metadata now reports raw candidate count, deduped candidate count, and dropped-row count so silent row loss is visible in cron history.
- read-time `yield-rankings` freshness warnings are source-cadence-aware: hourly families trip after three hourly publish cycles, all `protocol-api` rows — supplemental families plus the hourly single-coin adapters (BIMA, Etherfuse, Hashnote, Midas, Ondo, Zephyr) — and optional Aave/Compound rows wait 6 hours, `price-derived` observations wait 36 hours, and `rate-derived` observations wait 48 hours because their benchmark producer is daily. Ordinary exchange-rate comparison anchors expire after 14 days; price-derived plus Midas/Ondo NAV anchors expire after their configured 45-day lookup window. Stale-anchor examples include the source-specific `maxAgeSeconds` used for the decision.
- hourly publication writes selected-source decision rows after D1 staging and before cache publication. The per-row alternatives JSON blob is bounded to 4 KB and records compact selected, rejected, and retained-alternative reasons for operator debugging.
- hourly publication loads previous-best and previous-TVL history through indexed point reads scoped to the coins and source keys resolved in the current run. It does not materialize broad previous-row candidate sets before evaluation.
- the publication guard compares source quality mix with the prior public snapshot. When the prior snapshot has at least 10 direct/curated rows, publication is blocked if that cohort falls below 60% of its prior count and fallback/modeled rows simultaneously grow by at least the greater of 3 rows or 20% of the prior direct/curated cohort. Discovered rows remain neutral. The fixed failure reason is `published-source-quality-mix-regression`, with bounded count and threshold telemetry.
- Protocol API families use an 8 second per-request timeout, no retries, and a 25 second family budget:
  - `Morpho`
  - `Pendle`
  - `Yearn/Kong`
  - `Beefy`
  - `Royco Dawn`
- Optional RPC families use a 30 second family budget on the supplemental lane, a 10 second per-call timeout, two retries per URL, and alternating fallback/primary endpoint order across targets so one hot endpoint does not absorb the whole family burst:
  - `Compound V3`
  - `Aave V3`
- Optional RPC family metadata now records target counts, attempted counts, resolved target counts, emitted row counts, missing target counts, chain-level miss breakdowns, miss reasons, bounded missing-target examples, and whether the family budget exhausted before all targets were attempted. `sourceCoverage.sourceFamilySummaries` carries a compact per-family status/raw/emitted/inventory/budget view for operator triage; `sourceCoverage.sourceFamilyInventoryCounts` keeps audit-only inventory volume separate from candidate-oriented `sourceFamilyCounts`. Detailed `optionalRpcTelemetry` keeps the same counters but caps missing-target examples to avoid oversized cron metadata.
- The hourly publisher prefers fresh per-family supplemental caches when present, so a malformed or stale family cache suppresses only that family while other fresh families can still publish optional rows. If no family cache is usable, the publisher falls back to the legacy aggregate cache.
- Aave on-chain reads are batched two assets at a time to stay below the Worker connection ceiling even on the isolated supplemental trigger.
- the monthly yield coverage audit now counts explicit auto-lending overrides and curated exact-pool overrides as covered DL surfaces, and its high-TVL gap list is scoped to unsupported protocol families so the report stays actionable.
- Configure vaults.fyi credentials only as Worker runtime secrets. Do not commit a credential or put one in docs. The production four-hour lane caps runs at 13 credits, generation-fences one reservation owner before fetching, and dynamically lowers the allowance when the remaining UTC-month budget cannot sustain the configured cadence. Reservation acquisition compare-and-swaps the exact prior ledger; finalization requires the same generation and reservation ID, so an expired owner cannot overwrite a newer run or month bucket. A genuinely absent monthly ledger starts at zero; malformed JSON, an invalid month bucket, negative/non-integer counters, or an inconsistent reservation is `monthlyLedgerState: "corrupt"` and fails closed before any paid request with `skipReason: "credit-ledger-corrupt"`. Provider telemetry exposes locally estimated spent/reserved credits, sustainable and unthrottled month-end forecasts, utilization, remaining runs, and `coverageBudgetState`; vaults.fyi does not provide an authoritative usage counter on this path, so these values are explicitly estimates derived from the documented request costs. A warning begins before 75 percent projected or estimated utilization. It also reports `consumptionMode` (`disabled`, `probe-only`, or `rankable`) and `consumptionReason`; enabled with an empty `VAULTS_FYI_RANKABLE_VAULTS` list is `probe-only` and cannot emit candidates. Provider quota/errors fail open and should not block the hourly publisher. In `sourceCoverage.sourceFamilySummaries.vaultsFyi.provider.vaultsFyi`, `skipReason: "disabled"` means the enable flag is off/unset, `"no-key"` means the flag is true but the runtime secret is absent, and `"invalid-config"` includes a malformed enable flag.

- `fetch-tbill-rate` metadata includes bounded GBP `gbpResponseAttempts` entries for FRED, ALFRED, and BoE attempts: provider, status, content type, byte count, parse result, record date, and stable failure class. It never records response bodies or URLs. The `yield-gbp-benchmark-current` canary requires a direct GBP observation fetched within 48 hours, a record date within 7 days, and two consecutive fresh daily publications.

## Yield Health Thresholds

`/api/status` exposes these checks under `yieldHealth`; the admin Pipeline card renders the same fields. See the [Yield Health runbook](./runbooks/yield-health.md) for inspection commands.

| Surface | Owner cron/cache | Warn threshold | Stale threshold | Public-critical impact | Admin-watch impact | Runbook |
| --- | --- | --- | --- | --- | --- | --- |
| Rankings freshness | `sync-yield-data` -> `cache['yield-rankings']` | Age above 8 hourly producer intervals | Missing payload or age above 12 hourly producer intervals | Yes, when stale or missing | Degraded-but-not-stale rankings remain watch-only | [stale or missing rankings](./runbooks/yield-rankings-stale-or-missing.md) |
| Safety coverage | Read-time report-card hydration in `yield-rankings.provenance.safetySnapshot` | Coverage below 75% | No separate stale tier | No | Sparse safety evidence degrades Yield Health | [Yield Health](./runbooks/yield-health.md) |
| Supplemental source age | `sync-yield-supplemental` -> `yield:supplemental-sources:v1:*` | Any family age above 6h or missing family cache when family rows exist | Age above 72h | No | Degraded/stale optional families reduce confidence only | [supplemental snapshot](./runbooks/yield-supplemental-snapshot.md) |
| Used benchmark registry | `sync-yield-data` ranking + benchmark provenance | Any used fallback/proxy selection | Missing or age above 48h | No | Every used key is reported independently; expired rows remain visible with PYS NR | [benchmark fallback](./runbooks/yield-benchmark-fallback-stale.md) |
| Coverage audit age | `yield-coverage-audit` -> `cache['yield-coverage-audit']` | Age above 45d or missing audit | Age above 540d | No | Late monthly review or unavailable queue stays watch-only | [Yield Health](./runbooks/yield-health.md) |
| Source-risk coverage | `sync-yield-data` published `sourceRisk.*` rows and retained alternates | Any core field below 75% coverage: `sourceRiskPenalty`, `rewardShare`, `sourceAgeSeconds`, `sourceDepthRatio`, `venueRiskTier`, or `sourceRiskScore` | No separate stale tier; zero coverage is degraded when ranking rows exist | No | Missing neutral-fallback evidence degrades Yield Health | [Yield Health](./runbooks/yield-health.md) |

`yieldHealth.statusImpact` remains public-critical only for stale or missing rankings. Safety, supplemental, benchmark, coverage-audit, and source-risk coverage gaps are admin-watch unless a later release explicitly changes that rule.

## Coverage Audit Queue

The monthly coverage audit uses durable, evidence-fingerprinted review dispositions. The cached report carries `operatorQueue.persistence="durable"`, `promotionMode="human-reviewed"`, suppression counts, the allowed action labels, headline gaps (`manifestMissingIds`, `yieldBearingMissingFromRankings`, unmatched high-TVL pools, missing protocols), and recommendation candidates (native exact-pool, source-family adapter, and lending allowlist candidates). An unchanged reviewed item stays suppressed until its next-review or expiry boundary; decision-relevant evidence changes reopen it, while routine APY/TVL movement inside the same evidence band does not. A stored `accept` disposition records review evidence only and never mutates adapters or allowlists automatically. `/api/status` exposes the bounded visible queue under `yieldHealth.coverageAudit.headlineGaps` and `yieldHealth.coverageAudit.recommendationCandidates` so the admin card can show representative items without loading the full cache payload. Operators should classify each item in the monthly audit note:

| Action | Use when | Follow-up |
| --- | --- | --- |
| `accept` | The candidate is a real coverage improvement with enough evidence to implement | Open or land the config/runtime change with focused tests and docs |
| `dismiss` | The item is a duplicate, false positive, unsupported shape, or already covered through another source | Record the reason in the audit note; no cache or D1 mutation |
| `intentional-gap` | The asset or venue should remain explicitly uncovered until a reliable APY/source path exists | Add or confirm an intentional manifest gap with rationale when a code change is warranted |
| `watch` | The item is plausible but needs another cycle, more TVL, better timestamps, or venue review | Leave it visible for the next monthly audit and note the condition to re-check |

Do not add dismissal persistence until repeated monthly reports show that the same reviewed noise is consuming operator time. The admin queue rows are read-only; there are no `accept`/`dismiss` buttons and no stored operator state. Do not edit `yield-rankings` or source-risk fields to clear the queue; fix the source config, add an intentional gap, or leave the item on watch.

vaults.fyi audit evidence should be classified through the same queue actions. `accept` means "add or adjust explicit `VAULTS_FYI_RANKABLE_VAULTS` entries with focused tests and docs"; `watch` means leave it as research evidence; `dismiss` means record why the source shape is unsuitable or duplicative. No queue classification should mutate production rankings by itself.

## Adapter lifecycle states

Each yield-bearing adapter sits in one of four lifecycle states tracked by `YIELD_ADAPTER_LIFECYCLE` in `worker/src/cron/yield-config-registry.ts`. The monthly coverage audit emits a `lifecycleSummary` count plus bounded `quarantinedAdapters` and `intentionalGaps` lists in the `yield-coverage-audit` cache so operators can act on structured reasons (`code`, `since`, optional `nextReviewAt`, `note`).

| State | Use when | Operator classification cue |
| --- | --- | --- |
| `active` | Adapter ships an APY through the normal publication path | Default; no override needed |
| `quarantined` | Adapter exists but is intentionally disabled pending a protocol-specific reader or evidence | Add a typed reason in `QUARANTINED_DETERMINISTIC_ADAPTERS_TYPED` and link the reason `code` to the diagnosis (`convert-to-assets-empty`, `wrapper-not-yet-supported`) |
| `intentional-gap` | Asset is yield-bearing but no reliable runtime APY source exists yet | Add a typed reason in `INTENTIONAL_GAP_REASONS_TYPED` with a stable `code` such as `no-public-yield-source`, `off-chain-account-product`, `issuer-distributed-yield`, or `pre-launch` |
| `experimental` | Adapter is in trial; results should not block publication or alerts | Use sparingly while validating a new on-chain reader or rate source |

When promoting an adapter out of `quarantined` or `intentional-gap`, remove the typed entry (the legacy string map derives from the typed map, so a single edit propagates). Always set `since` to the date the lifecycle change happens; set `nextReviewAt` when the gap is expected to be revisited soon.

When a lifecycle review date comes due and the adapter stays quarantined or intentionally uncovered, update the typed reason `note` with the review date and disposition, then move `nextReviewAt` to the next concrete review window. Do not leave past-due review dates in the registry after a coverage-drain pass.

## Decision Ledger Retention (v8.14)

- Every `yield_source_decisions` row is tagged with a `retention_reason` of `trend` or `audit`.
- `trend` rows are persisted indefinitely. They cover source switches, evaluated-source anomalies, and decisions that rejected a higher-confidence-tier alternative.
- `audit` rows are pruned after 30 days inside the existing `pruneYieldTables` cleanup pass that runs at the end of each successful publication. There is no new cron trigger.
- Retained public alternates live in the sibling `yield_source_decision_alternatives` table; they are cascaded out when the referenced decision row is removed.
- The legacy `alternatives_json` blob continues to be written for one cycle of co-existence. Operators reading `/api/yield-source-decisions` may pass `?includePublicAlternatives=1` to receive the typed alternates from the new table alongside the legacy blob.
- Modern linked-variant and protocol-specific on-chain source keys are never normalized to `onchain:<stablecoinId>` merely because they carry an exchange rate. Only null/`legacy-best` history and the explicit LUSD `bprotocol-lqty-only` legacy alias normalize. Historical linked-variant false-switch rows are reclassified to `audit` only after two consecutive published generations select the linked identity with `source_switch = 0`; normal audit retention then removes the corrected noise.

## Failure Semantics

- Deterministic on-chain rows, curated DeFiLlama rows, price-derived rows, and rate-derived rows remain the primary publication path.
- A fully failed deterministic on-chain lane only degrades the cron when it leaves at least one configured coin without a non-onchain evaluated source in the same run; otherwise the run stays healthy and records the masked failure in metadata.
- If the deterministic cooldown is active but coverage gaps reappear, the hourly run degrades, clears the cooldown state, and retries the deterministic lane on the next hourly cycle.
- When an optional source budget is exhausted, the cron logs a warning and continues with the best remaining data instead of timing out the entire run.
- Chain-looped optional families keep any partial results they already collected before the budget expires.
- The four-hour supplemental publisher writes both the aggregate snapshot and per-family snapshots. The hourly publisher prefers fresh per-family caches, and when family coverage is partial it backfills missing/degraded families from a still-fresh aggregate snapshot instead of dropping otherwise valid candidates.
- The `yield-rankings` cache compare-and-swap, current/history row replacement, selected-source decision write, and generation publish run in one guarded D1 batch. If the cache write fails or compare-and-swap skips because a newer cache exists, the staged generation is marked `failed` before current rows are replaced. Public history and downstream D1 readers continue using the last published generation. Each hourly run also attempts to repair D1 row states for the generation currently advertised by the published cache before loading evaluation history.
- The intended failure mode for optional upstream stress is reduced supplemental coverage or an older cached supplemental snapshot. If that reduction would severely collapse the prior public lending-opportunity cohort or total ranking count, the hourly publisher returns degraded and keeps the previous `yield-rankings` snapshot.
- A stable headline row count does not override the source-quality guard. A simultaneous direct/curated collapse and fallback/modeled substitution returns degraded with `published-source-quality-mix-regression` and preserves the previous public snapshot.
- vaults.fyi unavailability has no public-critical impact. When disabled or inventory-only, it should surface only as provider-family telemetry/research evidence. When allowlisted rows are configured, failures reduce that supplemental family's coverage and are handled by the existing supplemental freshness and publication-collapse guards.
- Default or explicit-NR safety inputs remain publishable, but every such row carries a stable `safetyReason`: `report-card-score-missing`, `report-card-grade-not-rated`, or `underlying-report-card-score-missing` for a structured opportunity whose underlying report-card score is unavailable.
