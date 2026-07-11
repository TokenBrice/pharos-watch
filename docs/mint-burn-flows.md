# Mint/Burn Flow Tracker

On-chain mint and burn event tracker for stablecoins on their **configured issuance chains** via Alchemy JSON-RPC. Detects Transfer events (and USDT-specific Issue/Redeem events), aggregates them into hourly flow buckets, exposes per-coin raw `Net Flow` plus baseline-relative `Pressure Shift vs 30D`, computes a market-cap-weighted Bank Run Gauge, and flags flight-to-quality signals. Live ingestion runs in two lanes: a critical 30-minute lane for major coverage and an offset extended 30-minute lane for long-tail backlog drain.

Product scope note: the public `/flows` page now surfaces the configured issuance scope plus per-coin `coverage` metadata so partial history, lagging sync, or unknown current chain-head states are visible to users instead of implied as complete market-wide coverage. Current production scope is Ethereum for most tracked assets, with USDai tracked on native Arbitrum as its canonical issuance/redemption chain.

The `/flows` page also renders a Flow Receipt directly under the printer/shredder overview. The receipt uses the existing 24-hour coin rows and 7-day hourly buckets to show printed, shredded, and net tracked flow totals, the top 24-hour minter and burner, and the current coverage/lag state. Its labels deliberately describe observed configured-chain events; they do not claim complete market-wide supply creation or redemption.

Operational freshness configuration is shared via `worker/src/lib/mint-burn-health-config.ts`:
- major-symbol baseline (`USDT`, `USDC`, `DAI`, `USDS`, `GHO`, `FRXUSD`, `BOLD`, `reUSD`)
- warning threshold (`6h`)
- critical threshold (`24h`)

Scheduled/http handlers apply env overrides on top of these defaults (`worker/src/handlers/scheduled.ts`, `worker/src/handlers/http/request-dispatch.ts`). Public `/api/health` now keys mint/burn freshness to the critical-lane sync timestamp / run status (the same semantics exposed by `/api/mint-burn-flows`) so quiet majors do not falsely mark the health surface stale just because no new events occurred.

Public `/api/mint-burn-flows` freshness metadata and the `/flows` page intentionally allow one missed 30-minute critical-lane slot before warning. User-facing freshness is `fresh <= 60m`, `degraded <= 90m`, `stale > 90m`, which keeps the public warning surface aligned with `/status` cron-health grace windows instead of flagging a single late slot as an incident.

---

## Methodology Versioning

- **Current methodology version:** `v6.17`
- **Public changelog page:** `/methodology/mint-burn-flow-changelog/`
- **Internal reconstructed timeline:** [Mint/Burn Flow Methodology Timeline](./mint-burn-flows-timeline.md)

> **Note:** `v6.17` went live on 2026-06-07 with row-level tx-context shortfall exclusion so unresolved bridge-aware rows stay out of economic flow without blocking resolved rows in the same scan or counting as provider-error failures. `v6.16` added batched bridge tx-context reads and a larger bounded critical budget for bridge-aware configs. `v6.15` added bridge tx-context shortfall guards and explicit `bridgeClassification` cron metadata. `v6.14` added fail-closed bridge-detection config validation, `v6.13` added a USD-valued-only guard for the 24-hour largest-event field, `v6.12` added cadence-based per-coin lag classification and an `unknown` coverage status when current chain-head metadata is missing, `v6.11` added Yearn BOLD (yBOLD) to extended Ethereum mint/burn tracking, `v6.1` added Tangent USD (USG) coverage from its reviewed deployment block, and `v6.0` shipped bridge-mint tagging, LayerZero endpoint-only signal, canonical-chain gauge weighting, 0.5% roundtrip tolerance, config deferral, concurrent tx-context fetch, extended cron metadata, and migrations 0096/0097. Historical rows are reclassified progressively via the operator playbook (`/api/reclassify-atomic-roundtrips?stablecoinId=<id>` for partition-scoped reverse flips; `/api/backfill-mint-burn` for chunked bridge-mint replay).

---

## Cron Schedule

- **Critical lane pattern:** `4,34 * * * *` (every 30 minutes, offset at :04/:34)
- **Extended lane pattern:** `13,43 * * * *` (every 30 minutes, offset at :13/:43 — 9 minutes after critical lane starts)
- **Trigger mode:** isolated. `sync-blacklist` runs on its own dedicated 6-hourly trigger (`3 */6 * * *`); `sync-dex-discovery` runs on a dedicated 2-hourly trigger (`6 */2 * * *`).
- **Function:** `syncMintBurn(db, alchemyApiKey, { lane, jobName, ... })`
- **Provider:** Alchemy JSON-RPC
- **File:** `worker/src/cron/sync-mint-burn.ts`
- **Registration:** cron declared in `worker/wrangler.toml`; `worker/src/handlers/scheduled.ts` dispatches the isolated slots through `worker/src/handlers/scheduled/twenty-minute-mint-burn-critical.ts`, `worker/src/handlers/scheduled/twenty-minute-mint-burn-extended.ts`, and the shared `worker/src/handlers/scheduled/mint-burn-slot.ts`
- **Returns:** `{ itemCount, status, metadata }` where `itemCount = rowsInserted` (not parsed rows). Metadata includes `lane`, `jobName`, `nullPricesHealed`, and per-config coverage-frontier diagnostics when scans are partial.
- **Operator notes:** internal ingestion process notes are kept outside the public documentation archive.

Lane policy:
- `sync-mint-burn` = critical lane. Uses the existing job id so freshness alerts and API freshness remain keyed to the major-symbol path.
- `sync-mint-burn-extended` = extended lane. Uses its own `mint_burn_run_state.job` key and warning-only coverage semantics so long-tail backlog churn does not escalate the critical lane to `error`.

UI note: when `/flows` receives a mint/burn-specific `sync.warning`, it renders that targeted banner and suppresses the generic stale-data banner for the same query so users do not see duplicate amber warnings describing the same freshness condition. Cached fallback API responses now preserve only freshness-derived headers; a transient live-query failure no longer emits an extra generic `Warning` while the cached dataset is still inside the public 60-minute freshness window.

---

## Constants & Thresholds

| Constant | Value | Purpose |
|----------|-------|---------|
| `dustThreshold` | 10,000 default (token-native); 10 for precious-metal tokens | Events below this amount are discarded |
| `EVM_SAFETY_MARGIN_BLOCKS` | 75 | Safety margin when advancing sync state to chain head, derived as `ceil(900s indexing safety / 12s block time)` |
| `DENOM_SCALE` | 0.3 | Pressure-shift denominator = 30% of baseline daily absolute flow |
| `DENOM_FLOOR` | $1,000,000 | Minimum pressure-shift denominator |
| `Z_MULTIPLIER` | 50 | Z-score amplification in the pressure-shift formula |
| Pressure-shift clamp range | -100 to +100 | Signed baseline-relative score output range |
| `MIN_DATA_DAYS` | 7 | Days of history required before pressure shift returns a value |
| `MIN_ACTIVITY_USD` | 50,000 | 24h absolute flow below this returns NR pressure shift |
| `FTQ_THRESHOLD` | $100,000,000 | Minimum net flow (both sides) to trigger flight-to-quality |
| `MAX_SCAN_RANGE` | 50K | Max block range per contract per cycle |
| `startBlock` | per-config (non-uniform) | Each contract config has its own start block |
| Subrequest budget | 200 per cron run | Global Alchemy API call budget |
| Per-config request cap | 60 critical, 150 bridge-aware critical, 25 extended | Prevents one hot config from consuming the full lane while allowing high-volume bridge-aware critical configs to finish batched tx-context classification |
| Runtime self-budget | 9 minutes, with a 60-second minimum next-config window | Stops starting new configs before the 10-minute cron wrapper timeout so the run can persist controlled metadata and resume on the next slot |
| Config tier policy | `critical` / `extended` | Critical and extended lanes run on separate cron schedules; each config also has a per-config request cap |
| Coverage lag threshold | public freshness window by chain block cadence, capped at 10K blocks | Marks established per-coin coverage `lagging` once current block progress exceeds the public freshness cadence |

---

## Contract Configurations

**File:** `worker/src/lib/mint-burn-contracts.ts`

