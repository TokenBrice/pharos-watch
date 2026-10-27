# Mint/Burn Flow Tracker

> **Agent navigation** — Read the needed contract: Registry ownership · Open USD coverage review · Raw Token Conservation · Sync Algorithm · Scoring · Valuation Completeness · Retention · API Endpoints · Valuation Completeness Rendering · Circuit Breaker Separation. The registry owns the changing source roster; source and operator references use absolute URLs so this public page remains navigable.

On-chain mint and burn event tracker for stablecoins on their **configured issuance chains** via JSON-RPC (Alchemy alone, or enabled and admitted full-log Dwellir first with Alchemy second). Detects Transfer events (and USDT-specific Issue/Redeem events), aggregates them into hourly flow buckets, exposes per-coin raw `Net Flow` plus baseline-relative `Pressure Shift vs 30D`, computes a market-cap-weighted Bank Run Gauge, and flags flight-to-quality signals. Live ingestion runs in two lanes: a critical 30-minute lane for major coverage and an offset extended hourly lane (`:18`) for long-tail backlog drain.

Product scope note: the public `/flows` page now surfaces the configured issuance scope plus per-coin `coverage` metadata so partial history, lagging sync, or unknown current chain-head states are visible to users instead of implied as complete market-wide coverage. Current production scope is Ethereum for most tracked assets, with USDai tracked on native Arbitrum and Base Dollar tracked on native Base as their canonical issuance/redemption chains.

Configured contracts, exact start blocks, decoder/bridge bindings and dust thresholds are owned by `MINT_BURN_CONFIG_SPECS` in `worker/src/lib/mint-burn-contracts-data.ts`, not a release roster here. A configured start is not observed history: bootstrap/backfill and a fresh lane execution must establish current coverage. Other native deployments are not implicitly included. Fund-share mints can represent dividend reinvestment as well as subscriptions; token creation is not necessarily new investor cash.

