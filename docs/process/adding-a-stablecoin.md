# Adding a Stablecoin

Reference for adding a tracked asset to Pharos.

Current source of truth is the per-coin JSON registry under `shared/data/stablecoins/coins/*.json` plus selective research sidecars under `shared/data/stablecoins/domains/<domain>/*.json`, loaded through the generated runtime aggregate `shared/data/stablecoins/coins.generated.json`, and validated by `shared/lib/stablecoins/schema.ts`. Pre-launch entries are ordinary per-coin files with `status: "pre-launch"`. Eligibility and lifecycle decisions follow [Stablecoin Listing Policy](../listing-policy.md). The older top-level stablecoin barrel, helper-constructor paths, and legacy category-shard edit paths are obsolete; the maintained agent skills (`stablecoin-addition-orchestrator`, `stablecoin-runtime-price-marketcap-gate`, `stablecoin-identity-contracts`, `reserve-research`, `compliance-research`, `write-ai-summaries`, `resilience-classify`, `pre-launch-update`) remain optional workflow aids. Sidecar ownership and migrations are documented in [Stablecoin Research Sidecars](./stablecoin-research-sidecars.md).

> Completion gate: evaluate every phase below. A new addition changes the per-coin source, `canonical-order.json`, and `listing-decisions.json`; add logos/summaries or record the allowed gaps. Materialize Phase 4a projections, update applicable Phase 4b snapshots, and commit changed Phase 4c artifacts. `coins.generated.json` is required but gitignored. Evaluate yield, live reserves, redemption, mint/burn, Mint Authority, Bluechip, Safety Score scoreability, and history backfill explicitly.

> **Agent navigation** — Grep the phase you need instead of reading wholesale: Source Of Truth · Guardrails · Phase 0 Decide What You Are Adding · Phase 1 Eligibility · Phase 2 Research Packet · Phase 3 Classification · Phase 3.5 Editorial Coverage Gate · Phase 4 Edit The Registry (4a generated client projections · 4b test snapshots · 4c checked-in artifacts) · Phase 5 Downstream Coverage Branches · Phase 6 Static Assets And Editorial Copy · Phase 7 Validate · Phase 8 Push, Merge, Deploy, Then Backfill · Phase 9 Post-Deploy Verification · Source Reference.

---

## Source Of Truth