Token identity now resolves from the shared stablecoin registry in `shared/lib/stablecoins/registry.ts`, which validates the checked-in per-coin metadata assets under `shared/data/stablecoins/coins/*.json` through `shared/data/stablecoins/coins.generated.json` at module load. The mint/burn config file only keeps tracker-specific fields such as event signatures, `startBlock`, `dustThreshold`, tiering, and bridge-detection hints. There are no explicit address overrides; both `reUSD` configs (`reusd-re-protocol` and `reusd-resupply`) resolve the registered token contract and track its canonical zero-address `Transfer` events.

### Representative Stablecoins

Current scope: **135 contract configs** across **135 stablecoin IDs** (7 critical + 128 extended).

March 24, 2026 expansion: an additional 40 transfer-only configs were added for tracked assets that already had shared contract metadata but were not yet wired into the mint/burn registry. That wave initially included USDai on Ethereum, but canonical USDai issuance tracking now runs on native Arbitrum after LayerZero bridge-transfer filtering work. GYD was later removed when the asset moved to the cemetery. The broader active wave includes `U`, `A7A5`, `USDA` (Avalon), `BRZ`, `KAG`, `satUSD`, `rwaUSDi`, `FPI`, `AEUR`, `USDQ`, `USDX`, `MIM`, `USA₮`, `ZeUSD`, `GGBR`, `XSGD`, `IDRT`, `TRYB`, `EURS`, `pUSD` (Plume), `USBD`, `DGLD`, `AxCNH`, `EURQ`, `GYEN`, `USDU Finance`, `ZARP`, `USDp`, `PHT`, `VCHF`, `USSD`, `CADC`, `VEUR`, `dUSD` (dTRINITY), `USDaf`, `EURAU`, `DUSD` (Alto), and `ebUSD`.

The table below is representative, not exhaustive. The complete active registry is `MINT_BURN_CONFIGS` in `worker/src/lib/mint-burn-contracts.ts`.

| Symbol | ID | Decimals | Category | Events |
|--------|----|----------|----------|--------|
| USDT | usdt-tether | 6 | Safe haven | Transfer + Issue/Redeem |
| USDC | usdc-circle | 6 | Safe haven | Transfer |
| FDUSD | fdusd-first-digital | 18 | Safe haven | Transfer |
| PYUSD | pyusd-paypal | 6 | Safe haven | Transfer |
| DAI | dai-makerdao | 18 | Risky | Transfer |
| GHO | gho-aave | 18 | Risky | Transfer |
| USDe | usde-ethena | 18 | Risky | Transfer |
| USDS | usds-sky | 18 | Risky | Transfer |
| FRXUSD | frxusd-frax | 18 | Risky | Transfer |
| BOLD | bold-liquity | 18 | Risky | Transfer |
| yBOLD | ybold-yearn | 18 | Extended | Transfer |
| fxUSD | fxusd-f-x-protocol | 18 | Extended | Transfer |
| crvUSD | crvusd-curve | 18 | Extended | Transfer |
| AUSD | ausd-agora | 6 | Extended | Transfer |
| ZCHF | zchf-frankencoin | 18 | Extended | Transfer |
| EURC | eurc-circle | 6 | Extended | Transfer |
| PAXG | paxg-paxos | 18 | Extended | Transfer |
| XAUT | xaut-tether | 6 | Extended | Transfer |
| USDG | usdg-paxos | 6 | Extended | Transfer |
| USD1 | usd1-world-liberty-financial | 18 | Extended | Transfer |
| USDf | usdf-falcon | 18 | Extended | Transfer |
| USYC | usyc-hashnote | 6 | Extended | Transfer |
| RLUSD | rlusd-ripple | 18 | Extended | Transfer |
| USDY | usdy-ondo-finance | 18 | Extended | Transfer |
| BUIDL | buidl-blackrock | 6 | Extended | Transfer |
| USDD | usdd-tron-dao-reserve | 18 | Extended | Transfer |
| USDTB | usdtb-ethena | 18 | Extended | Transfer |
| M | m-m0 | 6 | Extended | Transfer |
| USD0 | usd0-usual | 18 | Extended | Transfer |
| TUSD | tusd-trueusd | 18 | Extended | Transfer |
| CUSD | cusd-cap | 18 | Extended | Transfer |
| USR | usr-resolv | 18 | Extended | Transfer |
| FRAX | frax-frax | 18 | Extended | Transfer |
| DOLA | dola-inverse-finance | 18 | Extended | Transfer |
| IUSD | iusd-infinifi | 18 | Extended | Transfer |
| GUSD | gusd-gate | 6 | Extended | Transfer |
| avUSD | avusd-avant | 18 | Extended | Transfer |
| pmUSD | pmusd-precious-metals | 18 | Extended | Transfer |
| USDz | usdz-anzen | 18 | Extended | Transfer |
| MNEE | mnee-mnee | 18 | Extended | Transfer |
| TBILL | tbill-openeden | 6 | Extended | Transfer |
| USG | usg-tangent | 18 | Extended | Transfer |
| USDO | usdo-openeden | 18 | Extended | Transfer |
| EURCV | eurcv-societe-generale-forge | 18 | Extended | Transfer |
| REUSD | reusd-resupply | 18 | Extended | Transfer |
| EURI | euri-banking-circle | 18 | Extended | Transfer |
| GUSD | gusd-gemini | 2 | Extended | Transfer |
| USDP | usdp-paxos | 18 | Extended | Transfer |
| XUSD | xusd-straitsx | 6 | Extended | Transfer |
| MUSD | musd-metamask | 6 | Extended | Transfer |
| YUSD | yusd-aegis | 18 | Extended | Transfer |
| SUSD | susd-synthetix | 18 | Extended | Transfer |
| LUSD | lusd-liquity | 18 | Extended | Transfer |
| USDCV | usdcv-societe-generale-forge | 18 | Extended | Transfer |
| EURE | eure-monerium | 18 | Extended | Transfer |
| USN | usn-noon | 18 | Extended | Transfer |
| EUSD | eusd-electronic-usd | 18 | Extended | Transfer |
| meUSD | meusd-mezo | 18 | Extended | Transfer |
| MSUSD | msusd-metronome | 18 | Extended | Transfer |
| NUSD | nusd-neutrl | 18 | Extended | Transfer |
| ALUSD | alusd-alchemix | 18 | Extended | Transfer |
| FIDD | fidd-fidelity | 18 | Extended | Transfer |
| MSUSD | msusd-main-street | 18 | Extended | Transfer |
| WUSD | wusd-worldwide | 18 | Extended | Transfer |
| SBC | sbc-brale | 18 | Extended | Transfer |
| OUSD | ousd-origin-protocol | 18 | Extended | Transfer |
| USP | usp-pikudao | 18 | Extended | Transfer |
| USDR | usdr-stablr | 6 | Extended | Transfer |
| USTB | ustb-superstate | 6 | Extended | Transfer |
| OUSG | ousg-ondo-finance | 18 | Extended | Transfer |
| mTBILL | mtbill-midas | 18 | Extended | Transfer |
| wsrUSD | wsrusd-reservoir | 18 | Extended | Transfer |
| AUDD | audd-novatti | 6 | Extended | Transfer |
| JPYC | jpyc-jpyc | 18 | Extended | Transfer |
| XAUm | xaum-matrixdock | 18 | Extended | Transfer |
| EURR | eurr-stablr | 6 | Extended | Transfer |
| EUROP | europ-schuman | 6 | Extended | Transfer |
| DEURO | deuro-deuro | 18 | Extended | Transfer |
| tGBP | tgbp-tokenised | 18 | Extended | Transfer |
| syrupUSDC | syrupusdc-maple | 6 | Extended | Transfer |
| syrupUSDT | syrupusdt-maple | 6 | Extended | Transfer |
| AID | aid-gaib | 18 | Extended | Transfer |
| apxUSD | apxusd-apyx | 18 | Extended | Transfer |
| reUSD | reusd-re-protocol | 18 | Extended | Transfer (zero-address) |

Public `/api/mint-burn-flows` and the daily digest collector now use the same **report-card-cache driven** FTQ classification. Coins with report-card score `>= 65` are treated as `safe`, scores `< 50` are treated as `risky`, and the middle band is ignored for FTQ. When `report_card_cache` is missing, stale, or malformed, FTQ classification is treated as unavailable instead of silently falling back to a hardcoded safe-haven list.

