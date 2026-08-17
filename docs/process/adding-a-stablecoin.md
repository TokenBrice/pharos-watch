# Adding a Stablecoin

Reference for adding a tracked asset to Pharos.

Current source of truth is the per-coin JSON registry under `shared/data/stablecoins/coins/*.json` plus selective research sidecars under `shared/data/stablecoins/domains/<domain>/*.json`, loaded through the generated runtime aggregate `shared/data/stablecoins/coins.generated.json`, and validated by `shared/lib/stablecoins/schema.ts`. Pre-launch entries are ordinary per-coin files with `status: "pre-launch"`. Eligibility and lifecycle decisions follow [Stablecoin Listing Policy](../listing-policy.md). The older top-level stablecoin barrel, helper-constructor paths, and legacy category-shard edit paths are obsolete; the Claude/Codex skills (`stablecoin-addition-orchestrator`, `stablecoin-runtime-price-marketcap-gate`, `stablecoin-info-fetch`, `contract-populate`, `contract-enrich`, `reserve-research`, `write-ai-summaries`, `resilience-classify`, `pre-launch-update`, `coingecko-id-verif`) remain supported and can be used per their own triggers. Sidecar ownership and migrations are documented in [Stablecoin Research Sidecars](./stablecoin-research-sidecars.md).

> Completion gate: do not consider the job done until every phase below has been evaluated. The minimum committed diff is the per-coin registry JSON, `shared/data/stablecoins/canonical-order.json`, `shared/data/stablecoins/listing-decisions.json`, `data/logos.json`, `data/ai-summaries.json`, the hand-edited couplings and test snapshots in Phase 4a and 4b, and the checked-in registry-derived artifacts in Phase 4c. The regenerated `shared/data/stablecoins/coins.generated.json` is required for the build and the checks but is gitignored, so it never appears in the diff. If the asset needs runtime coverage, also evaluate yield, live reserves, redemption backstops, mint/burn, Mint Authority, Bluechip, Safety Score V9 scoreability, and history-backfill branches.

> **Agent navigation** — ~62 KB; Grep the phase you need instead of reading wholesale: Source Of Truth · Guardrails · Phase 0 Decide What You Are Adding · Phase 1 Eligibility · Phase 2 Research Packet · Phase 3 Classification · Phase 3.5 Editorial Coverage Gate · Phase 4 Edit The Registry (4a hand-edited couplings · 4b test snapshots · 4c checked-in artifacts) · Phase 5 Downstream Coverage Branches · Phase 6 Static Assets And Editorial Copy · Phase 7 Validate · Phase 8 Merge, Push, Deploy, Backfill · Phase 9 Post-Deploy Verification · Quick Reference.

---

## Source Of Truth

| File                                                                                                            | Purpose                                                                                                          |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `shared/data/stablecoins/coins/*.json`                                                                          | Editable source of truth for all catalog metadata and lifecycle state                                            |
| `shared/data/stablecoins/domains/<domain>/*.json`                                                               | Optional strict sidecars for migrated reserves, mint-authority, compliance, and risk-review research             |
| `shared/data/stablecoins/coins.generated.json`                                                                  | Generated/runtime aggregate; regenerate with `npx tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts` |
| `shared/data/stablecoins/canonical-order.json`                                                                  | Canonical tracked order used to build `TRACKED_STABLECOINS`                                                      |
| `shared/data/stablecoins/listing-decisions.json`                                                                | Compact exhaustive catalog ID to listing-class map                                                              |
| `shared/data/stablecoins/AGENTS.md`                                                                             | Agent notes pinned to the registry directory                                                                     |
| `data/logos.json`                                                                                               | Static logo map used by the frontend                                                                             |
| `data/ai-summaries.json`                                                                                        | Static editorial summaries used on detail and upcoming surfaces                                                  |

Useful repo references before editing:

- `docs/classification.md`
- `docs/listing-policy.md`
- `docs/data-pipeline.md`
- `docs/live-reserves.md`
- `docs/yield-intelligence.md`
- `docs/redemption-backstops.md`
- `docs/mint-burn-flows.md`
- `docs/report-cards.md`
- `docs/upcoming-page.md`
- `docs/stablecoin-detail-page.md`
- `docs/shadow-stablecoins.md` for PSI-only exclusions
- `docs/bluechip-ratings.md`
- `docs/about-page.md` when a new data source is introduced
- `docs/deployment-process.md` when verifying the post-merge backfill path

---

## Guardrails

- Use canonical Pharos IDs in `ticker-issuer` format, all lowercase.
- New tracked entries belong in per-coin JSON assets, not in executable TypeScript arrays.
- For an existing coin with a research sidecar, update the sidecar and keep every field owned by that domain out of the base file. Do not create sidecars for unrelated scalar metadata.
- Regenerate `shared/data/stablecoins/coins.generated.json` after per-coin metadata edits; do not edit the generated aggregate by hand.
- New keys in `data/logos.json` and `data/ai-summaries.json` must use canonical stablecoin IDs; existing keys are canonical today, though many logo values still point at legacy numeric filenames such as `/logos/1-usdt.svg`.
- Do not add manual supply overrides. Pharos uses DefiLlama first, then the existing fallback paths documented in `docs/data-pipeline.md`.
- Do not treat `infrastructures` and `dependencies` as interchangeable. `infrastructures` is project taxonomy; `dependencies` is the asset graph.
- Keep `reserves[]` curated even when `liveReservesConfig` exists. Curated reserves still drive dependency inference and fallback views.
- Use only chain IDs that already exist in `shared/lib/chains/index.ts`.
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

### 0b. Plan the per-coin registry file

- Identify exactly one JSON file under `shared/data/stablecoins/coins/`, normally named for the canonical stablecoin ID.
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

Record one accepted path in the research packet:

| Path                        | Price requirement                                                                                                                                    | Market-cap / supply requirement                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| DefiLlama stablecoins       | `llamaId` resolves to the intended asset and the list/detail data exposes a price                                                                    | DefiLlama list `circulating` is present; do not multiply list values by price                                                              |
| CoinGecko supplemental fiat | `detailProvider: "coingecko"` plus verified `geckoId` returns a positive price through DefiLlama `coins.llama.fi` proxy or CoinGecko `/simple/price` | CoinGecko `usd_market_cap` is positive, or exactly one supported `contracts[]` deployment can support on-chain total-supply fallback       |
| Commodity supplemental      | verified `geckoId` returns the commodity token price, with `commodityOunces` set when fractionalized                                                 | CoinGecko market cap is positive, or gold/protocol-backed assets have a `protocolSlug` whose DefiLlama protocol data exposes usable `mcap` |
| Explicit runtime exception  | documented source-specific path such as Zephyr Scanner or a maintained low-volume allowlist                                                          | same source exposes usable circulating supply or market-cap data                                                                           |