[Stablecoin Data Registry](../stablecoin-data.md#source-files) owns the catalog source-file table, the generated projections, and the single supported regeneration entry point (`npm run bootstrap:generated`). Do not restate that table here. Two additional static files are addition-specific and are not part of it:

| File                    | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `data/logos.json`       | Static logo map used by the frontend                           |
| `data/ai-summaries.json`| Static editorial summaries used on detail and upcoming surfaces |

Useful repo references before editing:

- `docs/classification.md`
- `docs/listing-policy.md`
- `docs/pricing-pipeline.md`
- `docs/supply-snapshot.md`
- `docs/live-reserves.md`
- `docs/yield-intelligence.md`
- `docs/redemption-backstops.md`
- `docs/mint-burn-flows.md`
- `docs/report-cards.md`
- `docs/upcoming-page.md`
- `docs/stablecoin-detail-page.md`
- `docs/shadow-stablecoins.md` for off-catalog PSI historical assets
- `docs/bluechip-ratings.md`
- `docs/about-page.md` when a new data source is introduced
- `docs/deployment-process.md` when verifying the post-merge backfill path

---

## Guardrails

- Use canonical Pharos IDs in `ticker-issuer` format, all lowercase.
- New tracked entries belong in per-coin JSON assets, not in executable TypeScript arrays.
- Author domain-owned research only in its sidecar, creating it when absent; keep every field owned by that domain out of the base file. Do not create sidecars for unrelated scalar metadata.
- Regenerate `shared/data/stablecoins/coins.generated.json` after per-coin metadata edits; do not edit the generated aggregate by hand.
- New keys in `data/logos.json` and `data/ai-summaries.json` must use canonical stablecoin IDs; existing keys are canonical today, though many logo values still point at legacy numeric filenames such as `/logos/1-usdt.svg`.
- Do not add manual supply overrides. Pharos uses DefiLlama first, then the reviewed fail-closed fallback paths in [Supply Snapshot](../supply-snapshot.md#supply-data-source).
- Do not treat `infrastructures` and `dependencies` as interchangeable. `infrastructures` is project taxonomy; `dependencies` is the asset graph.
- Keep `reserves[]` curated even when `liveReservesConfig` exists. Curated reserves still drive dependency inference and fallback views.
- Use only chain IDs that already exist in `shared/types/chain-identity.ts`.
- If you add a new upstream source, new adapter family, or change a methodology surface, update the relevant verified docs and the about page in the same change.

---

## Phase 0 - Decide What You Are Adding

### 0a. Active vs pre-launch

Both feed into `TRACKED_STABLECOINS` from the per-coin catalog, but they behave differently at runtime:

- `status` omitted or `"active"`: included in `ACTIVE_STABLECOINS`, worker/runtime surfaces can process it.
- `status: "pre-launch"`: excluded from `ACTIVE_STABLECOINS`, appears on `/upcoming/`, and renders the pre-launch detail variant instead of the normal live detail page.

If the asset is pre-launch, also collect:

- `announcedDate`
- `expectedLaunchDate`
- `launchPhase`
- `launchPhaseDetail`
- `milestones`
- `featuredContent`
- `dateHistory` when dates changed over time

Do not expect pre-launch assets to show up in live worker-driven coverage until the status flips to active.

#### Launched, awaiting data

When a pre-launch asset is publicly issued on-chain but fails the [Phase 1a runtime gate](#1a-hard-runtime-data-gate-for-active-assets), keep `status: "pre-launch"` and set `launchPhase: "launched"` ("Launched – awaiting data"). Pilots, closed-loop platforms and private betas do not qualify; they stay in an earlier phase. The schema in `shared/lib/stablecoins/schema.ts` then requires:

- `launchDate`, plus at least one milestone with a primary `sourceUrl` dated on or after the start of `launchDate`.
- `listingStatusReview` with `changedAt` (the day the row entered the phase, not before `launchDate`), a `reason` naming the missing lane (no admitted price lane, no admitted supply lane, both, or a scope question), and `reviewBy` no more than `LAUNCHED_PHASE_MAX_DWELL_DAYS` (60) days after `changedAt`. `source` is optional.

The row stays out of aggregates and scoring. Its profile titles move to "Status & Tracking", the detail page drops the target countdown and drift badge, quick answers say the coin is live with price and supply unavailable (not zero), and `/upcoming/` lists it under "Launched – not yet tracked" instead of the upcoming count. Past `reviewBy`, `check:stablecoin-data` warns; resolve it per [Lifecycle Policy](../listing-policy.md#lifecycle-policy). Promotion to active still runs every Phase 1a, Phase 4 and Phase 7 step, and drops `launchPhase: "launched"` and its `listingStatusReview`.

#### 72-hour pre-launch stub lane

When an issuer, regulator or bank publishes a credible primary-source announcement of an in-scope stablecoin, add a pre-launch stub within 72 hours rather than waiting for a full research packet. Early entries capture launch-intent searches while they peak. The stub is still a normal pre-launch addition: it passes Phase 1 eligibility, gets a canonical-order position and a `listing-decisions.json` class, and clears every Phase 4 coupling group and Phase 7 check. Only the research depth is deferred.

Minimum stub content:

- Identity and classification: canonical `id`, `name`, `symbol`, `status: "pre-launch"`, `flags` (`backing`, `governance`, and `pegCurrency` when not USD) and a `oneLiner` that states only what the announcement supports.
- One primary source: the announcement itself, in `links` and as the `sourceUrl` of the milestone below. Secondary reporting alone does not open this lane.
- One milestone: the dated announcement (`type: "announcement"`, or `regulatory` for a licence or authorisation), plus `announcedDate`. Add `launchPhase`, `expectedLaunchDate` or `launchPhaseDetail` only when the source states them; never infer a phase or date from promotional language.
- `blacklistabilityReview` in `domains/risk-review/<id>.json`: when no source describes holder-control powers yet, record the reviewed status with a `sourceFreeRationale` that says the verdict follows the issuer model in the announcement.

Deeper research follows through the [`pre-launch-update`](../../.codex/skills/pre-launch-update/SKILL.md) review: collateral, peg mechanism, jurisdiction, featured content, further milestones and any refined blacklistability evidence. A stub never skips the [Phase 1a runtime gate](#1a-hard-runtime-data-gate-for-active-assets) at promotion.

### 0b. Plan the per-coin registry file

- Identify exactly one JSON file under `shared/data/stablecoins/coins/`; its filename must be `<id>.json`, matching the canonical stablecoin ID in the object.
- Plan `status: "pre-launch"` in that per-coin file for upcoming assets, regardless of peg. Remove the pre-launch status once the asset activates and has enough live metadata for active public surfaces.
- Do not edit the registry yet unless you are updating an already-approved existing entry. New active additions should pass Phase 1 and have a Phase 2 research packet first.
- Do not recreate the deleted legacy category shards (`pre-launch.json`, `usd-major.json`, `usd-minor.json`, `non-usd.json`, `commodity.json`); `npm run check:stablecoin-data` fails if any of those filenames reappears.

### 0c. Plan canonical order

Every tracked asset, including pre-launch ones, must appear in `shared/data/stablecoins/canonical-order.json`.

- Decide the intended canonical position before editing.
- Use current market cap / strategic ordering, not simple append-only ordering.
- Pre-launch assets usually live near the tail, but they still need an explicit position.

---

## Phase 1 - Eligibility Check

Before tracking a coin, confirm it belongs on Pharos:

| Question                                                                                              | Guidance                                                                           |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Is it pegged to fiat, a commodity, or a macro reference?                                              | Yes -> proceed                                                                     |
| Is it meant to be price-stable or to appreciate from a stable base in a way Pharos explicitly models? | Yes -> proceed                                                                     |
| Is supply observable on-chain or through a credible third-party source?                               | Some supply observability is enough to track metadata; full history can come later |
| Is circulating supply at least about $5M?                                                             | Soft threshold only. Smaller assets need a clear strategic reason                  |

### 1a. Hard runtime data gate for active assets

Active additions and pre-launch promotions must have both a fetchable current price path and a fetchable circulating/market-cap path before they are considered addable. Pre-launch entries are exempt until promotion.

Record one accepted path in the research packet, proving **both** current price and positive supply/market cap:

- **DefiLlama:** `llamaId` identifies this asset and list/detail exposes price; positive list `circulating` passes `getCirculatingRawOrNull()`. It is already USD—do not multiply by price.
- **Supplemental fiat:** `detailProvider: "coingecko"` with positive observed price from verified `geckoId`, or the supported single-contract resolver without one; positive fresh `usd_market_cap` or a path admitted by `hasRuntimeOnchainSupplyPath()` in `shared/lib/onchain-supply-probe.ts`. Static admission metadata does not prove live fetchability.
- **Commodity:** verified `geckoId` price and positive `commodityOunces` for every active GOLD/SILVER token, including 1oz tokens. Supply is positive fresh CoinGecko market cap, fresh circulating supply × resolved price for silver, a reviewed curated aggregate, or a dedicated gold slug in `shared/lib/commodity-protocols.ts` with usable `mcap`.
- **Explicit runtime exception:** demonstrate maintained source-specific price integration (such as Zephyr Scanner) and independently supported supply/market-cap integration; a price allowlist alone is insufficient.

Do not treat a filled JSON profile, static route or canonical-order inclusion as sufficient. If either requirement fails, do not add the asset as active; retain pre-launch/watchlist material or document the missing upstream path before continuing.

Runtime price-coverage monitoring is separate from this pre-edit gate. Missing price neither suppresses an otherwise admitted market cap nor makes the served surface stale. [Active-price gap duration bands](../status-dashboard.md#active-price-gap-duration-bands) owns continuity, alert thresholds and acknowledgement; `STATUS_MISSING_PRICE_THRESHOLDS` owns their values. Persistent unpriceability needs reviewed re-sourcing or a catalog decision, not indefinite waiting.

Exclusions:

- free-floating NAV/fund-share tokens with no stable reference
- assets that are not meaningfully stable
- additions that would require bespoke supply overrides instead of the existing pipeline

Important current taxonomy note:

- For active tracked assets, classify backing by actual collateral base. No tracked coin has standalone `algorithmic` backing; use `rwa-backed` or `crypto-backed`. The historical `algorithmic` enum remains solely for off-catalog PSI continuity metadata, not catalog admission.

---

## Phase 2 - Build The Research Packet

Do the research manually, or use the maintained skills when they match the task:

- `stablecoin-addition-orchestrator`: gather generic scalar metadata, run the full phase checklist, and coordinate the supporting skills.
- `stablecoin-runtime-price-marketcap-gate`: prove the hard active-asset price and market-cap path from Phase 1a.
- `stablecoin-identity-contracts`: verify `geckoId`, populate known deployments, or discover missing chain coverage.
- `reserve-research`: populate `reserves[]` composition for a single coin.
- `compliance-research`: research `genius`, `mica`, or both into the compliance sidecar.
- Mint Authority does not have a publication skill yet. Use the Phase 5f primary-source review rubric below and the existing `audit:mint-authority-review` / `audit:mint-bridge-ownership` QA commands.
- `write-ai-summaries`: draft or refresh the `data/ai-summaries.json` entry.
- `resilience-classify`: pick `collateralQuality` and `custodyModel` overrides.
- `pre-launch-update`: refresh milestones, launch phase, and featured content for pre-launch entries.

These skills do not replace review — they are research scaffolding. Always verify the output against official sources before editing the registry.

### Addition/evidence handoff packet

Keep one compact packet per asset in the task handoff (or ignored `agents/` scratch when a cross-session handoff needs it). This is handoff data, not a persisted registry or a new schema. Link to source-owned fields and evidence rather than copying inventories or policy thresholds.

| Packet field | Required handoff |
| --- | --- |
| ID/lifecycle | Canonical ID, active addition / pre-launch draft / promotion, target base file, canonical-order position, and listing decision. |
| Identity/deployments | Proposed or verified `llamaId`/`geckoId`/other routing IDs; each deployment's chain, exact identity, amount encoding/decimals, evidence, and unresolved identity conflicts. |
| Sources/admission | Source URL/code path, retrieval time, upstream observation or document date (unknown when absent), and pinned block/hash/time for on-chain reads. Record source-owned freshness/admission verdicts and reasons, including separate observed price and market-cap/supply evidence and the Phase 1a `PASS`/`FAIL` or pre-launch exemption. |
| Issuance ownership | For each deployment, reviewed native issuance, bridge/wrapped representation, or unknown, with supporting evidence and unresolved controls. Use the schema-owned route identities and issuance models from [sidecar ownership](./stablecoin-research-sidecars.md#domain-ownership); unknown is not reviewed absence. |
| Authorized writers | Base/sidecar paths, permitted fields, assigned writer, and the explicit apply authorization or research-only boundary. Name the separately authorized Mint Authority and Bridge Risk owners when deployment changes couple them; a packet never grants write authority. |
| Reviewed gaps | Each applicable editorial/downstream branch: added, reviewed not applicable, or intentional gap with reason, evidence scope, and unanswered questions. Distinguish unchecked/unavailable evidence from a reviewed negative. |
| Changed sources/outputs | Proposed versus actually changed source paths; generated artifact IDs/outputs expected from the owning registry, then the coordinator's actually regenerated/changed outputs after integration. |
| Admission receipt | For a listing or a pre-launch -> active promotion: the committed Safety Score admission receipt path, its replay `captureId`, the registry fingerprint it is bound to, and the asset's own versus inherited open-question counts. Not applicable to a pre-launch stub. |
| Verification | Commands/source reads actually exercised, observed result and source state, versus unexercised checks, backfills, or post-deploy observations. Never report a planned check or successful deploy as observed runtime health. |

Populate the pre-edit evidence and authorization fields before Phase 4, then update changed paths and verification after integration. Active additions/promotions still require the Phase 1a gate **before editing**; a packet cannot waive it.

In coordinated additions, specialists return their portion of this packet and land only authorized source edits. They do not regenerate shared artifacts or repeat catalog-wide checks. The addition orchestrator (or the coordinating agent when working manually) owns one [Phase 7 generation/check pass](#phase-7---validate) after all base, sidecar, and downstream edits land. Specialist evidence checks still run when required; they are not catalog generation. A standalone approved specialist edit has no separate coordinator, so its author owns the same generation and applicable checks after coupled edits are complete. Research-only work never generates or applies data. If later source edits invalidate the integration results, the owner refreshes the affected generation/checks rather than reusing stale proof.

### Always collect

Always research `id`, `name`, `symbol`, target file, lifecycle, backing/peg/governance/yield/RWA/NAV flags, collateral, peg mechanism, links, contracts and reserves. `StablecoinMetaStructuralSchema` in `shared/types/stablecoin-meta-schemas.ts` owns their field shapes; `shared/lib/stablecoins/schema.ts` owns semantic catalog admission, and the [registry editing rules](../stablecoin-data.md#editing-rules) own authoring semantics. Record the evidence in the [handoff packet](#additionevidence-handoff-packet). Schema defaults do not replace Phase 3 research or the Phase 3.5 editorial gate.

### Collect when applicable

Evaluate optional metadata against the asset's actual mechanism and supported pipelines: discovery/provider routing, parent/variant identity, report/attestor evidence, jurisdiction, dependencies, reviewed controls, resilience overrides, feature configs and pre-launch milestones. The schemas own field names and allowed values; each applicable editorial or downstream branch still needs a sourced decision or explicit gap.

### Research questions you should answer up front

- Is the coin in DefiLlama stablecoins? If yes, what is its `llamaId`?
- Is it on CoinGecko? If yes, what is its `geckoId`?
- Does it have a stablecoin-specific CMC slug worth keeping as a fallback?
- Which Phase 1a runtime data path admits it, and what are the expected initial `priceSource` and `supplySource` / market-cap source?
- If relying on on-chain total-supply fallback, is there exactly one supported deployment (or a documented curated exception), and are decimals verified?
- Does it have a reviewed hard-price or oracle source that should be documented?
- Does it have a public reserves/transparency API or on-chain reserve proof?
- Is there a meaningful redemption route worth modeling?
- Is the token itself yield-bearing, or is yield only available through a separate wrapper?
- Is Ethereum a canonical issuance chain worth tracking for mint/burn?
- For each supported `contracts[]` or high-signal `tradedContracts[]` chain, does the chain resolve to a L2BEAT project? If yes, record L2BEAT layer, category, host chain, stage, under-review flag, and weak risk fields as chain-route review context.
- Which deployment(s) create native liabilities, and which are bridge or wrapped representations? For native issuance, identify users, issuer/operator, minter roles, facilitators, proxy/cap admins, backend signers, governance, timelocks, Safes/multisigs, wrapper parents, or unresolved authority. Review bridge mint/burn, adapters, lockboxes, messaging, limits, upgrades, and administrators separately.
- Does Bluechip publish a rating for it?
- Does it belong to an existing infrastructure cohort such as `liquity-v1`, `liquity-v2`, or `m0`?
- If the asset is active, what admits it into `/api/stablecoins`: `llamaId`, commodity `geckoId`, or `detailProvider: "coingecko"` with `geckoId` or `hasRuntimeOnchainSupplyPath()` (single supported deployment, curated aggregate, or Zephyr Scanner)?

### Research quality rules

- Verify contract addresses against official docs and the relevant explorer.
- For EVM contracts, store lowercase hex addresses.
- Keep Solana, Tron, TON, Aptos, Sui, Near, and other non-EVM addresses in their native display form.
- Use `x.com`, not `twitter.com`.
- Prefer specific collateral descriptions over marketing copy.
- If a live reserves feed exists, pick an adapter key from `LIVE_RESERVE_ADAPTER_KEYS` in `shared/types/live-reserves.ts` rather than inventing a new one. Only add a new adapter (and key) when no existing one applies.

---

## Phase 3 - Classify It Correctly

### Schema-owned values

Do not copy enum inventories into this process. Read the current values from the owning schemas before editing:

- `shared/types/stablecoin-meta-schemas.ts` for catalog metadata and research profiles
- `shared/types/core.ts` for shared stablecoin classifications
- `shared/types/live-reserves.ts` for live-reserve adapter and semantic keys
- `shared/lib/stablecoins/schema.ts` for the assembled registry contract

Use a nearby coin only as a structural example. The schemas and `npm run check:stablecoin-data` decide which values are valid.

### Classification rules that are easy to get wrong

- `flags.backing` should describe the actual reserve base, not the marketing story.
- `structured-tranche` is reserved for runtime opportunity rows such as Royco Dawn senior/junior vaults. Do not use it for ordinary static stablecoin metadata unless the tracked asset is itself a tranche wrapper.
- Flags that equal schema defaults may be omitted or authored explicitly. `StablecoinFlagsSchema` supplies `pegCurrency: "USD"`, `yieldBearing: false`, `rwa: false`, and `navToken: false` when the key is absent, so the parsed record and every generated aggregate still carry explicit values. `backing` and `governance` have no default and are always required.
- `flags.governance` is the coarse public taxonomy. `governanceQuality` is the finer descriptive control-posture label, not a Safety Score input.
- Every coin — including pre-launch — requires a `blacklistabilityReview` with sources or an explicit `sourceFreeRationale`. Its `reviewedStatus` is the canonical verdict; `check:stablecoin-data` fails on any entry without one. Apply the [FreezeWatch decision procedure](../blacklist-tracker.md#freezewatch-decision-procedure) for status values, material deployments, direct-control precedence, parent/custody/reserve bases and evidence requirements; do not infer holder-control powers from governance or mint authority.
- `mintAuthority` is curated metadata that feeds Safety Score V9 Economic Control facts and its published mint component. The separate Mint Authority scoring engine is retired. This metadata does not create selector exclusions. Require reviewed primary-source/control evidence, and do not use it as a workaround for blacklistability/freezability review. Active variants require an explicit `mintAuthority` review, normally `wrapped-or-variant-inherited` with `inheritedFrom` set to `variantOf`, so inherited mint risk cannot silently become an unresolved V9 gap.
- `bridgeRouteRisk` is curated metadata for cross-chain mint, lockbox, attestation, liquidity, intent, or canonical routes. The current Safety Score consumes reviewed bridge evidence with bounded runtime materiality; missing required evidence becomes an explicit gap or cap. L2BEAT Interop matches are research leads, never sourced profiles or backing edges: verify the exact deployed route, contracts, controls, and primary sources before authoring a profile.
- `pegReferenceId` requires `variantOf` and must equal it; it is not a standalone dependency or NAV-reference field.
- `variantOf` / `variantKind` co-require and are allowed for post-launch readable children, not pre-launch entries. Active children require an active parent; inactive readable children require a readable parent. The parent must be non-variant and non-`navToken`, and `pegReferenceId` must equal `variantOf`. Use `VARIANT_KIND_VALUES` in `shared/types/core.ts` for supported kinds and `shared/lib/stablecoins/validate-variants.ts` plus `schema.ts` for admission rules: `pure-wrapper` keeps `navToken === false`; other kinds require `navToken === true`, and `risk-absorption` requires `wrapperOperator`. V9 evaluates wrapper strategy and parent caps; retired Selector ceilings do not apply. Review wrapper-local controls and parent exposure through the same [FreezeWatch procedure](../blacklist-tracker.md#freezewatch-decision-procedure), not a variant-specific status rule.
- `tradedContracts` is for market-traded variants that matter for discovery/liquidity/yield identity but are not the canonical supply contracts.

### Infrastructure taxonomy vs dependency graph

`infrastructures[]` is project taxonomy. `dependencies[]` is reserve/mechanism dependency.

L2BEAT `type`, `category`, `hostChain`, stage, and risk fields are chain-route context. Use them to review bridge-route and host-chain exposure, but do not copy them into `infrastructures[]` and do not turn host chains into `dependencies[]` unless there is an actual stablecoin collateral/mechanism/wrapper dependency.

Use `infrastructures[]` only when the coin directly belongs to a supported technical lineage:

- `liquity-v1`: original Liquity design, 110% liquidation threshold, Stability Pool liquidations, no ongoing borrower interest
- `liquity-v2`: BOLD-style design, user-set borrower rates, branch-style collateral markets, Stability Pools
- `m0`: built on the M0 issuance platform, minter governance, `SwapFacility`, `MExtension.sol` pattern

Important M0 rules:

- M0-built coins may or may not actually hold `m-m0` in reserves.
- `m-m0` is itself tagged `["m0"]` as the base infrastructure asset, so it appears in the M0 infrastructure cohort.
- A wrapper or downstream derivative should not inherit `["m0"]` automatically just because the base asset depends on M0.

Use `dependencies[]` separately to describe asset relationships:

- `wrapper`: direct 1:1 or near-1:1 wrapper on another tracked asset
- `mechanism`: the upstream asset is central to the mint/redeem mechanism
- `collateral`: the upstream asset sits in the reserves/collateral stack

Prefer `reserves[].coinId` plus explicit `depType` for reserve-derived relationships. Manual-only edges require a sourced `dependencyReview` matching the authored relationships. Do not duplicate a reserve edge's default economic role; an overlapping manual edge is allowed only when its sourced review assigns an exclusively distinct `economicRole` at the same weight.

### Reserve composition rules

Populate `reserves[]` with real slices, not generic prose.

- Percentages should reflect the best reviewed current mix.
- Use `coinId` when a slice is another tracked stablecoin.
- Every authored slice with `coinId` requires explicit `depType`; `depType` without `coinId` is invalid.
- Use `shared/lib/reserve-asset-risk.ts` for legacy `risk`; current Backing uses structured slice fields, not that tier alone.
- Even with `liveReservesConfig`, keep `reserves[]` up to date because fallback views and dependency logic still use it.
- For a reviewed stablecoin-looking aggregate or exogenous slice that cannot be linked, add a `reserveReview.nonLinkDispositions` row with one of `untracked-exogenous-asset`, `self-reserve`, `basket-needs-split`, `insufficient-evidence`, or `not-applicable`. Candidate IDs document research leads only and never substitute for evidenced constituent weights.

### Hero verdict, mechanism archetype, and attestor-tier surfacing

Three optional clusters on `StablecoinMeta` drive the hero verdict, mechanism schematic, and attestor badge. Schema optionality is not an addition-time waiver: apply Phase 3.5 before omitting them.

**`oneLiner` (top-level string, ≤160 chars)** — plain-language one-sentence verdict rendered as the hero TL;DR.

- Active asset: present-tense, names issuer + backing + redemption shape. Example for USDC: "USDC is Circle's centralized dollar stablecoin, redeemable 1:1 and backed by short-term U.S. Treasuries, repos, and cash held in an SEC-regulated reserve fund."
- Synthetic / hedged asset: name the hedge shape and where yield comes from. Example for USDe: "USDe is a synthetic dollar that stays near $1 by hedging crypto collateral with equal short positions on derivatives exchanges; yield comes from funding rates."
- Frozen / paused asset: use past tense and name the event. Example: "USR was Resolv Labs's delta-neutral synthetic dollar that paused issuance in 2026..."
- The `oneLiner` is also the profile meta description. Keep supply, AUM or other drifting amounts out of it ("~HK$527k circulating"); a `oneLiner` with such an amount is replaced in metadata by a generic fixed-structure sentence ([Metadata](../stablecoin-detail-page.md#metadata)).

**`brand` (optional top-level string, ≤20 chars)** — the issuer short name people search for (Circle, Paxos, JBFD), used in profile titles. Set it only when `name` omits the issuer, repeats the symbol, or is too long for a title.

**`mechanismArchetype` (top-level enum)** — coarse mechanism class that selects the mechanism flow drawn in the detail page's Mechanism module (`PegStabilityCard`), above the curated peg-mechanism prose.

Mapping cheatsheet:

- `fiat-cash`: RWA-backed + centralized + cash/repo/short-T-Bill mix (USDC, USDT, PYUSD). Formally also covers protocol-reserve-backed FX inventory — assets minted and burned against a shared on-chain protocol reserve at oracle rates with no borrower vault, health factor, or liquidation path (the Mento class: USDm, EURm, and the Mento FX stables). Read the class as reserve-backed cash-equivalent inventory issuance, not strictly custodial off-chain cash.
- `tbill`: RWA-backed + dominantly Treasury fund or NAV-bearing (USTB, USDtb, USDY)
- `cdp`: crypto-backed + decentralized + overcollateralized vaults (DAI, LUSD, crvUSD)
- `synthetic-delta-neutral`: crypto + hedging in `pegMechanism` (USDe, USR)
- `algorithmic`: mechanism archetype for reflexive/programmatic peg mechanisms; it is not tied to `flags.backing`. Current active entries with this archetype remain classified by actual collateral base.
- `rwa-credit-fund`: tokenized share of a managed credit/fund book whose value comes from NAV rather than a redeemable cash float; it selects `stable-value-investment` for non-variants. An unresolved mechanism review can also select that class under [listing-class precedence](../listing-policy.md#listing-classes).
- `commodity-claim`: redeemable claim on allocated physical commodity (PAXG, XAUT).

Wrappers (with `variantOf` set) generally inherit the parent's archetype; omit on the child if uncertain.

**`proofOfReserves` extensions** — four additive attestor fields inside the existing `proofOfReserves` object, used for the attestor-tier badge, plus an optional structured `latestReport` block that the badge does not read.

- `attestorTier`: `"big4"` (Deloitte, EY, KPMG, PwC), `"regional"` (BDO, RSM, Grant Thornton, Crowe, Mazars, Moore Stephens, Baker Tilly, Withum), `"niche"` (smaller / jurisdictionally-thin firms; single-purpose attestors), `"self"` (self-reported, no third-party signoff), `"none"` (a reviewer established that no attestation exists — the issuer's materials were enumerated, or a claimed attestor was checked and refuted), or `"undisclosed"` (the issuer names no attestor, or a named artefact could not be retrieved). Prefer `"undisclosed"` over omitting the block: omitting loses the reviewed fact that we looked. Omit the field only when the asset has no attestor concept at all, such as on-chain-verifiable bridge reserves.
- `cadence`: `"daily-nav"` (daily NAV publications, T-Bill funds, BUIDL-style), `"real-time"` (live on-chain feeds, Chainlink PoR, on-chain dashboards), `"daily"` (daily non-NAV reports or account checks), `"weekly"`, `"monthly"` (standard monthly attestations), `"semi-monthly"` (twice-monthly attestations), `"quarterly"`, `"semi-annual"`, `"annual"`, `"ad-hoc"` (irregular or one-off), `"none"` (established that nothing periodic is published), or `"undisclosed"` (a cadence is claimed but no artefact is retrievable, or nothing was reviewed).
- `attestorJurisdiction`: free-text country/region (e.g. `"United States"`).
- `attestorLicense`: free-text license/registration (e.g. `"PCAOB-registered"`).
- `latestReport`: optional record of the most recent attestation — period end, publication date, assurance method, assets-only versus assets-and-liabilities scope, liability reconciliation, and review provenance. Two schema refinements reject a publication date earlier than the period end, and an `assets-and-liabilities` scope paired with `none`/`unknown` liability reconciliation. See [Stablecoin Research Sidecars](./stablecoin-research-sidecars.md) for how this block is researched and where it is projected.

The durable schema lives in `shared/types/core.ts` and `shared/types/stablecoin-meta-schemas.ts`; refer to those schema files and the methodology page for the durable spec.

### When to override resilience/decentralization fields

Default inference exists, but many real assets need explicit overrides.

Override when the defaults would hide real structure, especially for:

- non-Ethereum primaries
- third-party bridge deployments
- wrapper tokens
- centralized custody around otherwise on-chain systems
- sanction-linked or CEX-held collateral
- regulated issuers that deserve `regulated-entity`

---

## Phase 3.5 - Editorial Coverage Gate

Before writing the per-coin JSON in Phase 4, verify that every editorial field is either filled or recorded as an intentional gap. This is the gate that turns the optional fields in Phase 3 into a required-or-waived decision so curation does not silently regress on new additions.

Required fields and their conditions:

| Field                             | Required when                                                                                                                                       | Acceptable waiver                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `oneLiner`                        | every active or pre-launch coin                                                                                                                     | none — frozen coins follow the past-tense rewrite path instead                                                    |
| `mechanismArchetype`              | every active coin (a variant may inherit the parent archetype; a divergent variant archetype needs `archetypeOverride: true` plus a `resolved` review)                       | a sourced `mechanismArchetypeReview` with `disposition: "unresolved"` — verify with `npm run audit:coverage -- --domain=mechanism-archetype` |
| `proofOfReserves.attestorTier`    | `proofOfReserves.type === "independent-audit"`                                                                                                      | none — if the attestor is genuinely unknown, set `attestorTier: "undisclosed"` and record the reason in `provider`                                    |
| `mintAuthority` coverage decision | new high-value active additions or pre-launch promotions (top-60 by canonical rank, market cap ≥ $50M, or issuer/operator has obvious mint control) | record an "intentional gap" line in Phase 5 coverage notes with the unresolved control path or source gap         |
| `data/ai-summaries.json` entry    | every active coin                                                                                                                                   | record skip reason in Phase 5 coverage notes                                                                      |

Run this gate before saving the per-coin JSON, working manually or through `stablecoin-addition-orchestrator` — the skill routes back to this document rather than carrying its own copy of the rubric, so the check is re-reading the fields against the table above.

The ordinary noncritical runtime-parser test `src/lib/__tests__/term-markup.test.ts` fails if AI-summary term markup references unknown glossary slugs or leaves raw opening/closing markers.

Mint Authority coverage is currently a manual reviewed-or-waived gate because absence can be intentional for direct, non-variant assets. `npm run check:stablecoin-data` validates authored `mintAuthority` profiles against the schema and requires active variants to carry an explicit inherited/wrapper review, but it does not require every high-value direct coin to have one yet.

Per-coin coverage in the retained annotation corpus (`shared/data/annotations/coins/*.json`, loaded by `shared/data/annotations/curated-annotations.ts`) is not gated by CI because absence is editorially ambiguous (no event vs. unrecorded event). It is handled instead by the `agents/annotation-candidates.md` queue, the `npm run candidates:annotations` producer, the `annotations-refresh` skill, and the `npm run digest:curation` rollup. The orchestrator appends a `launch` candidate row to the queue when a coin enters Pharos via a recent launch (see Phase 5 step on recent-launch annotation candidates). This intake does not restore the retired chart overlay or publish candidates automatically.

---

## Phase 4 - Edit The Registry

Add scalar metadata to the asset's per-coin JSON file using current field names and enum values. Author `reserves` in `domains/reserves/<id>.json` and the mandatory `blacklistabilityReview` in `domains/risk-review/<id>.json`, under `shared/data/stablecoins/`; see [sidecar ownership](./stablecoin-research-sidecars.md#domain-ownership).

### Minimal active-asset skeleton (field shapes only — a real entry also needs the mandatory `blacklistabilityReview` from Phase 3 and a `listing-decisions.json` class)

Use `StablecoinMetaAssetSchemaShape` in `shared/lib/stablecoins/schema.ts` for the active-asset shape and the [registry editing rules](../stablecoin-data.md#editing-rules) for authoring semantics. A valid base row alone is insufficient: add the required risk-review sidecar, listing decision, Phase 3.5 editorial decisions and observed Phase 1a runtime PASS. UI fallbacks do not waive these gates.

### Mint Authority profile shape

Author the profile in `shared/data/stablecoins/domains/mint-authority/<id>.json` using the [Mint Authority authoring contract](../stablecoin-data.md#mint-authority-and-bridge-risk-ownership) and the schema in `shared/types/stablecoin-meta-control-schemas.ts`. Follow Phase 5f for evidence and coverage; a copied example is not a reviewed profile.

### Current registry editing checklist

- Add or update the asset's JSON object in `shared/data/stablecoins/coins/*.json`.
- Add the ID to `shared/data/stablecoins/canonical-order.json`.
- Add the ID and derived class to `shared/data/stablecoins/listing-decisions.json`.
- Hand off completed source edits for the single Phase 7 generation/check pass; do not regenerate while specialists are still editing.
- Keep new keys canonical and consistent with the current schema.
- For active assets, ensure there is a runtime cache admission path and a Phase 1a price + market-cap gate record:
  - DefiLlama-tracked assets need `llamaId`.
  - Fiat assets not in DefiLlama need `detailProvider: "coingecko"` plus either `geckoId` or a supply path accepted by `hasRuntimeOnchainSupplyPath()` in `shared/lib/onchain-supply-probe.ts`.
  - Gold/silver assets need a `geckoId` for the commodity supplemental path.
  - Do not rely on `canonical-order.json` alone; static routes can exist before the Worker `/api/stablecoins` cache has a row.
- If `mintAuthority` is present, keep it sourced and schema-valid; if it is missing for a high-value active addition, record the intentional gap in Phase 5 coverage notes.
- For an active multi-deployment asset, complete the native-versus-representation review in Phase 5f: Mint Authority controls and mutable upgrade paths need native-only deployment references unless a reviewed `noLocalIssuance` exception applies; bridge capabilities need structured route-scoped controls.
- Work the three coupling groups below. The build, tests, and generated-artifact gates fail on **every** addition (active or pre-launch) until they match the registry.
- Record source and coupled-sidecar changes in the handoff packet for Phase 7 validation.

### 4a. Generated client projections

Do not hand-edit `src/lib/stablecoin-static-data.ts` or `src/lib/command-palette-search-data.ts` when
the tracked set changes. They are stable re-export boundaries for the two gitignored modules emitted
under `src/generated/` by the `stablecoin-client-projections` compile-input artifact. The generator
derives counts, active peg coverage, the active-ID set, homepage profiles, and command-palette tuples
from the validated registries. The Phase 7 generation pass materializes both modules after catalog,
listing-decision, and sidecar edits land.

### 4b. Hardcoded catalog snapshots in tests

These are deliberate tripwires, not incidental fixtures. Update the expectation to the new
value; do not weaken the assertion.

| File | What moves | Applies to |
| --- | --- | --- |
| `shared/lib/__tests__/stablecoins.test.ts` | `EXPECTED_TRACKED_STABLECOIN_COUNT`, lifecycle ID snapshots, and the implementation-scope variant ID list | Count on every addition; pre-launch snapshot on additions/promotions; variant list for `variantOf` children |
| `scripts/__tests__/bridge-route-coverage-audit.test.ts` | Registry-derived equality of reviewed profiles and applicable multi-deployment coins | Supply reviewed route rows; no hardcoded count to bump |
| `src/lib/__tests__/reserve-coinid-validation.test.ts` | A `REVIEWED_WARNING_IDS` entry with the reason | Only when a new `reserves[].name` contains a tracked ticker and the slice intentionally carries no `coinId`. Link the slice with `coinId` instead whenever that is honest. |

### 4c. Registry-derived artifacts that are checked in

These read the tracked catalog, so a coin addition selects them for regeneration. The complete
artifact inventory and each unit's command live in `GENERATED_ARTIFACT_REGISTRY`
(`scripts/lib/automation-registry.mjs`). Catalog edits also rotate the checked-in Safety Score
evaluation-build manifest, even without a new overlay; `public/llms.txt` changes when its catalog
output changes. Cemetery units cover cemetery rows only, so a live addition leaves them
byte-identical; regenerate affected tracked units explicitly and commit them with their sources.

These are artifact owners, not per-specialist steps. The coordinator owns Phase 7 generation; bootstrap includes the ignored `llms-txt` compile/serve output, which post-refresh generation rebuilds after live data updates.

| Artifact | Owning generator | Notes |
| --- | --- | --- |
| `public/llms.txt` | `npx tsx scripts/maintenance/generate-llms-txt.ts` | Active-stablecoin count in the summary line plus one per-coin entry |
| `public/datasets/stablecoin-cemetery.json` + `.csv` | `npx tsx scripts/maintenance/generate-cemetery-dataset.ts` | Provenance pins the curated dead-stablecoin file and the frozen-row projection, so a live addition leaves it byte-identical; it moves only when a frozen or dead row changes |
| `public/logos/atlas/cemetery-atlas.webp` + `src/lib/cemetery-logo-atlas.generated.json` (`cemetery-logo-atlas`) | `npm run logos:cemetery-atlas` | Selected by catalog and `data/logos.json` changes, but its input signature covers only cemetery rows' logos, so a live addition leaves it byte-identical; it moves only when a cemetery row or its logo changes |
| `public/og-cemetery.png` (`og-cemetery`) | `npm run build:og-cemetery` | Selected with the atlas it embeds; its input signature is the rendered plot-map card, so a live addition leaves it byte-identical; it moves only when a cemetery row, the atlas or the plot map changes |

The Phase 7 bootstrap pass also materializes gitignored projections, including the client constants
and command-palette tuples that the build, tests, and `check:stablecoin-data` all read. It executes
every bootstrap-safe unit in `GENERATED_ARTIFACT_REGISTRY` (`scripts/lib/automation-registry.mjs`),
which owns the artifact inventory and each unit's command, so no downstream projection is left
stale behind the catalog aggregate.

Gotcha worth recognising: a stale client projection makes unrelated test files fail at import with
`[client-registry] canonical-order.json references unknown stablecoin ID: <id>` rather than a catalog
assertion. Finish source integration before the coordinator refreshes generation and checks.

---

## Phase 5 - Evaluate Downstream Coverage Branches

Do not assume every branch applies. Evaluate each one explicitly.

Before validation, record every branch as added, not applicable, or intentional gap with a reason: logo/summary, live reserves, yield, redemption backstop, mint/burn, Mint Authority, blacklistability, bridge routes, Bluechip, price/discovery, Safety Score V9 scoreability, and history backfill.

For a recent-launch addition or promotion, record a sourced `launch` candidate in `agents/annotation-candidates.md` for human review. The producer's lookback is owned by `scripts/maintenance/build-annotation-candidates.ts`; historical additions need a candidate only when a meaningful event is established. Candidate intake does not publish an annotation.

### 5a. Logo and summary

New tracked coins should ship with both:

- a logo entry in `data/logos.json`
- an editorial summary entry in `data/ai-summaries.json`

See Phase 6 for exact rules.

### 5b. Live reserves

When a usable transparency API, attestation feed or on-chain reserve proof exists, follow [adding a live-reserve adapter](../live-reserves.md#adding-a-new-adapter) and the [metadata contract](../live-reserves.md#metadata-contract). Reuse a matching adapter; add/register one only when no existing adapter applies. Mapped dependencies also require the owner's reviewed dependency-target disposition in the same change.

If no live source exists, keep curated `reserves[]`, record the gap and reason, and do not invent a config or adapter. A config never waives supply policy or permits manual supply overrides.

### 5c. Yield intelligence

If `flags.yieldBearing` is true, add reviewed `yieldConfig` and evaluate the runtime source under [Source Configuration](../yield-intelligence-operations.md#source-configuration). That owner defines source registries and intentional-gap authoring; do not invent a source or write a derived export.

If a wrapper is tracked separately, do not also force it through the base asset's wrapper map. When a tracked savings wrapper becomes the canonical yield surface, remove its yield metadata and historical ownership from the parent. Record unsupported sources as sourced typed intentional gaps.

### 5d. Redemption backstops

For a meaningful direct redemption or swap route, follow [Redemption Backstops](../redemption-backstops.md) for reviewed route/config admission, including access, settlement, execution, output, capacity and cost. If weak or unknown evidence prevents a model, record the intentional gap; soften `pegMechanism`/summary claims and add a notice or audit note so the profile does not imply a modeled holder backstop.

### 5e. Mint/burn flows

For meaningful issuance on a supported chain, follow [Mint/Burn Flow Tracker](../mint-burn-flows.md) for config/spec ownership, event adapters, canonical chain, reviewed start block/provenance, decimal-aware dust and bridge detection. Choose the owner's shortcut only for matching plain Transfer events; otherwise use its full-spec path. Record non-applicability or a coverage gap with a reason instead of inventing an adapter.

### 5f. Mint Authority review

Mint Authority review feeds the V9 Economic Control mint component and should answer whether durable native supply can be created directly or indirectly by privileged minters, minter admins, proxy/cap admins, facilitators, backend signers, governance, timelocks, Safes/multisigs, custodians, or only through user/protocol mechanics. Representations and cross-chain transfer machinery belong to Bridge Risk even when they share a controller with native issuance.

For new high-value active additions and pre-launch promotions, record either a reviewed `mintAuthority` profile or an intentional gap. High-value means top-60 canonical rank, market cap ≥ $50M, or an obvious issuer/operator mint control. Missing data is acceptable, but the detail page then shows an explicit not-reviewed (`NR`) Mint Authority card until reviewed data exists; do not imply unknown means safe.

Every new addition or promotion that authors a `mintAuthority` profile must also author `mintAuthority.headline`: the detail card's one-sentence verdict, at most 25 words, with no raw identifiers (contract addresses, block heights, second counts, gate codes such as `D29`, evaluator keys, or version pins). `npm run check:stablecoin-data` rejects a headline that breaks that budget (`findSummaryBudgetViolations` in `shared/lib/summary-budget.ts`). Keep the long reviewer narrative in `summary`, which the card folds under `Review notes`. Without a headline the card falls back to a verdict generated from structured fields, which is acceptable for legacy profiles but not for new work.

Use the [registry authoring contract](../stablecoin-data.md#mint-authority-and-bridge-risk-ownership) for field/refinement and deployment-ownership requirements. Research the exact native mint path, current controls, proxy/admin/cap powers, Safe thresholds/modules/guards, key custody, incidents and unresolved paths from primary sources and pinned reads. Preserve unknown/null versus reviewed absence or inapplicability; a failed read proves neither.

Apply the live mint owner's [scope](../mint-authority-scoring.md#current-v9-scope), [posture derivation](../mint-authority-scoring.md#mint-posture-derivation-and-quality-ladder-932), [D29](../mint-authority-scoring.md#governed-unbounded-issuance-1002), [D30](../mint-authority-scoring.md#minority-veto-issuance-1003), [H](../mint-authority-scoring.md#operationally-governed-issuance-1005), [D32](../mint-authority-scoring.md#uniform-voting-control-1005) and [D33 positive-process/fallback rules](../mint-authority-scoring.md#availability-invariant-mint-fallback-1006), rather than copying their gates here. Only complete, fresh source-bound certification can admit a process rung. A posture label, partial certificate, reverted sample call or sourced `processCandidate` headline cannot; known adverse reach remains even when proof is incomplete.

For every active multi-deployment asset, complete the registry owner's [native-versus-Bridge Risk review](../stablecoin-data.md#mint-authority-and-bridge-risk-ownership): exact route coverage, native-only mint/upgrade references or a reviewed no-local-issuance exception, and separately scoped bridge controls. Do not invent native issuance, duplicate a bridge capability in Mint Authority, or retain historical bridge vocabulary in active mint data. Catalog validation and compilation fail closed on invalid ownership.

Keep the exact control/path/class/member/field gaps and real exercise clocks. Do not copy admission delay onto exercise, parent issuance onto a wrapper-local charge, or a sibling's qualification onto this asset. Do not target a grade, invent relief, cosmetically refresh evidence dates, or turn a URL/character count into whole-liability reconciliation or supervisory proof. New evidence and final annotations must agree with the actual compiler derivation across every lifecycle status.

Use the reviewed-source and ownership audits after collecting primary-source native-control evidence:

```bash
npm run audit:mint-authority-review
npm run audit:mint-bridge-ownership
```

For a saved Mint Authority review queue, use `npm run audit:mint-authority-review -- --json --report agents/mint-authority-review/audit.json`. To probe cited source URLs, add `-- --live --live-limit 50` to the bare audit command; live probes are advisory and Markdown-only.

These audits check authored review breadth and ownership; they do not discover authority facts or replace pinned source, proxy, role, and Safe evidence. Historical unknown scanner candidates are archival non-evidence.

### 5g. Bluechip ratings

If Bluechip covers the asset, update `shared/lib/bluechip-slugs.ts` (the worker imports `BLUECHIP_SLUG_MAP` from there).

Important: the map is `bluechip-slug -> pharos-id`, not the other way around.

### 5h. Price and discovery edge cases

Evaluate whether the asset needs any of these metadata fields:

- `cmcSlug` when CMC fallback matters
- `protocolSlug` for commodity/protocol-backed historical TVL paths
- `tradedContracts` for market-traded variants the runtime should recognize separately
- `pegReferenceId` for derivative NAV wrappers

### 5i. Safety Score V9 scoreability

A bare new coin publishes as `NR`, not as a low score. Missing mechanism evidence requires
a reviewed overlay in `shared/data/safety-score-v9/mechanism-review-overlays-v1.json`;
mint facts instead come from the `mintAuthority` sidecar through `adaptMintReview`.
Measurement producers use curated targets, not automatic catalog enrollment. Follow
[Mechanism Overlay Evidence Standard](./mechanism-overlay-evidence-standard.md), or record
the intentional mechanism-evidence gap separately from Mint Authority coverage.

Overlays are identity-bound: a batch lands through a replay on the pinned production envelope
with an attributed mover list, and unexplained movers stop the batch. Treat overlay authoring as
a deliberate reviewed change rather than a side effect of an addition, and expect
`npm run check:generated-artifacts` to report the `safety-score-v9-evaluation-build` manifest as
stale until the rotated identity is regenerated and committed.

### 5j. Safety Score admission receipt (new-asset evidence packet)

Listing a stablecoin, and promoting a pre-launch row to active, must pass the new-asset evidence packet gate. Unlike the branches above, this is a binary admission gate: a gated asset has no "not applicable" or "intentional gap" disposition — close the questions or use the owner override below. Only two PR shapes are gated: an added `shared/data/stablecoins/coins/<id>.json` whose status is active (`status` omitted or `"active"`), and a modified coin file whose status moves `"pre-launch"` -> active. A pre-launch stub publishes no scored open questions, and an ordinary edit of an existing asset is not gated. The check is `scripts/ci/check-new-asset-evidence-packet.ts`. It never re-derives the counting model — `shared/lib/safety-score-v9/open-questions.ts` owns question keys and buckets — and it reads the asset's counted questions from a committed receipt. A coin file whose status is unreadable or unrecognized is skipped here and fails `check:stablecoin-data`, which stays the catalog-validity authority.

#### Receipt

Commit one receipt per gated asset at `.github/artifacts/new-asset-evidence-packet/<id>.json`, named by the canonical asset id (lowercase `ticker-issuer`; the file name and `assetId` must agree). `NewAssetAdmissionReceiptSchema` in the gate is the field authority; the shape is:

```json
{
  "schemaVersion": 1,
  "kind": "safety-score-v9-new-asset-admission-receipt",
  "assetId": "ausd-acme",
  "captureId": "20261029T1814Z",
  "captureClockSec": 1793294244,
  "registryFingerprint": "<64 lowercase hex>",
  "card": {
    "id": "ausd-acme",
    "openBucketQuestionsCarried": 1,
    "inheritedOpenBucketQuestionsCarried": 0,
    "openBucketObligationsCarried": 1,
    "documentationObligationsCarried": 0
  },
  "questions": [
    {
      "questionKey": "ausd-acme|component|economic-control:mint",
      "bucket": "open",
      "inherited": false,
      "obligations": 1,
      "codes": [{ "code": "missing-mint-authority", "obligations": 1, "documentation": false }]
    }
  ]
}
```

- `card` is the replay's `openEvidence.byCard[]` row for the asset — the same counts the publication shows. The schema rejects a receipt whose list contradicts the row: open questions, inherited open questions, their summed obligations, and documentation-classed obligations must match the four `...Carried` counts.
- `questions[]` holds one row per question the card carries, across all three buckets: `questionKey` (the counting authority's key), `bucket` (`open`, `issuer`, or `documentation`), `inherited` when the key is rooted at another asset, the question's `obligations`, and one `codes[]` row per reason code with its own obligation count and documentation flag. Per-code obligations must sum to `obligations`; a `documentation` question carries only documentation-classed datums while any other bucket carries at least one counted datum; reason codes are unique per question.
- `registryFingerprint` must be the branch tree's registry fingerprint **after** the listing or promotion. A receipt replayed before the asset was in the tree is stale and rejected. Replay after the last coin edit: a second gated asset in the same PR changes the fingerprint and stales the first receipt. `captureId` and `captureClockSec` are provenance, not a freshness budget.

#### Gate conditions

The gate fails an asset when:

- the receipt is missing, is not valid JSON, fails the schema, or names another asset;
- its `registryFingerprint` differs from the PR checkout's fingerprint, recomputed over the loaded registry with the same authority the replay snapshot uses;
- the asset's own open questions exceed `NEW_ASSET_OPEN_QUESTION_LIMIT` (6). Own means `bucket: "open"` with `inherited: false`, i.e. `openBucketQuestionsCarried` minus `inheritedOpenBucketQuestionsCarried`. Inherited questions are counted once at their root: the pass line discloses them, and a non-documentation `missing-mint-authority` datum on an inherited question is a warning, not a failure;
- any of the asset's own questions carries a `missing-mint-authority` datum with `documentation: false`. The condition is per datum, not per code: a `missing-mint-authority` datum the documentation classifier assigned a documentation reason (`documentation: true`, a documentation-only gap such as a narrow reconciliation or supervision item) passes; a whole-profile, authority or topology gap stays counted.

The failure kinds are `invalid-asset-id`, `missing-receipt`, `invalid-receipt`, `mismatched-receipt`, `stale-receipt`, `open-question-limit`, and `missing-mint-authority`.

#### Override

The `new-asset-gate-override` owner label (the check's `--override`) bypasses the open-question count only. It never waives the receipt, its fingerprint binding, or the mint-authority condition, and the pass line marks the asset as overridden. Reserve it for an owner-approved addition whose remaining open questions are deliberately accepted, and say why in the reviewer notes.

#### Authoring the receipt

The gate trusts a committed, reviewed receipt: it does not re-run the replay. The counting authority publishes aggregates and `byCard`, not per-question rows (`V9OpenEvidenceCounter` exposes `add`/`finish` only), and the gate does not re-implement `obligationsForCard`. Until a per-question projection exists, produce `questions[]` from the replay that generated the capture and review it against the replay's `openEvidence` block; never hand-estimate the rows. Replay the newest production capture with `npm run safety-score-v9:replay` (see [Capture-Time Replay](../scripts.md#safety-score-capture-time-replay)).

#### Run it locally

```bash
npm run check:new-asset-evidence-packet -- --base=origin/main
```

| Option | Meaning |
| --- | --- |
| `--base=<ref>` | Base ref for the diff; default `PR_BASE_SHA`, then `GITHUB_BASE_SHA`, then `origin/main`. The diff runs from its merge-base to `--head`. |
| `--head=<ref>` | Head ref under test; default `PR_HEAD_SHA`, then `GITHUB_HEAD_SHA`, then `HEAD`. |
| `--receipt-dir=<path>` | Receipt directory; default `.github/artifacts/new-asset-evidence-packet/`. |
| `--override` | Treat the owner override as present (question count only). |
| `--json` | Print the full report as JSON. |

Exit codes: `0` admitted, `1` gate violation, `2` usage error. Ungated paths print their skip reason (`not-a-listing (pre-launch)`, `existing-asset`, ...). Without the package alias, run `node --import tsx scripts/ci/check-new-asset-evidence-packet.ts` with the same options.

---

## Phase 6 - Static Assets And Editorial Copy

### 6a. Logos

Current frontend practice is a local logo file plus a static map entry.

- Put the file in `public/logos/`
- Add an entry to `data/logos.json`
- New entries should use the canonical stablecoin ID as the key
- New local filenames should preferably be `${id}.${ext}` even though many historical files use older naming

Example:

```text
"ausd-acme": "/logos/ausd-acme.png"
```

Notes:

- `data/logos.json` keys are canonical stablecoin IDs today, though some values still point at legacy numeric filenames such as `/logos/1-usdt.svg`. Ignore that for new work.
- `scripts/maintenance/fetch-logos.ts` preserves canonical local `/logos/...` entries over provider images; CoinGecko fills entries without a local logo.
- If no logo exists yet, the UI can fall back to initials, but a tracked addition should ship with a real logo unless the coverage decision note records an explicit skipped reason.
- Oversized tracked logos (over 64px in either dimension and over 2500 bytes) also need 32px and 100px WebP derivatives for compact and header slots. These are checked-in generated artifacts owned by the `compact-logos` registry entry: after changing a `public/logos/*.{png,jpg,jpeg,webp}` source, run `npm run logos:compact` to regenerate `public/logos/compact/**`, chain variants in `public/chains/compact/**`, and `src/lib/logo-variants.generated.json`, pruning orphans; commit affected outputs with the source. `npm run check:generated-artifacts -- --only=compact-logos` verifies freshness. Source names must map to unique output filenames (for example `foo.png` and `foo.jpg` collide, as can `foo-100.png` and the larger `foo.png` variant); the generator rejects collisions before writing.

### 6b. Editorial summary

Add an entry to `data/ai-summaries.json` keyed by canonical ID:

```text
"ausd-acme": {
  "title": "Short headline",
  "text": "Evidence-grounded prose following the Coin summary register in docs/editorial-style.md.",
  "updatedAt": "2026-04-09"
}
```

Current expectations:

- keyed by canonical ID
- factual, specific, and editorial rather than marketing
- used on active detail pages and as teaser copy on `/upcoming/` when relevant

The `write-ai-summaries` skill (see Phase 2) is the standard path for drafting and refreshing these entries.

### 6c. Notices

If the coin needs explicit user-facing caveats, add `notices`.

### 6d. Historical annotation corpus (optional)

When a coin has notable historical events that the live tape can't recover (regulatory bans, market-wide shocks, mainnet launches, methodology pivots), curate them into `shared/data/annotations/coins/<stablecoin-id>.json`. The typed loader at `shared/data/annotations/curated-annotations.ts` validates the preserved editorial corpus. The chart overlay and its browser Tape reads have been retired; authoring preserves research history and human review/intake tooling, without automatic publication or live chart markers.

Authoring schema (the loader maps `date` to the runtime `ts` field; `note` is
editorial metadata retained in the source asset):

```json
{
  "date": "YYYY-MM-DD",
  "kind": "depeg",
  "label": "...",
  "severity": "med",
  "href": "https://...",
  "note": "..."
}
```

Use a full UTC ISO timestamp (`YYYY-MM-DDTHH:MM:SS[.SSS]Z`, with one to
three optional fractional digits) instead of the date-only form for sub-day
precision. The shared strict date parser rejects impossible calendar days and
out-of-range clock components at module initialization; admitted timestamps
retain millisecond precision without rounding to whole seconds.
`kind` must be one of the values in `CHART_ANNOTATION_KINDS`,
`label` is limited to 80 characters, `href` should be a primary source, and
`note` retains the editorial rationale. For a new corpus file, also add its import and ID mapping in `shared/data/annotations/curated-annotations.ts`; the corpus test checks file/loader parity.

Curation rules:

- One entry per discrete event (don't collapse multi-day depegs).
- Use the price-bottom / supply-pivot timestamp, not the press cycle.
- Severity follows the tape vocabulary: `high` for grade-impacting events, `med` for non-fatal stress, `low` for context.
- Keep the editorial rationale in the optional `note` field rather than a source comment.
- Sort each coin's array by `date` ascending.
- Do NOT invent dates. Drop a candidate rather than guess.

Coverage policy: top-50 coins by market-cap target ≥1 annotation each when a meaningful historical event exists. Coins without notable events stay uncurated (empty / absent key is the correct state). The historical launch seed remains a corpus-integrity contract: ≥10 annotations across the original top 4 seed coins (`usdc-circle`, `usdt-tether`, `dai-makerdao`, `usde-ethena`), enforced by `shared/data/annotations/__tests__/curated-annotations.test.ts`. It is no longer a flag-flip gate.

---

## Phase 7 - Validate

After all authorized specialist edits land, the coordinator owns the single generation/check pass. First confirm the addition-specific source decisions:

- per-coin JSON exists and matches the canonical ID
- all authorized base, sidecar, and downstream source changes listed in the handoff packet have landed
- `shared/data/stablecoins/canonical-order.json` includes the ID in the intended position
- active assets have a documented Phase 1a price + market-cap path
- `data/logos.json` has a canonical-ID key and the referenced local file exists, or the skip reason is documented
- `data/ai-summaries.json` has a canonical-ID key, or the skip reason is documented
- high-value active additions have either a reviewed `mintAuthority` profile or a documented intentional gap
- a listing or pre-launch -> active promotion has a committed Safety Score admission receipt replayed after the last coin edit (Phase 5j), and `npm run check:new-asset-evidence-packet` passes
- the source inputs and applicable Phase 4b test snapshots are ready for Phase 4a/4c generation
- downstream coverage decision notes cover every Phase 5 branch
- every per-coin or per-chain map this addition touches (native-peg currency, canonical mint/burn chain, Bluechip slug, redemption-backstop config) is derived from the registry or covered by a registry-iterating test that fails on the next unmapped addition — rule R5, ADR-32 in [../architecture.md](../architecture.md#adr-32); a "keep in sync" comment is not a mechanism

For a normal stablecoin addition, generate the working-tree projections once and run focused checks:

```bash
npm run bootstrap:generated
npx tsx scripts/maintenance/generate-llms-txt.ts
npm run check:stablecoin-data
npx vitest run shared/lib/__tests__/stablecoins.test.ts
npm run typecheck:worker
```

Confirm that `shared/data/stablecoins/coins.generated.json` and the Phase 4a/4c outputs match the integrated catalog. Update the packet with actually changed generated outputs and observed check results; do not count deferred post-deploy verification as exercised.

Base coin files feed the gitignored `sitemap-dates` projection, which is regenerated automatically and is not committed. Use the [smallest adequate checks](../testing.md#smallest-adequate-check-per-area) and the generated-artifact IDs selected by the router:

```bash
npm run check:generated-artifacts -- --only=stablecoin-client-projections
```

Run `check:stablecoin-data` first, then focused artifact checks. Run `npm run build` only for rendering changes or an explicit rehearsal. Before an authorized push, use `npm run check:pr` for focused authoring feedback under [Pre-push readiness](../testing.md#pre-push-readiness) and keep generated artifacts with their owning source changes. Local receipts are optional diagnostics; GitHub's protected `PR gate` is the readiness authority.

You can also run the individual checks directly when iterating:

- new redemption config -> `npm run audit:coverage -- --domain=redemption-backstops`
- L2BEAT-backed chain route review -> `npm run candidates:l2beat-bridge-routes` and `npm run audit:coverage -- --domain=l2beat-snapshot --check`
- dependency/process context review -> `npm run audit:coverage -- --domain=dependency-coverage` (report) or `npm run check:dependency-review-gaps` (gate), and inspect the L2BEAT Deployment Context section when contracts land on matched L2BEAT chains
- a gated listing or promotion -> `npm run check:new-asset-evidence-packet -- --base=origin/main`
- verified docs changed -> `npm run check:verified-doc-links`, `npm run check:doc-sync`

If you added or changed a new upstream/provider or methodology-affecting runtime path, update the matching verified docs in the same change:

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-and-api-limits.md`
- the area-specific feature doc
- `/methodology`, the owning methodology doc, and its structured changelog entry if scoring or methodology behavior changed
- the about page if a new data source was introduced

---

## Phase 8 - Push, Merge, Deploy, Then Backfill

This phase is post-validation and post-merge.

Only do the backfill after all of these are true:

- the local validation in Phase 7 passed
- the branch was pushed and passed the authoritative protected-main PR gate
- the pull request was merged into `main` through GitHub
- the production deploy completed

The branch/PR sequence itself is owned by [deployment-process.md](../deployment-process.md).

After the production deploy, backfill history for live assets:

- Skip pre-launch backfills until activation.
- For supply/market-cap history, use `backfill-supply-history` for `llamaId` assets and CoinGecko/commodity providers; it dispatches by metadata, not just `llamaId`.
- Use `backfill-cg-prices` for price repair or CoinGecko market-cap insertion, not as a substitute for historical supply replay when CoinGecko market caps are absent.
- Always target the new canonical ID with `--query 'stablecoin=<id>'`; an omitted target processes the default catalog batch, not the new coin. Read [One-Shot Backfills](../runbooks/one-shot-backfills.md) for credentials and write authorization before executing the examples below.

For commodity tokens (`pegCurrency: "GOLD" | "SILVER"`), `backfill-supply-history` automatically uses CoinGecko `market_chart` market caps as the primary source rather than DefiLlama TVL, because protocol TVL can diverge from token market cap (e.g. a protocol's multi-chain reserves exceeding the on-chain token supply). You still call the same CLI job; no extra flag is required. If CoinGecko has prices but missing/zero market caps, the CLI can replay historical EVM `totalSupply()` at each UTC day close for assets with exactly one supported EVM deployment; it does not project the current supply backward across the window. Multi-deployment assets fail closed unless CoinGecko market caps or a validated TVL fallback can cover the requested days.

Examples:

```bash
npx tsx worker/scripts/one-shot-backfill.ts backfill-supply-history --query 'stablecoin=ausd-acme' --execute
```

```bash
npx tsx worker/scripts/one-shot-backfill.ts backfill-cg-prices --query 'stablecoin=ausd-acme' --execute
```

Optional:

- `backfill-supply-history` accepts `allow-constant-price-fallback=true` for specific sparse-history cases

Do not create a branch or PR without release authorization. An authorized release uses protected `main` through a branch and PR, per [deployment-process.md](../deployment-process.md); apply Phase 7 readiness before every push.

## Phase 9 - Post-Deploy Verification

- [ ] The coin appears in the expected public surface:
      active -> detail and the appropriate homepage/table listing view (core by default; `variant=variants` for variants or `variant=catalog` for all active classes)
      pre-launch -> `/upcoming/` and pre-launch detail
- [ ] Logo resolves correctly
- [ ] Editorial summary renders correctly
- [ ] The detail page loads without runtime errors
- [ ] `coverage/` reflects the expected coverage state
- [ ] If `infrastructures[]` was set, the correct infrastructure hub includes the coin
- [ ] If `liveReservesConfig` was added, `GET /api/stablecoin-reserves/:id` works after the next four-hour reserve/redemption lane
- [ ] If `yieldConfig` or yield runtime config was added, the asset appears correctly on `/yield/` or in the detail yield section after the next yield sync
- [ ] If a redemption backstop was added, `GET /api/redemption-backstops` includes the coin after the next four-hour reserve/redemption lane
- [ ] If mint/burn coverage was added, the coin appears in `/api/mint-burn-flows` / `/api/mint-burn-events` after the next lane run
- [ ] If `mintAuthority` was added, the detail page shows the Mint Authority section and `/coverage/`, the homepage table, and `/screener/` reflect the expected bucket, score, and band
- [ ] If the asset is live and backfillable, the market-cap chart is no longer empty after Phase 8

---

## Source Reference

The editable catalog, sidecar ownership rules, generated projections, and validation commands are maintained in [../stablecoin-data.md](../stablecoin-data.md). For current enum values, use the schema-owned sources listed in Phase 3; do not maintain a second quick-reference inventory here.
