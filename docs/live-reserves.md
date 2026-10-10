# Live Reserve Sync

> **Agent navigation** — Current invariants and interfaces are below. Detailed implementation and historical decisions are retained in the [appendix](./process/live-reserves-appendix.md). Read routed sections rather than either file wholesale.

Dedicated documentation for the live reserve-composition subsystem that powers `GET /api/stablecoin-reserves/:id`, the stablecoin-detail reserve card, and `/status` reserve-sync health.


---

## Metadata Contract

Every provenance field below is an evidence claim about the current run, not a feed-family label — rule R6 (ADR-33 in [architecture.md](./architecture.md#architectural-decision-records)), enforced for route attribution by `buildRedemptionSnapshotMetadata` in `worker/src/cron/reserve-adapters/redemption.ts`.

Live reserve support is declared per coin in `StablecoinMeta.liveReservesConfig` (`shared/types/live-reserves.ts`, authored under `shared/data/stablecoins/coins/*.json` and validated by `shared/lib/stablecoins/schema.ts`). Producer, recovery, adapter lookups, and snapshot-store reads/writes use `shared/lib/stablecoins/worker-runtime-registry.ts`: configured feeds retain lossless `liveReservesConfig`, `flags`, `reserves`, and `reserveReview` inputs, while unconfigured entries keep only bounded classification/structural slices. `ReserveAdapterCoin` in `shared/types/core.ts` defines the adapter's metadata contract.

The `worker/src/lib/live-reserves/store.ts` barrel contains only producer-safe storage and overview functions. Public `resolveReserveResult` callers import `store-views.ts` directly; only that presentation layer keeps the full registry and curated-reserve fallback templates. This prevents a producer storage import from initializing the full evidence-heavy catalog.

### Registry-Defined Adapter Classes

`shared/types/live-reserve-adapter-declarations.ts` is the single authoring surface: it owns each adapter key, its Zod params schema (referenced directly by the declaration entry, not through a string identifier or a separate schema module), accepted primary input kinds, config validation policy, public source definition, provenance status, and display badge metadata. Shared `validation` tiers are named constants in `shared/types/live-reserve-adapter-policy.ts` so adapters on the same policy share one definition. `shared/lib/live-reserve-adapter-descriptors.ts` enriches the declarations and publishes `LIVE_RESERVE_ADAPTER_DEFINITIONS` as the single map for config, provenance, display, and adapter consumers; the Worker's `ReserveAdapterDefinition` is a `Pick<>` of the declaration type rather than a hand-copied structural type. `LIVE_RESERVE_ADAPTER_KEYS` and `LiveReserveAdapterKey` remain declaration-derived key views. Five important definition properties are not user-configured per coin:

Equivalent complete descriptors may select explicit named profiles; shared telemetry objects are immutable exact capacity/fee combinations, not inferred capabilities. Per-adapter origin and no-capacity rationale remain explicit, and params-gated telemetry stays at its declaration so a generic profile cannot grant it accidentally. These authoring aids introduce no second schema surface or policy/fingerprint change.

| Property              | Meaning                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `sourceModel`         | Distinguishes `dynamic-mix`, `validated-static`, and `single-bucket` reserve shapes                          |
| `evidenceClass`       | Distinguishes scoring-eligible `independent` feeds from `static-validated` and `weak-live-probe` feeds       |
| `sourceOriginClass`   | Records who produced the evidence without changing its admission, liveness, or scoring strength             |
| `sharedSourceMode`    | Distinguishes per-coin fetches (`none`) from explicitly source-invariant result sharing (`source-invariant`) |
| `redemptionTelemetry` | Declares whether the adapter can emit direct/proxy redemption capacity and current-fee telemetry             |

- `dynamic-mix`: independently measured reserve compositions. These can be `independent` evidence for scoring when the retained snapshot passes admission.
- `validated-static`: live validation/probe adapters over curated/static slices. These remain authoritative for the reserve detail API, but they are tagged `static-validated` and do not count as independent live collateral inputs for report-card scoring.
- `single-bucket`: one-slice live proofs/attestations. Some are true independent evidence (`anzen-usdz`, `astherus-earn-wrapper`, `blast-usdb-yield-manager`, `btcfi`, `chainlink-nav`, `chainlink-por`, `chronicle-nav`, `erc4626-single-asset`, `escrow-balance`, `hive-hbd-protocol`, `initia-wrapper-vault`, `liquity-native-active-pool`, `liquity-v1`, `m0`, `m0-wrapper-underlying`, `sgforge-coinvertible`, `spiko-api`, `superstate-liquidity`, `united-por`, `usd1-bundle-oracle`, `usdai-hub`, `yamato`), while weak liveness-only or proof-class summary feeds such as `single-asset`, `solstice-attestation`, and `river-protocol-info` are tagged `weak-live-probe`. wiTRY (`witry-brix`) binds `erc4626-single-asset` over its Ethereum ERC-4626 staking wrapper.
- `independent`: scoring-eligible live evidence when the retained snapshot is fresh, authoritative, config-matched, and has no unexcused snapshot degradation; a later failed attempt does not revoke it.
- `static-validated`, `weak-live-probe`: detail/status-visible evidence classes that never override curated collateral scoring. Nested same-run redemption telemetry (`live-direct`, `live-direct-bounded`, `live-queue`, `live-proxy-validated`, or `documented-bound` with `same-run-onchain`, `same-run-api`, or `verified-source-timestamp`) may still bound the holder-facing exit route independently of either non-scoring composition class; legacy `immediateRedeemableUsd` on those classes stays rejected.
- `sourceOriginClass` is orthogonal to `evidenceClass`. It records `issuer-attested`, `onchain-observation`, `independent-assurance`, `reviewed-curation`, or `unknown` for diagnostic provenance. Unreviewed adapters resolve explicitly to `unknown`; the registry never guesses origin from an adapter name or input kind. Origin does not change reserve admission, standalone reserve facts, V9 facts, scores, or public API fields. The private V9 evidence-journal schema can carry the resolved value when journal writers are enabled.
- `source-invariant`: opt-in within-run result sharing for coin-invariant payloads. The result key canonicalizes adapter/version/semantics/inputs/params and omits coin ID; coin-dependent results must declare `none`. Reservoir runs per coin: srUSD reads the SavingModule leg/fee, while wsrUSD uses the deployed direct-rUSD branch. HTTP request sharing and block/resource-keyed PSM inventory deduplicate physical reads without summing shared cash across routes.

For instrument identity, measurement limits, report validation, and retained weak-evidence tiers, read [adapter-specific evidence boundaries](process/live-reserves-appendix.md#adapter-specific-evidence-boundaries). The class definitions above remain the shared admission vocabulary.

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
| Snapshot warnings | `degraded-snapshot` | Apply the current per-coin warning policy to the retained snapshot, not the newest attempt. |
| Slice count | `insufficient-slices` | At least the requested count (one by default). |

`shared/lib/live-reserve-freshness.ts` owns `resolveLiveReserveSourceAgeBudget` and the 600-second `MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC`: scoring wins equal caps and the caller supplies the fallback. Producer validation, serving and nested redemption admission share this authority; `validate.ts` does not export a compatibility skew constant. Source skew and Worker fetch-clock integrity are independent.

This fixes the HBD 164-versus-165 discrepancy: its later node-disagreement error remains an operational error, while its clean retained snapshot contributes to eligible coverage in all three consumers. Redemption capacity consumes the same structural, configuration-identity, and freshness rejections but retains its separate evidence-class and degraded-telemetry policy; independent reserve composition is not a prerequisite for valid same-run redemption telemetry.

The accepted metadata projection reuses `evaluateLiveReserveAdmission` with `sliceCount` instead of decoded slices. Producer writes validate composition; the seal is not a second composition validator. Direct scoring and sealing share strict warning integrity: malformed JSON, types, members or count discrepancies cannot become clean warnings. NULL/empty arrays and valid legacy members with absent severity/effect retain supported defaults. Every consumer reassesses configuration, warnings and original clocks; sealing or fresh redemption never refreshes reserve evidence.

Feed acknowledgement is status policy only, never admission: raw counts, modes, source clocks, scoring and listing status remain unchanged. Valid matched reviews remove the matching feed/contribution from the health cohort only. Uncertain writes, corrupt evidence, deferrals, future clocks and BNUSD adapter-timeout cannot be acknowledged. Only the unchanged October 7 GUSD/mTBILL reviews remain, expiring October 21 under the shared fourteen-day cap. The seven fabricated attestation-redemption failure reviews were removed; any real corrected failure needs a new dated evidence review, not automatic acknowledgement retargeting. yzUSD remains inactive pending issuer-versus-mapping cause review. mTBILL matches only `midas-mtbill:stale-portfolio-timestamp`, never future or ambiguous clocks.
STBT's live binding and adapter are retired, not merely inactive for acknowledgements. The coin remains tracked; the public reserve endpoint returns 404, while curated detail and retained historical evidence remain. The durable byte-preserving captures and complete review receipt live under `shared/data/coverage-dispositions/retired-reserve-adapters/matrixdock-stbt/`.

`computeReserveCompositionOverview()` aggregates the status-card summary used by `/status`:

- `configuredCoins`
- `freshCoins`
- `staleCoins`
- `missingCoins`
- `degradedCoins`
- `errorCoins`
- `corruptCoins`
- `independentFreshEligible`
- `independentFreshUnverified`
- `staticValidatedFresh`
- `weakProbeFresh`
- `persistentlyStaleIndependentCoins` (independent feeds older than the persistent-staleness window that can escalate status beyond normal short-lived lag; includes old active failures and circuit-open skips, but not run-budget deferred rows)
- `writeTimeoutUncertain`
- `deferredCoins`
- `runBudgetTruncated`
- `deferredAt`
- `nextCursorStablecoinId`
- `cursorRecordedAt`
- `lastSuccessAt`
- `oldestFreshAgeSec`

`errorCoins` includes active adapter failures even before a coin has ever produced a successful live snapshot; those rows no longer remain hidden inside `missingCoins`.
`corruptCoins` counts rows where a matching latest-success snapshot exists in D1 but fails strict integrity validation, so the system fails closed to fallback presentation instead of serving truncated or malformed live data.
When a coin has both an old latest-success snapshot and a newer failing attempt state, the overview now prioritizes the active `error` / `degraded` attempt classification over generic `stale` labeling so status surfaces better reflect live incidents.
`writeTimeoutUncertain` counts coins whose latest attempt hit the D1 write-timeout / finalize-rejection path and whose authoritative success state could not be proven by readback.
`runBudgetTruncated`, `deferredCoins`, `deferredAt`, and `nextCursorStablecoinId` mirror the newest checkpoint attempt when that attempt still has an active next-item resume pointer, so terminal newer attempts cannot resurrect older orphaned pointers on status surfaces. The pointer survives a run-budget truncation and is replayed by the five-minute `reserve-recovery` lane; it is cleared only when the checkpoint reaches the queue end. Atomic authority/history persistence removes the history-gap reconciliation and repair subsystem.

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

Per ADR-30 the response publishes the policy values behind that verdict, not only the verdict. `sync.freshness` is the evaluator's own output, copied unchanged: the served snapshot reuses admission's assessment, while fallback and unavailable responses judge the newest consistent generation (else `sync.lastSuccessAt`) by fetch age alone. `fetchBudgetSec` is the budget the serving route actually passed (`LIVE_RESERVE_FRESHNESS_SEC` for `GET /api/stablecoin-reserves/:id`). A client can recompute the verdict: `stale` is `fetchAgeSec > fetchBudgetSec`, or `sourceAgeSec > sourceAgeBudgetSec` when the source fields are non-null. Both ages are measured at `assessedAt`.

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
| `sourceTimestamp`    | Upstream disclosure time judged. `null` when source age was not part of the verdict: non-`verified` freshness, no finite timestamp, or a fallback response |
| `sourceAgeSec`       | `assessedAt - sourceTimestamp`, or `null` |
| `sourceAgeBudgetSec` | Effective source-age budget: `min(scoring.maxSourceAgeSec, adapter validation.maxSourceAgeSec)`, else the fetch budget; `null` when source age was not judged |
| `sourceAgeBudgetCap` | Which cap won: `scoring` (per-coin cap, including ties), `adapter`, or `fetch-budget`; `null` when source age was not judged |

Uncertain write attempts are intentionally exposed as `sync.uncertainWrite = true` instead of being collapsed into generic stale/error narration. The API may still serve the last consistent snapshot or fallback presentation, but operators can tell that the latest attempted write is ambiguous until a clean follow-up run resolves it. Detail-page polling uses the normal 4-hour reserve cadence only for clean live responses; live responses with `sync.status !== "ok"` or `sync.uncertainWrite = true` use recovery polling and render the active status, failure category, and last error above the reserve card footer.

### Reviewed liability scopes

Reviewed 2026-09-27 from primary sources; the config `liabilityScope` blocks in `tusd-trueusd.json` and `usd1-world-liberty-financial.json` encode these tables, and a catalog data test requires every catalog chain to be classified exactly once. A new catalog deployment therefore withholds the ratio (`liability-scope-unclassified-chain`) until it is reviewed. Supply figures are the 2026-09-27 reads, in token units.

**TUSD** (`chainlink-por`, config v2). Evidence: Moore CPA assurance report as of 2026-09-27 08:30:30Z (footnote 1: issued tokens on Ethereum, Tron, Avalanche and BNB Smart Chain sum to total TrueUSD issued; footnotes 3–6 name the catalog contracts) and tusd.io/transparency "Natively Deployed Networks". The feed (`description()` "TUSD Reserves") answered $501,928,900.88, exactly Moore's "Total Assets Held in Reserve Accounts", against Moore's 494,515,082.75 issued TUSD, which the four native `totalSupply()` reads reproduce to the cent. The corrected ratio is 1.014992; the previous unscoped denominator added 819,883.78 of bridged supply and published 1.013312. `maxReserveSupplySkewSec` is 172800 (two days, equal to the adapter's default oracle-age cap), supported by issued supply being unchanged from Moore's 2026-08-07 report through 2026-09-27.

| Chain | Decision | Relation | Supply read | Basis |
|---|---|---|---|---|
| ethereum | include (`evm-erc20`) | issuer-native | 315,125,540.95 | Moore fn 3; includes the L1 bridge locks below |
| tron | include (`tron-trc20`) | issuer-native | 168,513,454.14 | Moore fn 4 |
| bsc | include (`evm-erc20`) | issuer-native | 10,030,363.88 | Moore fn 6 |
| avalanche | include (`evm-erc20`) | issuer-native | 845,723.78 | Moore fn 5 |
| polygon | exclude | lock-mint of Ethereum TUSD | 183,788.69 | ERC20PredicateProxy holds 236,917.48 TUSD on Ethereum |
| arbitrum | exclude | lock-mint of Ethereum TUSD | 164,752.32 | L1ERC20Gateway holds 164,752.33 TUSD on Ethereum |
| optimism | exclude | lock-mint of Ethereum TUSD | 4,874.23 | L1StandardBridge holds 4,890.72 TUSD on Ethereum |
| fantom | exclude | third-party bridge representation | 466,468.53 | Multichain MPC holds 6.31 TUSD; defunct-bridge claim, not issuer liability |
| near | exclude | lock-mint (Rainbow Bridge) | 509.67 | `factory.bridge.near` NEP-141; outside Moore's issued perimeter |

**USD1** (`usd1-bundle-oracle`, config v3). Evidence: KPMG's examination of the BitGo USD1 Reserve Report for July 2026 (Note A: "USD1 is minted and redeemed on the Ethereum, BNB Smart Chain, Solana, Tron, Aptos, and Tempo networks"; Note B redemption assets; Note C redeemed-not-settled), the issuer's `worldliberty/cre-por-dashboard@109a68ae` (`lib/contracts/usd1-token.ts` marks the same six chains `native: true` and counts only their supply), and the Chainlink CCIP USD1 directory. Bundles on 2026-07-15 (4,339,943,400.85 and, after 5,033,700 redeemed-not-settled, 4,334,909,700.85) and 2026-07-31 (3,996,921,055.91) equal KPMG's redemption assets to the dollar. Conservation: the Ethereum CCIP LockReleaseTokenPool `0x36a72eD0096B414521C45E3ddC9ed657d1D9c141` held 20,927,760.16 USD1 against 20,927,760.66 of bridge-only supply (six catalog chains plus uncatalogued Creditcoin; residual +0.50, or +21.50 with the paused Neo X lane), and the BNB, Solana, Aptos and Tempo pools held zero, so the native sum counts each token once. Catalog decimals for Tempo and Monad were corrected from 18 to 6 (on-chain `decimals()` and the CCIP directory).

| Chain | Decision | Relation | Supply read | Basis |
|---|---|---|---|---|
| ethereum | include (`evm-erc20`) | issuer-native | 1,603,126,802.60 | KPMG Note A; includes the CCIP pool lock |
| bsc | include (`evm-erc20`) | issuer-native | 1,392,331,528.62 | KPMG Note A; pool balance 0 |
| tron | include (`tron-trc20`) | issuer-native | 10,062,604.90 | KPMG Note A; no CCIP route |
| solana | include (`solana-spl-mint`) | issuer-native | 1,390,641,181.37 | KPMG Note A; 1-of-4 mint multisig with non-pool signers; pool 0 |
| aptos | include (`aptos-fungible-asset`) | issuer-native | 20,017,233.38 | KPMG Note A; `ConcurrentSupply` at one ledger; pool stores 0 |
| tempo | include (`evm-erc20`) | issuer-native | 1,119.86 | KPMG Note A fn 3; 6 decimals; pool 0 |
| plume, monad, mantle, morph-l2, abcore, xlayer | exclude | CCIP lock-mint of Ethereum USD1 | 20,899,866.44 combined | backed by the Ethereum pool lock; not minted-and-redeemed chains |

The six-chain native sum was 4,416,180,470.74 at 2026-09-27T20:43:47–20:44:16Z, 51 h 12 m 40 s after the latest bundle (2026-09-25T17:31:07Z, $4,416,592,902.74), so that quotient compares two instants and is withheld; it is not a backing claim. Per-chain historical supply at a bundle's timestamp cannot be reconstructed for Solana or Tron through public RPCs, which is why time identity is enforced by the skew bound instead of back-dated reads. Open item: the KPMG per-chain token columns were not reconciled against on-chain supply at the report instant.

**Availability limitation — pending owner review:** with the current 4-hour reserve/supply skew bound, USD1's collateralization ratio is expected to be withheld much of the time even when all six supply reads succeed. Historical bundle publication delays observed during review ranged from 556 seconds to 18 h 48 m; a subsequent live review measured roughly 53 hours of skew (190,758 seconds). Ten-minute oracle posting cadence does not establish timely advancement of the embedded reserve timestamp. The 4-hour value is pending owner review against these publication delays; no availability assurance or owner approval is implied, and the bound has not been widened.

### Adding a New Adapter

Research intake uses `npm run audit:coverage -- --domain=reserve-coverage`. It is a permanent advisory report, not an adapter admission evaluator, and rejects unsupported `--check`. `--prod` reads report-card and stablecoin catalog snapshots only. Supply `--reserve-states <file>` separately for reserve-sync observations and retain the supplied state generation; without that file, runtime state is unknown rather than inferred from configuration or a successful catalog fetch.

To register a new adapter for a coin's `liveReservesConfig.adapter`, edit these surfaces in order: **5 files, 6 edit sites** (4 files / 5 sites when the adapter takes no per-coin params). The shared schema and Worker registry tests fail if definition or fetcher coverage drifts.

1. **Params schema + descriptor declaration** — both live in `shared/types/live-reserve-adapter-declarations.ts`. Define the Zod params schema as a const above the table (or reuse `noParamsSchema` / an existing schema), then add one entry to `LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS` whose `paramsSchema` **references that schema object directly** — there is no separate schema module and no string identifier to register. Declare accepted primary input kinds, source/evidence class, source-sharing policy, supported semantics/versions, redemption telemetry, validation policy, and only non-default provenance or display metadata. Prefer a named validation tier from `shared/types/live-reserve-adapter-policy.ts` (`LATEST_STATE_VALIDATION`, `DASHBOARD_VALIDATION`, `DASHBOARD_WITH_UNKNOWN_CAP_VALIDATION`, `MONTHLY_VERIFIED_VALIDATION`, `LATE_MONTHLY_VERIFIED_VALIDATION`, `DISCLOSURE_VALIDATION`, …); an inline `validation` block should carry a comment explaining why the adapter is an exception. EVM addresses use `EvmAddressSchema`, never a bare `z.string()`. The key union, `LIVE_RESERVE_ADAPTER_KEYS`, and the enriched `LIVE_RESERVE_ADAPTER_DEFINITIONS` map all derive from this entry.
2. **Adapter fetch function** — add `worker/src/cron/reserve-adapters/<key>.ts` exporting `async function fetch<Name>Reserves(coin, config, signal, ctx?): Promise<AdapterResult>`. Adapter contract lives in `worker/src/cron/reserve-adapters/types.ts` (`AdapterFn`, `AdapterContext`, `ReserveAdapterDefinition` — the last is a `Pick<>` of the shared declaration, so declaration fields reach the Worker without being re-declared). Use helpers from `./helpers` rather than rebuilding fetch/parse/freshness primitives.
3. **Worker fetcher wiring** — add a `lazyAdapter(() => import("./<key>").then((mod) => mod.fetch<Name>Reserves))` entry to `LIVE_RESERVE_ADAPTER_FETCHERS` in `worker/src/cron/reserve-adapters/index.ts`. This stays a hand-written map because Worker implementations cannot enter the runtime-neutral shared registry and several keys deliberately share one fetcher; its `Record<LiveReserveAdapterKey, AdapterFn>` annotation makes a missing key or invalid named export a compile error, and `registry.test.ts` fails on the same coverage gap. Keep implementation imports inside these factories so inspecting the registry does not initialize the entire adapter graph.
4. **Coin config** — bind the coin's `liveReservesConfig` in `shared/data/stablecoins/coins/<id>.json`. A `params` block is required whenever the adapter's schema rejects `{}`.
5. **Adapter test and fixture** — add `worker/src/cron/reserve-adapters/__tests__/<key>.test.ts` and capture an HTTP-html fixture when applicable. HTML, JSON, and txt fixtures are all age-gated by `scripts/ci/check-html-fixture-age.ts` under the same `captured-at` stamp rule; a JSON or txt fixture that cannot carry the HTML-comment header is exempted in that script with a documented reason.

Changed reserve capture files select `npm run check:html-fixture-metadata` in the PR static guard plan. It validates canonical UTC second-precision stamps (`YYYY-MM-DDTHH:MM:SSZ`), real calendar dates, recorded provenance or explicit legacy exemptions, and refresh-inventory integrity without consulting calendar age. The weekly `check:html-fixture-age` retains the 90-day expiry and future-clock checks. The HTML capture writer truncates milliseconds rather than rounding; JSON captures can record the same comment in a `_capture` field without changing the captured payload's own clocks.

Docs are not a per-adapter step: the Adapter Registry notes above are for non-obvious semantics only, and the roster/counts are derived from the declaration table rather than copied.

For report-backed issuers, reuse `fetchIndependentAssuranceAdapter` in `independent-assurance.ts` when the existing generic engine owns the transport/parser contract. Agora, Anchorage, AUDD, CADD, FDUSD, RLUSD and SBC keep discovery/date/classification data in `*-independent-assurance-profile.ts` modules; they do not add forwarding fetchers. `IndependentAssuranceProfile` is defined in `types.ts`. Gemini, Paxos, FIDD and BRLA retain specialized orchestration. New material-clock consumers must submit every material contributor to the coverage summary and name any reviewed zoneless policy; do not drop all-bad coverage or manufacture a verified clock.

Minimal scaffold (HTTP-json single-asset shape):

```ts
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  freshnessMetadataFromTimestamp,
  parseTimestampLikeToUnixSeconds,
  requireJsonInput,
} from "./helpers";

interface MyAdapterPayload {
  totalReserves: number;
  updatedAt?: string;
}

export async function fetchMyAdapterReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "my-adapter");
  const params = parseLiveReserveAdapterParams("my-adapter", config.params);
  const payload = await fetchJsonWithRetry<MyAdapterPayload>(input.url, signal, 12_000, ctx);
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.updatedAt);

  return {
    slices: [{ name: params.assetLabel, pct: 100, risk: params.assetRisk }],
    metadata: {
      ...freshnessMetadataFromTimestamp(sourceTimestamp, "issuer-api", "payload has no source timestamp"),
    },
  };
}
```

---

## Frontend Consumers

Reserve composition and collateralization footers separate the source/report-as-of date from the last checked time, retain a stale label for out-of-window evidence, and never label a refreshed historical attestation as a new live measurement. Attestation-mix snapshots use the proof badge with an `Attestation` label. A source-age-only degradation explains that evidence is out of date; collection failures retain their separate sync-error notice.

`buildReserveFeedStatus()` appends reviewed exclusion reason, evidence date/URL, owner, reviewed date and expiry to stale/error/bootstrap/fallback disclosure rows. The status card distinguishes raw evidence coverage from health-cohort exclusions; neither surface claims acknowledgement makes evidence fresh.

- `src/hooks/use-stablecoin-reserves.ts` uses mode-aware polling: `live` responses follow the 4-hour reserve producer cadence (`staleTime = 4 hours` / `refetchInterval = 8 hours`), while stale or fallback modes tighten to `1 minute` / `2 minutes` so the UI re-checks recovery faster
- `src/hooks/use-stablecoin-detail-view-model.ts` injects the reserve result into the detail-page view model
- `src/lib/coverage.ts` uses the adapter badge taxonomy in `shared/lib/live-reserve-display.ts` so `/coverage` distinguishes true `Live` reserve feeds from `Curated-Validated` and `Proof` reserve-sync paths
- `worker/src/api/status.ts` uses `computeReserveCompositionOverview()` to surface reserve-sync health on `/status`

---

