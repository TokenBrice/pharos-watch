# Mint/Burn Flow Tracker

> **Agent navigation** — Grep the heading you need instead of reading wholesale: Methodology Versioning · Cron Schedule · Constants & Thresholds · Contract Configurations · Raw Token Conservation · Sync Algorithm · Shared Ingestion Pipeline Boundaries · Scoring · Valuation Completeness · Retention · Database Schema · API Endpoints · Cron Metadata Fields · Frontend · Error Handling & Edge Cases · Testing · Future Work.

On-chain mint and burn event tracker for stablecoins on their **configured issuance chains** via Alchemy JSON-RPC. Detects Transfer events (and USDT-specific Issue/Redeem events), aggregates them into hourly flow buckets, exposes per-coin raw `Net Flow` plus baseline-relative `Pressure Shift vs 30D`, computes a market-cap-weighted Bank Run Gauge, and flags flight-to-quality signals. Live ingestion runs in two lanes: a critical 30-minute lane for major coverage and an offset extended 30-minute lane for long-tail backlog drain.

Product scope note: the public `/flows` page now surfaces the configured issuance scope plus per-coin `coverage` metadata so partial history, lagging sync, or unknown current chain-head states are visible to users instead of implied as complete market-wide coverage. Current production scope is Ethereum for most tracked assets, with USDai tracked on native Arbitrum and Base Dollar tracked on native Base as their canonical issuance/redemption chains.

BUIDL Ethereum coverage includes both registered share-class contracts, `0x7712c34205737192402172409a8f7ccef8aa2aec` and `0x6a9da2d710bb9b700acde7cb81f10f1ff8c89041`. DefiLlama's [reviewed issuance configuration](https://github.com/DefiLlama/peggedassets-server/blob/074324b7775b0f18540e28b087fc281bf05d2b17/src/peggedData/peggedData.ts#L5159) sums both tokens in Ethereum supply. Both use six decimals, zero-address Transfer events, and the existing 21,900,000 default coverage floor; this floor is not a verified deployment block. The added contract requires its own bootstrap/backfill and a new extended-lane production execution before coverage can be accepted as current.

The `/flows` page also renders a Flow Receipt directly under the printer/shredder overview. The receipt uses the existing 24-hour coin rows and 7-day hourly buckets to show printed, shredded, and net tracked flow totals, the top 24-hour minter and burner, and the current coverage/lag state. Its labels deliberately describe observed configured-chain events; they do not claim complete market-wide supply creation or redemption.

Operational freshness configuration is shared via `worker/src/lib/mint-burn-health-config.ts`:
- major-symbol baseline (`USDT`, `USDC`, `DAI`, `USDS`, `GHO`, `FRXUSD`, `BOLD`, `reUSD`)
- warning threshold (`6h`)
- critical threshold (`24h`)

Scheduled/http handlers apply env overrides on top of these defaults (`worker/src/handlers/scheduled.ts`, `worker/src/handlers/http/request-dispatch.ts`). Public `/api/health` now keys mint/burn freshness to the critical-lane sync timestamp / run status (the same semantics exposed by `/api/mint-burn-flows`) so quiet majors do not falsely mark the health surface stale just because no new events occurred.

Public `/api/mint-burn-flows` freshness metadata and the `/flows` page intentionally allow one missed 30-minute critical-lane slot before warning. User-facing freshness is `fresh <= 60m`, `degraded <= 90m`, `stale > 90m`, which keeps the public warning surface aligned with `/status` cron-health grace windows instead of flagging a single late slot as an incident.

Fresh and cached flow responses without a sync timestamp retain their body sync warnings and return `Cache-Control: no-store`, `X-Data-Age: unavailable`, and HTTP `Warning: 199`. Neither response-generation time nor cache-write time substitutes for the missing sync clock.

> **Agent navigation** — Grep the heading you need: Methodology Versioning · Cron Schedule · Constants & Thresholds · Contract Configurations · Sync Algorithm · Shared Ingestion Pipeline Boundaries · Scoring · Retention · Database Schema · API Endpoints · Cron Metadata Fields · Frontend · Error Handling & Edge Cases · Testing · Future Work.