Do not treat a filled JSON profile, a static route, or `canonical-order.json` inclusion as sufficient. If the active asset cannot satisfy both columns, do not add it as active; track it as pre-launch/watchlist material or document the missing upstream path before continuing.

Exclusions:

- free-floating NAV/fund-share tokens with no stable reference
- assets that are not meaningfully stable
- additions that would require bespoke supply overrides instead of the existing pipeline

Important current taxonomy note:

- For active tracked assets, classify backing by actual collateral base. Pharos currently does not carry standalone active `algorithmic` registry entries; use `rwa-backed` or `crypto-backed` unless there is an explicit historical/shadow-only reason not to.

---

## Phase 2 - Build The Research Packet

Do the research manually, or use the maintained skills when they match the task:

- `stablecoin-addition-orchestrator`: run the full phase checklist and coordinate the supporting skills.
- `stablecoin-runtime-price-marketcap-gate`: prove the hard active-asset price and market-cap path from Phase 1a.
- `stablecoin-info-fetch`: audit/populate a single coin's detail fields (collateral, peg mechanism, jurisdiction, links, geckoId, contracts).
- `contract-populate` / `contract-enrich`: resolve `contracts[]` across chains from CoinGecko + DefiLlama + explorer verification.
- `reserve-research`: populate `reserves[]` composition for a single coin.
- Mint Authority does not have a publication skill yet. Use the Phase 5f review rubric below; `scripts/maintenance/audit-mint-authority.ts` is only a local candidate producer.
- `write-ai-summaries` (Claude-only): draft or refresh the `data/ai-summaries.json` entry.
- `resilience-classify`: pick `collateralQuality` and `custodyModel` overrides.
- `pre-launch-update` (Claude-only): refresh milestones, launch phase, and featured content for pre-launch entries.
- `coingecko-id-verif`: confirm a `geckoId` resolves to the correct asset before saving.

These skills do not replace review — they are research scaffolding. Always verify the output against official sources before editing the registry.

### Always collect

- `id`, `name`, `symbol`
- target per-coin registry file
- lifecycle status: active or pre-launch
- `flags.backing`
- `flags.pegCurrency` (schema default `"USD"` — omit when USD)
- `flags.governance`
- `flags.yieldBearing` (schema default `false` — omit when false)
- `flags.rwa` (schema default `false` — omit when false)
- `flags.navToken` (schema default `false` — omit when false)
- `collateral`
- `pegMechanism`
- `links`
- `contracts`
- `reserves`

### Collect when applicable

- `oneLiner`
- `mechanismArchetype`
- `llamaId`
- `detailProvider`
- `geckoId`
- `cmcSlug`
- `protocolSlug`
- `pythFeedId`
- `pegReferenceId`
- `commodityOunces`
- `proofOfReserves` (with optional `attestorTier`, `cadence`, `attestorJurisdiction`, `attestorLicense`)
- `jurisdiction`
- `tradedContracts`
- `dependencies`
- `blacklistabilityReview`
- `collateralQuality`
- `custodyModel`
- `governanceQuality`
- `infrastructures`
- `yieldConfig`
- `liveReservesConfig`
- `mintAuthority`
- `notices`
- `tags`
- all pre-launch metadata from Phase 0a

### Research questions you should answer up front

- Is the coin in DefiLlama stablecoins? If yes, what is its `llamaId`?
- Is it on CoinGecko? If yes, what is its `geckoId`?
- Does it have a stablecoin-specific CMC slug worth keeping as a fallback?
- Which Phase 1a runtime data path admits it, and what are the expected initial `priceSource` and `supplySource` / market-cap source?
- If relying on on-chain total-supply fallback, is there exactly one supported deployment (or a documented curated exception), and are decimals verified?
- Does it have a Pyth feed?
- Does it have a public reserves/transparency API or on-chain reserve proof?
- Is there a meaningful redemption route worth modeling?
- Is the token itself yield-bearing, or is yield only available through a separate wrapper?
- Is Ethereum a canonical issuance chain worth tracking for mint/burn?
- For each supported `contracts[]` or high-signal `tradedContracts[]` chain, does the chain resolve to a L2BEAT project? If yes, record L2BEAT layer, category, host chain, stage, under-review flag, and weak risk fields as chain-route review context.
- Which deployment(s) create native liabilities, and which are bridge or wrapped representations? For native issuance, identify users, issuer/operator, minter roles, facilitators, proxy/cap admins, backend signers, governance, timelocks, Safes/multisigs, wrapper parents, or unresolved authority. Review bridge mint/burn, adapters, lockboxes, messaging, limits, upgrades, and administrators separately.
- Does Bluechip publish a rating for it?
- Does it belong to an existing infrastructure cohort such as `liquity-v1`, `liquity-v2`, or `m0`?
- If the asset is active, what admits it into `/api/stablecoins` runtime cache: `llamaId`, `detailProvider: "coingecko"` with `geckoId`, `detailProvider: "coingecko"` with on-chain total-supply fallback, or commodity `geckoId`?

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
- Author only the flags that differ from the schema defaults. `StablecoinFlagsSchema` supplies `pegCurrency: "USD"`, `yieldBearing: false`, `rwa: false`, and `navToken: false` when the key is absent, so the parsed record and every generated aggregate still carry explicit values. `backing` and `governance` have no default and are always required.
- `flags.governance` is the coarse public taxonomy. `governanceQuality` is the finer report-card override.
- Every coin — including pre-launch — requires a sourced `blacklistabilityReview`. Its `reviewedStatus` is the canonical verdict and accepts `true`, `false`, `"possible"`, or `"inherited"`; `check:stablecoin-data` fails on any entry without one. Use `"inherited"` for tracked parent or wrapper exposure, full CEX custody, or reserve exposure that strictly exceeds 50% under the FreezeWatch policy rather than a direct holder-control surface. Admin mint authority belongs in the Mint Authority review, not in FreezeWatch.
- `mintAuthority` is curated metadata that feeds Safety Score V9 Economic Control facts and its published mint component. The separate Mint Authority scoring engine is retired. This metadata does not create selector exclusions. Do not add it from scanner output alone, and do not use it as a workaround for blacklistability/freezability review. Active variants require an explicit `mintAuthority` review, normally `wrapped-or-variant-inherited` with `inheritedFrom` set to `variantOf`, so inherited mint risk cannot silently become an unresolved V9 gap.
- `bridgeRouteRisk` is curated metadata for cross-chain mint, lockbox, attestation, liquidity, intent, or canonical routes. Safety Score V9 combines the reviewed route identity and control evidence with bounded runtime materiality; missing required evidence becomes an explicit gap or cap. Use L2BEAT Interop candidate output only as review evidence; verify route docs, contracts, and source links before authoring a sourced profile.
- `pegReferenceId` is for NAV wrappers or derivative assets whose stability should inherit from another tracked base asset.
- `variantOf` / `variantKind` are only for active wrapped, staked, strategy-vault, or bond-maturity children whose primary user expectation is still direct exposure to another tracked stablecoin. They co-require, the parent must be an active non-variant non-`navToken` stablecoin, and the child must keep `flags.navToken === true` plus `pegReferenceId === variantOf`. Supported kinds and their dependency-risk ceilings relative to the parent overall: `savings-passthrough` = `parent - 3`, `strategy-vault` = `parent - 5`, `risk-absorption` = `parent - 5`, `bond-maturity` = `parent - 8`. Review the variant as `"inherited"` when its exposure comes only from the parent; use a direct verdict only when the wrapper has its own holder-control surface.
- `tradedContracts` is for market-traded variants that matter for discovery/liquidity/yield identity but are not the canonical supply contracts.
- `tags` is optional editorial metadata. Do not use it instead of a first-class field.