Per-config adapter provenance is now surfaced through coin `coverage` metadata:
- `adapterKinds` — active decoding families for the coin (`transfer-zero-address`, `custom-events`, `mixed`)
- `startBlockSource` — whether the earliest tracked block is a reviewed contract-specific bound or a blanket default coverage floor
- `startBlockConfidence` — qualitative confidence on historical completeness (`high`, `medium`, `low`)
- `status` — `full`, `partial-history`, `lagging`, `bootstrapping`, `unknown`, or `disabled`; `unknown` means the current chain head is unavailable, so Pharos cannot certify present sync lag

Current rule: the March 24 long-tail transfer wave that inherited the blanket `21_900_000` Ethereum floor is labeled `startBlockSource = default-coverage-floor-2026-03-24` and `startBlockConfidence = low`, so the public API no longer implies contract-specific historical certainty where none exists.

Events are also classified by `flow_type` (`standard`, `bridge_transfer`, or `atomic_roundtrip`) so non-economic bridge transfers and same-tx roundtrip noise stay out of aggregate flow metrics.

### Event Detection

**Standard mint/burn:** ERC-20 `Transfer(address,address,uint256)` events filtered by zero address.

- **Mint:** `topics[1]` (from) = zero address
- **Burn:** `topics[2]` (to) = zero address

**USDT Ethereum special handling:** The USDT contract uses custom `Issue(uint256)` and `Redeem(uint256)` events for treasury operations (issue() does NOT emit Transfer). These are tracked in addition to Transfer events.

| Event | Topic Hash | Amount Encoding |
|-------|-----------|-----------------|
| `Transfer(address,address,uint256)` | `0xddf252ad...` | `transfer-value` (data field) |
| `Issue(uint256)` | `0xcb8241ad...` | `first-data-uint256` |
| `Redeem(uint256)` | `0x702d5967...` | `first-data-uint256` |

**reUSD special handling:** Re Protocol reUSD is tracked from the reUSD token's canonical zero-address `Transfer` events. Earlier vault-event parsing used `Deposited(address,address,uint256)`, but that event reports deposited collateral units; USDC/USDT deposits therefore decode as 6-decimal collateral amounts instead of 18-decimal reUSD shares and can fall below the dust threshold. The token `Transfer(from=0x0)` / `Transfer(to=0x0)` logs are the canonical mint/burn amount source, and they also avoid double-counting instant redemptions that emit both a token burn and a route-level redemption event.

**Custom counterparty encoding.** For events whose relevant address is not in a standard topic slot, `MintBurnEventDef` now exposes an optional `counterpartyEncoding` override:

- `{ source: "topic", index }` — read `log.topics[index]` (must be ≥1).
- `{ source: "data", slot }` — read a 32-byte word from `log.data` at `slot * 32` and take the low-20 bytes as the address. Implemented via the new `readDataWord` helper in `worker/src/lib/evm-logs.ts`.

When omitted, the default is the Transfer convention: mint → `topics[2]` (recipient), burn → `topics[1]` (sender).

---

## Sync Algorithm

1. **Load sync state** — batch query `mint_burn_sync_state` for all lane-selected contract keys. Falls back to `startBlock - 1` for new configs.
2. **Apply runtime policy** — filter disabled configs (`MINT_BURN_DISABLED_IDS`, `MINT_BURN_DISABLED_SYMBOLS`), select the requested lane (`critical`, `extended`, or `all`), rotate start index from the lane-specific `mint_burn_run_state.job`, front-load critical configs inside mixed/all runs, and assign a per-config request cap inside the global budget. The cron runner reserves a 9-minute self-budget inside the 10-minute wrapper timeout and skips the remaining config tail once fewer than 60 seconds remain for starting another config.
3. **Skip deferred configs** — load active deferrals from `mint_burn_config_deferral` (rows with `deferred_until > now`) and remove them from the run. A config is deferred for a 1-hour grace period when it exits a run with `apiErrors > 5` AND `coverage < 0.8`, so chronically failing configs cannot starve healthy ones of subrequest budget.
4. **Get chain head** — Alchemy `eth_blockNumber` call per chain (cached per chain ID).
5. **Load price cache** — query `price_cache` for all tracked stablecoin IDs (used for USD conversion).
6. **For each contract config:**
   - Skip if `fromBlock > chainHead` or the lane/global budget is exhausted.
   - For each event definition, call Alchemy `eth_getLogs` with adaptive recursive block-range splitting on provider/range failures.
   - Enforce the per-config request cap while fetching logs, resolving timestamps, and classifying bridge activity so a single config cannot monopolize the lane.
   - Resolve block timestamps — batch `eth_getBlockByNumber` for unique blocks that contain non-dust candidate logs, using local + persistent (`block_timestamp_cache`) caches. Dust-only blocks are dropped before timestamp resolution so they cannot pin the sync frontier.
   - Parse logs per event definition: decode amount (respecting decimals), derive counterparty address, compute `amount_usd = amount * price` (null if no price), and initialize `flow_type='standard'`.
   - Resolve transaction-context receipts for candidate bridge rows in chunks of 20 transaction hashes with the local `mapWithConcurrency` helper (`TX_CONTEXT_BATCH_CONCURRENCY = 3`) instead of one HTTP request per transaction. Each HTTP request carries both transaction and receipt JSON-RPC calls for its chunk, so high-volume USDC-style bridge-aware windows consume a handful of Worker subrequests instead of hundreds.
   - Classify bridge transfers after all parsed rows for the config chunk are assembled so bridge-related mints and burns can be tagged together while still sharing the same transaction-context budget.
   - Timestamp and bridge-classification phases receive the cron lane deadline; when the 9-minute self-budget is reached they stop adding remote work and surface ordinary partial-frontier diagnostics instead of relying on the outer 10-minute cron timeout.
   - If a bridge-enabled config cannot resolve required transaction and receipt context for a parsed transaction, rows from that transaction are withheld from persistence for that run while resolved rows in the same window can still publish. These shortfalls remain in `bridgeClassification` diagnostics and keep the sync cursor at the safe retry frontier instead of counting unresolved rows as economic flow.
   - Detect atomic roundtrips after all event definitions for the config are parsed: group rows by `(tx_hash, stablecoin_id, chain_id)` and flip the whole group to `flow_type='atomic_roundtrip'` when both mint and burn directions appear in the same transaction and their totals match within `ROUNDTRIP_AMOUNT_TOLERANCE` (0.5%). Rows with an empty `tx_hash` are defensively skipped.
   - Filter out dust events (amount < `dustThreshold`).
   - Batch `INSERT OR IGNORE` into `mint_burn_events`, track parsed vs inserted counts from D1 `meta.changes`. Cron callers pass the wrapper `AbortSignal` into insert/classification batches so timeout or lease-loss cancellation stops before large D1 persistence chunks continue.
   - Update `mint_burn_sync_state.last_block`:
     - If every event definition completed and timestamps are fully resolved:
       - If events found: advance to `maxBlockSeen`.
       - If no events: advance to `chainHead - safetyMarginBlocks` (avoids skipping not-yet-indexed events).
     - If any event definition was partial or any block timestamps were unresolved: advance only to the shared safe coverage frontier (`min(scannedToBlock, earliestMissingTimestamp-1)`).
     - If no safe frontier exists for the config in that run: do not advance.
7. **Recalculate affected hourly buckets** — for each unique `(stablecoinId, chainId, hourTs)` touched, `INSERT OR REPLACE` into `mint_burn_hourly` by re-aggregating from `mint_burn_events`, counting only `flow_type='standard'` rows so bridge transfers and atomic roundtrips do not leak into flow statistics.
   - Recalc runs inside a `finally` block so it still fires after partial-run failures. If the recalc itself throws, the critical lane downgrades `status=ok` to `status=degraded` and surfaces `recalcFailed: true` plus `recalcError: <message>` in cron metadata (previously failures were only logged silently). The cron abort signal is also passed into this recalc path and into post-run null-price healing / roundtrip sweep recalcs.
8. **Auto-heal recent NULL prices** — on non-error runs, query up to 500 events with `amount_usd IS NULL` in the last 48 hours, resolve from `price_cache`, update `amount_usd/price_*` with `price_source=price_cache_heal`, and re-aggregate only newly affected hourly buckets.
   - Cron metadata now includes both `nullPricesHealed` and `nullPriceBacklog` (`recent`, `historical`) so operators can distinguish live healable gaps from older debt.