Mint and burn events measure token creation and destruction, not investor intent. USDai is the reviewed counterexample: a burn can release PYUSD from the hub for sUSDai loan deployment without an equivalent fall in protocol assets. Since methodology v6.21, individually reviewed events of this kind are tagged `flow_type='protocol_internal'` and leave counted flow; see [Reviewed protocol-internal events](#reviewed-protocol-internal-events). The public FAQ and USDai's curated chart annotation keep the measured burn visible without calling it a redemption or investor outflow.

---

## Methodology Versioning

- **Current methodology version:** <!-- GENERATED-START: methodology-version-mint-burn-flow -->`v6.24`<!-- GENERATED-END: methodology-version-mint-burn-flow -->
- **Public changelog page:** `/methodology/mint-burn-flow-changelog/`
- **Structured changelog:** `shared/data/methodology-changelogs/mint-burn-flow/`

The v6.24 release aligns aggregate and per-coin windows to N closed UTC hours ending at the current hour boundary, excluding the open hour without dropping the oldest hour's valuation debt. Verified CCTP V2 destination recipient/fee mints leave issuance while unrelated same-transaction flow stays counted. Actual observation-clock admission governs historical pricing, and whole-hour retention plus post-materialization cursor advancement preserves all siblings needed for repair. Pressure formulas and gauge weights are unchanged; existing pruned evidence and overadvanced historical cursors are not automatically repaired.

Earlier release history lives in `shared/data/methodology-changelogs/mint-burn-flow/`; keep this document focused on the current contract.

---

## Cron Schedule

- **Critical lane pattern:** logical `4,34 * * * *`, deployed as hourly physical aliases `4 * * * *` and `34 * * * *` (every 30 minutes, offset at :04/:34)
- **Extended lane pattern:** logical `18,48 * * * *`, deployed as hourly physical aliases `18 * * * *` and `48 * * * *` (every 30 minutes, offset at :18/:48 — placed ahead of the fenced V9 publication slot at :22/:52 to keep the minute-long extended scan clear of the DEX/V9 publication chain). The aliases preserve cadence and slot identity while qualifying each invocation for Cloudflare's hourly Cron CPU class; the combined expression was retired after same-version production runs repeatedly exhausted the sub-hourly 30-second class and were reconciled as `platform-abandoned`.
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
| `dustThreshold` | 10,000 default (token-native); lower per-config overrides where unit economics require them (e.g. 10 for precious-metal tokens, 100 for BD) — the registry is authoritative | Events below this amount are discarded |
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

Token identity resolves from the canonical checked-in per-coin metadata under `shared/data/stablecoins/coins/*.json`. The validated full aggregate generates `coins.worker-runtime.generated.json`, a narrow identity/lifecycle/contract projection used by mint/burn so the extended scheduled lane does not initialize the evidence-rich full registry inside its 128 MB isolate. `npm run check:runtime-reachability` bundles the extended scheduled entrypoint (and, since 2026-09-02, the five-minute Telegram entrypoint, which shares the projection) and rejects any runtime path back to the full registry. The mint/burn config file only keeps tracker-specific fields such as event signatures, `startBlock`, `dustThreshold`, tiering, and bridge-detection hints. There are no explicit address overrides; both `reUSD` configs (`reusd-re-protocol` and `reusd-resupply`) resolve the registered token contract and track its canonical zero-address `Transfer` events.

### Registry ownership

Current scope, decimals, contract identity, ingestion tier, start block, and event-decoder configuration are owned by
the complete `MINT_BURN_CONFIGS` registry in `worker/src/lib/mint-burn-contracts.ts`. Do not copy that changing roster
into this document. The registry distinguishes `critical` and `extended` ingestion tiers; those tiers are operational
scheduling choices, not safe/risky classifications. USDT is the notable custom-event example: it tracks only the
contract's Issue/Redeem events (adapter kind `custom-events`) because `issue()`/`redeem()` emit no zero-address
`Transfer` logs. Other special decoding and bridge rules remain source-owned.

DEWS and digest aggregation default configured coins to Ethereum and keep non-Ethereum canonical-chain overrides in
`worker/src/lib/mint-burn-canonical-chain.ts`; current overrides route USDai to Arbitrum and Base Dollar to Base. A
registry-iterating test requires every coin configured only outside Ethereum to have an override or a documented
exception, while coins with an Ethereum contract retain the Ethereum default. This keeps the hot path lightweight
without letting the side map drift silently from `MINT_BURN_CONFIG_SPECS`.

Public `/api/mint-burn-flows` and the daily digest collector use the same canonical V9 flight-to-quality classification. `B-` or better is `safe`; `C+`, `C`, and `C-` are neutral; grades below `C-` are `risky`. Classification requires a complete current `safety-score-v9-publication` identity and becomes unavailable when the accepted publication is missing, held, stale, malformed, or identity-mismatched instead of falling back to a hardcoded safe-haven list.

Per-config adapter provenance is now surfaced through coin `coverage` metadata:
- `adapterKinds` — active decoding families for the coin (`transfer-zero-address`, `custom-events`, `mixed`)
- `startBlockSource` — whether the earliest tracked block is a reviewed contract-specific bound or a blanket default coverage floor
- `startBlockConfidence` — qualitative confidence on historical completeness (`high`, `medium`, `low`)
- `status` — `full`, `partial-history`, `lagging`, `bootstrapping`, `unknown`, or `disabled`; `unknown` means the current chain head is unavailable, so Pharos cannot certify present sync lag

Window maturity accepts either the oldest retained hourly event or the shortest successfully scanned block span across that coin's configured chains, converted with the same conservative chain block-time assumptions used for lag classification. This lets completed scans prove the zero-activity intervals between sparse events and keeps retention from regressing a fully observed quiet asset to `bootstrapping`: less than 24 hours of evidence remains `bootstrapping`, 24 hours through 30 days is `partial-history`, and at least 30 days is `full` when current lag/head checks also pass. `historyStartAt` remains the timestamp of real retained event evidence and can therefore be recent or `null` while the window booleans are proven by older scan progress.

Current rule: the March 24 long-tail transfer wave that inherited the blanket `21_900_000` Ethereum floor is labeled `startBlockSource = default-coverage-floor-2026-03-24` and `startBlockConfidence = low`, so the public API no longer implies contract-specific historical certainty where none exists.

Events are also classified by `flow_type` (`standard`, `bridge_transfer`, `atomic_roundtrip`, or `protocol_internal`) so non-economic bridge transfers, same-tx roundtrip noise, and reviewed issuer-internal movements stay out of aggregate flow metrics.

### Open USD coverage review (2026-09-30)

Open USD (`ousd-open-standard`, issued by Bridge) is distinct from Origin Dollar (`ousd-origin-protocol`). The [issuer's reserve page](https://reserves.bridge.xyz/ousd) binds its Ethereum, Base, Tempo and Solana deployments. The extended lane indexes Ethereum and Base with six decimals, canonical zero-address `Transfer` events and a 10,000-token dust threshold ($10,000 at peg). Both use explicit primary-contract configs and reviewed code-deployment bounds, rather than the default Ethereum coverage floor. Small test mints/burns are deliberately below the economic-flow cutoff.

Archive reads from `https://eth-mainnet.g.alchemy.com/v2/` and `https://base-mainnet.g.alchemy.com/v2/`, authenticated with `ALCHEMY_API_KEY`, established code absence at `startBlock - 1` and presence at `startBlock` on 2026-09-30 at 16:26 UTC. Ethereum starts at block **25,137,271** (2026-05-20); Base starts at **48,631,941** (2026-07-14). These are high-confidence deployment bounds, not claims that issuance began at deployment. The first Ethereum mint in the initial 50,000-block window was block 25,153,426, transaction `0x9ad6f66779dd7d07db46ed4fab8132cc3ed91e1b724ab8fb32fa93a6e4f55a7f`; no Base mint appeared in its initial window.

The following actual log samples were read at 16:28 UTC. All have topic0 `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`, three topics and a single data-word amount. Mint uses zero `topics[1]`; burn uses zero `topics[2]`. Custom issuer events are not additionally counted.

| Chain | Direction | Block | Transaction | Raw amount (6 decimals) |
| --- | --- | --- | --- | --- |
| Ethereum | Mint | 25,999,541 | [0x30bd12db49f8452a8f200193b01141c10639980d2a07a4e13f718a12b2bc510d](https://etherscan.io/tx/0x30bd12db49f8452a8f200193b01141c10639980d2a07a4e13f718a12b2bc510d) | 10,000,000 |
| Ethereum | Burn | 26,042,405 | [0xe12e0ac6bc884084a7a9035d5baab554f8308b486f8d794c00ec5ebb9dbfb038](https://etherscan.io/tx/0xe12e0ac6bc884084a7a9035d5baab554f8308b486f8d794c00ec5ebb9dbfb038) | 10,000,000 |
| Base | Mint | 51,904,411 | [0x67ab7ed88340ff982cc5ac9012293cbf5f9da10143fc91842243b338eb28ccee](https://basescan.org/tx/0x67ab7ed88340ff982cc5ac9012293cbf5f9da10143fc91842243b338eb28ccee) | 100,000,000 |
| Base | Burn | 51,921,642 | [0xe3ff268dec284704fc138efe008cd4dbb4a8f38cdb22f817b406e7a5da8860cc](https://basescan.org/tx/0xe3ff268dec284704fc138efe008cd4dbb4a8f38cdb22f817b406e7a5da8860cc) | 11,230,000 |

**Intentional chain gaps:** Tempo is the dominant issuance chain (about 91% of supply). Although `chain-registry.ts` already declares Tempo Dwellir archive state/full log history, `cron/mint-burn/chain-context.ts` builds contexts only through `buildAlchemyUrl`, and `ALCHEMY_CHAINS` excludes Tempo. Revisit when the mint/burn lane supports Tempo RPC routing through the chain registry/Dwellir, then review TIP-20 event semantics and deployment history before admission. Solana is also excluded: the lane has no Solana supply-event decoder or RPC ingestion path. Its trigger is a supported Solana mint/burn adapter. No bridge-detection hints were added without verified CCIP, CCTP or LayerZero attribution.

Ethereum remains the configured canonical chain for DEWS/digest aggregation. The override map could select Tempo even with an Ethereum config, but doing so before Tempo ingestion would exclude all observed OUSD pairs from canonical metrics. Switch the override to Tempo when that config is live. Ethereum/Base together represented about **5.26%** of issuer supply at review: pinned supply reads at Ethereum block 26,091,490 and Base block 51,998,181, compared with the reserve page's 477,309,854 total; Tempo block 41,973,289 was read through `https://rpc.tempo.xyz`. These flows do not represent whole-coin issuance.

The public flows table describes configured issuance chains, and the per-coin API returns `scope.chainIds`. The detail-page `flow-summary-card.tsx` instead consumes the aggregate `useMintBurnFlows()` response; its coin `coverage` metadata has no chain IDs, so that card does not name the coin's configured chains. Coverage status measures scanned-history maturity/freshness, not the fraction of global supply indexed. This is an existing cross-coin disclosure limitation.

**Conservation decision:** Ethereum is admitted under the exact `transfer-supply` law. The [verified StablecoinTemplateV3 implementation](https://eth.blockscout.com/api/v2/smart-contracts/0x264048239dd1b5939599fae8e6000df40248d524) routes mint, wrap, burn, unwrap and blocked-address burns through stored-sum supply updates with exactly one matching zero-address `Transfer`; ordinary transfers reject zero endpoints. Two hash-pinned archive windows, boundary blocks 26,077,249-26,084,420 and 26,084,420-26,091,591, each returned an exact zero residual. Implementation-slot and six-decimal reads matched at all three boundaries, with no in-range `Upgraded` logs. Base is explicitly unsupported with `unverified-implementation-source`: the [B20 specification](https://docs.base.org/specifications/b20) explains the native token surface, but its canonical Solidity interfaces do not verify the deployed native implementation or every supply-storage writer. Base's two archive windows also passed; that observation alone does not close the source gap. Both decisions are recorded in the reviewed sidecar. Revisit Ethereum on implementation changes and Base when version-pinned native source or a justified source exception permits a complete supply-path and zero-address pairing review. Origin Dollar's vault-yield law does not apply to Open USD.

**Budget impact:** two additional serial extended-lane configs, each capped at 25 requests within the unchanged 200-request run ceiling. A simple complete scan adds four `eth_getLogs` requests (mint/burn per deployment), plus candidate-block timestamp batches; range splitting/backfill can consume up to 50 requests across the pair. Ethereum admission adds two hash-pinned `totalSupply()` calls and up to four boundary-header calls (initial reads and rechecks), pooled into the existing three chain-wide pre-pass phases of up to 100 calls per POST and charged to the global budget. It adds no guard views or conservation-only log scans; unsupported Base adds no conservation reads. Existing Ethereum/Base contexts avoid additional chain-head requests, and neither config is bridge-aware. Initial catch-up needs roughly 20 Ethereum and 68 Base 50,000-block ranges at the observed heads; cursor rotation and deferral remain unchanged.

### Reviewed protocol-internal events

`shared/lib/reviewed-protocol-internal-flows.ts` holds individually reviewed events that moved tokens inside an issuer's own balance sheet, each with its block timestamp. `persistMintBurnRows()` applies it through `applyReviewedProtocolInternalFlows()` (`worker/src/lib/mint-burn-pipeline/reviewed-protocol-flows.ts`) after atomic-roundtrip detection, in both the cron and `npx tsx worker/scripts/one-shot-backfill.ts backfill-mint-burn --execute --allow-atomic-import` paths, so a replay over the event's block rewrites the stored row and recalculates its hourly bucket. Matching requires the exact event id (chain, transaction hash, log index), stablecoin, chain, direction, and the reviewed token amount; a row whose amount drifts keeps its normal classification. There is no address-level rule. The homepage Biggest Supply Moves card reads the same registry and leaves a coin out of its week-over-week ranking while a reviewed event sits inside the comparison (see [Homepage](./homepage.md)).

The only entry is USDai's September 23, 2026 burn of 128,895,244.1 tokens (block 508,237,173). The sUSDai vault funded USD.AI's EscrowTimelock escrow-admin Safe with exactly that amount through two same-evening strategy transfers; the Safe then called the hub's `withdraw()`, burning the USDai and paying 128,895,243.0 PYUSD to a recipient address. USD.AI's dashboard loan-reserve series rose by exactly 128,895,244.1 in the same half hour while protocol TVL stayed near $609.05M. The withdrawal path is the one an ordinary redemption uses, which is why the rule is per event. Four earlier escrow-admin Safe burns (July 10, July 20, August 21, September 14) and four repayment re-deposit mints lacked matching half-hour loan-reserve evidence at review and remain counted. `reviewedProtocolInternal` in persistence results counts rows tagged during a run.

### Event Detection

**Standard mint/burn:** ERC-20 `Transfer(address,address,uint256)` events filtered by zero address.

- **Mint:** `topics[1]` (from) = zero address
- **Burn:** `topics[2]` (to) = zero address

**USDT Ethereum special handling:** The USDT contract uses custom `Issue(uint256)` and `Redeem(uint256)` events for treasury operations (issue() does NOT emit Transfer). Because no zero-address `Transfer` logs are produced, these are the only events tracked for USDT on Ethereum (adapter kind `custom-events`).

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

## Raw Token Conservation

The mint/burn producer performs a bounded integrity audit for reviewed contract identities using the raw logs already fetched by the normal config scan. This is separate from public economic-flow aggregation: small, atomic and bridge events stay in the raw conservation channel even when excluded from public standard flow. No new cron, migration, provider or public supply override is introduced.

For a complete successful range `[fromBlock, toBlock]`, the audit reads boundary headers and pins supply calls (`totalSupply()` by default, `totalShares()` for USDO) and law-specific guard views to their canonical hashes using [EIP-1898](https://eips.ethereum.org/EIPS/eip-1898). It rechecks the boundary identities before accepting the result. Missing archive support, partial ranges, invalid RPC results, changed hashes, exhausted budget or elapsed deadline produce unverified evidence; there is no fallback to latest-state reads. Contract/topic/range identities, non-removed logs, fixed-width amounts and duplicate consistency are validated before exact native integer summation. Retrieved positive config events at or above the configured cutoff must also correspond to parsed row identities, directions and amounts before persistence. A passing verdict is published only after successful writes and a bounded readback confirms every eligible row’s identity, direction, native amount, block and timestamp, including rows retained by `INSERT OR IGNORE`. Missing or conflicting stored rows fence advancement.

Before scanning configs, a serialized boundary pre-pass pools eligible ranges by chain/Alchemy URL: distinct boundary headers, hash-pinned supply calls, then header rechecks. Each phase is chunked at 100 calls per POST and charged to the lane global budget, not per-config budgets (cost per chain/run is the sum of chunks across the three phases). Each POST has a 15-second timeout capped by the remaining pre-pass allowance of 45 seconds or the lane deadline, whichever comes first. Per-call and chunk failures affect only dependent configs. Raw logs are reused rather than scanned again; each config still fences, persists and advances its cursor immediately, preserving completed progress if a later config aborts. Interior log block identities remain provider evidence; the boundary checks do not independently retrieve every interior header. Exact conservation can detect an unmatched omitted event, but cannot alone detect a provider omitting offsetting mint/burn pairs.

The committed evidence sidecar `worker/src/lib/mint-burn-conservation-reviewed.json` is the only list of admitted and explicitly unsupported identities: one entry per config identity (chain, stablecoin id, lowercase address, decimals) carrying the reviewer's identity evidence (explorer-verified source, external address match, on-chain decimals) and supply-path review, with admitted entries carrying audited windows proving the reviewed law exactly. A config with no entry falls back to `unreviewed-contract-or-event-semantics`. Admission requires the exact reviewed identity and compatible event adapter: ordinary zero-address `Transfer` semantics with `transfer-zero-address`, or reviewed `config-events` semantics with `custom-events`. An `unsupported` entry carries a reason from the fixed vocabulary in `worker/src/lib/mint-burn-conservation.ts`: literals `rebasing-supply-without-events`, `total-supply-override`, `deprecated-upgrade-forwarding`, `unverified-implementation-source`, or a reason beginning with `unpaired-supply-path:` or `zero-address-transfer-without-supply-change:`. `m-m0` is explicitly unsupported with `rebasing-supply-without-events` because its index accrues over time. `npm run audit:mint-burn-conservation-admission` produces, replays and merges this evidence. The Worker runtime never parses the evidence file: eligibility resolves from the generated lookup `worker/src/lib/mint-burn-conservation-runtime.generated.json` (identity, disposition, reason and runtime params projected from the sidecar by a registered generator; `npm run check:generated-artifacts -- --only=mint-burn-conservation-runtime` guards drift), keeping the evidence out of the isolate bundle.

The permanent admission CLI (`npm run audit:mint-burn-conservation-admission`) records a redacted RPC journal and can replay it offline. Audit-only operation and `--emit-sidecar-draft` do not alter the reviewed sidecar. Reviewer semantic files describe source/control/supply-law evidence; they do not substitute for complete passing audited windows. Only explicit `--merge-into-sidecar` mutates admission authority and regenerates its runtime lookup. Retain journals and restore the sidecar/lookup pair together; never bypass the conservation fence to undo a review.

Reviewed alternative laws are exact, without tolerance: USDT's `config-events` sums Issue mints minus Redeem and conservation-only DestroyedBlackFunds burns, guarded by `deprecated()` being false at both boundaries. Origin Dollar's (`ousd-origin-protocol`) `transfer-plus-vault-yield` adds vault `YieldDistribution` yield minus fee to the zero-address Transfer net; it requires each distribution to pair with a later `TotalSupplyUpdatedHighres` in the same transaction, rejects legacy checkpoints and saturated rebases, pins mutual token/vault identity at both boundaries, and rejects in-range proxy upgrades. USDO's `usdo-bonus-multiplier-shares` replays `BonusMultiplier` in block/log order from the opening view, folds each Transfer amount `A` into `floor(A * 1e18 / multiplier)` shares, and requires net shares to equal the `totalShares` delta. Its replay must match the closing multiplier view, `totalSupply = floor(totalShares * multiplier / 1e18)` must hold at both boundaries, and pinned implementation identity plus the upgrade guard must hold; its record arithmetic units are `raw-shares`.

Conservation-only events are fetched in the same scan, using each definition's emitter when supplied, but never become public flow rows or enter config-event row correspondence checks. Their fetch failures or partial coverage make the audit incomplete without independently counting as ingestion API errors or blocking otherwise valid config-event cursor progress. Public Mint/Burn Flow methodology is unchanged.

Evidence uses existing `cache` rows at `mint-burn:conservation:<configKey>`, with monotonic writes and a fingerprint covering the audited configuration. Storage is one compact latest record per audited contract, not a growing event archive. Unresolved verified mismatches survive unavailable follow-up attempts and clear only after a verified passing audit covers the entire failing range for the same identity. Changing a config invalidates old proof. Cache write failures surface through the producer rather than pretending evidence was published.

A verified native mismatch fences cursor advancement and immediately degrades the affected run so the same range can be retried. The fence is also a write barrier: a conservation-fenced attempt (verified mismatch, unreliable raw-log/boundary evidence, or parser correspondence failure) persists no rows into `mint_burn_events`, so rows whose event set was never conservation-verified cannot outlive the fence — a later clean retry that covers the range writes only the rows it re-observed, and its persisted-row readback verifies exactly those. Invalid raw identity or parser/stored-row correspondence evidence is likewise not allowed to advance as a clean scan. Pure audit capability/budget unavailability does not independently stall otherwise valid ingestion or count as an ingestion API error; separate conservation counters expose audit failures and unavailable attempts. The operator verdict stays unverified, and existing partial-coverage, timestamp, bridge-context and persistence rules continue to govern progress.

The operator view reads cached evidence only, displays each latest audited range separately, and never treats the old timestamp-less circulating-supply delta as a critical ingestion verdict. See [Status Dashboard: Mint/Burn Reconciliation Card](./status-dashboard.md#mintburn-reconciliation-card). The public mint/burn methodology and its version are unchanged because event cutoffs, classifications, counts, valuation and flow formulas are unchanged.

## Sync Algorithm

1. **Load sync state** — batch query `mint_burn_sync_state` for all lane-selected contract keys. Falls back to `startBlock - 1` for new configs.
2. **Apply runtime policy** — filter disabled configs (`MINT_BURN_DISABLED_IDS`, `MINT_BURN_DISABLED_SYMBOLS`), select the requested lane (`critical`, `extended`, or `all`), rotate start index from the lane-specific `mint_burn_run_state.job`, front-load critical configs inside mixed/all runs, and assign a per-config request cap inside the global budget. The cron runner reserves a 9-minute self-budget inside the 10-minute wrapper timeout and skips the remaining config tail once fewer than 60 seconds remain for starting another config.
3. **Skip deferred configs** — load active deferrals from `mint_burn_config_deferral` (rows with `deferred_until > now`) and remove them from the run. A config is deferred for a 1-hour grace period when it exits a run with `apiErrors > 5` AND `coverage < 0.8`, so chronically failing configs cannot starve healthy ones of subrequest budget.
4. **Get chain head** — Alchemy `eth_blockNumber` call per chain (cached per chain ID).
5. **Load price evidence** — read the tracked IDs' `supply_history` prices that carry a recorded `price_observed_at` (migration `0253`; rows without it are not evidence) and their `price_cache` rows projected with the actual observation clock (`observed_at`, else the writer's effective `updated_at`), source and observation mode. Rows with an unusable price, a missing/invalid clock, or a clock after the read are not evidence.
6. **For each contract config:**
   - Skip if `fromBlock > chainHead` or the lane/global budget is exhausted.
   - For each event definition, call Alchemy `eth_getLogs` with adaptive recursive block-range splitting on provider/range failures.
   - Enforce the per-config request cap while fetching logs, resolving timestamps, and classifying bridge activity so a single config cannot monopolize the lane.
   - Resolve block timestamps — batch `eth_getBlockByNumber` for unique non-dust candidate blocks using local + persistent (`block_timestamp_cache`) caches bound to the logs' block hashes. Missing/mismatching cached hashes are refetched; conflicting returned hashes hold the frontier. Dust-only blocks need no timestamp.
   - Parse logs per event definition: decode amount (respecting decimals), derive counterparty address, compute `amount_usd = amount * price` (null if no price), and initialize `flow_type='standard'`.
   - Cron and admin share per-log decode retry state: the first two failures hold the frontier; observation three quarantines with `amount-decode-retry-exhausted`, excludes only that row and permits progress. Admin diagnostics count decode drops separately and in total drops; valid peers persist.
   - Event-time pricing contract (DEC-08, v6.23): a price values an event only when `abs(priceObservedAt - eventTimestamp) <= 86_400` seconds, boundaries inclusive, and it passes the `historical_backfill` peg-plausibility validation the historical price-repair scanner applies. The `supply_history` snapshot is tried first, admitted only through its recorded `price_observed_at` (the published price's actual observation time written by `snapshot-supply`), never through its UTC day label; among in-window snapshots the one observed closest to the event wins. `snapshot-supply` stores a price only when `isObservedPrice` holds, so a nominal par reference never enters the daily history, and legacy, prior-Worker and admin-backfill rows (NULL clock) never value an event. Otherwise a `price_cache` observation is admitted when it is also replay-safe (`isReplaySafePriceSource`) and an actual observation (`isObservedPrice`, so a nominal par reference never counts); legacy `protocol-redeem` rows of nominal-par routes (`protocolParProvider.matches`) are par written before the nominal cutover and never count. It is stamped with its own observation time (`price_source=price-cache-event-window`), never the run time. When both a snapshot and a cache observation qualify, the one observed closest to the event wins (a tie keeps the snapshot). With no admissible evidence the row stays NULL; a current quote never values an old event. Assets observed less than daily (NAV tokens over weekends and holidays) therefore leave events unpriced, and their hours `partial`, whenever the latest observation is more than 24 hours from the event. Rows written before v6.23 may carry the retired `price-cache-current` label with a run-time `price_timestamp`.
   - Resolve transaction-context receipts for candidate bridge rows in chunks of 20 transaction hashes with the local `mapWithConcurrency` helper (`TX_CONTEXT_BATCH_CONCURRENCY = 3`) instead of one HTTP request per transaction. Each HTTP request carries both transaction and receipt JSON-RPC calls for its chunk, so high-volume USDC-style bridge-aware windows consume a handful of Worker subrequests instead of hundreds.
   - Classify bridge transfers after all parsed rows for the config chunk are assembled so bridge-related mints and burns can be tagged together while still sharing the same transaction-context budget.
   - Timestamp and bridge-classification phases receive the cron lane deadline; when the 9-minute self-budget is reached they stop adding remote work and surface ordinary partial-frontier diagnostics instead of relying on the outer 10-minute cron timeout.
   - If a bridge-enabled config cannot resolve required transaction and receipt context for a parsed transaction, rows from that transaction are withheld from persistence for that run while resolved rows in the same window can still publish. These shortfalls remain in `bridgeClassification` diagnostics and keep the sync cursor at the safe retry frontier instead of counting unresolved rows as economic flow.
   - Malformed transaction, receipt, or explorer-log payloads are quarantined at the provider boundary. They contribute a named classification shortfall while valid peers in the same batch continue.
   - Detect atomic roundtrips after all event definitions for the config are parsed: group rows by `(tx_hash, stablecoin_id, chain_id)` and flip the whole group to `flow_type='atomic_roundtrip'` when both mint and burn directions appear in the same transaction and their totals match within `ROUNDTRIP_AMOUNT_TOLERANCE` (0.5%). Rows with an empty `tx_hash` are defensively skipped.
   - Filter out dust events (amount < `dustThreshold`).
   - Batch `INSERT OR IGNORE` into `mint_burn_events`, track parsed vs inserted counts from D1 `meta.changes`. Cron callers pass the wrapper `AbortSignal` into insert/classification batches so timeout or lease-loss cancellation stops before large D1 persistence chunks continue.
   - Stage the next `mint_burn_sync_state.last_block` frontier (do not commit it before hourly materialization):
     - If every event definition completed and timestamps are fully resolved:
       - If events found: advance to `maxBlockSeen`.
       - If no events: advance to `chainHead - safetyMarginBlocks` (avoids skipping not-yet-indexed events).
     - If event, timestamp, bridge-context, or still-retryable decode coverage is partial: advance only to the shared safe coverage frontier (`min(scannedToBlock, earliestMissingTimestamp-1, earliestDeferredRow-1, earliestDecodeFailure-1)`).
     - If no safe frontier exists for the config in that run: do not advance. A decode row that reaches its bounded retry limit is quarantined per row and no longer holds this frontier.
7. **Recalculate affected hourly buckets** — for each unique `(stablecoinId, chainId, hourTs)` touched, `INSERT OR REPLACE` into `mint_burn_hourly` by re-aggregating from `mint_burn_events`, counting only `flow_type='standard'` rows so bridge transfers and atomic roundtrips do not leak into flow statistics.
   - Recalc runs inside a `finally` block so it still fires after partial-run failures. Only a successful recalc commits the staged config cursors. Failure holds every staged cursor for idempotent replay; duplicate-only `INSERT OR IGNORE` replays still collect their affected hours. The critical lane downgrades `status=ok` to `status=degraded` and surfaces `recalcFailed: true` plus `recalcError: <message>`. Cancellation likewise holds cursors. The cron abort signal is passed into this recalc path and into post-run null-price healing / roundtrip sweep recalcs.
8. **Auto-heal recent NULL prices** — on non-error runs, list the coins with `amount_usd IS NULL` events in the last 48 hours, drop coins with no evidence that could value any of them (`hasMintBurnEventPriceEvidenceSince`: no usable snapshot or cache observation observed after the lookback start minus 24h), then take up to 500 of the remaining coins' NULL rows, value them with the same `resolveMintBurnEventPrice()` admission parse uses (`price_source=supply-history-heal` or `price_cache_heal`, stamped with the evidence's observation time), update `amount_usd/price_*`, and re-aggregate only newly affected hourly buckets.
   - Replay-safe provenance alone is not enough: a cache observation outside ±24h of the event is rejected. Skipping evidence-less coins keeps their permanently unpriceable rows from filling the 500-row budget ahead of healable coins. When nothing qualifies, `amount_usd` stays NULL for `backfill-mint-burn-prices` rather than being valued from a stale snapshot or a later quote; this deliberately grows the historical repair backlog.
   - Cron metadata now includes both `nullPricesHealed` and `nullPriceBacklog` (`recent`, `historical`) so operators can distinguish live healable gaps from older debt.
   - If the backlog metadata read remains unavailable after D1 overload retries, the completed ingestion run continues with an explicit unavailable marker and warning; it never fabricates a zero backlog.
9. **Emit active progress** — long runs call the shared cron `reportProgress(...)` hook so `/api/status` can surface the active stage, queue position, and budget heartbeat while the lease is still live.
10. **Escalate degraded runs** — the critical lane emits `status=degraded|error` when sustained coverage/API thresholds are breached, with streak tracking in `mint_burn_run_state`. The extended lane keeps the same observability metadata but does not escalate long-tail backlog pressure to `error`.
11. **Sweep cross-run roundtrips** — on non-error runs, query up to 200 `(tx_hash, stablecoin_id, chain_id)` groups within the last 7 days where both mint and burn directions exist but `flow_type = 'standard'`. Reclassify to `atomic_roundtrip` and re-aggregate affected hourly buckets. This catches roundtrips where the mint and burn were ingested in separate cron runs. The HAVING clause mirrors `ROUNDTRIP_AMOUNT_TOLERANCE` from the in-memory detector so partial same-tx groups (e.g. mint 100 / burn 50) are not mis-tagged as atomic roundtrips.
12. **Invalidate flow API caches** — successful runs (`ok` or `degraded`) purge the versioned `FLOW_CACHE_PREFIX` range. Critical/manual-all runs purge `mint-burn-flows:v4:*` and republish aggregate windows `24` and `168`; extended runs purge only `mint-burn-flows:v4:coin:*`, preserving the gauge until the next critical publication. Per-coin requests rebuild against freshly written buckets.

**Counterparty resolution (default):** mints read `topics[2]` (recipient), burns read `topics[1]` (sender); a config's `counterpartyEncoding` override changes the slot (see Event Detection).

**Event ID format:** `"{chainId}-{txHash}-{logIndex}"` — deterministic, prevents duplicates via `INSERT OR IGNORE`.

---

## Shared Ingestion Pipeline Boundaries

Cron (`sync-mint-burn`) and admin backfill (`backfill-mint-burn`) now share a single ingestion pipeline under `worker/src/lib/mint-burn-pipeline/`.

| Module | Responsibility |
|--------|----------------|
| `types.ts` | Shared ingestion row/context/counter types and sync-state mode union |
| `parse.ts` | `parseMintBurnLogs()`; values each event through the shared event-time admission in `context.ts` |
| `roundtrip-detection.ts` | Same-transaction `(tx_hash, stablecoin_id, chain_id)` atomic roundtrip detection for `flow_type` tagging |
| `classification.ts` | Bridge-aware burn classification and transaction-context loading |
| `context.ts` | Price evidence loaders (`supply_history` series, `price_cache` observation projection) and `resolveMintBurnEventPrice()`, the ±24h event-time admission shared by parse and heal |
| `persistence.ts` | `INSERT OR IGNORE` event writes, burn classification updates, affected-hour aggregation |
| `price-heal.ts` | Auto-heal recent NULL-price rows through the shared event-time admission and return affected hours |
| `roundtrip-sweep.ts` | Post-cron sweep for cross-run atomic roundtrip detection (7-day window, 200-group limit per run) |
| `sync-state.ts` | Sync-state key helpers plus mode-specific upserts; cron and backfill both use `monotonic-max` so a partial run cannot regress the stored frontier (`replace` remains available but has no production caller) |

Implementation invariant: `worker/scripts/backfills/backfill-mint-burn.ts` does not import from `worker/src/cron/sync-mint-burn.ts`; both entrypoints import shared helpers from `mint-burn-pipeline/*`.

`mint_burn_events.flow_type` is orthogonal to `burn_type`: `burn_type` still classifies burns as economic vs bridge/review, while `flow_type` applies to both mints and burns and marks tx-level bridge noise as `bridge_transfer`, same-transaction mint+burn noise as `atomic_roundtrip`, and reviewed issuer-internal movements as `protocol_internal`. Large-flow Tape projection skips `bridge_transfer` and `protocol_internal` rows; the Tape row already projected for the September 23 USDai burn before the review remains, because it records a burn that did occur.

Cron metadata includes `atomicRoundtripsDetected`, an observability counter for how many rows were tagged during the run.

### Bridge Classifier

Dispatch and per-protocol fingerprint logic now live in three co-operating modules instead of one monolith:

| Module | Responsibility |
|--------|----------------|
| `worker/src/lib/mint-burn-bridge-classifier.ts` | Dispatcher: normalizes tx context, walks per-row fingerprints, and writes `flow_type = 'bridge_transfer'` plus (for burns) `burn_type = 'bridge_burn'` |
| `worker/src/lib/mint-burn-bridge-classifier-protocols.ts` | Per-protocol helpers: CCIP/CCTP router matching, LayerZero OFT signal fingerprints, generic pool/router address heuristics |
| `worker/src/lib/mint-burn-bridge-classifier-types.ts` | Leaf module with shared types (breaks the classifier ↔ protocols import cycle) |

Key behavior changes forward-going:

- **Mint-side tagging for CCIP/CCTP.** Bridge mints are `flow_type='bridge_transfer'` and excluded from issuance, covering USDO, USD1, avUSD and ZCHF (CCIP), and USDC/EURC (CCTP). CCTP source-side deposit topics/selectors are unchanged. Destination recognition requires a paired `MessageReceived(address,uint32,bytes32,bytes32,uint32,bytes)` log from Circle's reviewed Ethereum MessageTransmitterV2, a `MintAndWithdraw(address,uint256,address,uint256)` log from the reviewed TokenMessengerV2 naming this config's registry-resolved token, and a matching zero-address token `Transfer` (recipient and raw amount) in the same receipt. A generic or wrongly emitted `MessageReceived`, or a receive for another token, cannot tag the config's mint. Identity source: [Circle mainnet contract addresses](https://developers.circle.com/cctp/references/contract-addresses); event semantics: [MessageTransmitterV2](https://github.com/circlefin/evm-cctp-contracts/blob/master/src/v2/MessageTransmitterV2.sol) and [BaseTokenMessenger](https://github.com/circlefin/evm-cctp-contracts/blob/master/src/v2/BaseTokenMessenger.sol).
  Destination CCTP tags only parsed mint rows matched by receipt log index to the recipient Transfer and, for nonzero `feeCollected`, the subsequent fee Transfer made by the reviewed TokenMinterV2 before `MintAndWithdraw`. Unrelated same-transaction mints/burns stay standard; the recipient amount is net of fees, not the gross message-body amount.
- **LayerZero endpoint-only signal.** The OFT/OAdapter path now accepts a third fingerprint (`fingerprintC`) that fires when the transaction context contains both a known LayerZero endpoint topic and an expected emitter address, even without the classic pool-address match (`hasSignalTopic && hasExpectedEmitter && signalEmitterSet.size > 0`). This catches LayerZero-Executor-only mints that previously slipped through. Tradeoff: known risk of shared-endpoint false positives is accepted to eliminate the prior false-negative backlog.
- **No more `bridge-signal-with-unknown-pool` review path.** Rows that touch a recognized source-side bridge signal or LayerZero topic/emitter but not a tracked pool address tag as `bridge_transfer` rather than flowing to a review queue. The transaction-wide rule for those existing fingerprints is unchanged; the token-specific destination CCTP path above tags only matched mint evidence.
- **Fail-closed bridge-detection config validation.** `validateMintBurnBridgeDetection` runs against every `bridgeDetection` config at module load. Address fields must match `ADDRESS_RE`, topics must match `TOPIC_RE`, and selectors must match `SELECTOR_RE`. Any malformed bridge config aborts module load instead of logging and continuing, so bridge filtering cannot silently disable itself for one coin.
- **Bridge tx-context shortfall guard.** For bridge-enabled configs, both transaction and receipt context must resolve before parsed rows can count as standard economic flow. If context is unavailable under budget pressure or RPC failure, every parsed row from that transaction is withheld from persistence for that run and the config advances only to the safe retry frontier below the earliest deferred row, so those blocks are rescanned on a later slot. Run metadata surfaces `bridgeClassification.txContextShortfalls` and `bridgeClassification.deferredRows`; these diagnostics do not increment provider `apiErrors`.
- **Provider-shape isolation.** Transaction and receipt bodies must pass the runtime shape boundary before classification, and Etherscan topics/data must pass strict word decoding. A malformed peer is dropped and counted without aborting classification of valid peers.

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

**One producer.** `refreshAggregateMintBurnFlowCache()` (`worker/src/api/mint-burn-flows.ts`) publishes the gauge over active tracked pairs and tracked-chain supply weights under `mint-burn-flows:v4:aggregate:24`. All consumers, including the daily digest, read that publication through `worker/src/lib/mint-burn-published-gauge.ts`; they never recompute the gauge or its `chains[]` 24h breakdown over another universe. The critical-lane sidecar refreshes every 30 minutes; extended-lane purges preserve it.

**Mcap weighting — tracked-chain scope.** Each coin's weight is now its **canonical tracked-chain circulating supply**, not its global peg-bucket total. A coin is only scored against chains where we actually ingest mint/burn events, so omnichain tokens don't over-contribute via supply we don't observe.

**Aggregate read path.** `fetchAggregateData()` (`worker/src/api/mint-burn-flows/aggregate.ts`) expresses tracked-pair membership as a row-value `(chain_id, stablecoin_id) IN (SELECT ... FROM json_each(?))` pinned to `idx_mbh_chain_coin_hour` (and `(stablecoin_id, chain_id)` pinned to `idx_mbe_coin_chain_ts` for the largest-event scan), so each tracked pair's window is an index range seek. A correlated `EXISTS (SELECT ... FROM json_each(?))` instead re-scans the whole pair array for every index row — with ~130 tracked pairs that turned the 90-day net-flow read into ~1.6M rows per call and made it a leading D1 contention source; keep the filter row-value/index-driven if these statements are ever edited.

Implementation (`worker/src/lib/mint-burn-mcap-weighting.ts`):

- `getMintBurnTrackedChains(stablecoinId)` derives the active `chainId` set from `MINT_BURN_CONFIGS`.
- `sumMcapForTrackedChains(stablecoinId, chainCirculating, circulating)` sums `chainCirculating[chainId].current` over those tracked chains, after `canonicalizeChainCirculating(...)` normalizes DefiLlama's capitalized keys (e.g. `Ethereum`) to canonical chain IDs.
- Fallback policy (preserves legacy behavior where per-chain data isn't available):
  1. Coin with no tracked chains → `getCirculatingRawOrNull({ circulating })`.
  2. Canonicalized `chainCirculating` is empty → `getCirculatingRawOrNull({ circulating })` (keeps CG-fallback assets alive).
  3. No tracked chain has an entry in the canonicalized map → `getCirculatingRawOrNull({ circulating })`.
  4. Otherwise sum `current` across tracked chains. `current = 0` is treated as real data (zero supply) and does not trigger fallback.
- A fallback with no observed circulating bucket returns `null`: that coin's weight is unavailable, not `0`. The aggregate excludes it from the gauge inputs and from `gauge.trackedMcapUsd` and counts it in `gauge.mcapUnavailableCoins` (absent on payloads produced before the count existed). Its flow row is still published. Because a zero weight already contributed nothing, the gauge score formula is unchanged.

### Flight-to-Quality Detection

Detects simultaneous outflows from risky stablecoins and inflows to safe havens.

- **Activation:** `riskyNet24h < -$100M` AND `safeNet24h > +$100M`
- **Intensity:** `min(100, |riskyNet24h| / $1B * 100)`
- Safe/risky cohorts come from the report-card cache: `B-` or better is safe, `C+` through `C-` is neutral, and grades below `C-` are risky. If the complete identified report-card cache is unavailable, flight-to-quality classification is unavailable rather than falling back to hardcoded safe havens.
- On aggregate API reads, a changed publication identity triggers FTQ recomputation from the validated cached per-coin `netFlow24hUsd` values and current cohorts. This updates only the response's FTQ fields, classification identity, and classification warning; the cached flow data, producer timestamps, freshness headers, and database row are preserved. Missing, held, stale, or malformed Safety Score sources and invalid cached coin inputs still fail closed.

---

## Valuation Completeness

Since methodology v6.22 (CR-18 release A, migration `0251`), every hourly bucket stores `mint_unpriced_event_count` and `burn_unpriced_event_count` beside the existing columns. Counted flow is standard mints and standard effective burns; an event without `amount_usd` increments its side's unpriced count and adds nothing to `mint_volume_usd` / `burn_volume_usd` / `net_flow_usd`, which are known-valuation subtotals. All materializers (sync recalc, retention evidence repair, heal rebuild and its verification) share `mintBurnHourlyBucketAggregatesSql`, so counts, unpriced counts and subtotals are rebuilt together in the existing atomic per-hour delete+insert pair.

- **Completeness:** `complete` (no unpriced counted event; an empty window is complete, genuine zero stays zero), `partial` (unpriced events exist: gross subtotals are explicit lower bounds, a signed partial net is not a bound), `unknown` (a bucket written before `0251`, or rewritten by a prior Worker, has NULL counts on a side with counted events). Precedence is partial > unknown > complete. Shared logic: `shared/lib/mint-burn-valuation.ts`; SQL tally: `worker/src/lib/mint-burn-hourly-valuation.ts`.
- **Legacy rebuild:** after each completed run, `rebuildRetainedLegacyValuationHours` re-aggregates up to 500 NULL-count buckets that start at least one hour inside the 8-day event-retention window (their raw events cannot have been pruned), newest first, through the partial index `idx_mbh_valuation_unrecorded`. Older legacy buckets stay `unknown` until hourly retention prunes them; nothing reconstructs pruned history.
- **Proven direction:** unpriced mints can only raise the true net and unpriced burns can only lower it. A direction survives only when that proven range excludes zero; `flat` requires complete valuation.
- **Internal consumers (active now):** DEWS flow is unavailable (`mint-burn-valuation-partial` / `-unknown`) unless the 24h window is complete, and when its burn baseline is partial (`mint-burn-baseline-valuation-partial`); an unknown legacy baseline is tolerated until it ages out of the 30-day window. DDR mint surge uses hourly evidence only when the proven range decides the 20% threshold, otherwise the supply-history proxy. The daily digest withholds the gauge when `gauge.partialValuationInputs > 0` and the withheld weight could move it across a band edge (see below), restates pressure and chain nets only for complete 24h windows, and marks FTQ unavailable (`valuation-incomplete`) unless exact or provably inactive.
- **Public API (v6.23 activation):** additive `valuation` fields on coins, chains, hourly buckets and per-coin totals/chains, plus `gauge.partialValuationInputs` and (v6.23) `gauge.partialValuationMcapUsd` / `gauge.scoredMcapUsd`. A signed net (`netFlow24hUsd`, `netFlow7d/30d/90dUsd`, chain `netFlow24hUsd`, per-coin `netFlowUsd`, hourly `netFlowUsd`) is `null` when its window is `partial`; gross volumes stay known subtotals. `netFlowDirection24h` comes from `provenNetFlowDirection24h()` and is `null` whenever missing valuation (partial or unknown) could change it. Pressure is computed only for a `complete` 24h window whose baseline is not `partial` (an `unknown` baseline is accepted during the transition window). A weighted coin with 24h activity and at least seven days of baseline history (`FLOW_INTENSITY_MIN_DATA_DAYS`; shorter baselines are NR regardless) whose pressure is withheld for that reason leaves the gauge, `computeGaugeScore` re-weights over the scored coins, and the gauge discloses those coins in `partialValuationInputs` with their weight in `partialValuationMcapUsd` beside the scored weight `scoredMcapUsd`; `/flows` shows the incomplete-valuation note. The digest withholds the gauge only when `isGaugeBandRobustToWithheldWeight()` fails: with any true intensity in [-100, 100] for the withheld weight, the full-cohort score `(W·S ± 100w)/(W+w)` must stay in the published band (shift at most `w/(W+w)·(100+|S|)`); a kept gauge carries quality reason `mint-burn-gauge-valuation-partial-band-stable`, and a positive count without published weights (older producer) still withholds. Flight-to-quality uses `detectFlightToQualityFromValuedNets()`: exact, provably inactive, or `null`; a cached aggregate reclassified for a newer Safety Score publication applies the same rule, and a cached coin without `valuation` reads as `unknown`. The stablecoin OG card shows a partial seven-day window as `7D GROSS (MIN)` (`$X+`) and an unknown one as `7D NET (UNVERIFIED)`, never a signed partial net.
- **Transition window:** `unknown` legacy buckets keep their old-method net and the pressure baseline, labelled through `valuation`, because the legacy rebuild only reaches the eight-day raw-event window. They leave the 30-day baseline about 30 days after `0251` reached production and the 7/30/90-day net windows after 7/30/90 days. Until then an unknown 24h window publishes its net but no direction or pressure, and flight-to-quality can be `null`.
- **Event-time pricing (v6.23):** parse and the 48-hour heal value an event only through `resolveMintBurnEventPrice()` (`worker/src/lib/mint-burn-pipeline/context.ts`); see [Sync Algorithm](#sync-algorithm). More events can therefore stay unpriced (backfills, new configs, `price_cache` outages, NAV observations older than 24h, nominal-par assets, and events only a snapshot could value until the first post-`0253` daily snapshot records a clock); those hours are `partial` and their raw rows stay retention-protected debt for the historical repair path.
- **Historical repair admission:** daily supply snapshots use the same actual-clock projection and event-price resolver as parse/heal, including positive integral read-time-valid clocks, peg plausibility and inclusive ±24h event distance. The scanner considers nearby snapshot days rather than inventing a clock from the day label; an invalid or unclocked snapshot cannot suppress event-day provider fallback. Recovered rows persist the admitted observation timestamp, and already-valued rows are never overwritten.

## Retention

The critical `sync-mint-burn` producer owns bounded cleanup and aggregation-evidence repair after ingestion:

- Individual `mint_burn_events` rows are retained for at least **8 days**. An older row is eligible only after its USD valuation is settled (`amount_usd` is present or price repair is explicitly `recovered`/`irreducible`), its stablecoin/chain/hour aggregate exists, and the Tape projector cursor has passed its timestamp. The shared whole-hour finality guard protects **all siblings**, including priced rows, whenever any sibling has unresolved valuation, pending aggregation, or a block beyond a matching config's committed scan frontier.
- A missing hourly bucket for terminal, projected raw rows is rebuilt oldest-first before deletion. Unresolved or pending hours are neither rebuilt nor pruned. Missing sync state fails closed for active, enabled configs: every matching stablecoin/chain frontier, including secondary contracts across both lanes, must cover the hour's raw blocks. Disabled configs (registry flag, runtime ID/key or symbol policy) and inactive assets do not hold protection. The 50,000-event candidate and 5,000-hour repair budgets remain in force; there is no age-based deletion escape. Historical price repair recalculates and verifies only its affected hours, preserving unrelated aggregate history.
- `mint_burn_hourly` buckets are retained for at least **95 days**, preserving the public 90-day aggregate window with a five-day operating margin. Cleanup never removes a bucket while any raw event still depends on it as aggregation evidence.
- Repairs are capped at 5,000 hourly buckets per critical run. Deletes run oldest-first in 10,000-row statements, capped at 50,000 event rows and 25,000 hourly rows per critical run. The extended lane does not run cleanup.
- Cron metadata reports aggregation repair and deletion cutoffs, changed counts, oldest backlog timestamps, cap states, durations, and errors. `retention.frontierProtection.configs` identifies each enabled config holding an expired hour: config/coin/chain identity, `lastBlock`, `highestProtectedBlock`, `lagBlocks`, `oldestProtectedHour`, and `oldestProtectedAgeSeconds`. Missing state has null frontier/lag, not fabricated progress; a failed diagnostic read publishes null configs and an error, not an empty healthy list. Cleanup or diagnostic failure degrades an otherwise successful critical run without discarding ingestion.

The daily `mint-burn-growth-watchdog` cron remains a fail-safe rather than the retention owner. It reports degraded at **2.3M event rows**, the existing proxy for the agreed ~5 GB investigation point, so operators can detect cleanup that is not converging, an unexpectedly large protected backlog, or abnormal producer growth. D1 disallows `PRAGMA page_count`, hence the row-count proxy. Each daily watchdog execution independently counts current `mint_burn_events` rows with `COUNT(*)`; it does not recycle the previous watchdog result. This intentionally incurs one table-count read per daily run, and an unavailable count fails the job rather than reporting zero.

## Database Schema

Exact columns, constraints, and indexes live in `worker/migrations/0000_baseline.sql`, the follow-on migrations named below, and `worker/migrations/MANIFEST.md`. This section owns the table roles and flow semantics, not a second DDL copy.

### mint_burn_events (current excerpt; baseline plus later indexes)

`mint_burn_events` is the transaction-addressable recent event ledger with the protected 8-day retention policy above. It preserves token-native amount, optional event valuation and its source timestamp, chain/transaction provenance, counterparty, burn classification, and economic-flow classification. `standard`, `bridge_transfer`, `atomic_roundtrip`, and `protocol_internal` semantics decide whether a row contributes to aggregates; burn rows additionally distinguish effective burns, bridge burns, and review-required evidence.

Migration `0178_historical_data_debt_closure.sql` owns bounded historical price-repair state and its provenance columns; migration `0234_mint_burn_price_repair_backlog_index.sql` owns the repair backlog index (`idx_mbe_historical_price_repair_backlog`). Repair provenance distinguishes retryable unclassified debt, aggregate rebuild pending, recovered rows, and irreducible exact-day gaps; it also binds mutation attempts to their operator run and pre-run Time Travel bookmark. Migration `0097_mbe_flow_type_ts_index.sql` owns flow-classification query support. Exact index membership stays in the migrations.

### mint_burn_hourly (baseline `0000_baseline.sql`)

Pre-aggregated stablecoin/chain/hour buckets store counted mint and burn volume, event counts, and signed net flow. The cron rebuilds affected buckets after ingestion; repair and reclassification paths recalculate the same canonical buckets before declaring completion.

### mint_burn_sync_state (baseline `0000_baseline.sql`)

This table owns the monotonic last-processed block for each chain/contract configuration. Cron and backfill ingestion share it, and partial backfills must never regress the stored frontier.

### mint_burn_config_deferral (baseline `0000_baseline.sql`; originally migration 0096)

Per-config deferral state prevents a chronically failing configuration from exhausting the shared request budget. A run with more than five API errors and less than 80% coverage defers that configuration for one hour; later runs skip it until the deadline and continue healthy work.

**Migration history:** The earlier per-step mint/burn migrations were squashed into the baseline; the `mint_burn_events`, `mint_burn_hourly`, and `mint_burn_sync_state` tables now live in `0000_baseline.sql`. Migration 0096 adds per-config deferral, migration 0097 adds flow-classification query support, migration 0159 purges Re Protocol reUSD rows and resets the obsolete vault/canonical-token cursors, and migration 0178 adds historical valuation repair provenance and resumable aggregate verification. `worker/migrations/MANIFEST.md` is the lineage authority.

---


## API Endpoints

These headings remain stable for feature-document navigation. The exhaustive HTTP contract is owned by the linked endpoint sections in `docs/api-reference.md`.

### GET /api/mint-burn-flows

All API totals and series use closed UTC hours: `end=floor(now/3600)*3600`, `start=end-hours*3600`, with buckets in `[start,end)`. Responses publish `window: {start,end,semantics:"closed-utc-hours"}`; the open current hour is excluded. Aggregate chart hours vary, but coin counts, volumes, pressure and largest events use 24 closed hours ending at the same boundary; 7d/30d/90d nets share that end. Hourly retention cannot reconstruct rolling raw-event fragments.

Parameters, response fields, cache/freshness behavior, and errors are canonical in [Operator runbook: `GET /api/mint-burn-flows`](./api-reference.md#get-apimint-burn-flows).

Aggregate mode constrains configured `(stablecoin_id, chain_id)` pairs in SQL and selects the deterministic largest 24-hour event per coin there; the Worker does not materialize the full event day to compute that field.

Each aggregate coin row publishes `pressureShiftScore` as the sole baseline-relative score field. The former `flowIntensity` alias duplicated the same value and is no longer part of the response contract.

### GET /api/mint-burn-events

The event feed exposes the recent classified, valuation-aware ledger for one stablecoin. Safely settled, aggregated, and Tape-projected rows remain available for at least 8 days; the separate hourly aggregate keeps 90 days of public flow history. The detail-page history deliberately uses the counted view so bridge transfers, review-required burns, and atomic roundtrips do not appear as ordinary economic flow.

Filters, cursor/offset pagination, ordering, response fields, cache/freshness behavior, and errors are canonical in [Operator runbook: `GET /api/mint-burn-events`](./api-reference.md#get-apimint-burn-events).

### Operator CLI: backfill-mint-burn-prices

The recent cron path auto-heals bounded NULL-price debt; this operator path handles older history. It accepts only exact UTC event-day evidence from stored history or bounded historical providers, never current spot, peg par, or another day's price. Definitive no-source results become irreducible, transient provider failures remain retryable, and recovered rows stay `pending_aggregate` until every affected hourly bucket is rebuilt and verified. An interrupted run resumes aggregate verification before selecting new valuation work.

Auth, dry-run/confirmation/bookmark/idempotency requirements, parameters, dispositions, response fields, and errors are canonical in [Operator runbook: historical mint/burn prices](./runbooks/one-shot-backfills.md#backfill-mint-burn-prices). Use the [Mint/Burn Integrity runbook](./runbooks/mint-burn-integrity.md#historical-price-debt) for the operator sequence; live aggregate replacement also requires the [atomic import availability gate](./runbooks/one-shot-backfills.md#transport-safety).

### Operator CLI: backfill-mint-burn

Admin ingestion shares cron parsing, classification, persistence, aggregation, decode retries and safe-frontier policy. Default/live-tip scans anchor to parsed events or the indexing-safe empty frontier (`head-75`); explicit finalized historical chunks may advance fully. Decode failures hold the cursor below their block until re-observed successfully or quarantined on the third observation. Valid peers persist; every committed cursor follows successful hourly materialization.

Operator CLI arguments and execution/atomic-import guards, selection and range parameters, progression fields, reclassification counters, and errors are canonical in [Operator runbook: mint/burn ingestion](./runbooks/one-shot-backfills.md#backfill-mint-burn).

### Operator CLI: reclassify-atomic-roundtrips

This bounded repair applies the shared 0.5% same-transaction amount-tolerance rule in both directions: newly recognized mint/burn pairs become atomic roundtrips, while old atomic tags that fail the tolerance return to standard flow. Every affected hourly bucket is recalculated before a batch reports completion.

Operator CLI arguments and execution/atomic-import guards, scope parameters, batch progression, counters, and errors are canonical in [Operator runbook: roundtrip reclassification](./runbooks/one-shot-backfills.md#reclassify-atomic-roundtrips).

---


## Cron Metadata Fields

`syncMintBurn(...)` stores a JSON `metadata` blob on every run row in `cron_runs`. Operators consume it via `/api/status` and the merge-gate metadata checks. Current notable fields:

| Field | Type | Meaning |
|-------|------|---------|
| `lane` | `"critical" \| "extended"` | Which lane produced this run |
| `jobName` | string | Lane-specific run-state job key |
| `rowsRead`, `rowsParsed`, `rowsInserted`, `rowsIgnored`, `rowsDropped` | number | Ingestion throughput counters |
| `sourceCoverage` | object | `contractsProcessed`, `contractsSkipped`, `contractsEnabled`, `contractsDisabled`, `contractsTotal` |
| `configSamples[]`, `configBreakdownSummary`, `laggingConfigs[]` | mixed | Per-config diagnostics; the full breakdown is persisted separately under `runDrilldownCacheKey` |
| `apiErrors` | number | Provider errors observed while collecting configured contracts |
| `atomicRoundtripsDetected` | number | Rows tagged in-memory this run |
| `bridgeClassification.txContextShortfalls` | number | Transaction/receipt context lookup shortfalls for bridge-enabled configs |
| `bridgeClassification.deferredRows` | number | Parsed rows excluded from economic flow because bridge classification context was unavailable |
| `nullPricesHealed` | number | Rows valued this run by the shared ±24h event-time admission (event-day `supply_history` snapshot or in-window replay-safe `price_cache` observation; 48h window) |
| `degradedSignal`, `degradedStreak`, `coverageRatio` | mixed | Critical-lane health signals |
| `recalcFailed` | boolean | `true` when `recalcAffectedHours` threw during the run's `finally` block; critical lane downgrades `ok → degraded` when this is set |
| `recalcError` | string (optional) | Error message captured from the failed recalc call |
| `nullPriceBacklogRecent` | number \| null | Count inside the 48h auto-heal window, or `null` when the backlog read is unavailable |
| `nullPriceBacklogHistorical` | number \| null | Count of older NULL-valued rows, or `null` when the backlog read is unavailable |
| `roundtripsBacklogSaturated` | boolean | `true` when the cross-run roundtrip sweep hit its per-run limit and more candidate groups likely remain in the 7-day lookback window |
| `nullPriceBacklogAvailable` | boolean | `false` when the retried backlog metadata read failed; `nullPriceBacklog` and its count projections are unavailable rather than zero |
| `nullPriceBacklogError` | string (optional) | Bounded failure detail for an unavailable backlog metadata read |
| `budgetUsed` | number | Alchemy subrequests consumed by this run (emitted via `withBudgetMetadata`) |
| `budgetLimit` | number | Global subrequest budget for the run (default 200) |

---

## Frontend

### Page

**Route:** `/flows`
**File:** `src/app/flows/page.tsx`

Four sections, followed by a Timeline link:
1. **Hero Overview** — net-direction hero with the baseline-relative Bank Run Gauge, a literal 24h Minting Pressure gauge, and flight-to-quality badge. Headline copy is derived from aggregate `Net Flow 24h` direction plus the Bank Run Gauge pressure state; it does not imply cross-asset breadth unless a separate breadth signal is added.
2. **Per-Coin Flows** — sortable table with `Pressure vs 30D`, net 24h/7d, mint/burn volumes, and largest USD-valued event
3. **Aggregate Flows** — Recharts composed chart with 24h/7d/30d toggle; missing buckets render as gaps, remain unavailable in its accessible table, and are excluded from rolling averages
4. **Flow Interpretation + Mint/Burn Flow FAQ** — explanatory guidance and the mint/burn FAQ

The page then links to the Timeline for all mint/burn events.

### Hooks

**File:** `src/hooks/use-mint-burn-flows.ts`

| Hook | Endpoint | Stale Time | Notes |
|------|----------|-----------|-------|
| `useMintBurnFlows(hours?)` | `/api/mint-burn-flows` | `CRON_MINT_BURN` | Aggregate mode, no coin filter |
| `mintBurnFlowsCoinQueryOptions(id, hours?)` | `/api/mint-burn-flows?stablecoin=` | `CRON_MINT_BURN` | Per-coin query options (a factory, not a hook — used via `useQueries`), enabled only when ID truthy |
| `useMintBurnEvents(id, opts?)` | `/api/mint-burn-events?stablecoin=` | `CRON_MINT_BURN` | Paginated event feed |

All hooks use Zod schema validation for aggregate and per-coin responses (`MintBurnFlowsResponseSchema`, `MintBurnPerCoinResponseSchema`).

### Components

| Component | File | Description |
|-----------|------|-------------|
| `FlowBrrrOverview` | `src/components/flow-brrr-overview.tsx` | Overview shell used by `/flows`; renders the printer/shredder scene, Bank Run Gauge band, literal 24h minting-pressure gauge, and a `FlowReceiptBand` below a dashed tear-line carrying the 24h/7d mint/burn/net receipt tiles plus scope, top minter/burner, and coverage summary. |
| `FlowReceiptBand` | `src/components/flow-receipt-band.tsx` | Receipt-styled sub-component rendered inside `FlowBrrrOverview`. Shows 24h/7d printed/shredded/net tiles, with the full `/flows` mode including scope caveat, top minter/burner, coverage pills, and any sync warning. |
| `FlowChart` | `src/components/flow-chart.tsx` | Recharts composed chart: net-mint/net-burn bars, cumulative line, rolling-net band, and hourly tooltip. Missing hourly or daily buckets break the plotted series and render as `—` in the accessible table instead of becoming measured zeroes. |
| `FlowTable` | `src/components/flow-table.tsx` | Sortable per-coin table. Sort keys: net24h, mint24h, burn24h, net7d, net30d, net90d, largest USD-valued event, pressure (net30d/net90d columns hidden below lg/xl). Responsive column hiding; incomplete 30d/90d windows are marked `partial` because their values cover only the observed portion; `Pressure vs 30D` header uses the shared methodology-hint trigger. |
| `FlowEventFeed` | `src/components/flow-event-feed.tsx` | Paginated event table: time, direction badge, amount USD, chain, tx link |
| `MintingPressureGauge` | `src/components/minting-pressure-gauge.tsx` | Shared literal 24h mint-vs-burn gauge used by both the aggregate overview and stablecoin detail summary cards |
| `FlowSummaryCard` | `src/components/flow-summary-card.tsx` | Summary card for stablecoin detail pages: explicit net windows, `Pressure Shift vs 30D`, and a literal `Minting Pressure (24h)` gauge, plus contextual methodology hints / footer links for the flow model. Its 30d/90d cells use the API coverage flags and mark incomplete windows `partial`, matching the per-coin table. |

### Valuation Completeness Rendering

Frontend consumers read the additive `valuation` fields through `resolveMintBurnValuation()` / `resolveMintBurnValuationCompleteness()` (`shared/lib/mint-burn-valuation.ts`), so a payload without `valuation` is `unknown`, never complete. Presentation helpers live in `src/lib/mint-burn-valuation-display.ts` and `src/lib/mint-burn-coin-helpers.ts`; the shared `FlowSignedNetValue` / `FlowVolumeValue` components (`src/components/flow-valuation-value.tsx`) render them.

- **Signed nets** (`netFlow*Usd`, hourly `netFlowUsd`): `null` or a `partial` window renders the component's unavailable placeholder (`—` or `NR`) with an accessible reason naming the unpriced mint/burn event counts; a partial signed net is not a bound, so it is never shown as a number or `$0`. `unknown` keeps the value with a `*` coverage-unknown marker.
- **24h direction**: producers and client overview sums use `provenNetFlowDirection24h()` with per-side completeness, including legacy `unknown` windows whose old-method net stays visible. A partial older payload with a numeric net is re-derived by the same helper; an unproven direction renders "Direction unavailable", never `flat` or `No activity`.
- **Pressure shift**: a coin whose `window24h` or `baseline` valuation is `partial` renders `NR` with a partial-valuation reason, sorts last, and its baseline average daily net is withheld.
- **Gross volumes**: a non-complete side renders as a `≥` lower bound (known-valuation subtotal).
- **Client-side sums** (overview/receipt totals, home mini card, chart re-bucketing): any null or partial component makes the summed signed net unavailable; leaders and sorts rank only displayable nets. The aggregate chart draws no bar for a partial bucket, stops the cumulative line at the first one, and lists bucket valuation in its accessible table; the compare chart omits such hours.
- **Gauge**: `flightToQuality: null` renders "FTQ unavailable"; `partialValuationInputs > 0` adds a note that N weighted coins have incomplete valuation (pre-v6.23 payloads: partial inputs that entered the score; v6.23: coins withheld from it).
- No frontend CSV/NDJSON export carries mint/burn flow values.

### Dashboard Integration

`FlowSummaryCard` (`src/components/flow-summary-card.tsx`) keys machine visuals from the valuation-gated 24h direction (see [Valuation Completeness Rendering](#valuation-completeness-rendering)) and also renders the same literal `Minting Pressure (24h)` gauge used in the aggregate overview, while Bank Run Gauge band labels remain available for baseline-relative pressure semantics.

---

## Error Handling & Edge Cases

| Condition | Behavior |
|-----------|----------|
| No admissible price within ±24h of the event | `amount_usd` stored as NULL and the hour is `partial` (net unavailable, pressure NR); cron auto-heals recent rows (48h window) only with in-window evidence, and the admin endpoint handles older history |
| Fewer than 7 days of flow history | Pressure shift returns `null`; coin excluded from gauge weighting |
| No 24h mint/burn activity in a sparse window | Pressure shift returns `null` (NR) for that window; coin excluded from gauge weighting |
| All coins have null pressure shift | Gauge score returns `null`; frontend shows "Calibrating" state |
| Alchemy API error for a config | `apiErrors` incremented; sync state NOT advanced (retried next cycle) |
| Incomplete timestamp resolution | `apiErrors`/`errors` incremented; sync state advances only to the safe coverage frontier (`earliestMissingTimestamp - 1`), or not at all when no safe frontier exists |
| Undecodable event amount | Hold at the safe frontier for two retries; on the third observation quarantine only that log as `amount-decode-retry-exhausted` and advance past it |
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

During the Dwellir trial this lane never reaches the supplemental Dwellir operator (`excludeSupplementalRpc` on every batch call, including the conservation pre-pass), because mint/burn depends on full-history `eth_getLogs` while the trial's Dwellir endpoints are plan-capped at 500 blocks per request and zkSync answers pruned ranges with a silent empty result.

---

## Testing

**Files:**
- `worker/src/lib/__tests__/mint-burn-scoring.test.ts` — pressure-shift formula, gauge bands, composite gauge, flight-to-quality
- `worker/src/lib/__tests__/mint-burn-pipeline.test.ts` — shared parse/classification/persistence/sync-state behavior parity
- `worker/src/cron/__tests__/sync-mint-burn.test.ts` — cron ingestion orchestration and degraded-mode handling
- `worker/scripts/backfills/__tests__/backfill-mint-burn.test.ts` — operator backfill chunking, `done/nextFromBlock`, and sync-state progression
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