### Infrastructure taxonomy vs dependency graph

`infrastructures[]` is project taxonomy. `dependencies[]` is reserve/mechanism dependency.

L2BEAT `type`, `category`, `hostChain`, stage, and risk fields are chain-route context. Use them to review bridge-route and host-chain exposure, but do not copy them into `infrastructures[]` and do not turn host chains into `dependencies[]` unless there is an actual stablecoin collateral/mechanism/wrapper dependency.

Use `infrastructures[]` only when the coin directly belongs to a supported technical lineage:

- `liquity-v1`: original Liquity design, 110% liquidation threshold, Stability Pool liquidations, no ongoing borrower interest
- `liquity-v2`: BOLD-style design, user-set borrower rates, branch-style collateral markets, Stability Pools
- `m0`: built on the M0 issuance platform, minter governance, `SwapFacility`, `MExtension.sol` pattern

Important M0 rules:

- M0-built coins may or may not actually hold `m-m0` in reserves.
- `m-m0` itself is not tagged with `["m0"]`; it is the base infrastructure asset.
- A wrapper or downstream derivative should not inherit `["m0"]` automatically just because the base asset depends on M0.

Use `dependencies[]` separately to describe asset relationships:

- `wrapper`: direct 1:1 or near-1:1 wrapper on another tracked asset
- `mechanism`: the upstream asset is central to the mint/redeem mechanism
- `collateral`: the upstream asset sits in the reserves/collateral stack

Prefer `reserves[].coinId` plus an explicit `depType` when reserve composition expresses the relationship. Keep a manual `dependencies[]` row only for a non-reserve mechanism or another relationship the reserve list cannot encode; every such manual-only set requires a sourced `dependencyReview` whose typed relationships exactly match the authored edges. Do not duplicate a reserve-derived relationship manually.

### Reserve composition rules

Populate `reserves[]` with real slices, not generic prose.

- Percentages should reflect the best reviewed current mix.
- Use `coinId` when a slice is another tracked stablecoin.
- Use `depType` when the slice relationship should become a dependency. A `depType` without `coinId` is invalid.
- Keep risk tiers aligned with `docs/report-cards.md`.
- Even with `liveReservesConfig`, keep `reserves[]` up to date because fallback views and dependency logic still use it.
- For a reviewed stablecoin-looking aggregate or exogenous slice that cannot be linked, add a `reserveReview.nonLinkDispositions` row with one of `untracked-exogenous-asset`, `self-reserve`, `basket-needs-split`, `insufficient-evidence`, or `not-applicable`. Candidate IDs document research leads only and never substitute for evidenced constituent weights.

### Hero verdict, mechanism archetype, and attestor-tier surfacing

Three optional clusters on `StablecoinMeta` drive the detail-page hero verdict, mechanism schematic, and attestor-tier badge added in the May 2026 detail-page work (see methodology changelog `v3.12 (2026-05-15)` in `docs/methodology-page.md`). All are additive — omit when uncertain and the UI falls back cleanly.

**`oneLiner` (top-level string, ≤160 chars)** — plain-language one-sentence verdict rendered as the hero TL;DR.

- Active asset: present-tense, names issuer + backing + redemption shape. Example for USDC: "USDC is Circle's centralized dollar stablecoin, redeemable 1:1 and backed by short-term U.S. Treasuries, repos, and cash held in an SEC-regulated reserve fund."
- Synthetic / hedged asset: name the hedge shape and where yield comes from. Example for USDe: "USDe is a synthetic dollar that stays near $1 by hedging crypto collateral with equal short positions on derivatives exchanges; yield comes from funding rates."
- Frozen / paused asset: use past tense and name the event. Example: "USR was Resolv Labs's delta-neutral synthetic dollar that paused issuance in 2026..."

**`mechanismArchetype` (top-level enum)** — coarse mechanism class that drives the schematic diagram shown above the Peg Stability prose in `KeyInfoCard`.

Mapping cheatsheet:

- `fiat-cash`: RWA-backed + centralized + cash/repo/short-T-Bill mix (USDC, USDT, PYUSD). Formally also covers protocol-reserve-backed FX inventory — assets minted and burned against a shared on-chain protocol reserve at oracle rates with no borrower vault, health factor, or liquidation path (the Mento class: USDm, EURm, and the Mento FX stables). Read the class as reserve-backed cash-equivalent inventory issuance, not strictly custodial off-chain cash.
- `tbill`: RWA-backed + dominantly Treasury fund or NAV-bearing (USTB, USDtb, USDY)
- `cdp`: crypto-backed + decentralized + overcollateralized vaults (DAI, LUSD, crvUSD)
- `synthetic-delta-neutral`: crypto + hedging in `pegMechanism` (USDe, USR)
- `algorithmic`: mechanism archetype for reflexive/programmatic peg mechanisms; it is not tied to `flags.backing`. Current active entries with this archetype remain classified by actual collateral base.

Wrappers (with `variantOf` set) generally inherit the parent's archetype; omit on the child if uncertain.

**`proofOfReserves` extensions** — four additive fields inside the existing `proofOfReserves` object, used for the attestor-tier badge.