9. **Emit active progress** — long runs call the shared cron `reportProgress(...)` hook so `/api/status` can surface the active stage, queue position, and budget heartbeat while the lease is still live.
10. **Escalate degraded runs** — the critical lane emits `status=degraded|error` when sustained coverage/API thresholds are breached, with streak tracking in `mint_burn_run_state`. The extended lane keeps the same observability metadata but does not escalate long-tail backlog pressure to `error`.
11. **Sweep cross-run roundtrips** — on non-error runs, query up to 200 `(tx_hash, stablecoin_id, chain_id)` groups within the last 7 days where both mint and burn directions exist but `flow_type = 'standard'`. Reclassify to `atomic_roundtrip` and re-aggregate affected hourly buckets. This catches roundtrips where the mint and burn were ingested in separate cron runs. The HAVING clause mirrors `ROUNDTRIP_AMOUNT_TOLERANCE` from the in-memory detector so partial same-tx groups (e.g. mint 100 / burn 50) are not mis-tagged as atomic roundtrips.
12. **Invalidate flow API caches** — on successful runs (`status ∈ {ok, degraded}`), purge `mint-burn-flows:*` rows from the shared `cache` table using a PK-range predicate (`key >= 'mint-burn-flows:' AND key < 'mint-burn-flows:\uffff'`). This drops stale pre-sync aggregate payloads so the next `/api/mint-burn-flows` request rebuilds against the freshly written buckets.

**Counterparty resolution:** For mints, `topics[2]` (recipient). For burns, `topics[1]` (sender).

**Event ID format:** `"{chainId}-{txHash}-{logIndex}"` — deterministic, prevents duplicates via `INSERT OR IGNORE`.

---

## Shared Ingestion Pipeline Boundaries

Cron (`sync-mint-burn`) and admin backfill (`backfill-mint-burn`) now share a single ingestion pipeline under `worker/src/lib/mint-burn-pipeline/`.

| Module | Responsibility |
|--------|----------------|
| `types.ts` | Shared ingestion row/context/counter types and sync-state mode union |
| `parse.ts` | `parseMintBurnLogs()` and event-level price resolution (`supply-history` then `price_cache` fallback) |
| `roundtrip-detection.ts` | Same-transaction `(tx_hash, stablecoin_id, chain_id)` atomic roundtrip detection for `flow_type` tagging |
| `classification.ts` | Bridge-aware burn classification and transaction-context loading |
| `context.ts` | Shared loaders for current prices and historical price series |
| `persistence.ts` | `INSERT OR IGNORE` event writes, burn classification updates, affected-hour aggregation |
| `price-heal.ts` | Auto-heal recent NULL-price rows from `price_cache` and return affected hours |
| `roundtrip-sweep.ts` | Post-cron sweep for cross-run atomic roundtrip detection (7-day window, 200-group limit per run) |
| `sync-state.ts` | Sync-state key helpers plus mode-specific upserts (`replace` for cron, `monotonic-max` for backfill) |

Implementation invariant: `worker/src/api/backfill-mint-burn.ts` does not import from `worker/src/cron/sync-mint-burn.ts`; both entrypoints import shared helpers from `mint-burn-pipeline/*`.

`mint_burn_events.flow_type` is orthogonal to `burn_type`: `burn_type` still classifies burns as economic vs bridge/review, while `flow_type` applies to both mints and burns and now marks tx-level bridge noise as `bridge_transfer` plus same-transaction mint+burn noise as `atomic_roundtrip`.

Cron metadata includes `atomicRoundtripsDetected`, an observability counter for how many rows were tagged during the run.

### Bridge Classifier

Dispatch and per-protocol fingerprint logic now live in three co-operating modules instead of one monolith:

| Module | Responsibility |
|--------|----------------|
| `worker/src/lib/mint-burn-bridge-classifier.ts` | Dispatcher: normalizes tx context, walks per-row fingerprints, and writes `flow_type = 'bridge_transfer'` plus (for burns) `burn_type = 'bridge_burn'` |
| `worker/src/lib/mint-burn-bridge-classifier-protocols.ts` | Per-protocol helpers: CCIP/CCTP router matching, LayerZero OFT signal fingerprints, generic pool/router address heuristics |
| `worker/src/lib/mint-burn-bridge-classifier-types.ts` | Leaf module with shared types (breaks the classifier ↔ protocols import cycle) |

Key behavior changes forward-going:

- **Mint-side tagging for CCIP/CCTP.** The classifier now tags bridge *mints* (not just burns) as `flow_type='bridge_transfer'`. Affects USDO, USD1, avUSD, ZCHF (CCIP) and USDC, EURC (CCTP). Previously only the burn side was filtered, so counted flow aggregates double-counted cross-chain hops.
- **LayerZero endpoint-only signal.** The OFT/OAdapter path now accepts a third fingerprint (`fingerprintC`) that fires when the transaction context contains both a known LayerZero endpoint topic and an expected emitter address, even without the classic pool-address match (`hasSignalTopic && hasExpectedEmitter && signalEmitterSet.size > 0`). This catches LayerZero-Executor-only mints that previously slipped through. Tradeoff: known risk of shared-endpoint false positives is accepted to eliminate the prior false-negative backlog.
- **No more `bridge-signal-with-unknown-pool` review path.** Rows that touch a recognized bridge-signal topic/emitter but not a tracked pool address now tag as `bridge_transfer` instead of flowing to a review queue. Policy: if a transaction carries a bridge signal, treat every mint/burn in it as bridge noise.
- **Fail-closed bridge-detection config validation.** `validateMintBurnBridgeDetection` runs against every `bridgeDetection` config at module load. Address fields must match `ADDRESS_RE`, topics must match `TOPIC_RE`, and selectors must match `SELECTOR_RE`. Any malformed bridge config now aborts module load instead of logging and continuing, so bridge filtering cannot silently disable itself for one coin. Healthy mint/burn runs publish `bridgeValidationErrors: 0` in cron metadata for status diagnostics.
- **Bridge tx-context shortfall guard.** For bridge-enabled configs, both transaction and receipt context must resolve before parsed rows can count as standard economic flow. If context is unavailable under budget pressure or RPC failure, rows for that transaction are tagged `bridge_transfer` (and burns carry `tx-context-unavailable`) so they publish only as excluded diagnostics. Run metadata surfaces `bridgeClassification.txContextShortfalls` and `bridgeClassification.deferredRows`; these diagnostics do not increment provider `apiErrors`.

### Atomic Roundtrip Detection

Same-transaction mint+burn pairs for one stablecoin are tagged `flow_type='atomic_roundtrip'` in two places: in-memory during ingestion (per config chunk) and via the post-run sweep (cross-run, 7-day lookback, capped at 200 groups per run). Both paths now share the same `ROUNDTRIP_AMOUNT_TOLERANCE = 0.005` (0.5%) rule:

- A group tags atomic only when `|sum(mint) - sum(burn)| ≤ 0.005 × max(mintSum, burnSum)`.
- Partial same-tx groups (e.g. mint 100 / burn 50) are no longer flagged atomic_roundtrip and stay as `standard` flow.
- Rows with an empty `tx_hash` are defensively skipped by the in-memory detector.
- The forward tagging SQL mirrors the tolerance via `HAVING ... ABS(mint_amt - burn_amt) <= 0.005 * (CASE WHEN mint_amt >= burn_amt THEN mint_amt ELSE burn_amt END)` (SQLite has no two-arg `MAX`, so the explicit `CASE` is intentional). Reverse cleanup uses `NOT (...)` around the same predicate.
- A drift-guard unit test asserts `ROUNDTRIP_AMOUNT_TOLERANCE === 0.005` so changes to the TS constant surface against the SQL literals that mirror it.

---

## Scoring

**File:** `worker/src/lib/mint-burn-scoring.ts`

### Pressure Shift vs 30D (Flow Intensity Formula)

The underlying scoring formula is unchanged, but the product now exposes it as the baseline-relative `Pressure Shift vs 30D` signal. Runs server-side in the `/api/mint-burn-flows` aggregate handler.

```
denominator = max(baselineDailyAbs * 0.3, $1M)
z = (currentDailyNet - baselineDailyNet) / denominator
pressureShift = clamp(-100, 100, z * 50)
```

**Activity gate:** If the coin's 24h absolute flow (mint volume + burn volume) is below `MIN_ACTIVITY_USD` ($50,000), pressure shift returns `null` (NR). This prevents misleading scores for dormant or low-activity coins.

- **Input:** 24h net flow, 24h absolute flow (`|mint| + |burn|`), trailing 30 fully closed daily average net flow, trailing 30 fully closed daily average absolute flow, data age in days.