The `/flows` page leads with the Bank Run Gauge hero (see [Page](#page)); its printed, shredded and net 24h facts and the folded 7-day receipt (weekly totals, top 24-hour minter and burner, coverage) use the existing 24-hour coin rows and 7-day hourly buckets. Their labels deliberately describe observed configured-chain events; they do not claim complete market-wide supply creation or redemption.

Operational freshness configuration is shared via `worker/src/lib/mint-burn-health-config.ts`:
- major-symbol baseline (`USDT`, `USDC`, `DAI`, `USDS`, `GHO`, `FRXUSD`, `BOLD`, `reUSD`)
- warning threshold (`6h`)
- critical threshold (`24h`)

Scheduled/http handlers apply env overrides on top of these defaults (`worker/src/handlers/scheduled.ts`, `worker/src/handlers/http/request-dispatch.ts`). Public `/api/health` now keys mint/burn freshness to the critical-lane sync timestamp / run status (the same semantics exposed by `/api/mint-burn-flows`) so quiet majors do not falsely mark the health surface stale just because no new events occurred.

Public `/api/mint-burn-flows` freshness assesses the confirmed critical-lane flow-generation clock using the shared availability ratios, not the latest attempt or cache write. The effective budgets are returned in `_meta.freshBudgetSec` / `degradedBudgetSec` (currently 8h / 12h); these endpoint availability bands are separate from lane escalation and the tighter Safety Score consumer budget used only by flight-to-quality.

Fresh and cached flow responses without a sync timestamp retain their body sync warnings and return `Cache-Control: no-store`, `X-Data-Age: unavailable`, and HTTP `Warning: 199`. Neither response-generation time nor cache-write time substitutes for the missing sync clock.

The detail flow card preserves that producer generation through successful refetches and failed refreshes with saved totals. Its local health notice shares the endpoint budgets and warning floors, ages without another fetch, and leaves an explicit unknown clock unavailable. Like the detail page health strip, it excludes only the typed flight-to-quality dependency and its matching advisory because the card renders coin totals, not the market-wide classification.

Mint and burn events measure token creation and destruction, not investor intent. USDai is the reviewed counterexample: a burn can release PYUSD from the hub for sUSDai loan deployment without an equivalent fall in protocol assets. Since methodology v6.21, individually reviewed events of this kind are tagged `flow_type='protocol_internal'` and leave counted flow; see [Reviewed protocol-internal events](#reviewed-protocol-internal-events). The public FAQ and USDai's curated chart annotation keep the measured burn visible without calling it a redemption or investor outflow.

---

## Methodology Versioning

- **Current methodology version:** <!-- GENERATED-START: methodology-version-mint-burn-flow -->`v6.30`<!-- GENERATED-END: methodology-version-mint-burn-flow -->
- **Public changelog page:** `/methodology/mint-burn-flow-changelog/`
- **Structured changelog:** `shared/data/methodology-changelogs/mint-burn-flow/`

The [public changelog](https://pharos.watch/methodology/mint-burn-flow-changelog/) owns releases and activation records. Current semantics are defined below: closed-hour windows, event-time valuation, verified bridge exclusions and one-sided partial-net bounds. Fixed-clock input/output comparison and owner review of changed outcomes, fresh admitted producer observations and separate production resource evidence are release prerequisites, not claims of completed repair or health. Replay cannot reconstruct pruned event evidence or automatically repair overadvanced historical cursors.

---

## Cron Schedule

The critical lane runs every 30 minutes at :04/:34; the extended lane runs hourly at :18. The critical job retains `sync-mint-burn` for freshness and escalation; `sync-mint-burn-extended` has its own rotation/run-state key and warning-only backlog semantics. Enabled, admitted full-log Dwellir runs before Alchemy ([provider order](#circuit-breaker-separation)).

Extended-lane health is a **full-pass verdict**, not a per-config age clock. `updateMintBurnAttemptState()` (`worker/src/cron/mint-burn/run-state.ts`) records the current pass start and the last completed pass in `mint-burn:attempt-state:sync-mint-burn-extended`; a pass completes only when every enabled config was actually attempted (or proven up to date) since that start; a provider deferral or an absent attempt record is evidence, not coverage, and cannot complete a pass (ADR-29). `completeMintBurnRun()` degrades the lane when the running pass exceeds `MINT_BURN_EXTENDED_COVERAGE_WINDOW_SEC` — 4 × the extended lane interval (240 min since the lane moved from 30 minutes to hourly on 2026-10-23), the named authority derived from the 129-config roster and 39–44 attempts per run in the 2026-10-18 mint/burn dossier — or a genuine failure exists (`apiErrors > 1`, a conservation mismatch, or a failed state/cache write). Rotation inside the window never degrades. Metadata publishes `coverageCycle.status` (`cycle-in-progress` while no pass has completed — neutral, never healthy-by-default; `complete` once a pass has finished and the running one is still inside the window; `stalled`), `coverageCycleSec` (duration of the last completed pass) and `expectedWindowSec`. The check runs at each lane start, so `stalled` appears on the first run whose pass age is strictly greater than the window. The critical lane keeps its coverage-ratio rules and publishes no cycle block. Losing the cache restarts the pass, so a cold lane reports `cycle-in-progress` rather than latching a stale age.

Extended placement precedes the `:22/:52` Safety Score fence to avoid overlapping its publication chain. Each physical alias is hourly: combining aliases into one sub-hourly expression would reduce Cloudflare's CPU class to 30 seconds, the exhaustion mode recorded as `platform-abandoned`. The [schedule and dispatch owner](https://github.com/TokenBrice/pharos-watch/blob/main/docs/worker-infrastructure.md#cron-scheduling) owns expressions; [per-job timeouts](https://github.com/TokenBrice/pharos-watch/blob/main/docs/worker-and-api-limits.md#per-job-cron-timeouts) own runtime ceilings.

`syncMintBurn()` returns actual inserted rows as `itemCount`, plus status and bounded lane/config coverage diagnostics. When a targeted sync warning exists, the UI suppresses a duplicate generic stale banner. Cached fallback preserves freshness-derived headers, not an extra transient-query warning while the dataset is fresh.
---

## Constants & Thresholds

The contract registry owns per-config dust thresholds, start blocks and lane selection. Dust is measured in token-native units; configured overrides are necessary where unit economics differ. Established coverage becomes lagging against the public freshness cadence translated to chain blocks, capped at 10K blocks.

The [Scoring](#scoring) section owns pressure/activity/flight-to-quality parameters. The [operational budget table](https://github.com/TokenBrice/pharos-watch/blob/main/docs/worker-and-api-limits.md#mint-burn-and-producer-metadata-budgets) owns global/per-config request caps, scan limits and self-deadline; they are not additive per-contract allowances. [Sync Algorithm](#sync-algorithm) owns finalized scan admission.

---

## Contract Configurations

**File:** `worker/src/lib/mint-burn-contracts.ts`

Token identity resolves from canonical per-coin metadata under `shared/data/stablecoins/coins/*.json` through the narrow `coins.worker-runtime.generated.json` identity/lifecycle/contract projection. `npm run check:runtime-reachability` rejects extended mint/burn and five-minute Telegram entrypoint paths back to the full registry. Tracker-specific fields live in `worker/src/lib/mint-burn-contracts-data.ts`; reviewed address/decimal overrides select secondary registered deployments such as BUIDL's second Ethereum share class. Both `reUSD` configs resolve their registered token contracts and track canonical zero-address `Transfer` events.

An address override inherits fixed decimals only from that exact chain/address in the selected primary or traded inventory (`any` searches both). An unregistered override requires reviewed `decimalsOverride`; neither another deployment's scale nor an assumed 18 decimals is permitted. Missing scale fails contract configuration through the existing required-resolution error, and native XRPL issued-currency amounts remain outside fixed-unit event resolution.

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

Aggregate FTQ carries one classification source and machine-readable `gauge.classificationReason`. When classification is unavailable, `flightToQuality` and `flightIntensity` are both `null`, never an inactive/zero observation. Its independent `_meta.dependencies.flightToQuality` entry names the accepted Safety Score publication's `generationId`, original `updatedAt`, assessed age, status/reason and `freshBudgetSec`. That consumer budget is two publication refresh intervals (currently 2h / 7,200 seconds), sourced from `SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC`; a fresh flow generation does not renew it.

Fresh materializations, cached reads and fallback reads expose the same FTQ state, dependency evidence, `sync.classificationWarning` and HTTP advisory. Every aggregate cache read re-admits the small canonical index, including previously unavailable entries. A newly admitted identity reclassifies the stored 24h coin nets under the existing valuation gates, removes the old classification warning, and never changes the flow observation or sync clock. Missing/held/stale/index-read-failed sources remain explicitly unavailable. Per-coin responses do not load Safety Scores or carry this market-wide dependency.

Per-config adapter provenance is now surfaced through coin `coverage` metadata:
- `adapterKinds` — active decoding families for the coin (`transfer-zero-address`, `custom-events`, `mixed`)
- `startBlockSource` — whether the earliest tracked block is a reviewed contract-specific bound or a blanket default coverage floor
- `startBlockConfidence` — qualitative confidence on historical completeness (`high`, `medium`, `low`)
- `status` — `full`, `partial-history`, `lagging`, `bootstrapping`, `unknown`, or `disabled`; `unknown` means either no admitted continuous history reaches the selected window end or the chain head needed to measure current lag is unavailable. `bootstrapping` means some history reaches that end but the full 24-hour window is not admitted.

Windows use a common closed-hour watermark across the complete active configured roster: the minimum accepted current-fingerprint scan end, rounded down to a UTC hour. `window.watermark` exposes its timestamp, assessed age, effective public freshness budget and machine-readable failure reason. This uses the same effective fresh budget as the endpoint's `_meta.freshBudgetSec`, not the base producer cadence. Missing or over-budget frontiers fail closed; aggregate and per-coin totals, largest events, net windows and complete-day baselines all use the selected end rather than silently pretending the rotating extended lane reached the latest hour.

Historical admission has two explicit assurance regimes. At and after `MINT_BURN_LEGACY_CUTOVER` (2026-10-20 12:00 UTC), exact current-fingerprint v2 proof is required. Earlier hours may use the bounded pre-T1 cursor/event rule: retained hourly evidence plus a scanned cursor span anchored to an observed pre-cutover scan timestamp, with the frozen cutover source identity. It never anchors history to the request clock or treats an old fingerprint as v2 proof. The coverage/window provenance is `legacy-pre-cutover` whenever this weaker historical assurance is used; otherwise it is `durable-v2`. All configured contracts must qualify, dirty-hour debt vetoes both regimes, and existing valuation gates remain unchanged. Missing raw history is not rebuilt from pruned events.

The cutover is the last complete UTC-hour boundary before the 12:03 deployment and first T1 producer at 12:05:04; its boundary hour belongs entirely to v2. The transition expires when the longest 90-day window no longer overlaps it: remove the branch and frozen identity snapshot after 2027-01-18 12:00 UTC plus the effective watermark freshness budget. No D1 migration or synthetic proof write is involved.

Current rule: the March 24 long-tail transfer wave that inherited the blanket `21_900_000` Ethereum floor is labeled `startBlockSource = default-coverage-floor-2026-03-24` and `startBlockConfidence = low`, so the public API no longer implies contract-specific historical certainty where none exists.

Events are also classified by `flow_type` (`standard`, `bridge_transfer`, `atomic_roundtrip`, or `protocol_internal`) so non-economic bridge transfers, same-tx roundtrip noise, and reviewed issuer-internal movements stay out of aggregate flow metrics.

### Open USD coverage review (2026-09-30)

Open USD (`ousd-open-standard`, issued by Bridge) is distinct from Origin Dollar (`ousd-origin-protocol`). The [issuer's reserve page](https://reserves.bridge.xyz/ousd) binds its Ethereum, Base, Tempo and Solana deployments. The extended lane indexes Ethereum and Base with six decimals, canonical zero-address `Transfer` events and a 10,000-token dust threshold ($10,000 at peg). Both use explicit primary-contract configs and reviewed code-deployment bounds, rather than the default Ethereum coverage floor. Small test mints/burns are deliberately below the economic-flow cutoff.

Reviewed deployment bounds are config-specific, not the default Ethereum coverage floor; their provenance belongs with the registry and [reviewed conservation sidecar](https://github.com/TokenBrice/pharos-watch/blob/main/worker/src/lib/mint-burn-conservation-reviewed.json). The decoder counts exactly one canonical zero-address `Transfer` per mint/burn, not duplicate custom issuer events.

**Intentional chain gaps:** Tempo is the dominant issuance chain (about 91% of supply). Although `chain-registry.ts` declares Tempo Dwellir archive state/full log history, mint/burn also requires a supported Alchemy URL (`ALCHEMY_CHAINS` excludes Tempo), and registry support alone does not admit a chain. Revisit Tempo routing only after reviewing TIP-20 event semantics and deployment history for admission. Solana is also excluded: the lane has no Solana supply-event decoder or RPC ingestion path. Its trigger is a supported Solana mint/burn adapter. No bridge-detection hints were added without verified CCIP, CCTP or LayerZero attribution.

Ethereum remains the configured canonical chain for DEWS/digest aggregation. The override map could select Tempo even with an Ethereum config, but doing so before Tempo ingestion would exclude all observed OUSD pairs from canonical metrics. Switch the override to Tempo when that config is live. Ethereum/Base together represented about **5.26%** of issuer supply at review: pinned supply reads at Ethereum block 26,091,490 and Base block 51,998,181, compared with the reserve page's 477,309,854 total; Tempo block 41,973,289 was read through `https://rpc.tempo.xyz`. These flows do not represent whole-coin issuance.

The public flows table describes configured issuance chains, and the per-coin API returns `scope.chainIds`. The detail-page `flow-summary-card.tsx` instead consumes the aggregate `useMintBurnFlows()` response; its coin `coverage` metadata has no chain IDs, so that card does not name the coin's configured chains. Coverage status measures scanned-history maturity/freshness, not the fraction of global supply indexed. This is an existing cross-coin disclosure limitation.

**Conservation decision:** Ethereum is admitted under the exact `transfer-supply` law. The [verified StablecoinTemplateV3 implementation](https://eth.blockscout.com/api/v2/smart-contracts/0x264048239dd1b5939599fae8e6000df40248d524) routes mint, wrap, burn, unwrap and blocked-address burns through stored-sum supply updates with exactly one matching zero-address `Transfer`; ordinary transfers reject zero endpoints. Two hash-pinned archive windows, boundary blocks 26,077,249-26,084,420 and 26,084,420-26,091,591, each returned an exact zero residual. Implementation-slot and six-decimal reads matched at all three boundaries, with no in-range `Upgraded` logs. Base is explicitly unsupported with `unverified-implementation-source`: the [B20 specification](https://docs.base.org/specifications/b20) explains the native token surface, but its canonical Solidity interfaces do not verify the deployed native implementation or every supply-storage writer. Base's two archive windows also passed; that observation alone does not close the source gap. Both decisions are recorded in the reviewed sidecar. Revisit Ethereum on implementation changes and Base when version-pinned native source or a justified source exception permits a complete supply-path and zero-address pairing review. Origin Dollar's vault-yield law does not apply to Open USD.

**Budget impact:** two additional serial extended-lane configs, each capped at 25 requests within the unchanged 200-request run ceiling. A simple complete scan adds four `eth_getLogs` requests (mint/burn per deployment), plus candidate-block timestamp batches; range splitting/backfill can consume up to 50 requests across the pair. Ethereum admission adds two hash-pinned `totalSupply()` calls and up to four boundary-header calls (initial reads and rechecks), pooled into the existing three chain-wide pre-pass phases of up to 100 calls per POST and charged to the global budget. It adds no guard views or conservation-only log scans; unsupported Base adds no conservation reads. Existing Ethereum/Base contexts avoid additional chain-head requests, and neither config is bridge-aware. Initial catch-up needs roughly 20 Ethereum and 68 Base 50,000-block ranges at the observed heads; cursor rotation and deferral remain unchanged.

### Reviewed protocol-internal events

`shared/lib/reviewed-protocol-internal-flows.ts` holds individually reviewed events that moved tokens inside an issuer's own balance sheet, each with its block timestamp. `persistMintBurnRows()` applies it through `applyReviewedProtocolInternalFlows()` (`worker/src/lib/mint-burn-pipeline/reviewed-protocol-flows.ts`) after atomic-roundtrip detection, in both the cron and `npx tsx worker/scripts/one-shot-backfill.ts backfill-mint-burn --execute --allow-atomic-import` paths, so a replay over the event's block rewrites the stored row and recalculates its hourly bucket. Matching requires the exact event id (chain, transaction hash, log index), stablecoin, chain, direction, and the reviewed token amount; a row whose amount drifts keeps its normal classification unless it independently matches the supply-exclusion rule below. The homepage Biggest Supply Moves card reads the same registry and leaves a coin out of its week-over-week ranking while a reviewed event sits inside the comparison (see [Homepage](https://pharos.watch/)).

The narrow address-level exception is inventory already curated as non-circulating in `CURATED_ONCHAIN_SUPPLY_EXCLUSIONS` (`worker/src/lib/onchain-supply-exclusions.ts`). At the same persistence stage, `applySupplyExcludedProtocolInternalFlows()` tags mints to and burns from those holder addresses as `protocol_internal`, matching the coin and chain exactly and the counterparty address case-insensitively. These inventory movements cannot change circulating supply. Burn classification is preserved; the rows remain visible in the event ledger but leave all counted hourly totals, nets, pressure, baselines, Bank Run Gauge, DEWS flow and digest inputs. The existing classification UPDATE rewrites duplicate stored IDs after INSERT OR IGNORE, including non-standard mints, and replay rebuilds their affected hours. Historical rows require replay; changing the rule alone does not repair stored aggregates.

Everything else still requires per-event review: the USDai vault-to-loan deployment used a contract path that can also redeem. The reviewed registry owns exact event identity, evidence and original timestamps. `reviewedProtocolInternal` counts only exact reviewed-event matches; address-tagged rows contribute to the existing non-standard `flowTypeChanges` count. Frontend supply surfaces already use circulating balances with these inventory exclusions, so they need no additional event-based suppression for address-tagged rows.

### Event Detection

**Standard mint/burn:** ERC-20 `Transfer(address,address,uint256)` events filtered by zero address.

- **Mint:** `topics[1]` (from) = zero address
- **Burn:** `topics[2]` (to) = zero address

**A burn-shaped event is not always supply destruction.** The reviewed conservation sidecar is the sole identity authority for the `zero-address-transfer-without-supply-change:` finding. For those exact chain/token/address/decimal identities, a zero-recipient Transfer first remains a non-counted `review_required` observation. Agora `Burned`, BoringVault `Exit`, and Maple `Withdraw` receipts can prove internal/batch burn paths: the token emitter, indexed owner, native share amount and complete receipt tuple multiplicities must match, not just a transaction-wide topic. Collateral amounts never substitute for share amounts.

For reviewed Transfer-only burn paths, admission requires a successful transaction addressed directly to the token, its complete source-reviewed calldata, matching owner/amount and a unique token burn in the same block-bound receipt. A burn selector on a router is not evidence of an internal call. Internal calls without a separate source-backed receipt proof remain `review_required`; missing or malformed context is `supply-proof-context-unavailable`, not an effective burn or a dropped observation. Other conservation exclusions, such as rebasing supply or unverified source, do not trigger this filter.

Each config scan reconciles at most twenty retained legacy burn rows after current ingestion, within its existing request budget and deadline. Candidates start at the first whole hour at or after the canonical raw-retention cutoff; an older surviving event cannot prove that its already-pruned siblings are available for rebuilding. Every reviewed classification update atomically records its affected hour in the durable maintenance debt; the existing independent drainer rebuilds the canonical hourly bucket. Unavailable context remains retryable. Raw events remain retained, and no exact correction is claimed for hours whose raw evidence has expired.

The per-config `mint-burn-supply-proof-cursor:v1:` key advances by `(timestamp,id)` only after attempted classifications and their debt persist. Unavailable receipts keep `supply-proof-context-unavailable` and remain retryable; a short/exhausted page wraps the next sweep instead of letting twenty unavailable oldest receipts starve later rows.

**USDT Ethereum special handling:** Public flows track custom `Issue(uint256)` and `Redeem(uint256)` treasury events (adapter kind `custom-events`); neither issuance path emits the canonical zero-address `Transfer` pair. Transfers to zero can occur without changing USDT supply and must not be treated as burns. `DestroyedBlackFunds` is conservation-only evidence, not a public flow event.

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

Before scanning configs, a serialized boundary pre-pass pools eligible ranges by chain/ordered endpoint list: distinct boundary headers, hash-pinned supply calls, then header rechecks. Admitted, enabled Dwellir is first for supported operations, then the existing Alchemy endpoint. Arbitrary historical supply/guard state requires Dwellir archive capability separately from log/header eligibility; recent-only BSC cannot supply old conservation state. Each phase is chunked at 100 calls per POST and charged to the global budget, not per-config budgets. Each POST has a 15-second timeout capped by the remaining 45-second pre-pass allowance or lane deadline. Failures affect dependent configs only. Raw logs are reused rather than scanned again; configs fence and persist individually, but cursors commit only after successful hourly recalc. Interior log block identities remain provider evidence; boundary checks do not retrieve every interior header. Exact conservation detects unmatched omitted events, not omitted offsetting mint/burn pairs.

Boundary-header responses must validate the requested block number, nonzero 32-byte hash and timestamp before an endpoint's JSON-RPC success is accepted. Null or malformed initial/recheck headers retry only the unresolved calls on the next admitted endpoint, within the existing global request budget and pre-pass deadline. If no endpoint supplies a valid header, the audit remains `unavailable` with `invalid-boundary-header`; it is not a positive conservation claim or evidence of a reorg. Only a changed identity between two validated reads of the same block is `boundary-reorg`; that remains an immediate write/cursor fence and run degradation, without retrying away the discrepancy. Diagnostic header-read unavailability alone does not degrade a completed critical or extended ingestion run; its unavailable count and reason remain visible separately. These rules do not change the scan head, confirmation policy or public flow methodology.

The committed evidence sidecar `worker/src/lib/mint-burn-conservation-reviewed.json` is the only list of admitted and explicitly unsupported identities: one entry per config identity (chain, stablecoin id, lowercase address, decimals) carrying the reviewer's identity evidence (explorer-verified source, external address match, on-chain decimals) and supply-path review, with admitted entries carrying audited windows proving the reviewed law exactly. A config with no entry falls back to `unreviewed-contract-or-event-semantics`. Admission requires the exact reviewed identity and compatible event adapter: ordinary zero-address `Transfer` semantics with `transfer-zero-address`, or reviewed `config-events` semantics with `custom-events`. An `unsupported` entry carries a reason from the fixed vocabulary in `worker/src/lib/mint-burn-conservation.ts`: literals `rebasing-supply-without-events`, `total-supply-override`, `deprecated-upgrade-forwarding`, `unverified-implementation-source`, or a reason beginning with `unpaired-supply-path:` or `zero-address-transfer-without-supply-change:`. `m-m0` is explicitly unsupported with `rebasing-supply-without-events` because its index accrues over time. `npm run audit:mint-burn-conservation-admission` produces, replays and merges this evidence. The Worker runtime never parses the evidence file: eligibility resolves from the generated lookup `worker/src/lib/mint-burn-conservation-runtime.generated.json` (identity, disposition, reason and runtime params projected from the sidecar by a registered generator; `npm run check:generated-artifacts -- --only=mint-burn-conservation-runtime` guards drift), keeping the evidence out of the isolate bundle.

Supply-burn admission uses the same sidecar's source-reviewed `supplyBurnProof` projection without changing raw-law admission. A proven individual economic burn does not make a generally false Transfer conservation law valid, and an unsupported raw law is not a verified conservation mismatch. Economic `flow_type` exclusions (bridge, atomic roundtrip and issuer-internal activity) remain independent of proven supply destruction.

The permanent admission CLI (`npm run audit:mint-burn-conservation-admission`) records a redacted RPC journal and can replay it offline. Audit-only operation and `--emit-sidecar-draft` do not alter the reviewed sidecar. Reviewer semantic files describe source/control/supply-law evidence; they do not substitute for complete passing audited windows. Only explicit `--merge-into-sidecar` mutates admission authority and regenerates its runtime lookup. Retain journals and restore the sidecar/lookup pair together; never bypass the conservation fence to undo a review.

The BRSRV, CHFSAFO and GLDon Ethereum flow additions have explicit conservation reviews. CHFSAFO and GLDon use the existing stored-supply `transfer-supply` law after exact implementation-path review and two complete, disjoint 7,200-block archived windows; the reviewed CHFSAFO windows are quiet, so they establish boundary conservation rather than observed dealing throughput. BRSRV is explicitly unsupported with `total-supply-override`: its verified `StandardToken.totalSupply()` converts stored shares through an external rebasing-provider service instead of returning a stored token sum. Its two sampled windows pass the arithmetic, but do not establish that generic law or prove active rebasing. This exclusion does not remove configured `Transfer` flow ingestion or waive its separate bootstrap/backfill requirement.

Reviewed alternative laws are exact, without tolerance: USDT's `config-events` sums Issue mints minus Redeem and conservation-only DestroyedBlackFunds burns, guarded by `deprecated()` being false at both boundaries. Origin Dollar's (`ousd-origin-protocol`) `transfer-plus-vault-yield` adds vault `YieldDistribution` yield minus fee to the zero-address Transfer net; it requires each distribution to pair with a later `TotalSupplyUpdatedHighres` in the same transaction, rejects legacy checkpoints and saturated rebases, pins mutual token/vault identity at both boundaries, and rejects in-range proxy upgrades. USDO's `usdo-bonus-multiplier-shares` replays `BonusMultiplier` in block/log order from the opening view, folds each Transfer amount `A` into `floor(A * 1e18 / multiplier)` shares, and requires net shares to equal the `totalShares` delta. Its replay must match the closing multiplier view, `totalSupply = floor(totalShares * multiplier / 1e18)` must hold at both boundaries, and pinned implementation identity plus the upgrade guard must hold; its record arithmetic units are `raw-shares`.

Conservation-only events are fetched in the same scan, using each definition's emitter when supplied, but never become public flow rows or enter config-event row correspondence checks. Their fetch failures or partial coverage make the audit incomplete without independently counting as ingestion API errors or blocking otherwise valid config-event cursor progress. Public Mint/Burn Flow methodology is unchanged.

Evidence uses existing `cache` rows at `mint-burn:conservation:<configKey>`, with monotonic writes and a fingerprint covering the audited configuration. Storage is one compact latest record per audited contract, not a growing event archive. Unresolved verified mismatches survive unavailable follow-up attempts and clear only after a verified passing audit covers the entire failing range for the same identity. Changing a config invalidates old proof. Cache write failures surface through the producer rather than pretending evidence was published.

A verified native mismatch fences cursor advancement and immediately degrades the affected run so the same range can be retried. The fence is also a write barrier: a conservation-fenced attempt (verified mismatch, unreliable raw-log/boundary evidence, or parser correspondence failure) persists no rows into `mint_burn_events`, so rows whose event set was never conservation-verified cannot outlive the fence — a later clean retry that covers the range writes only the rows it re-observed, and its persisted-row readback verifies exactly those. Invalid raw identity or parser/stored-row correspondence evidence is likewise not allowed to advance as a clean scan. Pure audit capability/budget unavailability does not independently stall otherwise valid ingestion or count as an ingestion API error; separate conservation counters expose audit failures and unavailable attempts. The operator verdict stays unverified, and existing partial-coverage, timestamp, bridge-context and persistence rules continue to govern progress.

The operator view reads cached evidence only, displays each latest audited range separately, and never treats the old timestamp-less circulating-supply delta as a critical ingestion verdict. The [public status dashboard](https://pharos.watch/status/) presents these diagnostics; conservation does not change event cutoffs, classifications, counts, valuation or flow formulas.

## Sync Algorithm

`syncMintBurn()` in `worker/src/cron/sync-mint-burn.ts` composes one invocation-local `MintBurnRun` from `worker/src/cron/mint-burn/run.ts`. The aggregate coordinates run-state/rotation, config scanning, hourly materialization, staged cursor commits and completion, owning the shared `lastBlocksAfterRun`, `pendingCursorUpdates` and `affectedHours` maps. `run-state.ts`, `run-configs.ts` and `run-completion.ts` remain its focused state, scan and terminal-materialization collaborators. Recalc still runs in `finally`; moving ownership does not change failure propagation, cursor fencing, retention or lane-specific cache invalidation.

| Boundary | Invariant |
| --- | --- |
| Selection and progress | Lane-specific cursors rotate enabled configs. Extended admission reserves minimum scan cost for half the rotated roster before hot-config headroom; the next run resumes at the first capacity-deferred config. Error deferrals protect healthy work. Deadline/budget stops are incomplete coverage, not successful emptiness. |
| Provider frontier | Resolve each enabled issuance chain's `finalized` header through CHAIN's capability-aware header reader before conservation boundaries or log queries. Its validated number is the scan ceiling for fetching, parsing, persistence, materialization and cursor advancement; neither the raw tip nor a common block margin is a finality guarantee. Dwellir-first scans and fallback additionally use that endpoint's own observed head, cached only within this run, so a lagging fallback cannot inherit a higher provider head. Adaptive splitting retains only a proven contiguous prefix. Timestamp/receipt caches bind to the event's block hash; mismatches hold the frontier. Dust-only blocks need no timestamp. |
| Decode/classification | The first two amount-decode failures hold below the row; the third observation quarantines only it as `amount-decode-retry-exhausted`. Valid peers persist. Required unresolved bridge transaction/receipt context withholds that transaction, not its healthy peers, and keeps the safe retry frontier. Malformed provider members are quarantined separately. |
| Event-time valuation | Use only actual price observations within inclusive ±24h of the event and passing historical peg plausibility. `supply_history` requires recorded `price_observed_at`, never the UTC day label. Cache evidence must also be replay-safe and observed, never nominal par (including old nominal `protocol-redeem`). Closest qualifying observation wins; ties keep the snapshot. Missing/invalid/future clocks and old unclocked history cannot value an event. Persist the evidence clock, not run time; absent evidence leaves NULL, including NAV weekends/holidays. |
| Persistence and cursor commit | Deterministic event IDs make inserts idempotent. Stage, but do not commit, frontiers until affected hours materialize. Complete eventful and quiet scans advance to the same admitted finalized range end. Admissible exhaustive scan proof commits with its cursor in one atomic D1 batch, only after materialization succeeds. Logs outside the requested range never enter parsing or persistence. Partial scans stop before the earliest uncovered log/timestamp/context/retryable decode, never beyond the covered range. No safe frontier means no advance. |
| Materialization | Recalculate each affected hour from stored events with atomic delete+insert, counting only standard mints/effective burns. Recalc runs in `finally`, including partial failure and duplicate-only replay. Only successful recalc commits staged cursors monotonically; recalc failure or cancellation holds all staged cursors and reports failure (`recalcFailed`/`recalcError`, critical ok → degraded). Abort signals cover persistence, recalc and post-run work. |
| Repair and terminal status | Non-error runs inspect at most 500 recent NULL-price rows and heal at most that many through the same event-time admission, skipping evidence-less coins. A durable descending `(timestamp,id)` keyset in the existing cache advances past ineligible same-coin rows across runs; new arrivals cannot continually displace older candidates. Older/unhealable debt remains for operator repair. Backlog read failure is unavailable, never zero. Cross-run roundtrip sweeps recalculate changed hours. Critical coverage/API failures escalate with streaks; extended backlog is warning-only because it is judged by full-pass completion inside the [coverage window](#cron-schedule), so an unfinished rotation inside that window is not a failure. Active progress keeps stage/budget observability live. |
| API caches | Successful ok/degraded runs invalidate versioned flow caches. Critical/manual-all purge the full `FLOW_CACHE_PREFIX`; the scheduled critical sidecar republishes aggregate 24h/7d windows. Extended purges only coin responses, preserving the gauge until critical publication. |

Aggregate sidecar completion uses HTTP publication success and the canonical `X-Data-Freshness` flow verdict, not the presence of an HTTP `Warning`: optional Safety Score/flight-to-quality dependency advisories remain in per-window sidecar metadata without turning a completed fresh scan/publication into incomplete required work. Missing or non-fresh flow freshness still degrades the run (`mint-burn-aggregate-freshness-unavailable`); failed publication names `mint-burn-aggregate-publication-failed`. A primary scan failure retains its own reason.

Finality coverage is derived from enabled `MINT_BURN_CONFIGS` and the runtime-admitted endpoints returned by `mintBurnRpcEndpoints()`. CHAIN's `finalizedTagUnsupported` capability excludes that endpoint from finality reads, independently of historical log/state support. Missing, refused or malformed finalized headers produce per-config/event coverage reason `finality-head-unavailable`, `finality.unavailableChains` in cron metadata, and immediate degraded status (including the extended lane); unaffected chains continue. No tip fallback or successful quiet-zero claim is synthesized for the unavailable chain. A validated conservation `boundary-reorg` remains a write fence and immediate degradation, not a diagnostic finality-read failure.

Timestamp batches admit one complete `{number, hash, timestamp}` header per requested block: the number must match, the hash must be 32-byte hex, and the timestamp must be positive and safe-integer. Duplicate IDs invalidate that member, out-of-range IDs are ignored, and unresolved members retry within the existing budget. Timestamp and hash are never taken from different responses; expected event hashes still gate cache writes. Legacy unpinned readers require the same complete header without acquiring a new freshness policy.

Prospective `mint_burn_scan_coverage` segments bind config identity and a versioned source/decoder fingerprint to inclusive block ranges, validated first/last block timestamps and `finalized` authority. Every configured public event topic must be exhausted, required row context resolved, and no decode quarantine present before staging proof, including quiet scans. Boundary headers use the existing serialized request budget; missing/invalid boundaries or incomplete scans leave that interval unproved without relabelling legacy cursor progress. Only same-fingerprint adjacent/overlapping block intervals merge; elapsed time cannot bridge a failed/unscanned block, old-writer interval or registry/source revision. All older fingerprints and segments remain retained, including evidence needed by the longest 90-day window. Closed UTC 24h/7d/30d/90d coverage requires admitted continuous block/time evidence spanning both exact boundaries for every required config/chain; no events is not evidence of coverage.

**Counterparty resolution (default):** mints read `topics[2]` (recipient), burns read `topics[1]` (sender); a config's `counterpartyEncoding` override changes the slot (see Event Detection).

**Event ID format:** `"{chainId}-{txHash}-{logIndex}"` — deterministic, prevents duplicates via `INSERT OR IGNORE`.

---

## Shared Ingestion Pipeline Boundaries

Cron and admin backfill share `worker/src/lib/mint-burn-pipeline/` finalized-head admission, range-bounded log fetching, parsing, classification, event-time price resolution, persistence, hourly materialization and decode retries. Neither entrypoint imports the other. Both use monotonic-max sync-state commits; a partial replay cannot regress or overadvance a cursor. Explicit historical backfills retain complete-range advancement when the requested range is below the validated finalized ceiling; near-head requests are capped to that ceiling, never to an assumed 75-block margin. The [operator path](#operator-cli-backfill-mint-burn) additionally aborts an incomplete chunk instead of committing its resolved subset. This cutover does not remove previously stored orphan rows: any historical repair needs retained canonical evidence and audited row replacement/materialization, not a cursor rewind alone.

`flow_type` is orthogonal to burn classification: bridge, atomic-roundtrip and individually reviewed protocol-internal events stay outside economic aggregates. Raw conservation still sees them. Tape excludes bridge/protocol-internal rows, but a previously projected reviewed burn remains a true historical event; reclassification is not evidence that it never happened.

Cron metadata includes `atomicRoundtripsDetected`, an observability counter for how many rows were tagged during the run.

Recent price healing, historical price repair and the cross-run roundtrip sweep use `materialization-debt.ts`: each bounded maintenance transaction commits its source mutation with all affected stablecoin/chain/hour keys in `mint_burn_dirty_hours` (migration `0280`). Rebuilding reads current raw events in SQL, then finalizes applicable priced `pending_aggregate` repairs and deletes that hour's debt in the same atomic batch. A mutation committed before rebuilding is included; a later mutation re-enqueues the hour. Classification alone never recovers an unpriced event. Failed rebuilds retain durable debt and raw rows. Completion independently seeds and drains bounded debt after the candidate maintenance stages, even if those stages find nothing or fail; it does not rewind ingestion cursors.

Every bucket delete, raw-row rebuild and priced-repair finalization requires the matching durable debt key to exist **inside the same atomic batch**, with debt deleted last. A stale second drainer is a no-op once another drainer has settled that key, even if retention has since removed some or all raw siblings; retained hourly history is not reconstructed from a pruned source. The primitive returns only hours actually rebuilt, so historical repair neither verifies stale no-ops against pruned raw rows nor reports them as its own rebuilds.

The ledger is prospective: neither event age, cursor state nor cron metadata backfills v2 proof. The scheduled scanner stages proof through `scan-coverage.ts`; generic/operator cursor commits without accepted proof remain unproved. The bounded pre-cutover reader transition above is separately labelled weaker assurance, never a ledger mutation. Worker rollback keeps the additive table and prior segments.

Cursor advances require proof ending at that block. An unproven live range gets at most four attempts/config/run within existing request budgets. A known timestamp/decode failure or partial-topic frontier selects the retry endpoint immediately before the failure; otherwise the range halves from the same start. Every prefix is re-scanned with fresh conservation boundaries, never certified from a candidate frontier alone. Live admission funds paged logs, a cold provider-head read when needed, event timestamps and proof headers; retry reservations also fund the three conservation-boundary batches. The extended roster's log-query reservation is a soft target: configurations that cannot afford a complete scan/proof are capacity-deferred and rotated, not attempted with a doomed log-only budget. First-block failure remains `scan-coverage-unproven`, never skipped (`scanAttempts`, `scanAttemptRanges`). Separately, each lane replays up to four coverage gaps/run (10,000 blocks/config, 40 reserved requests, 60 seconds), prioritizing current-fingerprint internal/tail holes within whole raw-retained hours (eight days). Proofs follow event persistence and hourly materialization, with monotonic-max cursor commits and `coverageRepairs` reasons. No synthetic proof or rebuilding older hourly-only history from pruned raw rows.

Before the conservation prepass, an initial range whose paged scan/proof cost exceeds its per-config request cap is repeatedly shortened from the same start until it fits. The prepass and scanner use that identical planned range; subsequent runs continue from its certified end. Oversized ranges therefore cannot remain permanently deferred merely because the global budget is larger than the per-config cap.

### Bridge Classifier

Dispatch and per-protocol fingerprint logic now live in three co-operating modules instead of one monolith:

| Module | Responsibility |
|--------|----------------|
| `worker/src/lib/mint-burn-bridge-classifier.ts` | Dispatcher: normalizes tx context, walks per-row fingerprints, and writes `flow_type = 'bridge_transfer'` plus (for burns) `burn_type = 'bridge_burn'` |
| `worker/src/lib/mint-burn-bridge-classifier-protocols.ts` | Per-protocol helpers: CCIP/CCTP router matching, LayerZero OFT signal fingerprints, generic pool/router address heuristics |
| `worker/src/lib/mint-burn-bridge-classifier-types.ts` | Leaf module with shared types (breaks the classifier ↔ protocols import cycle) |

Key behavior changes forward-going:

- **Mint-side tagging for CCIP/CCTP.** Bridge mints are `flow_type='bridge_transfer'` and excluded from issuance, covering USDO, USD1, avUSD and ZCHF (CCIP), and USDC/EURC (CCTP). CCTP source-side deposit topics/selectors are unchanged. Destination recognition requires a paired `MessageReceived(address,uint32,bytes32,bytes32,uint32,bytes)` log from Circle's reviewed Ethereum MessageTransmitterV2, a `MintAndWithdraw(address,uint256,address,uint256)` log from the reviewed TokenMessengerV2 naming this config's registry-resolved token, and a matching zero-address token `Transfer` (recipient and raw amount) in the same receipt. A generic or wrongly emitted `MessageReceived`, or a receive for another token, cannot tag the config's mint. Identity source: [Circle mainnet contract addresses](https://developers.circle.com/cctp/references/contract-addresses); event semantics: [MessageTransmitterV2](https://github.com/circlefin/evm-cctp-contracts/blob/master/src/v2/MessageTransmitterV2.sol) and [BaseTokenMessenger](https://github.com/circlefin/evm-cctp-contracts/blob/master/src/v2/BaseTokenMessenger.sol).
  Destination CCTP tags only parsed mint rows matched by receipt log index to the recipient Transfer and, for nonzero `feeWord`, the subsequent fee Transfer made by the reviewed TokenMinterV2 before `MintAndWithdraw`. Unrelated same-transaction mints/burns stay standard; the recipient amount is net of fees, not the gross message-body amount.
- **LayerZero endpoint-only signal.** The OFT/OAdapter path now accepts a third fingerprint (`fingerprintC`) that fires when the transaction context contains both a known LayerZero endpoint topic and an expected emitter address, even without the classic pool-address match (`hasSignalTopic && hasExpectedEmitter && signalEmitterSet.size > 0`). This catches LayerZero-Executor-only mints that previously slipped through. Tradeoff: known risk of shared-endpoint false positives is accepted to eliminate the prior false-negative backlog.
- **No more `bridge-signal-with-unknown-pool` review path.** Rows that touch a recognized source-side bridge signal or LayerZero topic/emitter but not a tracked pool address tag as `bridge_transfer` rather than flowing to a review queue. The transaction-wide rule for those existing fingerprints is unchanged; the token-specific destination CCTP path above tags only matched mint evidence.
- **Fail-closed bridge-detection config validation.** `validateMintBurnBridgeDetection` runs against every `bridgeDetection` config at module load. Address fields must match `ADDRESS_RE`, topics must match `TOPIC_RE`, and selectors must match `SELECTOR_RE`. Any malformed bridge config aborts module load instead of logging and continuing, so bridge filtering cannot silently disable itself for one coin.
- **Bridge tx-context shortfall guard.** Bridge-enabled configs require transaction and receipt context before rows count as economic flow. Unresolved transactions are withheld; resolved peers can persist and the cron cursor stops at the safe frontier below the earliest deferred row. Metadata reports `bridgeClassification.txContextShortfalls` and `bridgeClassification.deferredRows`; a config with any shortfall also increments `apiErrors` and its `errors` once, including budget/deadline shortfalls.
- **Provider-shape isolation.** Transaction and receipt bodies must pass the runtime shape boundary before classification, and Etherscan topics/data must pass strict word decoding. A malformed peer is dropped and counted without aborting classification of valid peers.

### Atomic Roundtrip Detection

Same-transaction mint+burn pairs for one stablecoin are tagged `flow_type='atomic_roundtrip'` in two places: in-memory during ingestion (per config chunk) and via the post-run sweep (cross-run, 7-day lookback, capped at 200 groups per run). Both paths now share the same `ROUNDTRIP_AMOUNT_TOLERANCE = 0.005` (0.5%) rule:

- A group tags atomic only when `|sum(mint) - sum(burn)| ≤ 0.005 × max(mintSum, burnSum)`.
- Partial same-tx groups (e.g. mint 100 / burn 50) are no longer flagged atomic_roundtrip and stay as `standard` flow.
- Rows with an empty `tx_hash` are defensively skipped by the in-memory detector.
- Forward tagging and reverse cleanup import `ROUNDTRIP_TOLERANCE_HAVING_SQL` from `roundtrip-detection.ts`; the SQL interpolates the same private tolerance constant used by the in-memory detector. Its explicit `CASE` selects the larger side rather than relying on scalar `MAX` inside aggregate `HAVING`.
- SQLite-backed sweep tests cover exactly 0.5% mismatch and just outside it; reclassification tests assert use of the shared SQL fragment.

---

## Scoring

**File:** `worker/src/lib/mint-burn-scoring.ts`

Only standard mints and supply-proven standard effective burns enter counted flow, hourly totals and downstream pressure/flight-to-quality signals. Review-required burn-shaped observations remain in the event ledger but contribute neither counted burn volume nor counted burn events. This admission correction changes inputs, not the pressure formula.

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
- `getLiteralMintingPressureReading()`: the literal 24h mint-vs-burn balance, published only when both sides are `complete`; otherwise NR with `valuation-partial`, `valuation-unknown` or `no-24h-volume`, because a balance of lower-bound volumes bounds nothing (v6.27)
- `resolvePublishedGaugeBand()` and `formatBankRunGaugeScore()`: the published band as a typed band, and the gauge figure with one rounding and an explicit sign, shared by the page hero and the share card

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
- Each aggregate coin row publishes its weight as optional `gaugeWeightUsd` (v6.27): the observed tracked-chain supply applied to that coin, `null` when unavailable (excluded and counted in `mcapUnavailableCoins`, never zero). A coin moves the score only when its `pressureShiftScore` is non-null; scored weights sum to `scoredMcapUsd`.
- The per-coin `clamp(-100, 100, z × 50)` is a methodology bound on each input's intensity, not a display clamp (ADR-34/R7): the gauge is the weighted mean of those bounded intensities, published unclamped, and no surface clamps the gauge itself.
- Returns `null` when the total market-cap weight of coins with non-null intensity is zero, including when all scores or weights are unavailable.

**One producer.** `refreshAggregateMintBurnFlowCache()` publishes the gauge over active tracked pairs and tracked-chain supply weights under `mint-burn-flows:v6:aggregate:24`. Other consumers read it through `worker/src/lib/mint-burn-published-gauge.ts`, never recomputing the composite over another universe. The critical lane refreshes every 30 minutes; extended-lane purges preserve it. As before T1, only admitted non-null pressure inputs with observed positive weights enter the weighted mean; there is no roster-percentage quorum. `gauge.scoreScope = admitted-coins` and `gauge.scanCoverage` disclose complete versus incomplete membership, admitted/excluded coin counts and excluded observed market cap (null when any excluded weight is unavailable). The composite is null when no scored weight remains; an excluded coin is never a zero input.

**Mcap weighting — tracked-chain scope.** Each coin's preferred weight sums circulating supply across all configured tracked chains, not just its DEWS canonical chain. When no tracked-chain entry exists, the fallback policy below uses observed global circulating supply.

**Aggregate read path.** `fetchAggregateData()` (`worker/src/api/mint-burn-flows/aggregate.ts`) uses row-value tracked-pair membership over `json_each(?)`, pinned to `idx_mbh_chain_coin_hour` for hourly windows and `idx_mbe_coin_chain_ts` for largest events. Keep this index-driven pattern: a correlated `EXISTS` re-scans the pair array for each index row.

Implementation (`worker/src/lib/mint-burn-mcap-weighting.ts`):

- `getMintBurnTrackedChains(stablecoinId)` derives the active `chainId` set from `MINT_BURN_CONFIGS`.
- `sumMcapForTrackedChains(stablecoinId, chainCirculating, circulating)` sums `chainCirculating[chainId].current` over those tracked chains, after `canonicalizeChainCirculating(...)` normalizes DefiLlama's capitalized keys (e.g. `Ethereum`) to canonical chain IDs.
- Fallback policy (preserves legacy behavior where per-chain data isn't available):
  1. Coin with no tracked chains → `getCirculatingRawOrNull({ circulating })`.
  2. Canonicalized `chainCirculating` is empty → `getCirculatingRawOrNull({ circulating })` (keeps CG-fallback assets alive).
  3. No tracked chain has an entry in the canonicalized map → `getCirculatingRawOrNull({ circulating })`.
  4. Otherwise sum observed `current` across tracked-chain entries. A present entry with `current = null` makes the entire weight unavailable; `current = 0` is real zero supply and does not trigger fallback.
- A fallback with no observed circulating bucket returns `null`: that coin's weight is unavailable, not `0`. The aggregate excludes it from the gauge inputs and from `gauge.trackedMcapUsd` and counts it in `gauge.mcapUnavailableCoins` (absent on payloads produced before the count existed). Its flow row is still published. Because a zero weight already contributed nothing, the gauge score formula is unchanged.

### Flight-to-Quality Detection

Detects simultaneous outflows from risky stablecoins and inflows to safe havens.

- **Activation:** `riskyNet24h < -$100M` AND `safeNet24h > +$100M`
- **Intensity:** `min(100, |riskyNet24h| / $1B * 100)`
- Safe/risky cohorts come from the report-card cache: `B-` or better is safe, `C+` through `C-` is neutral, and grades below `C-` are risky. If the complete identified report-card cache is unavailable, flight-to-quality classification is unavailable rather than falling back to hardcoded safe havens.
- On aggregate API reads, a changed publication identity triggers FTQ recomputation from the validated cached per-coin `netFlow24hUsd` values and current cohorts. This updates only the response's FTQ fields, classification identity, and classification warning; the cached flow data, producer timestamps, freshness headers, and database row are preserved. Missing, held, stale, or malformed Safety Score sources and invalid cached coin inputs still fail closed.

---

## Valuation Completeness

Since methodology v6.22 (CR-18 release A, migration `0251`), hourly buckets record per-side unpriced event counts. Only standard mints and standard effective burns count; events without `amount_usd` increment their side's unpriced count and add nothing to USD subtotals. Materializers share `mintBurnHourlyBucketAggregatesSql` so counts and subtotals agree. Recalc and heal rebuild use atomic per-hour delete+insert; retention evidence repair fills missing buckets with `INSERT OR IGNORE`.

**Scan evidence is independent of valuation.** Each 24h/7d/30d/90d signed window requires coverage for every configured source of that coin: current-fingerprint v2 proof after the immutable cutover, or the explicitly labelled bounded legacy assurance before it. The common end is the fresh fully scanned closed-hour watermark described above. A rounded scan tail that lands inside another source's gap steps backward to the latest common admitted hour within the same freshness budget. Missing or gapped evidence publishes null signed net, direction and pressure with a machine-readable coverage reason. `has24hActivity` stays null for incomplete scans; `observed24hActivity` independently preserves observed events. Gross volumes/counts remain `observed-subtotals`.

The pressure baseline uses only a continuous suffix of fully admitted complete UTC days before the watermark's day; admitted quiet days enter its denominator. DEWS reads hourly windows at the published watermark and preserves its own freshness and per-coin coverage gates. DDR's incident-anchored window and OG's independent windows retain strict v2 proof; the public transition does not silently weaken those readers.

Aggregate/per-coin readers, DDR and stablecoin OG cards read hourly data, current scan proof and overlapping `mint_burn_dirty_hours` in one D1 batch snapshot. Any debt for a required coin/chain/hour withholds exact-window admission until the atomic rebuild settles it, including corrections after v2 proof was recorded. DEWS batches its hourly reads with the same debt check before applying its published-window proof. A delayed or failed drainer therefore cannot certify stale hourly totals as complete.

The supply-destruction fingerprint remains `mint-burn-finalized-scan-v2`. Old segments are retained but never relabelled. Aggregate and per-coin cache namespaces move together to v6 so old all-roster/latest-hour materializations cannot mask the new contract. No sealed historical generation is rewritten; pre-cutover admission is disclosed as legacy and every later gap still needs real scan proof.

Maintenance rebuilds additionally settle durable per-hour debt atomically with the bucket write. A failure in aggregation, priced-repair finalization, or debt deletion rolls back the entire rebuild, preserving the last bucket and debt for recovery; source mutations already committed remain priced/classified. On non-error run completion, the independent drain seeds up to 100 retained legacy priced `pending_aggregate` hours not already dirty, then rebuilds up to 100 dirty hours oldest-first regardless of current price, flow classification or age. Seeding is idempotent and runtime-only; still-unpriced pending rows remain unresolved rather than claiming recovery. Historical repair uses the same atomic primitive and preserves the original price observation, operator run and Time Travel bookmark when finalizing an interrupted repair.

Mutating historical repair seeds up to 500 legacy hours before selecting its pending page, and selects only pending hours whose durable keys exist. Its stablecoin-first page therefore cannot rebuild unseeded hours from the seeder's hour-first page or resurrect a stale selected key after another drainer and retention. Dry-run remains read-only and previews pending source hours without requiring a debt key.

- **Valuation completeness:** `complete` means no observed counted event lacks USD valuation; an empty observed subtotal is valuation-complete, but only separate scan proof establishes genuine zero. `partial` means unpriced events exist; `unknown` means a bucket has NULL counts on a side with counted events. Precedence is partial > unknown > complete. Shared logic: `shared/lib/mint-burn-valuation.ts`; SQL tally: `worker/src/lib/mint-burn-hourly-valuation.ts`.
- **Legacy rebuild:** after each completed run, `rebuildRetainedLegacyValuationHours` re-aggregates up to 500 NULL-count buckets that start at least one hour inside the 8-day event-retention window (their raw events cannot have been pruned), newest first, through the partial index `idx_mbh_valuation_unrecorded`. Older legacy buckets stay `unknown` until hourly retention prunes them; nothing reconstructs pruned history.
- **Proven direction:** unpriced mints can only raise the true net and unpriced burns can only lower it. A direction survives only when that proven range excludes zero; `flat` requires complete valuation.
- **One-sided net bounds (v6.25):** the same range yields `mintBurnSignedNetBound()` (`shared/lib/mint-burn-valuation.ts`): with only the mint side partial the known net is a floor (`lower`), with only the burn side partial a ceiling (`upper`); both sides incomplete, or any `unknown` side, yields none. The API publishes `valuation.netFlow7dBound` / `netFlow30dBound` / `netFlow90dBound` (`{ kind, valueUsd }`, `null` when none, absent before v6.25) beside the still-null partial nets; the 24h bound derives from the published subtotals and `window24h` sides.
- **Internal consumers (active now):** DEWS flow is unavailable (`mint-burn-valuation-partial` / `-unknown`) unless the 24h window is complete, and when its burn baseline is partial (`mint-burn-baseline-valuation-partial`); an unknown legacy baseline is tolerated until it ages out. DDR mint surge uses hourly evidence only when the proven range decides the 20% threshold, otherwise the supply-history proxy. The digest accepts withheld gauge weight only if every possible score preserves the published band, digest regime and risk-tape tone; pressure and chain nets require complete 24h windows, and FTQ is unavailable (`valuation-incomplete`) unless exact or provably inactive.
- **Public API (v6.23 activation):** additive `valuation` fields on coins, chains, hourly buckets and per-coin totals/chains, plus `gauge.partialValuationInputs`, `gauge.partialValuationMcapUsd` and `gauge.scoredMcapUsd`. Signed nets are `null` for `partial` windows; gross volumes remain known subtotals. `netFlowDirection24h` uses `provenNetFlowDirection24h()` and is `null` when missing valuation could change it. Pressure requires a complete 24h window and a non-partial baseline; an unknown baseline is tolerated. Weighted coins with activity and at least seven baseline days whose pressure is withheld for valuation leave the gauge, which re-weights over scored coins and discloses their count and weight. `/flows` re-labels the beam and shows a `Partial valuation` chip. For withheld weight `w` and scored weight `W`, the full-cohort interval is `(W·S ± 100w)/(W+w)` (shift at most `w/(W+w)·(100+|S|)`). The digest requires `isGaugeBandRobustToWithheldWeight()` plus unchanged regime and risk-tape tone at both interval endpoints; a kept gauge carries `mint-burn-gauge-valuation-partial-band-stable`, while a positive count without published weights withholds it. FTQ uses `detectFlightToQualityFromValuedNets()`: exact, provably inactive, or `null`; cached reclassification uses the same rule and absent coin valuation is unknown. Stablecoin OG cards show partial seven-day flow as `7D GROSS (MIN)` (`$X+`) and unknown flow as `7D NET (UNVERIFIED)`, never signed partial net.
- **Transition window:** existing legacy valuation may retain its labelled old-method known-valued net only after independent scan admission under the bounded transition or v2 rule. This does not waive missing event-time prices: partial valuation keeps signed nets and pressure unavailable. Sparse buckets alone cannot authorize quiet zero; raw-event rebuilds cannot reconstruct pruned history.
- **Event-time pricing (v6.23):** parse and the 48-hour heal value an event only through `resolveMintBurnEventPrice()` (`worker/src/lib/mint-burn-pipeline/context.ts`); see [Sync Algorithm](#sync-algorithm). More events can therefore stay unpriced (backfills, new configs, `price_cache` outages, NAV observations older than 24h, nominal-par assets, and events only a snapshot could value until the first post-`0253` daily snapshot records a clock); those hours are `partial` and their raw rows stay retention-protected debt for the historical repair path.
  The healer persists its last inspected key under `mint-burn-price-heal-cursor:v1` only after successful inspection and any source/debt transactions. It resumes strictly below that key even if the cursor row was deleted; exhausting a page shorter than the 500-row budget or aging the cursor outside the current 48-hour cutoff wraps the next pass to newest-first. This revisits new arrivals and previously ineligible rows when evidence becomes available without widening the inclusive ±24h policy. Evidence-less rows stay NULL. Healing still enqueues the existing durable materialization debt, and completion independently drains it; the scan adds no schema or index.
- **Historical repair admission:** daily supply snapshots use the same actual-clock projection and event-price resolver as parse/heal, including positive integral read-time-valid clocks, peg plausibility and inclusive ±24h event distance. The scanner considers nearby snapshot days rather than inventing a clock from the day label; an invalid or unclocked snapshot cannot suppress event-day provider fallback. Recovered rows persist the admitted observation timestamp, and already-valued rows are never overwritten.

## Retention

The critical `sync-mint-burn` producer owns bounded cleanup and aggregation-evidence repair after ingestion:

- Individual `mint_burn_events` rows are retained for at least **8 days**. An older row is eligible only after its USD valuation is settled (`amount_usd` is present or price repair is explicitly `recovered`/`irreducible`), its stablecoin/chain/hour aggregate exists, and the Tape projector cursor has passed its timestamp. The shared whole-hour finality guard protects **all siblings**, including priced rows, whenever any sibling has unresolved valuation, pending aggregation, or a block beyond a matching config's committed scan frontier.
- A `mint_burn_dirty_hours` key protects **every raw sibling** in that stablecoin/chain/hour, even if all events are priced and an older aggregate exists. Dirty hours are also excluded from missing-bucket evidence repair; only the atomic maintenance rebuild can settle their debt. Independent completion draining releases that whole-hour protection only after the rebuilt bucket and applicable repair finalization commit together; interruptions leave debt for a later run.
- A missing hourly bucket for terminal, projected raw rows is rebuilt oldest-first before deletion. Unresolved or pending hours are neither rebuilt nor pruned. Missing sync state fails closed for active, enabled configs: every matching stablecoin/chain frontier, including secondary contracts across both lanes, must cover the hour's raw blocks. Disabled configs (registry flag, runtime ID/key or symbol policy) and inactive assets do not hold protection. The 50,000-event candidate and 5,000-hour repair budgets remain in force; there is no age-based deletion escape. Historical price repair recalculates and verifies only its affected hours, preserving unrelated aggregate history.
- `mint_burn_hourly` buckets are retained for at least **95 days**, preserving the public 90-day aggregate window with a five-day operating margin. Cleanup never removes a bucket while any raw event still depends on it as aggregation evidence.
- Repairs are capped at 5,000 hourly buckets per critical run. Deletes run oldest-first in 10,000-row statements, capped at 50,000 event rows and 25,000 hourly rows per critical run. The extended lane does not run cleanup.
- Cron metadata reports aggregation repair and deletion cutoffs, changed counts, oldest backlog timestamps, cap states, durations, and errors. `retention.frontierProtection.configs` identifies each enabled config holding an expired hour: config/coin/chain identity, `lastBlock`, `highestProtectedBlock`, `lagBlocks`, `oldestProtectedHour`, and `oldestProtectedAgeSeconds`. Missing state has null frontier/lag, not fabricated progress; a failed diagnostic read publishes null configs and an error, not an empty healthy list. Cleanup or diagnostic failure degrades an otherwise successful critical run without discarding ingestion.

The daily `mint-burn-growth-watchdog` remains a fail-safe rather than the retention owner. At **2.3M event rows** (the existing proxy for the agreed ~5 GB investigation point), it returns `status=ok` with `metadata.quality.reason="row-count-threshold"`; it does not emit a degraded ingestion verdict. Each execution independently uses `COUNT(*)` on current `mint_burn_events`, and an unavailable or invalid count fails the job rather than reporting zero.

## Database Schema

Exact columns, constraints, and indexes live in `worker/migrations/0000_baseline.sql`, the follow-on migrations named below, and `worker/migrations/MANIFEST.md`. This section owns the table roles and flow semantics, not a second DDL copy.

### mint_burn_events (current excerpt; baseline plus later indexes)

`mint_burn_events` is the transaction-addressable recent event ledger with the protected 8-day retention policy above. It preserves token-native amount, optional event valuation and its source timestamp, chain/transaction provenance, counterparty, burn classification, and economic-flow classification. `standard`, `bridge_transfer`, `atomic_roundtrip`, and `protocol_internal` semantics decide whether a row contributes to aggregates; burn rows additionally distinguish effective burns, bridge burns, and review-required evidence.

Migration `0178_historical_data_debt_closure.sql` owns bounded historical price-repair state and its provenance columns; migration `0234_mint_burn_price_repair_backlog_index.sql` owns the repair backlog index (`idx_mbe_historical_price_repair_backlog`). Repair provenance distinguishes retryable unclassified debt, aggregate rebuild pending, recovered rows, and irreducible exact-day gaps; it also binds mutation attempts to their operator run and pre-run Time Travel bookmark. Migration `0097_mbe_flow_type_ts_index.sql` owns flow-classification query support. Exact index membership stays in the migrations.

### mint_burn_hourly (baseline `0000_baseline.sql`)

Pre-aggregated stablecoin/chain/hour buckets store counted mint and burn volume, event counts, and signed net flow. The cron rebuilds affected buckets after ingestion; repair and reclassification paths recalculate the same canonical buckets before declaring completion.

### mint_burn_sync_state (baseline `0000_baseline.sql`)

This table owns the monotonic last-processed block for each chain/contract configuration. Cron and backfill ingestion share it, and partial backfills must never regress the stored frontier. `upsertMintBurnSyncState()` commits the cursor (with its scan-coverage merge) through `runWithOverloadRetry()`: the monotonic cursor and the coverage merge/compact converge on the same interval, so replaying a commit whose `Network connection lost` response hid a successful write is idempotent.

### mint_burn_config_deferral (baseline `0000_baseline.sql`; originally migration 0096)

Per-config deferral protects healthy work: more than five API errors plus less than 80% or unavailable coverage defers a configuration for one hour.

**Migration history:** The earlier per-step mint/burn migrations were squashed into the baseline; the `mint_burn_events`, `mint_burn_hourly`, and `mint_burn_sync_state` tables now live in `0000_baseline.sql`. Migration 0096 adds per-config deferral, migration 0097 adds flow-classification query support, migration 0159 purges Re Protocol reUSD rows and resets the obsolete vault/canonical-token cursors, and migration 0178 adds historical valuation repair provenance and resumable aggregate verification. `worker/migrations/MANIFEST.md` is the lineage authority.

---


## API Endpoints

These headings remain stable for feature-document navigation. The exhaustive HTTP contract is owned by the linked endpoint sections in `docs/api-reference.md`.

### GET /api/mint-burn-flows

All API totals and series use closed UTC hours: `end=commonWatermark`, `start=end-hours*3600`, with buckets in `[start,end)`. Responses publish `window: {start,end,semantics:"closed-utc-hours",watermark}`; the open current hour is excluded. Aggregate chart hours vary, but coin counts, volumes, pressure and largest events use 24 closed hours ending at that same boundary; 7d/30d/90d nets share it. Expired cached watermarks fail closed rather than being renewed by a newer cache-read or sync clock.

Parameters, response fields, cache/freshness behavior and errors are canonical in the [HTTP reference](https://github.com/TokenBrice/pharos-watch/blob/main/docs/api-reference.md#get-apimint-burn-flows).

Aggregate mode constrains configured `(stablecoin_id, chain_id)` pairs in SQL and selects the deterministic largest 24-hour event per coin there; the Worker does not materialize the full event day to compute that field.

Each aggregate coin row publishes `pressureShiftScore` as the sole baseline-relative score field. The former `flowIntensity` alias duplicated the same value and is no longer part of the response contract.

`shared/types/mint-burn.ts` owns the producer and reader DTOs. The Worker derives `CoinFlowSummary` from `MintBurnCoinFlow`, requiring live `coverage` and `valuation` rather than maintaining mirrored interfaces; declared reasons survive shared-schema parsing. Per-coin totals, chains and hourly buckets carry their own `scanCoverage` block and withhold signed nets independently of their observed gross/count subtotals.

### GET /api/mint-burn-events

The event feed exposes the recent classified, valuation-aware ledger for one stablecoin. Safely settled, aggregated, and Tape-projected rows remain available for at least 8 days; the separate hourly aggregate keeps 90 days of public flow history. The detail-page history deliberately uses the counted view so bridge transfers, review-required burns, and atomic roundtrips do not appear as ordinary economic flow.

Filters, pagination, ordering, response fields, cache/freshness behavior and errors are canonical in the [HTTP reference](https://github.com/TokenBrice/pharos-watch/blob/main/docs/api-reference.md#get-apimint-burn-events).

### Operator CLI: backfill-mint-burn-prices

The recent cron path auto-heals bounded NULL-price debt; this operator path handles older history. Stored snapshots use actual observation clocks within inclusive ±24h of the event, including nearby UTC days; historical-provider fallback accepts only the exact UTC event day. Neither path invents a clock, current spot or peg-par price. Definitive no-source results become irreducible, transient failures remain retryable, and recovered rows stay `pending_aggregate` until affected hours are rebuilt and verified. Interrupted runs resume aggregate verification before new valuation work.

Operator auth, dry-run/confirmation/bookmark/idempotency and execution requirements have one owner in the [historical price-repair runbook](https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks/one-shot-backfills.md#backfill-mint-burn-prices) and [integrity repair sequence](https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks/mint-burn-integrity.md#historical-price-debt). Live aggregate replacement requires the [atomic-import availability gate](https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks/one-shot-backfills.md#transport-safety).

### Operator CLI: backfill-mint-burn

Operator ingestion shares finalized-head admission, bounded log fetching, parsing, classification, persistence, aggregation and decode retries with cron, but aborts the current chunk on incomplete logs, timestamps or bridge context rather than persisting its resolved subset. Complete eventful and quiet chunks advance through their admitted finalized range, including explicit historical chunks. A missing finalized head refuses the request rather than scanning tip. Decode failures hold below their block until success or third-observation quarantine; valid peers persist. Every committed cursor follows successful hourly materialization.

Operator arguments, execution/atomic-import guards, selection/range parameters, progression, counters and errors are canonical in the [ingestion runbook](https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks/one-shot-backfills.md#backfill-mint-burn).

### Operator CLI: reclassify-atomic-roundtrips

This bounded repair applies the shared 0.5% same-transaction amount-tolerance rule in both directions: newly recognized mint/burn pairs become atomic roundtrips, while old atomic tags that fail the tolerance return to standard flow. Every affected hourly bucket is recalculated before a batch reports completion.

Operator arguments, execution/atomic-import guards, scope, batch progression, counters and errors are canonical in the [roundtrip-reclassification runbook](https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks/one-shot-backfills.md#reclassify-atomic-roundtrips).

---


## Cron Metadata Fields

`completeMintBurnRun()` owns bounded cron metadata: actual throughput, selected lane/job, source/config coverage, API/bridge shortfalls, decode/roundtrip diagnostics, recalc outcome, request/deadline stops, the extended-lane `coverageCycle` block and NULL-price debt. `attemptCoverage` keeps per-config attempt evidence (never a verdict); `coverageCycle.status`/`coverageCycleSec`/`expectedWindowSec` own the extended-lane verdict and are absent from critical-lane metadata. Full per-config drilldown lives separately under its cache key, not in a second field catalog here.

Parsed rows are not inserted rows. NULL backlog counts with `nullPriceBacklogAvailable: false` mean a failed retried read, not no debt. `recalcFailed` means cursors did not commit even if event inserts succeeded. A saturated sweep can leave backlog beyond this run. These distinctions govern repair; metadata field definitions are source-owned.
---

## Frontend

### Page

The public [Flows page](https://pharos.watch/flows/) uses the instrument header (one-line deck, folded lead, methodology line, Share). Its order is answer, table, evidence, footer:

- **Hero** (`FlowGaugeHero`, `src/components/flow-gauge-hero.tsx`): the One Beam is `gauge.score` (`formatBankRunGaugeScore`) in neutral ink beside its published band chip (`GAUGE_BAND_LABELS` / `GAUGE_BAND_TONE_CLASSES`). A null score renders "—" with a `Not rated` chip (`gauge-score-null`). When `partialValuationInputs > 0` the beam label adds "partial: N weighted coins withheld" (the share card's stamp says the same) and a `Partial valuation` chip (`partial-valuation-inputs`) carries the scored and withheld weights. When that withheld weight could carry the full-cohort score across a band edge (`assessGaugeBandSettlement()` in `shared/lib/mint-burn-gauge-bands.ts`, the same `isGaugeBandRobustToWithheldWeight()` rule the daily digest applies), no band is printed: the beam shows the score alone, a `Band unsettled` chip (`band-not-robust-to-withheld-weight`) carries the score interval, the verdict drops its band sentence, and the share card omits the band and stamps "band unsettled". `mcapUnavailableCoins`, unavailable FTQ, `sync.warning` and a degraded or stale read are chips too (`mcap-unavailable-coins`, `valuation-incomplete` / `classification-unavailable`, `freshness-<status>`, `data-health-<state>` plus its reason), never body callouts or headlines; the shared freshness banner remains only when no data loaded. A verdict of at most 25 words comes from the band and the coins with the largest weighted pull. Facts: Printed 24h, Shredded 24h (lower bounds when partial), Net 24h (a bound when only one side is partial), and Flight to quality only when active. No net-direction headline and no literal minting-pressure gauge appear on this page.
- **Run line** (`FlowRunLine`, `src/components/flow-run-line.tsx`; model `src/lib/flow-run-line-model.ts`): x is each scored coin's pressure over the band zones from `GAUGE_BAND_RANGES`; tick height is its `gaugeWeightUsd` on a square-root scale with a 6px floor (uniform, with no driver labels, on payloads without weights); the ink rule is the gauge. Coins outside the score are dashed stubs in a counted gutter, each with a reason (`no-24h-activity`, `below-scoring-floor`, `valuation-partial`, `weight-unavailable`), resolved in the producer's order so weighted `valuation-partial` stubs equal `partialValuationInputs`; the per-coin table's NR cells name the same reason. Without published weights the stage collapses to a short strip. An sr-only table lists every coin's pressure, weight, pull in gauge points and status. It is static (no motion).
- **Per-coin table**: sorted by pressure vs the 30-day norm, worst first, NR last. Coverage-unknown nets drop the per-cell `*` for one `Unverified` column-header chip with the count (`valuation-unknown`); each cell keeps its screen-reader reason.
- **Aggregate chart**: partial buckets are hatched columns, the cumulative line's last proven point is labelled where it stops, and the rolling band is a light outlined area with a direct label.
- **Folds**: "7-day receipt" (`FlowWeekReceipt`: weekly printed/shredded/net rows, top 7-day net minter and burner, and coverage from one weekly receipt model; the hero owns 24h totals) and "How to read flows" (interpretation and FAQ, JSON-LD kept). Missing weekly hourly data leaves volumes NR; partial valuation and incomplete scans retain their lower-bound or unavailable-net reasons. The footer names source, cadence and sync freshness and links to the Timeline once.

Leaders rank only displayable USD-valued nets/events. Missing chart buckets remain gaps in plots and accessible tables and do not enter rolling averages.

Direction and pressure labels use one shared presentation across detail cards and the per-coin table. An unproven direction remains "Direction unavailable"; pressure retains its explanatory helper text.

The aggregate chart initially selects 7d, sharing the authoritative 168h query with the overview receipt; 24h totals remain an independent query. The 720h variant is admitted only when 30d is selected. No shorter-window totals or valuation-completeness claims are synthesized from a longer response; selecting another window retains the existing canonical keys and cadence.

### Hooks

`src/hooks/use-mint-burn-flows.ts` shares aggregate/per-coin query options and event-feed hooks. Both response modes are schema-validated; stale-time configuration follows the lane cadence rather than duplicating freshness rules in components.

### Components

Hero, table, chart and detail consumers share valuation/display helpers instead of re-deriving missing-data rules. Detail/table long windows mark incomplete coverage `partial`; gauge colour comes only from the published band chip, not the sign of net flow. Only the stablecoin detail card renders the literal 24h minting-pressure gauge.

### Valuation Completeness Rendering

Frontend consumers read the additive `valuation` fields through `resolveMintBurnValuation()` / `resolveMintBurnValuationCompleteness()` (`shared/lib/mint-burn-valuation.ts`), so a payload without `valuation` is `unknown`, never complete. Presentation helpers live in `shared/lib/mint-burn-valuation-display.ts` and `shared/lib/mint-burn-coin-helpers.ts`; the shared `FlowSignedNetValue` / `FlowVolumeValue` components (`src/components/flow-valuation-value.tsx`) render them.

- **Scan-window activity:** `has24hActivity: null` gates unproved windows for legacy readers, including observed-but-unscanned windows. Current readers retain observed activity through `observed24hActivity: true`; false does not override an unknown legacy gate. Unknown rows remain visible and contribute unavailable rather than idle/zero to totals. Observed activity never overrides incomplete scan proof: direction, pressure, literal dial and signed bounds stay unavailable. Gross values render as `≥` observed subtotals whenever scan coverage is incomplete, including fully priced nonzero observations and zero observations; valuation completeness is unchanged. The producer retains PR-B's null gate so normal Worker-before-Pages activation is safe.

- **Signed nets** (`netFlow*Usd`, hourly `netFlowUsd`): `null` or a `partial` window renders the component's unavailable placeholder (`—` or `NR`) with an accessible reason naming the unpriced mint/burn event counts, never `$0`. Since v6.25 a partial net with a proven one-sided bound renders as `≥ $X` / `≤ $X` (`FlowSignedNetValue`), coloured only when the bound proves the sign, with a reason naming the unpriced side; it is never shown as the net itself. `unknown` keeps the value with a `*` coverage-unknown marker.
- **24h direction**: producers and client overview sums use `provenNetFlowDirection24h()` with per-side completeness, including legacy `unknown` windows whose old-method net stays visible. The client aggregate adds a partial coin's known subtotals (mint − burn) to the proven range rather than discarding it (v6.25). A partial older payload with a numeric net is re-derived by the same helper; an unproven direction renders "Direction unavailable", never `flat` or `No activity`.
- **Pressure shift**: a partial 24h window or baseline renders `NR` with a partial-valuation reason and sorts last. The baseline average daily net is withheld only when the baseline itself is partial.
- **Gross volumes**: a non-complete side renders as a `≥` lower bound (known-valuation subtotal).
- **Client-side sums** (overview/receipt totals, home mini card, chart re-bucketing): any null or partial component makes the summed signed net unavailable; leaders and sorts rank only displayable nets, never bounds. A summed net keeps a one-sided bound only when every withheld component is bounded on the same side and no component is coverage-unknown; the 24h aggregate derives its bound from the same per-side range as its direction. The aggregate chart draws no bar for a partial bucket, stops the cumulative line at the first one, and lists bucket valuation in its accessible table; the compare chart omits such hours.
- **Gauge**: unavailable Safety Score classification takes precedence over valuation-null and renders an "FTQ unavailable" chip with its actual reason, named Safety Score dependency and independent budget/accepted source clock. A null FTQ with an admitted classification retains the missing-valuation explanation. `partialValuationInputs > 0` re-labels the beam and adds the `Partial valuation` chip (v6.23 semantics: coins withheld from the score).
- **Literal minting pressure** (v6.27): NR with its reason whenever either 24h side is `partial` or `unknown`; the detail card shows the reason instead of a dial.
- No frontend CSV/NDJSON export carries mint/burn flow values.

### Dashboard Integration

`FlowSummaryCard` (`src/components/flow-summary-card.tsx`) keys its direction chip from the valuation-gated 24h direction (see [Valuation Completeness Rendering](#valuation-completeness-rendering)) and renders the literal `Minting Pressure (24h)` dial only from a fully valued window; otherwise it names the NR reason. Bank Run Gauge band labels remain the baseline-relative pressure vocabulary.

Detail health monitors the coin flow lane only when it renders (coin row, loading or failure), and scopes its evidence to the coin totals it displays. The optional market-wide FTQ dependency and its matching advisory do not degrade a coin's flow section; ingestion, valuation, transport, other dependency warnings and the original flow-generation budget remain applicable. UI disclosures format HTTP Warning text as human prose while preserving raw transport metadata and machine-readable reasons.

---

## Error Handling & Edge Cases

| Condition | Behavior |
|-----------|----------|
| No admissible price within ±24h of the event | `amount_usd` remains NULL; a counted event makes the hour partial (net unavailable, pressure NR). Cron heals recent rows (48h) with in-window evidence; the operator price-repair CLI handles older history |
| Fewer than 7 days of flow history | Pressure shift returns `null`; coin excluded from gauge weighting |
| No 24h mint/burn activity in a sparse window | Pressure shift returns `null` (NR) for that window; coin excluded from gauge weighting |
| All coins have null pressure shift | Gauge score returns `null`; the overview displays `NR` without a gauge marker |
| Alchemy API error for a config | `apiErrors` increments; a partially successful scan may stage the shared safe frontier, while a failed event definition with no covered prefix holds advancement |
| Incomplete timestamp resolution | `apiErrors`/`errors` incremented; sync state advances only to the safe coverage frontier (`earliestMissingTimestamp - 1`), or not at all when no safe frontier exists |
| Undecodable event amount | Hold at the safe frontier for two retries; on the third observation quarantine only that log as `amount-decode-retry-exhausted` and advance past it |
| Subrequest budget exhausted | Remaining configs skipped; picked up in next cron cycle |
| Finalized head unavailable or unsupported | Named `finality-head-unavailable` coverage, no tip scans or cursor advance; unaffected chains continue and cron status degrades immediately |
| Duplicate events | `INSERT OR IGNORE` on deterministic `id` key prevents duplicates |
| Unknown stablecoin ID in per-coin API | Returns 404 with descriptive error |
| Missing `stablecoin` param in events API | Returns 400 |
| Partial-coverage cron run | Hourly aggregation rebuilds from all DB events for affected hours; buckets may be temporarily incomplete for configs still catching up |

### Circuit Breaker Separation

Blacklist and mint/burn have independent circuit breakers:

- **`CIRCUIT_SOURCE.ETHERSCAN`** — used by `sync-blacklist` (Etherscan REST API)
- **`CIRCUIT_SOURCE.ALCHEMY`** — used by `sync-mint-burn` (Alchemy JSON-RPC)

An Alchemy outage does not block blacklist sync, and vice versa. Each circuit breaker opens after consecutive failures and probes independently.

`mint-burn-pipeline/rpc.ts::mintBurnRpcEndpoints()` consumes the scheduled runtime's already-admitted `chainRpcs` map. An enabled Dwellir endpoint with full log history is first for each configured mint/burn chain, followed by the existing Alchemy URL; the former Ethereum/Arbitrum/Base-only fallback roster is removed. Missing admission, unsupported logs or `DWELLIR_ROUTING_DISABLED_CHAINS` keep Alchemy alone, with incumbent windows and budgets. Request/admin paths never acquire Dwellir. Heads, logs and hash-checked timestamps/receipts use this order; conservation's historical supply/guard phase separately excludes recent-only Dwellir state. Each endpoint's own budgeted head bounds its log frontier; a lagging fallback cannot prove the tail. Dwellir pages clamp to registry `maxLogBlockSpan` (usually 10,000), so successful scans can require more calls within the unchanged cap. Failed pages retain only the proven contiguous frontier. Registered auth and per-member metering cover every physical Dwellir request, including bounded unexecuted-batch retries. Existing subrequest caps/deadlines and receipt concurrency remain unchanged; routing adds no configured token/chain inventory or unsupported historical capability.