- `attestorTier`: `"big4"` (Deloitte, EY, KPMG, PwC), `"regional"` (BDO, RSM, Grant Thornton, Crowe, Mazars, Moore Stephens, Baker Tilly, Withum), `"niche"` (smaller / jurisdictionally-thin firms; single-purpose attestors), `"self"` (self-reported, no third-party signoff), or `"none"` (PoR block exists but is unhelpful — usually omit the whole block instead).
- `cadence`: `"daily-nav"` (daily NAV publications, T-Bill funds, BUIDL-style), `"real-time"` (live on-chain feeds, Chainlink PoR, on-chain dashboards), `"daily"` (daily non-NAV reports or account checks), `"weekly"`, `"monthly"` (standard monthly attestations), `"semi-monthly"` (twice-monthly attestations), `"quarterly"`, `"semi-annual"`, `"annual"`, `"ad-hoc"` (irregular or one-off), or `"none"` (not actually published).
- `attestorJurisdiction`: free-text country/region (e.g. `"United States"`).
- `attestorLicense`: free-text license/registration (e.g. `"PCAOB-registered"`).

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
| `mechanismArchetype`              | coin enters the editorial cohort (top-60 by canonical rank in `scripts/lib/curation-baseline-caps.json` or market cap ≥ $50M)                       | record an "intentional gap" line in Phase 5 coverage notes with reason (e.g. "wrapper inherits parent archetype") |
| `proofOfReserves.attestorTier`    | `proofOfReserves.type === "independent-audit"`                                                                                                      | none — if the attestor is genuinely unknown, omit the whole `proofOfReserves` block instead and record the reason |
| `mintAuthority` coverage decision | new high-value active additions or pre-launch promotions (top-60 by canonical rank, market cap ≥ $50M, or issuer/operator has obvious mint control) | record an "intentional gap" line in Phase 5 coverage notes with the unresolved control path or source gap         |
| `data/ai-summaries.json` entry    | every active coin                                                                                                                                   | record skip reason in Phase 5 coverage notes                                                                      |

The orchestrator (`stablecoin-addition-orchestrator`) runs this gate in its Phase 3.5 step before saving the per-coin JSON. The maintainer can also run the gate manually by re-checking the fields against the rubric above.

Automated backstops:

- The ordinary noncritical test `scripts/__tests__/weekly-curation-digest.test.ts` fails if any active/pre-launch coin lacks a nonblank `oneLiner`.
- The same test fails if more than 27% of the fixed `topByRank` cohort lacks an archetype after frozen coins and then variants are excluded, or if the baseline contains an unknown coin ID.
- The same test fails if more than 20% of `independent-audit` coins lack an attestor tier.
- The ordinary noncritical runtime-parser test `src/lib/__tests__/term-markup.test.ts` fails if AI-summary term markup references unknown glossary slugs or leaves raw opening/closing markers.

Mint Authority coverage is currently a manual reviewed-or-waived gate because absence can be intentional for direct, non-variant assets. `npm run check:stablecoin-data` validates authored `mintAuthority` profiles against the schema and requires active variants to carry an explicit inherited/wrapper review, but it does not require every high-value direct coin to have one yet.

The chart-annotation stream (`shared/data/annotations/curated-annotations.ts`) is not gated by CI because absence is editorially ambiguous (no event vs. unrecorded event). It is handled instead by the `agents/annotation-candidates.md` queue, the `npm run candidates:annotations` producer, the `annotations-refresh` skill, and the `npm run digest:curation` rollup. The orchestrator appends a `launch` candidate row to the queue when a coin enters Pharos via a recent launch (see Phase 5 step on recent-launch annotation candidates).

---

## Phase 4 - Edit The Registry

Add the new object to the asset's per-coin JSON file using current field names and current enum values.

### Minimal active-asset skeleton

```json
{
  "id": "ausd-acme",
  "name": "Acme USD",
  "symbol": "AUSD",
  "oneLiner": "AUSD is Acme's centralized dollar stablecoin, redeemable 1:1 and backed by short-term U.S. Treasury bills held in a bankruptcy-remote vehicle.",
  "flags": {
    "backing": "rwa-backed",
    "pegCurrency": "USD",
    "governance": "centralized",
    "yieldBearing": false,
    "rwa": true,
    "navToken": false
  },
  "llamaId": "999",
  "detailProvider": "defillama",
  "geckoId": "acme-usd",
  "collateral": "Short-term U.S. Treasury bills held in a bankruptcy-remote vehicle",
  "pegMechanism": "1:1 mint and redemption against issuer-approved cash subscriptions",
  "mechanismArchetype": "fiat-cash",
  "proofOfReserves": {
    "type": "independent-audit",
    "url": "https://acme.example/transparency",
    "provider": "Deloitte",
    "attestorTier": "big4",
    "cadence": "monthly",
    "attestorJurisdiction": "United States",
    "attestorLicense": "PCAOB-registered"
  },
  "links": [
    { "label": "Website", "url": "https://acme.example" },
    { "label": "X", "url": "https://x.com/acme" },
    { "label": "Docs", "url": "https://docs.acme.example" }
  ],
  "contracts": [{ "chain": "ethereum", "address": "0xabc123...", "decimals": 6 }],
  "reserves": [{ "name": "Short-term U.S. Treasury Bills", "pct": 100, "risk": "very-low" }]
}
```

`oneLiner`, `mechanismArchetype`, and the four `proofOfReserves` extension fields (`attestorTier`, `cadence`, `attestorJurisdiction`, `attestorLicense`) drive the hero verdict, mechanism schematic, and attestor-tier badge on the detail page. Omit when uncertain — they're optional and the UI falls back cleanly. See the Phase 3 "Hero verdict, mechanism archetype, and attestor-tier surfacing" subsection for full guidance.

### Mint Authority profile shape

When the Phase 3.5 / Phase 5f gate calls for a reviewed Mint Authority profile, author it in `shared/data/stablecoins/domains/mint-authority/<id>.json`. It is optional overall, but when present the schema expects a reviewable profile:

```json
{
  "mintAuthority": {
    "mintPath": "issuer-direct-mint",
    "authorityPosture": "concentrated-admin",
    "confidence": "manual-review",
    "summary": "A short user-facing sentence explaining who can create durable supply and through which route.",
    "controls": [
      {
        "chain": "ethereum",
        "address": "0xabc123...",
        "label": "Acme token owner",
        "role": "direct-minter",
        "authorityType": "multisig",
        "directMintAbility": "direct",
        "threshold": 3,
        "signerCount": 5,
        "modulesOrGuardsStatus": "unknown",
        "sources": [{ "label": "Ethereum token contract", "url": "https://etherscan.io/address/0xabc123..." }],
        "evidence": "Contract reads and verified source show this owner can call the token mint function."
      }
    ],
    "review": {
      "sources": [{ "label": "Acme docs", "url": "https://docs.acme.example" }],
      "evidence": "Official docs and verified contract reads identify the mint route and controlling authority.",
      "reviewer": "Codex stablecoin addition",
      "reviewedAt": "2026-05-25",
      "unresolvedQuestions": ["Verify whether the multisig has off-chain operational policy constraints."]
    }
  }
}
```