- **Output:** -100 to +100 score, or `null` (NR) if fewer than 7 days of history, if 24h absolute flow is below $50,000, or if the coin has no 24h mint/burn activity.
- Score of 0 = current flow matches baseline. Negative values = pressure is worse than baseline. Positive values = pressure is improving versus baseline.

### Two-Signal Interpretation Model

Per-coin UI and API now answer two different questions explicitly:

1. **Net Flow 24h** — current direction and magnitude from raw mint-minus-burn totals
   - `minting`: `netFlow24hUsd > 0`
   - `burning`: `netFlow24hUsd < 0`
   - `flat`: `netFlow24hUsd = 0` with activity
   - `inactive`: no 24h activity
2. **Pressure Shift vs 30D** — how unusual current pressure is versus the coin's own baseline
   - `improving`: score `> 10` (strictly greater; score of exactly 10 is stable)
   - `stable`: score between `-10` and `+10` (inclusive on both boundaries)
   - `worsening`: score `< -10` (strictly less; score of exactly -10 is stable)
   - `nr`: insufficient history or no current activity

Invariant: minting vs burning semantics now always come from raw net flow, never from score sign.

### Shared Signal Helper

`shared/lib/mint-burn-signals.ts` centralizes interpretation logic used by worker responses and frontend fallbacks:

- `getNetFlowDirection24h()`
- `getPressureShiftState()`
- `getLiteralMintingPressureScore()`

### Gauge Bands

| Band | Range | Color | Meaning |
|------|-------|-------|---------|
| CRISIS | -100 to -70 | red | Massive redemption pressure |
| STRESS | -70 to -40 | orange | Heavy redemptions |
| CAUTIOUS | -40 to -10 | amber | Elevated burns |
| NEUTRAL | -10 to +10 | gray | Balanced mint/burn |
| HEALTHY | +10 to +40 | light-green | Net minting |
| CONFIDENT | +40 to +70 | green | Strong demand |
| SURGE | +70 to +100 | bright-green | Extreme minting demand |

Boundary convention: each band is `[min, max)`. The last band includes +100.

### Bank Run Gauge (Composite)

Market-cap-weighted average of individual pressure-shift scores:

```
gauge_score = Σ(intensity_i * mcap_i) / Σ(mcap_i)
```

- Skips coins with `null` intensity (insufficient data or NR no-activity window).
- Returns `null` only when ALL tracked coins lack valid intensity.

**Mcap weighting — tracked-chain scope.** Each coin's weight is now its **canonical tracked-chain circulating supply**, not its global peg-bucket total. A coin is only scored against chains where we actually ingest mint/burn events, so omnichain tokens don't over-contribute via supply we don't observe.

Implementation (`worker/src/lib/mint-burn-mcap-weighting.ts`):