Use `sourceFreeRationale` instead of `review.sources` only when the review is intentionally source-free, for example a documented absence after exhaustive source review. Privileged mint paths require at least one `controls[]` entry unless confidence is `unknown`. Verified Safe/multisig controls require `threshold`, `signerCount`, and `modulesOrGuardsStatus`; verified or probable controls cannot use `modulesOrGuardsStatus: "unknown"` because unknown modules or guards cap confidence at `manual-review`. A verified Safe control with an on-chain or Safe API `safe.source` also needs `safe.observedBlock`. Wrapped or variant inherited profiles must use `mintPath: "wrapped-or-variant-inherited"` and provide `inheritedFrom` or `variantOf` (both must match when both are present).

### Current registry editing checklist

- Add or update the asset's JSON object in `shared/data/stablecoins/coins/*.json`.
- Regenerate `shared/data/stablecoins/coins.generated.json` with `npx tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts`.
- Add the ID to `shared/data/stablecoins/canonical-order.json`.
- Add the ID and derived class to `shared/data/stablecoins/listing-decisions.json`.
- Keep new keys canonical and consistent with the current schema.
- For active assets, ensure there is a runtime cache admission path and a Phase 1a price + market-cap gate record:
  - DefiLlama-tracked assets need `llamaId`.
  - Fiat assets not in DefiLlama need `detailProvider: "coingecko"` plus either `geckoId` or a supported on-chain total-supply contract.
  - Gold/silver assets need a `geckoId` for the commodity supplemental path.
  - Do not rely on `canonical-order.json` alone; static routes can exist before the Worker `/api/stablecoins` cache has a row.
- If `mintAuthority` is present, keep it sourced and schema-valid; if it is missing for a high-value active addition, record the intentional gap in Phase 5 coverage notes.
- For an active multi-deployment asset, complete the native-versus-representation review in Phase 5f: every Mint Authority control and mutable upgrade path needs native-only deployment references, and bridge capabilities need structured route-scoped controls.
- Work the three coupling groups below. The build, tests, and generated-artifact gates fail on **every** addition (active or pre-launch) until they match the registry.
- Use `npm run check:stablecoin-data` before moving on.

### 4a. Hand-edited source that hard-codes the tracked set

| File | What to change | Applies to |
| --- | --- | --- |
| `src/lib/stablecoin-static-data.ts` | Status count constants (`TRACKED_STABLECOIN_COUNT`, `ACTIVE_STABLECOIN_COUNT`, `PRE_LAUNCH_STABLECOIN_COUNT`, …), the listing-class counters (`CORE_AGGREGATE_STABLECOIN_COUNT`, `ACTIVE_VARIANT_STABLECOIN_COUNT`, `ACTIVE_STABLE_VALUE_INVESTMENT_COUNT`), `ACTIVE_PEG_CURRENCY_COUNTS`, the `TRACKED_STABLECOIN_IDS` array (canonical order), and `NON_ACTIVE_STABLECOIN_ID_SET` for pre-launch, quarantined, delisted, and frozen entries | Every addition. Only the counter matching the derived listing class moves, so check which class Phase 1 resolved. |
| `src/lib/command-palette-search-data.ts` | One `COMMAND_PALETTE_STABLECOINS` search row | Every addition |

`src/lib/__tests__/stablecoin-static-data.test.ts` enforces both against the shared registry; it needs no edit of its own.

### 4b. Hardcoded catalog snapshots in tests

These are deliberate tripwires, not incidental fixtures. Update the expectation to the new
value; do not weaken the assertion.

| File | What moves | Applies to |
| --- | --- | --- |
| `shared/lib/__tests__/stablecoins.test.ts` | `EXPECTED_TRACKED_STABLECOIN_COUNT`, and the implementation-scope variant ID list | Count on every addition; the ID list only for `variantOf` children |
| `src/components/__tests__/stablecoin-table-logic.test.ts` | `buildTrackedIdSet` variant-set size and the per-`variantKind` ID sets | Variants only |
| `scripts/__tests__/weekly-curation-digest.test.ts` | `oneLiner` total; separately the attestor-tier total and the archetype cohort total | `oneLiner` on every active or pre-launch addition; attestor tier when `proofOfReserves.type === "independent-audit"`; archetype when the coin enters the fixed `topByRank` cohort |
| `scripts/__tests__/bridge-route-coverage-audit.test.ts` | `applicableMultiDeploymentCoins` and `reviewedProfiles` | When `contracts[]` covers more than one chain |
| `src/lib/__tests__/reserve-coinid-validation.test.ts` | A `REVIEWED_WARNING_IDS` entry with the reason | Only when a new `reserves[].name` contains a tracked ticker and the slice intentionally carries no `coinId`. Link the slice with `coinId` instead whenever that is honest. |

### 4c. Registry-derived artifacts that are checked in

Every one of these hashes or enumerates the tracked catalog, so a coin addition moves them and
`npm run check:generated-artifacts` fails until they are regenerated and committed.

| Artifact | Regenerate with | Notes |
| --- | --- | --- |
| `shared/data/stablecoins/report-card-registry-fingerprint.generated.ts` | `npx tsx scripts/maintenance/generate-report-card-registry-fingerprint.ts` | Report cards read this precomputed fingerprint instead of hashing the catalog at runtime |
| `public/datasets/stablecoin-cemetery.json` | `npx tsx scripts/maintenance/generate-cemetery-dataset.ts` | Only the `coins.generated.json` source checksum moves for a live addition; the paired `.csv` moves only when a frozen or dead row changes |
| `public/llms.txt` | `npx tsx scripts/maintenance/generate-llms-txt.ts` | Active-stablecoin count in the summary line plus one per-coin entry |
| `src/generated/sitemap-dates.json` | `npx tsx scripts/maintenance/generate-sitemap-dates.ts` | Commit-derived: the coin source must be committed first. See Phase 7. |

Also regenerate the gitignored projections, which are not committed but which the build, the
tests, and `check:stablecoin-data` all read:
`coins.generated.json`, `coins.client.generated.json`, `coins.compliance.generated.json`,
`coins.telegram-mini-app.generated.json` and
`legacy-llama-redirects.generated.json` (only moves when the coin has a `llamaId`).

Gotcha worth recognising: if the client projection is stale, a large number of unrelated test
files fail at import with `[client-registry] canonical-order.json references unknown stablecoin
ID: <id>` rather than with a catalog assertion. Run
`node scripts/build-data/build-client-registry.mjs` and re-run.

---

## Phase 5 - Evaluate Downstream Coverage Branches

Do not assume every branch applies. Evaluate each one explicitly.

Record a short coverage decision note for every branch before validation: logo/summary, live reserves, yield, redemption backstop, mint/burn, Mint Authority, Bluechip, price/discovery, Safety Score V9 scoreability, and history backfill. Mark each as added, not applicable, or intentional gap with a reason. This prevents silent omissions from looking like completed work.

If the coin is active and reached Pharos through a recent launch (a `pre-launch` → `active` transition within the last 90 days, or DefiLlama first observation within 90 days), append a `launch` candidate row to `agents/annotation-candidates.md` so the chart-annotation editorial loop picks it up at the next sweep. Pre-launch promotions and historical additions do not need this — they are higher-touch and the maintainer chooses whether to surface them.

### 5a. Logo and summary

New tracked coins should ship with both:

- a logo entry in `data/logos.json`
- an editorial summary entry in `data/ai-summaries.json`

See Phase 6 for exact rules.

### 5b. Live reserves

If the issuer publishes a usable transparency API, attestation feed, or on-chain reserve proof:

- add `liveReservesConfig` to the coin metadata
- reuse an existing adapter if it actually matches the source
- otherwise add a new adapter under `worker/src/cron/reserve-adapters/` and register it

Current `liveReservesConfig` rules:

- `adapter`, `version`, and `semantics` are required
- `display.url` / `display.label` should point to the public source page
- `inputs.primary` is required
- `inputs.fallbacks` is optional
- use a coin-specific `breakerScope` when the same adapter is reused against different upstream sources or params
- shared breaker scopes are only appropriate when the source is truly shared and source-invariant, such as the M0 family
- `curated-validated` must align with a tracked on-chain contract for that coin

If no live source exists:

- keep `reserves[]` populated
- do not invent a live config

### 5c. Yield intelligence

If `flags.yieldBearing` is `true`, add `yieldConfig`.

Then evaluate whether runtime config is also needed. `worker/src/cron/yield-config.ts` is the aggregator; the actual tables live in per-concern files beside it:

- `YIELD_POOL_MAP` (`yield-config-pools.ts`): explicit DeFiLlama pool mapping.
- `YIELD_VARIANT_MAP` (`yield-config-variants.ts`): separate wrapper/savings token that Pharos does not track directly.
- `EXPLICIT_YIELD_SOURCE_POOL_MAP` (`yield-config-explicit-pools.ts`): curated exact-pool override for special assets.
- `ON_CHAIN_RATE_CONFIGS` (`yield-config-rate-sources.ts`): deterministic on-chain exchange-rate APY.
- `RATE_DERIVED_CONFIGS` (`yield-config-rate-sources.ts`): benchmark-minus-spread products.
- `DIRECT_PROTOCOL_API_STRATEGIES` (`yield-config-rate-sources.ts`): issuer-API yield sources outside DefiLlama.
- `PRICE_DERIVED_FALLBACK_IDS` (`yield-config-rate-sources.ts`): allow price-derived APY as the fallback path.
- `QUARANTINED_DETERMINISTIC_ADAPTERS` (`yield-config-rate-sources.ts`): temporarily disable a deterministic adapter.
- `INTENTIONAL_GAP_REASONS` (`yield-config-rate-sources.ts`): document an accepted no-yield gap so coverage audits stay clean.
- `AUTO_LENDING_POOL_MAP` / `AUTO_LENDING_SAFETY_BYPASS_IDS` (`yield-config-lending-protocols.ts`): auto-discovered lending-opportunity pools and their safety-check exceptions.

Notes:

- Use a real mechanism type such as `nav-appreciation`, `rebase`, or `lending-vault`.
- `lending-opportunity` is primarily a runtime-discovered publication type, not the usual static metadata choice.
- If the yield wrapper is tracked as its own coin, do not also force the base asset through `YIELD_VARIANT_MAP`.
- When a tracked savings wrapper becomes the canonical yield surface, remove the wrapper-owned `yieldBearing` / `yieldConfig` metadata and historical ownership from the parent instead of leaving the base asset as the wrapper host.
- If no yield source exists and none is expected, add a row to `INTENTIONAL_GAP_REASONS` rather than leaving the coverage audit red.

### 5d. Redemption backstops

If the coin has a meaningful direct redemption or swap route, add a config to `shared/lib/redemption-backstops.ts` / `shared/lib/redemption-backstop-configs/*`.

Evaluate:

- route family
- access model
- settlement model
- execution model
- output asset type
- capacity model
- cost model

If the route is weak, unknown, or impossible to review cleanly, skip it rather than overstating exit quality. In that case, make the metadata explicit: soften `pegMechanism`/summary language so it does not imply a modeled holder backstop, and add a short notice or audit note explaining that redemption scoring is intentionally absent pending source review.

### 5e. Mint/burn flows

If there is a meaningful issuance contract on a tracked chain, usually Ethereum, evaluate adding a config to `worker/src/lib/mint-burn-contracts-data.ts` (the resolved consumer aggregate lives in `worker/src/lib/mint-burn-contracts.ts`). The spec shape is declared in `worker/src/lib/mint-burn-contracts-types.ts` as `MintBurnContractConfigSpec`.

Two authoring paths:

- **Shortcut** - for plain Transfer-to-zero-address mint/burn on Ethereum, add an entry to `EXTENDED_ETHEREUM_TRANSFER_EXPANSION_SPECS` with `stablecoinId`, `dustThreshold`, and (optionally) `bridgeDetection`. The array expands into full specs automatically.
- **Full spec** - for custom events (USDT `Issue`/`Redeem`, reUSD deposits, etc.) or non-Ethereum chains, add a `MintBurnContractConfigSpec` to `MINT_BURN_CONFIG_SPECS`.

Current practice:

- token identity should come from shared metadata where possible; use `contractSource: "primary" | "traded"` (default `"primary"`) to pick from the coin's `contracts[]` vs `tradedContracts[]`.
- use `contractAddressOverride` / `decimalsOverride` only when no existing registry deployment matches.
- prefer a reviewed `startBlock` over the blanket default coverage floor; set `isDefaultStartBlock: true` explicitly when you fall back to the floor.
- record provenance with `startBlockSource` (free-text) and `startBlockConfidence` (`"high" | "medium" | "low"`).
- set `adapterKind` when the event set is not plain Transfers: `"custom-events"` or `"mixed"`; omit it (or use `"transfer-zero-address"`) for Transfer-based coins.
- use `tier: "extended"` by default; reserve `tier: "critical"` for truly major coverage.
- set a realistic `dustThreshold` (decimals of the coin; see existing entries for scale).
- add bridge-detection hints (`ccipBridgeDetection`, `cctpBridgeDetection`, `layerZeroOftBridgeDetection`) only when there is a verified reason.

### 5f. Mint Authority review

Mint Authority review feeds the V9 Economic Control mint component and should answer whether durable native supply can be created directly or indirectly by privileged minters, minter admins, proxy/cap admins, facilitators, backend signers, governance, timelocks, Safes/multisigs, custodians, or only through user/protocol mechanics. Representations and cross-chain transfer machinery belong to Bridge Risk even when they share a controller with native issuance.