- `getMintBurnTrackedChains(stablecoinId)` derives the active `chainId` set from `MINT_BURN_CONFIGS`.
- `sumMcapForTrackedChains(stablecoinId, chainCirculating, circulating)` sums `chainCirculating[chainId].current` over those tracked chains, after `canonicalizeChainCirculating(...)` normalizes DefiLlama's capitalized keys (e.g. `Ethereum`) to canonical chain IDs.
- Fallback policy (preserves legacy behavior where per-chain data isn't available):
  1. Coin with no tracked chains → `sumPegBuckets(circulating)`.
  2. Canonicalized `chainCirculating` is empty → `sumPegBuckets(circulating)` (keeps CG-fallback assets alive).
  3. No tracked chain has an entry in the canonicalized map → `sumPegBuckets(circulating)`.
  4. Otherwise sum `current` across tracked chains. `current = 0` is treated as real data (zero supply) and does not trigger fallback.

### Flight-to-Quality Detection

Detects simultaneous outflows from risky stablecoins and inflows to safe havens.

- **Activation:** `riskyNet24h < -$100M` AND `safeNet24h > +$100M`
- **Intensity:** `min(100, |riskyNet24h| / $1B * 100)`
- Safe/risky cohorts come from the report-card cache: Safety Score `>=65` is safe, `<50` is risky, and `50–64` is ignored. If the report-card cache is unavailable, flight-to-quality classification is unavailable rather than falling back to hardcoded safe havens.

---

## Retention

`mint_burn_events` is **append-only by product decision** (settled with owner, 2026-06-10): it is the immutable on-chain event log behind /flows history and Telegram flow alerts, and no retention pruning is applied. The growth budget is enforced by the daily `mint-burn-growth-watchdog` cron (`worker/src/cron/mint-burn-growth-watchdog.ts`, 03:00 UTC slot): it counts table rows and webhook-alerts (7-day redelivery cooldown) once the count crosses **2.3M rows**, the row-count proxy for the agreed ~5 GB D1 revisit point (at ~1.43M rows the whole database measured 3.09 GB of the 10 GB cap; D1 disallows `PRAGMA page_count`). When the alert fires, revisit the decision: document a raised budget, or archive rows older than N months into the dated snapshot export.

## Database Schema

### mint_burn_events (current excerpt; baseline plus later indexes)

```sql
CREATE TABLE mint_burn_events (
  id TEXT PRIMARY KEY,                 -- "{chainId}-{txHash}-{logIndex}"
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  direction TEXT NOT NULL,             -- "mint" or "burn"
  amount REAL NOT NULL,                -- Token-native amount
  amount_usd REAL,                     -- NULL if price unavailable at sync time
  price_used REAL,                     -- Price at resolution time
  price_timestamp INTEGER,             -- When the price was sourced (cache update time), NOT the event's block timestamp
  price_source TEXT,                   -- Runtime source or exact historical repair source
  price_repair_status TEXT,            -- NULL, "pending_aggregate", "recovered", or "irreducible"
  price_repair_reason TEXT,            -- Terminal no-source reason or retryable provider diagnostic
  price_repair_attempted_at INTEGER,   -- Latest bounded historical repair attempt
  price_repair_run_id TEXT,            -- Operator Idempotency-Key for the last mutation attempt
  price_repair_bookmark TEXT,          -- Pre-run D1 Time Travel bookmark
  burn_type TEXT,                      -- "effective_burn", "bridge_burn", or "review_required" when classified
  burn_review_reason TEXT,             -- reason code when burn classification needs review
  flow_type TEXT DEFAULT 'standard',   -- "standard", "bridge_transfer", or "atomic_roundtrip"
  counterparty TEXT,                   -- Address that received/sent tokens
  tx_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,          -- Unix seconds
  explorer_tx_url TEXT NOT NULL
);

CREATE INDEX idx_mbe2_ts ON mint_burn_events(timestamp DESC);
CREATE INDEX idx_mbe2_coin ON mint_burn_events(stablecoin_id, timestamp DESC);
CREATE INDEX idx_mbe2_chain ON mint_burn_events(chain_id, timestamp DESC);
CREATE INDEX idx_mbe2_burn_type ON mint_burn_events(burn_type, timestamp DESC);
CREATE INDEX idx_mbe_coin_chain_ts ON mint_burn_events(stablecoin_id, chain_id, timestamp DESC);
CREATE INDEX idx_mbe_symbol_ts ON mint_burn_events(symbol, timestamp DESC);
CREATE INDEX idx_mbe_null_price_ts ON mint_burn_events(timestamp DESC) WHERE amount_usd IS NULL;

-- migration 0178: bounded historical debt selection and aggregate-resume state
CREATE INDEX idx_mbe_historical_price_repair_backlog
  ON mint_burn_events(price_repair_status, price_repair_attempted_at ASC, timestamp ASC, id ASC)
  WHERE amount_usd IS NULL OR price_repair_status = 'pending_aggregate';

-- migration 0097: composite index to speed roundtrip sweep and future flow_type-filtered queries
CREATE INDEX idx_mbe_flow_type_ts ON mint_burn_events(flow_type, timestamp DESC);
```

### mint_burn_hourly (baseline `0000_baseline.sql`)

Pre-aggregated hourly flow buckets. Written by cron after each scan; also recalculated by the backfill admin endpoint.

```sql
CREATE TABLE mint_burn_hourly (
  stablecoin_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  hour_ts INTEGER NOT NULL,            -- Unix seconds, truncated to hour: (timestamp / 3600) * 3600
  mint_count INTEGER NOT NULL DEFAULT 0,
  burn_count INTEGER NOT NULL DEFAULT 0,
  mint_volume_usd REAL NOT NULL DEFAULT 0,
  burn_volume_usd REAL NOT NULL DEFAULT 0,
  net_flow_usd REAL NOT NULL DEFAULT 0, -- mint_volume - burn_volume (positive = net mint)
  PRIMARY KEY (stablecoin_id, chain_id, hour_ts)
);

CREATE INDEX idx_mbh_ts ON mint_burn_hourly(hour_ts DESC);
CREATE INDEX idx_mbh_coin ON mint_burn_hourly(stablecoin_id, hour_ts DESC);
```

### mint_burn_sync_state (baseline `0000_baseline.sql`)

Incremental block tracking (same pattern as `blacklist_sync_state`).

```sql
CREATE TABLE mint_burn_sync_state (
  config_key TEXT PRIMARY KEY,         -- "{chainId}-{contractAddress}"
  last_block INTEGER NOT NULL DEFAULT 0
);
```

### mint_burn_config_deferral (migration 0096)

Per-config deferral log. Configs that exit a run with `apiErrors > 5` AND `coverage < 0.8` are inserted here with `deferred_until = now + 3600s`. The next cron run skips any config whose `deferred_until` is still in the future, so chronically failing configs cannot starve healthy ones of subrequest budget.

```sql
CREATE TABLE mint_burn_config_deferral (
  config_key TEXT PRIMARY KEY,
  deferred_until INTEGER NOT NULL,
  reason TEXT NOT NULL,
  api_errors INTEGER NOT NULL DEFAULT 0,
  coverage REAL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_mbcd_until ON mint_burn_config_deferral(deferred_until);
```

**Migration history:** The earlier per-step mint/burn migrations were squashed into the baseline; the `mint_burn_events`, `mint_burn_hourly`, and `mint_burn_sync_state` tables (v2 layout) now live in `0000_baseline.sql`. Migration 0096 adds `mint_burn_config_deferral`; migration 0097 adds the `(flow_type, timestamp)` composite index on `mint_burn_events`; migration 0159 purges Re Protocol reUSD rows and resets the old vault plus canonical token cursors so the canonical `Transfer` source rebuilds history without stale vault rows.

---

## API Endpoints

### GET /api/mint-burn-flows

Two modes depending on whether `stablecoin` is provided.

**Aggregate mode** (no `stablecoin` param):

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | int | 24 | Time window, 1–720 (up to 30 days) |

Returns:

- `gauge` — composite Bank Run Gauge: `{ score, band, flightToQuality, flightIntensity, trackedCoins, trackedMcapUsd }`
- `coins[]` — per-coin summaries: fixed 24h raw net flow, canonical `pressureShiftScore`, derived interpretation fields, baseline context, coverage metadata, and largest USD-valued event
- `hourly[]` — aggregate hourly timeseries: `{ hourTs, netFlowUsd, mintVolumeUsd, burnVolumeUsd }`
- `updatedAt` — Unix seconds of latest hourly bucket
- `windowHours` — requested chart window for `hourly[]`
- `scope` — current ingestion scope (for example `Configured issuance chains`, or `Arbitrum-only` on per-coin USDai views)
- `sync` — latest critical-lane freshness and warning state

**Per-coin mode** (`stablecoin` param provided):

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stablecoin` | string | — | Stablecoin ID (required) |
| `hours` | int | 24 | Time window, 1–720 |

Returns:

- `stablecoinId`, `symbol`
- `mintVolumeUsd`, `burnVolumeUsd`, `netFlowUsd`, `mintCount`, `burnCount`
- `chains[]` — per-chain breakdown
- `hourly[]` — hourly timeseries
- `updatedAt`
- `windowHours`, `scope`, `sync`

Returns 404 if the stablecoin ID is not in the tracked set.

Contract note: aggregate `hours` only changes `hourly[]`. Coin-level `netFlow24hUsd`, mint/burn 24h volumes, counts, and pressure state remain fixed to the canonical 24-hour window.

**Cache:** `CACHE_PROFILES.standard` (~30-minute freshness keyed to successful critical-lane syncs)

### GET /api/mint-burn-events

Paginated event feed for a single stablecoin.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stablecoin` | string | — | Stablecoin ID (required) |
| `direction` | string | — | Filter: `"mint"` or `"burn"` |
| `chain` | string | — | Filter by chain ID within the stablecoin's tracked issuance scope (for example `ethereum` for most coins, `arbitrum` for USDai) |
| `burnType` | string | — | Burn-only filter: `"effective_burn"`, `"bridge_burn"`, or `"review_required"` |
| `scope` | string | `"all"` | `"all"` returns the classified raw event stream; `"counted"` returns only rows that contribute to economic-flow aggregates (`flow_type='standard'` and mint/effective-burn semantics) |
| `minAmount` | number | — | Minimum USD amount; rows with `amount_usd IS NULL` are excluded when this filter is used |
| `limit` | int | 50 | Page size, 1–500 |
| `offset` | int | 0 | Pagination offset |

Returns: `{ events[], total }`. Events sorted by `timestamp DESC`.

Each event row includes valuation provenance fields (`priceUsed`, `priceTimestamp`, `priceSource`), `flowType`, plus burn classification fields (`burnType`, `burnReviewReason`).

Product note: stablecoin detail-page "Mint & Burn Flow History" uses the counted view so bridge transfers, review-required burns, and atomic roundtrips do not appear as ordinary economic flow.

**Cache:** `CACHE_PROFILES.producerBacked` (~5-min CDN edge freshness with a 5-min stale-while-revalidate window)

### POST /api/backfill-mint-burn-prices (admin)

Repairs historical `amount_usd IS NULL` debt. Requires Access service-token headers on `ops-api.pharos.watch`. The route is bounded to `1..500` rows (`limit=100` by default) and defaults to dry-run even though it is a `POST` action.

Note: cron now auto-heals recent NULL-price events (48h lookback). This endpoint remains the operator tool for broader historical backfills.

1. Selects the oldest bounded batch of unclassified NULL-USD events, optionally scoped with `stablecoin=<id>`.
2. Prefers an exact UTC event-day `supply_history` price. If absent, it fetches a bounded event-day CoinGecko market-chart range, then DefiLlama CoinGecko-identity and exact contract-chart ranges. DefiLlama ranges are fetched sequentially in at most eight 800-day windows per identity and merged before exact-day resolution; a larger range or any unavailable window remains retryable instead of being misclassified as definitive absence. Each accepted price records its source and source timestamp.
3. It never uses the current `price_cache` or another day's price for historical repair. A definitive search with no valid event-day point becomes `price_repair_status = "irreducible"`; transient provider failures remain unclassified and retryable with a diagnostic reason.
4. Recovered rows first enter `pending_aggregate`. The operator rebuilds all hourly buckets for each affected coin, verifies every bucket against `mint_burn_events`, and only then marks the rows `recovered`. A failed/interrupted rebuild resumes before new valuation work on the next call.
5. The response includes the remaining unclassified, irreducible, pending-aggregate, and total NULL-USD counts, so closure means `unclassified = 0` and `pendingAggregate = 0` rather than pretending irreducible rows were valued.

Preview one batch:

```text
POST /api/backfill-mint-burn-prices?dry-run=true&limit=100
```

After taking a D1 Time Travel bookmark and reviewing the preview, execute the identical scope with an idempotency key of 1 to 128 trimmed characters:

```text
POST /api/backfill-mint-burn-prices?dry-run=false&confirm=historical-mint-prices&bookmark=<fresh-d1-bookmark>&limit=100
```

`retry-irreducible=true` explicitly reopens terminal classifications when a new historical source becomes available. Do not use it as the normal drain mode.

Returns: `{ dryRun, limit, selected, recovered, classifiedIrreducible, deferredForRetry, aggregateCoinsRebuilt, aggregateVerificationPassed, dispositions, backlog }`.

### POST /api/backfill-mint-burn (admin)

Controlled ingestion backfill by explicit config/range/chunk, or by automatic config selection when `configKey` is omitted.

- Auth: Access service-token headers
- Idempotency: `Idempotency-Key` supported via admin idempotency middleware
- Parameters: `configKey`, `fromBlock`, `toBlock`, `chunkSize`, `maxChunks`
- Behavior:
  - If `configKey` is omitted, the worker auto-selects one tracked config using a critical-first / major-symbol-first / most-behind ordering and returns `selectionMode="auto"` plus the chosen `configKey`.
  - Uses the same shared parse/classification/context/persistence helpers as cron ingestion.
  - Advances `mint_burn_sync_state` with monotonic max semantics (never regresses on partial backfills).
  - Returns `done=false` with `nextFromBlock` when additional calls are needed.
- Response includes a `reclassified` object exposing reclassification deltas for observability:
  - `reclassified.flowTypeChanges` — rows where `flow_type` flipped during this call (e.g. `standard → bridge_transfer` once the classifier saw a previously-unknown bridge signal).
  - `reclassified.burnTypeChanges` — rows where `burn_type` flipped (e.g. `review_required → bridge_burn`).
  - `rowsReclassified` — legacy scalar retained for backward compatibility; the exact count of unique rows whose classification columns were rewritten during this chunk. Prefer the nested `reclassified.*` fields for per-column accounting.

### POST /api/reclassify-atomic-roundtrips (admin)

Retroactive cleanup endpoint for historical rows that predate shared roundtrip detection, were ingested before both sides of a transaction were visible to the detector, or were tagged atomic before the 0.5% amount-tolerance rule shipped.

- Auth: Access service-token headers
- Idempotency: `Idempotency-Key` supported via admin idempotency middleware
- Parameters: `since` (unix seconds; default `now - 90 days` via `DEFAULT_SINCE_LOOKBACK_SEC`; pass `since=0` to sweep the whole table at D1 CPU-budget risk), `stablecoinId` (optional; narrows both passes to one coin's rows).
- Behavior:
  - **Forward pass** — scans up to `1000` `(tx_hash, stablecoin_id, chain_id)` groups per call where `flow_type='standard'` but both mint and burn directions exist, and flips all matching rows in each group to `flow_type='atomic_roundtrip'`.
  - **Reverse pass (new).** Scans up to `1000` groups currently tagged `flow_type='atomic_roundtrip'` that fail the 0.5% tolerance (`|mint_amt - burn_amt| > 0.005 × max(mint_amt, burn_amt)`) and flips them back to `flow_type='standard'`. The SQL mirrors `ROUNDTRIP_AMOUNT_TOLERANCE` in `worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts`.
  - Recalculates the affected hourly buckets so downstream flow aggregates pick up both directions of reclassification immediately.
  - Returns `done=true` only when BOTH forward and reverse passes returned fewer than `BATCH_SIZE` groups.
- Response fields:
  - `since` — echoed effective lookback cutoff (unix seconds).
  - `stablecoinId` — echoed coin filter, or null.
  - `toRoundtrip` — forward-pass count (`standard → atomic_roundtrip`).
  - `toStandard` — reverse-pass count (`atomic_roundtrip → standard`).
  - `updated` — legacy scalar kept for backward compat: `toRoundtrip + toStandard`.
  - `hoursRecalculated` — number of distinct `(stablecoinId, chainId, hourTs)` buckets re-aggregated.
  - `batchSize`, `done`.

---

## Cron Metadata Fields

`syncMintBurn(...)` stores a JSON `metadata` blob on every run row in `cron_runs`. Operators consume it via `/api/status` and the merge-gate metadata checks. Current notable fields:

| Field | Type | Meaning |
|-------|------|---------|
| `lane` | `"critical" \| "extended"` | Which lane produced this run |
| `jobName` | string | Lane-specific run-state job key |
| `rowsRead`, `rowsParsed`, `rowsInserted`, `rowsIgnored`, `rowsDropped` | number | Ingestion throughput counters |
| `sourceCoverage` | object | `contractsProcessed`, `contractsSkipped`, `contractsEnabled`, `contractsDisabled`, `contractsTotal` |
| `configBreakdown[]`, `laggingConfigs[]` | arrays | Per-config diagnostics |
| `apiErrors`, `fallbackMode`, `validationFailures` | mixed | Provider-error observability |
| `atomicRoundtripsDetected` | number | Rows tagged in-memory this run |
| `bridgeClassification.txContextShortfalls` | number | Transaction/receipt context lookup shortfalls for bridge-enabled configs |
| `bridgeClassification.deferredRows` | number | Parsed rows excluded from economic flow because bridge classification context was unavailable |
| `nullPricesHealed` | number | Rows auto-valued from `price_cache` this run (48h window) |
| `degradedSignal`, `degradedStreak`, `coverageRatio` | mixed | Critical-lane health signals |
| `recalcFailed` | boolean | `true` when `recalcAffectedHours` threw during the run's `finally` block; critical lane downgrades `ok → degraded` when this is set |
| `recalcError` | string (optional) | Error message captured from the failed recalc call |
| `nullPriceBacklogRecent` | number | Count of `amount_usd IS NULL` rows inside the 48h auto-heal window still awaiting price resolution |
| `nullPriceBacklogHistorical` | number | Count of `amount_usd IS NULL` rows older than the auto-heal window (debt that `backfill-mint-burn-prices` must address) |
| `roundtripsBacklogSaturated` | boolean | `true` when the cross-run roundtrip sweep hit its per-run limit and more candidate groups likely remain in the 7-day lookback window |
| `budgetUsed` | number | Alchemy subrequests consumed by this run (emitted via `withBudgetMetadata`) |
| `budgetLimit` | number | Global subrequest budget for the run (default 200) |

---

## Frontend

### Page

**Route:** `/flows`
**File:** `src/app/flows/page.tsx`

Three sections:
1. **Hero Overview** — net-direction hero with the baseline-relative Bank Run Gauge, a literal 24h Minting Pressure gauge, and flight-to-quality badge. Headline copy is derived from aggregate `Net Flow 24h` direction plus the Bank Run Gauge pressure state; it does not imply cross-asset breadth unless a separate breadth signal is added.
2. **Per-Coin Flows** — sortable table with `Pressure vs 30D`, net 24h/7d, mint/burn volumes, and largest USD-valued event
3. **Aggregate Flows** — Recharts composed chart (mint area, burn area, net flow line) with 24h/7d/30d toggle

### Hooks

**File:** `src/hooks/use-mint-burn-flows.ts`

| Hook | Endpoint | Stale Time | Notes |
|------|----------|-----------|-------|
| `useMintBurnFlows(hours?)` | `/api/mint-burn-flows` | `CRON_MINT_BURN` | Aggregate mode, no coin filter |
| `useMintBurnFlowsCoin(id, hours?)` | `/api/mint-burn-flows?stablecoin=` | `CRON_MINT_BURN` | Per-coin mode, enabled only when ID truthy |
| `useMintBurnEvents(id, opts?)` | `/api/mint-burn-events?stablecoin=` | `CRON_MINT_BURN` | Paginated event feed |

All hooks use Zod schema validation for aggregate and per-coin responses (`MintBurnFlowsResponseSchema`, `MintBurnPerCoinResponseSchema`).

### Components

| Component | File | Description |
|-----------|------|-------------|
| `FlowBrrrOverview` | `src/components/flow-brrr-overview.tsx` | Overview shell used by `/flows`; renders the printer/shredder scene, Bank Run Gauge band, literal 24h minting-pressure gauge, and a `FlowReceiptBand` below a dashed tear-line carrying the 24h/7d mint/burn/net receipt tiles plus scope, top minter/burner, and coverage summary. |
| `FlowReceiptBand` | `src/components/flow-receipt-band.tsx` | Receipt-styled sub-component rendered inside `FlowBrrrOverview`. Shows 24h/7d printed/shredded/net tiles, with the full `/flows` mode including scope caveat, top minter/burner, coverage pills, and any sync warning. |
| `FlowChart` | `src/components/flow-chart.tsx` | Recharts composed chart: mint (green area), burn (red area), net flow (blue line), hourly tooltip |
| `FlowTable` | `src/components/flow-table.tsx` | Sortable per-coin table. Sort keys: net24h, mint24h, burn24h, net7d, net30d, net90d, largest USD-valued event, pressure (net30d/net90d columns hidden below lg/xl). Responsive column hiding; `Pressure vs 30D` header uses the shared methodology-hint trigger |
| `FlowEventFeed` | `src/components/flow-event-feed.tsx` | Paginated event table: time, direction badge, amount USD, chain, tx link |
| `MintingPressureGauge` | `src/components/minting-pressure-gauge.tsx` | Shared literal 24h mint-vs-burn gauge used by both the aggregate overview and stablecoin detail summary cards |
| `FlowSummaryCard` | `src/components/flow-summary-card.tsx` | Summary card for stablecoin detail pages: explicit `Net 24h`, `Pressure Shift vs 30D`, and a literal `Minting Pressure (24h)` gauge, plus contextual methodology hints / footer links for the flow model |

### Dashboard Integration

`FlowSummaryCard` (`src/components/flow-summary-card.tsx`) now keys machine visuals from raw `netFlow24hUsd` and also renders the same literal `Minting Pressure (24h)` gauge used in the aggregate overview, while Bank Run Gauge band labels remain available for baseline-relative pressure semantics.

---

## Error Handling & Edge Cases

| Condition | Behavior |
|-----------|----------|
| Price unavailable at sync time | `amount_usd` stored as NULL initially; cron auto-heals recent rows (48h window) and admin endpoint handles older history |
| Fewer than 7 days of flow history | Pressure shift returns `null`; coin excluded from gauge weighting |
| No 24h mint/burn activity in a sparse window | Pressure shift returns `null` (NR) for that window; coin excluded from gauge weighting |
| All coins have null pressure shift | Gauge score returns `null`; frontend shows "Calibrating" state |
| Alchemy API error for a config | `apiErrors` incremented; sync state NOT advanced (retried next cycle) |
| Incomplete timestamp resolution | `configError = true`; sync state not advanced, retried next cycle |
| Subrequest budget exhausted | Remaining configs skipped; picked up in next cron cycle |
| Block explorer indexing lag | 75-block safety margin prevents advancing past un-indexed blocks |
| Duplicate events | `INSERT OR IGNORE` on deterministic `id` key prevents duplicates |
| Unknown stablecoin ID in per-coin API | Returns 404 with descriptive error |
| Missing `stablecoin` param in events API | Returns 400 |
| Partial-coverage cron run | Hourly aggregation rebuilds from all DB events for affected hours; buckets may be temporarily incomplete for configs still catching up |

### Circuit Breaker Separation

Blacklist and mint/burn have independent circuit breakers:

- **`CIRCUIT_SOURCE.ETHERSCAN`** — used by `sync-blacklist` (Etherscan REST API)
- **`CIRCUIT_SOURCE.ALCHEMY`** — used by `sync-mint-burn` (Alchemy JSON-RPC)

An Alchemy outage does not block blacklist sync, and vice versa. Each circuit breaker opens after consecutive failures and probes independently.

---

## Testing

**Files:**
- `worker/src/lib/__tests__/mint-burn-scoring.test.ts` — pressure-shift formula, gauge bands, composite gauge, flight-to-quality
- `worker/src/lib/__tests__/mint-burn-pipeline.test.ts` — shared parse/classification/persistence/sync-state behavior parity
- `worker/src/cron/__tests__/sync-mint-burn.test.ts` — cron ingestion orchestration and degraded-mode handling
- `worker/src/api/__tests__/backfill-mint-burn.test.ts` — admin backfill chunking, `done/nextFromBlock`, and sync-state progression
- `worker/src/api/__tests__/mint-burn-flows.test.ts` — API response shape validation plus burning/improving regression coverage
- `shared/lib/__tests__/mint-burn-signals.test.ts` — shared direction/pressure/composite interpretation coverage

**Coverage:**
- Pressure shift: null for < 7 days, neutral at baseline, clamping at 0/100, floor denominator
- Gauge bands: correct band for all score ranges
- Composite gauge: mcap-weighted average, skips null, returns null when all null
- Flight-to-quality: $100M activation, intensity formula, edge cases
- Pipeline convergence: inserted-vs-ignored accounting, bridge/effective/review burn counters, affected-hour recomputation, sync-state mode semantics
- Backfill chunking: `done=false` and `nextFromBlock` emitted when `maxChunks` stops before target range
- API: aggregate vs per-coin response shapes against Zod schemas, 404 for unknown coin
- Coverage/freshness: aggregate `hours` leaves 24h coin fields unchanged, current UTC day excluded from baseline, deterministic largest-event selection on ties, and `amount_usd IS NULL` rows excluded from the USD largest-event column

---

## Future Work

Current production scope already spans configured issuance chains. Planned next expansions:

- **Additional EVM chains:** add more native issuance configs + chain-specific scan policies after reliability gates are met
- **Tron support:** USDT Issue/Redeem topic groundwork exists; ingestion path is not wired yet
- **Curve Finance detection:** DEX-level flow tracking

---

## File Index

| File | Role |
|------|------|
| `worker/src/cron/sync-mint-burn.ts` | Cron job: critical + extended incremental event sync lanes, hourly aggregation, lane-specific run-state |
| `worker/src/lib/mint-burn-pipeline/types.ts` | Shared ingestion types for cron/backfill |
| `worker/src/lib/mint-burn-pipeline/parse.ts` | Shared log parsing and price resolution |
| `worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts` | Shared same-transaction roundtrip tagging |
| `worker/src/lib/mint-burn-pipeline/classification.ts` | Shared bridge-burn classification |
| `worker/src/lib/mint-burn-pipeline/context.ts` | Shared current/historical price context loaders |
| `worker/src/lib/mint-burn-pipeline/persistence.ts` | Shared event write + hourly recompute helpers |
| `worker/src/lib/mint-burn-pipeline/price-heal.ts` | Shared NULL-price auto-heal helper |
| `worker/src/lib/mint-burn-historical-price-repair.ts` | Bounded event-day historical repair, terminal classification, aggregate resume, and verification |
| `worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts` | Post-cron sweep for cross-run atomic roundtrip detection |
| `worker/src/lib/mint-burn-pipeline/sync-state.ts` | Shared sync-state read/init/upsert helpers |
| `worker/src/lib/mint-burn-contracts.ts` | Mint/burn event configs resolved from shared stablecoin contracts (no explicit address overrides; both reUSD configs track canonical zero-address Transfers) |
| `worker/src/lib/mint-burn-scoring.ts` | Pure scoring functions: pressure shift (FIS), gauge, flight-to-quality |
| `worker/src/api/mint-burn-flows.ts` | API handler: route-level aggregate + per-coin orchestration |
| `worker/src/api/mint-burn-flows-shared.ts` | Shared mint/burn cache fallback, cron snapshot, baseline, and coverage helpers |
| `worker/src/api/mint-burn-events.ts` | API handler: paginated event feed |
| `worker/src/api/backfill-mint-burn.ts` | Admin endpoint: controlled event ingestion backfill |
| `worker/src/api/backfill-mint-burn-prices.ts` | Admin endpoint: backfill NULL amount_usd values |
| `worker/src/api/reclassify-atomic-roundtrips.ts` | Admin endpoint: retroactively tag same-tx mint/burn rows as atomic roundtrips |
| `worker/migrations/0000_baseline.sql` | Baseline mint/burn schema (3 tables, including the historical v2 layout) |
| `worker/migrations/0178_historical_data_debt_closure.sql` | Historical repair state plus reviewed BRLA DDR repair provenance |
| `src/hooks/use-mint-burn-flows.ts` | TanStack Query hooks (3 hooks) |
| `src/app/flows/page.tsx` | Frontend page and metadata |
| `worker/src/lib/mint-burn-scoring.ts` | Pure Flow Intensity / Bank Run Gauge / flight-to-quality logic (`getGaugeBand`, `computeGaugeScore`, `detectFlightToQuality`) |
| `src/components/flow-brrr-overview.tsx` | Bank Run Gauge overview shell for `/flows` |
| `src/components/flow-chart.tsx` | Recharts flow chart |
| `src/components/flow-table.tsx` | Sortable per-coin table |
| `src/components/flow-event-feed.tsx` | Paginated event table |
| `src/components/minting-pressure-gauge.tsx` | Shared literal 24h mint-vs-burn gauge |
| `src/components/flow-summary-card.tsx` | Summary card for detail pages |
| `shared/lib/mint-burn-signals.ts` | Shared net-direction + pressure-state interpretation helpers |
| `shared/types/index.ts` | TypeScript types + Zod schemas |
| `worker/src/lib/__tests__/mint-burn-scoring.test.ts` | Scoring unit tests |
| `worker/src/lib/__tests__/mint-burn-pipeline.test.ts` | Shared ingestion pipeline tests |
| `worker/src/cron/__tests__/sync-mint-burn.test.ts` | Cron ingestion tests |
| `worker/src/api/__tests__/backfill-mint-burn.test.ts` | Backfill ingestion tests |
| `worker/src/api/__tests__/mint-burn-flows.test.ts` | API contract tests |