For new high-value active additions and pre-launch promotions, record either a reviewed `mintAuthority` profile or an intentional gap. High-value means top-60 canonical rank, market cap ≥ $50M, or an obvious issuer/operator mint control. Missing data is acceptable, but the detail page omits the Mint Authority section until reviewed data exists; do not imply unknown means safe.

When authoring `mintAuthority`, verify:

- `mintPath`, `authorityPosture`, `confidence`, `summary`, and `review` are present.
- `review` includes `evidence`, `reviewer`, `reviewedAt`, and either `sources[]` or `sourceFreeRationale`.
- privileged native paths such as `issuer-direct-mint`, `permissioned-minter`, `offchain-attested-minter`, `facilitator-bucket-mint`, `amo-or-custodian-hybrid`, and `m0-permissioned-minter` include at least one `controls[]` entry unless confidence is `unknown`.
- each control identifies `label`, `role`, `authorityType`, and `directMintAbility`; addressed or mint-capable controls need control-level sources/evidence or profile-level sources.
- Safe/multisig controls with `verified` confidence include `threshold`, `signerCount`, and `modulesOrGuardsStatus`; `modulesOrGuardsStatus: "unknown"` caps verified or probable confidence at `manual-review`.
- EOA mint-capable controls should include `keyCustodyAttestation` when MPC/HSM custody is publicly evidenced; otherwise non-issuer-context EOA direct/can-authorize paths are capped by the score methodology.
- Cap-limited controls should state `canRaiseCap` when known, and compromised or historically exploited mint paths should include `mintIncidents` entries with source links.
- direct chain reads, proxy/admin reads, cap/facilitator registries, and Safe state include observed block or source notes when they are part of the evidence.
- wrapper or variant rows use `mintPath: "wrapped-or-variant-inherited"` and set `inheritedFrom` or `variantOf`; if both are present they must match.
- `authorityPosture: "none-resolved"` is only for non-privileged user/protocol minting, or inherited wrappers whose reviewed parent is also `none-resolved`.
- `authorityPosture: "none-resolved-mint"` is the mint-scoped alternative: use it when no control can mint or authorize minting on this asset but other control domains exist (upgrade or parameter authority, or an inherited parent mint authority). It requires the same non-privileged `mintPath` and places no condition on the parent. Prefer it over an adverse posture for share wrappers whose own token has no minter.
- `reconciliation: "continuous" | "periodic"` and `supervision: "prudential"` are scored economic-control claims — between them they lift the V9 mint component from 25 to 55/70/80 — so each requires at least one `mintAuthority.review` source and a review evidence sentence stating what is reconciled against what, or which named regime supervises the issuer. `unknown`, `not-applicable`, and `none` record an absence and need no such sentence. Do not set a scored value from a homepage link alone.

For every active asset with more than one authored deployment, also complete these required steps:

1. Add one `bridgeRouteRisk.routes[]` row per authored chain/contract deployment. Use its normalized `chain:contractAddress` ID and classify the issuance model from evidence; deployment on multiple chains does not by itself prove multi-canonical issuance.
2. Add `deploymentRefs` to every Mint Authority control, naming only reviewed `native-issuance` routes. Add `mintAuthority.upgradeability.deploymentRefs` when `canChangeMintLogic: true`, naming only the native deployments that upgrade path can replace.
3. Author bridge mint/burn, adapters, lockboxes or escrow, messaging/peers, rate limits, validators, bridge upgrades, pause, and administrators in `bridgeRouteRisk.controls[]`. Give each control a stable kebab-case `id`, one or more exact `routeRefs`, and its evidenced bridge capabilities.
4. Split a shared controller across the two modules when it genuinely has distinct native-mint and bridge powers. Preserve controller identity and adverse evidence, but never duplicate one bridge capability into Mint Authority.
5. Remove active Mint Authority use of `role: "bridge-admin"`, `authorityType: "bridge"`, `routeChecks`, and `mintPath: "bridge-or-oft-synthetic"`; the three bridge-specific enum values remain only for historical readback, while `routeChecks` moves with the bridge control.
6. If no reviewed native deployment exists, do not invent one. Author the reviewed `mintAuthority.review.noLocalIssuance` exception for `inherited-parent-issuance` or `external-only-representation`, satisfying the conditions in [Stablecoin Data Registry](../stablecoin-data.md#mint-authority-and-bridge-risk-ownership).

`npm run check:stablecoin-data` blocks invalid ownership, missing active multi-deployment references, and active bridge vocabulary in Mint Authority. The V9 compiler also fails closed on invalid ownership rather than filtering the control into a safer-looking score.

If you use the local scanner POC, run it as a candidate producer only:

```bash
npx tsx scripts/maintenance/audit-mint-authority.ts --coin <stablecoin-id>
```

The scanner writes to `agents/mint-authority-candidates/` and never updates stablecoin metadata. Treat its output as a review queue, not evidence ready for publication.

### 5g. Bluechip ratings

If Bluechip covers the asset, update `shared/lib/bluechip-slugs.ts` (the worker imports `BLUECHIP_SLUG_MAP` from there).

Important: the map is `bluechip-slug -> pharos-id`, not the other way around.

### 5h. Price and discovery edge cases

Evaluate whether the asset needs any of these metadata fields:

- `pythFeedId` for oracle corroboration
- `cmcSlug` when CMC fallback matters
- `protocolSlug` for commodity/protocol-backed historical TVL paths
- `tradedContracts` for market-traded variants the runtime should recognize separately
- `pegReferenceId` for derivative NAV wrappers

### 5i. Safety Score V9 scoreability

A bare new coin publishes as `NR`, not as a low score. Mechanism components and mint facts stay
`missing` until a hand-authored mechanism review overlay exists in
`shared/data/safety-score-v9/mechanism-review-overlays-v1.json`; the measurement producers
iterate curated allowlists and do not pick a new coin up on their own. Author the overlay per
[Mechanism Overlay Evidence Standard](./mechanism-overlay-evidence-standard.md), or record an
intentional NR-until-overlay gap in the Phase 5 coverage notes.

Overlays are identity-bound: a batch lands through a replay on the pinned production envelope
with an attributed mover list, and unexplained movers stop the batch. Treat overlay authoring as
a deliberate reviewed change rather than a side effect of an addition, and expect
`npm run check:generated-artifacts` to report the `safety-score-v9-evaluation-build` manifest as
stale until the rotated identity is regenerated and committed.

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
- `scripts/maintenance/fetch-logos.ts` exists, but the checked-in production map today is local `/logos/...` paths.
- If no logo exists yet, the UI can fall back to initials, but a tracked addition should ship with a real logo unless the coverage decision note records an explicit skipped reason.

### 6b. Editorial summary

Add an entry to `data/ai-summaries.json` keyed by canonical ID:

```text
"ausd-acme": {
  "title": "Short headline",
  "text": "3-6 sentence editorial summary grounded in actual Pharos metadata and market structure.",
  "updatedAt": "2026-04-09"
}
```

Current expectations:

- keyed by canonical ID
- factual, specific, and editorial rather than marketing
- used on active detail pages and as teaser copy on `/upcoming/` when relevant

The `write-ai-summaries` skill (see Phase 2) is the standard path for drafting and refreshing these entries.

### 6c. Notices and tags

If the coin needs explicit user-facing caveats, add `notices`.

Use `tags` sparingly for editorial categorization, not for core classification.

### 6d. Historical chart annotations (optional)

When a coin has notable historical events that the live tape can't recover (regulatory bans, market-wide shocks, mainnet launches, methodology pivots), curate them into `shared/data/annotations/curated-annotations.ts`. These render as dashed vertical markers on `PegDeviationChart` + `McapChart` when `NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS` is on.

Schema (mirrors `shared/types/chart-annotation.ts`):

```ts
{
  ts: Date.UTC(YYYY, monthIdx, day), // months are 0-indexed
  kind: "depeg" | "mint-burn-spike" | "blacklist-surge" | "exploit" | "governance" | "regulatory" | "methodology-change",
  label: string, // ≤80 chars
  severity?: "low" | "med" | "high",
  href?: string, // primary source — issuer post-mortem, regulator filing, methodology changelog
}
```

Curation rules:

- One entry per discrete event (don't collapse multi-day depegs).
- Use the price-bottom / supply-pivot timestamp, not the press cycle.
- Severity follows the tape vocabulary: `high` for grade-impacting events, `med` for non-fatal stress, `low` for context.
- Add an inline `// YYYY-MM-DD — short note` comment on each `ts:` line so the date is legible at review time.
- Sort each coin's array by `ts` ascending.
- Do NOT invent dates. Drop a candidate rather than guess.

Coverage policy: top-50 coins by market-cap target ≥1 annotation each when a meaningful historical event exists. Coins without notable events stay uncurated (empty / absent key is the correct state). The flag-flip gate for `NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS` is ≥10 annotations across the top 4 coins by mcap (`usdc-circle`, `usdt-tether`, `dai-makerdao`, `usde-ethena`), enforced by `shared/data/annotations/__tests__/curated-annotations.test.ts`.

---

## Phase 7 - Validate

Before running commands, confirm the addition-specific artifacts:

- per-coin JSON exists and matches the canonical ID
- `shared/data/stablecoins/coins.generated.json` was regenerated from the per-coin registry
- `shared/data/stablecoins/canonical-order.json` includes the ID in the intended position
- active assets have a documented Phase 1a price + market-cap path
- `data/logos.json` has a canonical-ID key and the referenced local file exists, or the skip reason is documented
- `data/ai-summaries.json` has a canonical-ID key, or the skip reason is documented
- high-value active additions have either a reviewed `mintAuthority` profile or a documented intentional gap
- the Phase 4a couplings, Phase 4b test snapshots, and Phase 4c checked-in artifacts all match the new catalog
- downstream coverage decision notes cover every Phase 5 branch

For a normal stablecoin addition, generate the working-tree projections and run focused checks first:

```bash
npx tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts
npm run check:stablecoin-data
npm test
cd worker && npx tsc --noEmit
```

Base coin files also feed commit-derived sitemap timestamps. Commit the coin source and ordinary generated registry projections before producing the final sitemap output, then settle and validate the committed snapshot:

```bash
npx tsx scripts/maintenance/generate-sitemap-dates.ts
npm run check:commit-derived-artifacts
npm run check:generated-artifacts
npm run check:pr -- --base=origin/main
npm run build
```

Commit the sitemap output separately or amend it into the source commit without changing the source author date. Run `check:stablecoin-data` first for fast feedback, then run the focused generated-artifact checks selected by the change. `npm run check:pr -- --base=<ref>` mirrors the adaptive protected PR contract after commit; GitHub's protected `PR gate` remains authoritative.

You can also run the individual checks directly when iterating:

- new redemption config -> `npm run audit:coverage -- --domain=redemption-backstops`
- L2BEAT-backed chain route review -> `npm run candidates:l2beat-bridge-routes` and `npm run audit:coverage -- --domain=l2beat-snapshot -- --check`
- dependency/process context review -> `npm run audit:dependency-coverage` (report) or `npm run check:dependency-review-gaps` (gate), and inspect the L2BEAT Deployment Context section when contracts land on matched L2BEAT chains
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

## Phase 8 - Merge, Push, Deploy, Then Backfill

This phase is post-validation and post-merge.

Only do the backfill after all of these are true:

- the local validation in Phase 7 passed
- the change was merged
- the merged change was pushed
- the production deploy completed

After the production deploy, backfill history for live assets:

- If the coin has `llamaId`, use `POST /api/backfill-supply-history`
- If the coin has `geckoId` but no `llamaId`, use `POST /api/backfill-cg-prices`
- If it is pre-launch, skip runtime backfills until activation

For commodity tokens (`pegCurrency: "GOLD" | "SILVER"`), `backfill-supply-history` automatically uses CoinGecko `market_chart` market caps as the primary source rather than DefiLlama TVL, because protocol TVL can diverge from token market cap (e.g. a protocol's multi-chain reserves exceeding the on-chain token supply). You still call the same endpoint; no extra flag is required. If CoinGecko has prices but missing/zero market caps, the endpoint can replay historical EVM `totalSupply()` at each UTC day close for assets with exactly one supported EVM deployment; it does not project the current supply backward across the window. Multi-deployment assets fail closed unless CoinGecko market caps or a validated TVL fallback can cover the requested days.

Examples:

```bash
curl -X POST "https://ops-api.pharos.watch/api/backfill-supply-history?stablecoin=ausd-acme" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "X-Pharos-Admin: 1" \
  -H "Idempotency-Key: backfill-supply-ausd-acme"
```

```bash
curl -X POST "https://ops-api.pharos.watch/api/backfill-cg-prices?stablecoin=ausd-acme" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "X-Pharos-Admin: 1" \
  -H "Idempotency-Key: backfill-cg-prices-ausd-acme"
```

Optional:

- `backfill-supply-history` accepts `allow-constant-price-fallback=true` for specific sparse-history cases

Do not hardcode branch or PR creation into the process. Follow the repo's current agent guidance: routine maintenance can land on `main`, while separate branches/worktrees/PRs are used only when the maintainer explicitly asks for that workflow.

## Phase 9 - Post-Deploy Verification

- [ ] The coin appears in the expected public surface:
      active -> homepage/table/detail
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
