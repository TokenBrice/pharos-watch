# Classification System, Peg Handling & Gold Stablecoins

> **Agent navigation** — Start at [Classification entry](#classification-entry); use the focused taxonomy headings instead of reading the complete classification chapter.

## Classification entry

For catalog flags, read [Type](#type-governance-field-internally), [Backing](#backing), [Peg Currency](#peg-currency), and [Listing Class And Lifecycle](#listing-class-and-lifecycle). Catalog authors then use the [registry editing rules](https://github.com/TokenBrice/pharos-watch/blob/main/docs/stablecoin-data.md#editing-rules), not a second field glossary.

Reviewed controls: [FreezeWatch](https://github.com/TokenBrice/pharos-watch/blob/main/docs/blacklist-tracker.md#freezewatch-decision-procedure), [Mint Authority](#mint-authority-taxonomy), [age](#implementation-age-policy), [infrastructure](#infrastructure-tagging). Prices: [non-USD](#non-usd-peg-handling), [commodities](#commodity--non-defillama-stablecoins).

Display taxonomies are owned by `shared/lib/classification.ts` and its typed children: PYS text/gauges share one band ladder, status badges/runway bars share labels, and mint/redemption descriptors retain their compact and coverage variants. PSI chart colors, text classes, and animation timings share one descriptor; methodology tables consume its text styles.

DEX concentration bands admit only finite HHI in `[0, 1]`. Nullish, non-finite and out-of-range values are unscored (`Crowding not scored` / unknown), never the favorable broad-diversity band. The reviewed boundaries remain Medium at `0.18` and High at `0.35`, inclusive.

## Stablecoin Classification System

Each tracked stablecoin is defined in the checked-in per-coin data assets under `shared/data/stablecoins/coins/*.json`, loaded through `shared/lib/stablecoins/registry.ts` from the generated `shared/data/stablecoins/coins.generated.json` aggregate, and validated by `shared/lib/stablecoins/schema.ts` at generation/test time. Import stablecoin helpers from their explicit submodules; use the registry module for the complete catalog and explicit lifecycle splits. Each entry carries these flags:

### Type (governance field internally)

Three-tier system reflecting actual dependency on centralized infrastructure:

| Tier                    | Label    | Meaning                                                                                                               | Examples                                 |
| ----------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `centralized`           | CeFi     | Fully centralized issuer, custody, and redemption                                                                     | USDT, USDC, PYUSD, FDUSD                 |
| `centralized-dependent` | CeFi-Dep | Decentralized governance/mechanics but depends on centralized custody, off-chain collateral, or centralized exchanges | DAI, USDS, USDe, GHO, FRAX, crvUSD, sUSD |
| `decentralized`         | DeFi     | Fully on-chain collateral, no centralized custody dependency                                                          | LUSD, BOLD                               |

The key distinction for `centralized-dependent`: these protocols may have on-chain governance and smart contract mechanics, but ultimately rely on off-chain assets, centralized exchange positions, custodial collateral or centralized stablecoins. Current crvUSD collateral and PegKeeper counter-assets are recorded in `shared/data/stablecoins/coins/crvusd-curve.json`; sUSD's Synthetix V3 collateral is recorded in `shared/data/stablecoins/coins/susd-synthetix.json`.

### Backing

| Value           | Meaning                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rwa-backed`    | Backed by real-world assets (fiat reserves, treasuries, gold)                                                                                                       |
| `crypto-backed` | Backed by on-chain crypto collateral                                                                                                                                |
| `algorithmic`   | Historical off-catalog metadata only — valid in `BACKING_TYPE_VALUES` for PSI historical assets, never assigned to tracked catalog coins |

Active Pharos taxonomy no longer exposes `algorithmic` as a standalone backing bucket. Programmatic peg controls are classified by actual collateral. UST/IRON retain historical `algorithmic` backing metadata for PSI continuity; do not coerce those facts into a modern backing category. This historical backing label is distinct from DDR's `mechanismArchetype: "algorithmic"` and does not change that mechanism rule.

### Peg Currency

`PEG_CURRENCY_VALUES` in `shared/types/core.ts` is the runtime authority. It covers the tracked fiat pegs (including COP, CLP, GHS, KES, PEN, CZK, PLN, and AED), `GOLD`, `SILVER`, `VAR` (variable/CPI-linked), and `OTHER`; do not maintain a second literal enum here. Czech koruna, Polish zloty, and UAE dirham assets use `CZK`, `PLN`, and `AED` rather than `OTHER`.

### Boolean Flags

- `yieldBearing` — token itself accrues yield (e.g., USDY, sUSDe, BUIDL)
- `rwa` — backed by real-world assets like treasuries/bonds (distinct from `rwa-backed` which also includes plain fiat reserves)
- `navToken` — price appreciates over time as yield accrues (USYC, USDY, TBILL, YLDS). Excluded from peg deviation metrics; table shows "NAV" instead of bps. Also used for CPI-indexed tokens (FPI) — table shows "CPI" for VAR-pegged navTokens

### Listing Class And Lifecycle

`shared/data/stablecoins/listing-decisions.json` assigns exactly one listing class to every catalog ID, and the compact ledger stores only that class mapping. Listing class is separate from lifecycle, which stays on the per-coin catalog row. Aggregate helpers include active core and cash-equivalent rows, exclude variants from parent-inclusive totals, and report stable-value investments separately.

[Stablecoin Listing Policy](https://pharos.watch/docs/listing-policy/) owns class tests, precedence, lifecycle, eligibility and review rules.

An unresolved mechanism review cannot validate its currently authored class by identity. CI preserves delisted, variant, credit-fund, and NAV/T-bill precedence first; a remaining unresolved mechanism stays `stable-value-investment` until resolved rather than entering core aggregates.

### Additional Metadata

Classification describes what a token represents, how its peg is maintained, and which controls and dependencies act on the exact claim. A reviewed unresolved mechanism remains unresolved rather than receiving a guessed archetype. Native-family admission requires an exact-token resolved review after its UTC evidence day and before expiry. Variant departures require sourced, non-redundant overrides.

Browser variant archetypes use the shared `resolveMechanismArchetype` resolver: an explicit override uses the child's archetype; otherwise an existing parent supplies its archetype, including an unresolved result. Only a missing parent falls back to the child's own value. Unresolved results are omitted from compact JSON, not replaced with a guessed child classification.

See the public [mechanism guides](https://pharos.watch/learn/mechanisms/) for the conceptual families. Catalog authors use the [registry editing rules](https://github.com/TokenBrice/pharos-watch/blob/main/docs/stablecoin-data.md#editing-rules) and [metadata schema](https://github.com/TokenBrice/pharos-watch/blob/main/shared/types/stablecoin-meta-schemas.ts) for field shape, provenance and validation. Labels, compact variants, confidence vocabulary and display styles are owned by `shared/lib/classification.ts`, not this page; unknown values must retain each domain's explicit unavailable fallback.

Cross-domain reviewed incidents are not a `StablecoinMeta` classification field. `shared/data/safety-score-v9/incident-reviews-v1.json` owns events that need explicit control, wrapper-local, operational, or peg routing plus root-claim, deployment, integration-only, or holder-exit scope. Each event changes the existing component that owns its risk; it does not create another Safety Score pillar. Domain-native evidence such as `mintAuthority.mintIncidents` remains in its existing sidecar and must not be duplicated into the cross-domain registry.

### Native mechanism families

- `ucits-trs-fund` is a proportional interest in an exact UCITS fund/share class with physical
  securities and total-return swaps, not Treasury-only or custodial cash backing. Signed
  derivatives, unswapped sleeves, collateral and recovery require their own mechanism evidence.
- `shared-reserve` describes several protocol liabilities backed by a common pool. Operational
  exchange rights do not establish exclusive allocation or enforceable insolvency priority.
  All identified reserve-backed Mento members use this rule, including USDm/EURm with their
  current V3 FPMM claim; Mento CDP currencies remain `cdp`.
- `protocol-position` describes bridge, vault or module-issued operational liabilities, not
  direct fiat ownership or necessarily borrower debt. Not all members are bridged. Parent
  reserve quality does not erase local conservation, position custody, allocation and recovery.

Family admission and component grading are owned by the
[mechanism-overlay evidence standard](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/mechanism-overlay-evidence-standard.md#native-family-admission-and-grading).
Missing claim identity remains NR; unknown or undisclosed protections after admission remain
priced bounded facts. This code capability does not author catalog members, change reserve
percentages, grant new oracle tiers or add supply overrides.

### Implementation Age Policy

`launchDate` remains the product or project launch. Author `implementationLaunchDate` only when a later deployed mechanism, relaunch, or critical implementation boundary makes the product date misleading. The field requires a sourced `mechanismArchetypeReview`, cannot unambiguously predate `launchDate`, and cannot begin after its mechanism review date.

For `YYYY`, `YYYY-MM`, `YYYY-Qn`, and `YYYY-Hn`, track-record age uses the inclusive end of that period. When the period end is later than the fixed scoring `asOf` date, the `asOf` date is used, yielding zero claimed age for the unresolved part of the period. Tracked variants resolve effective implementation age from the newest required layer across the child and parent chain, with cycle detection; they do not blindly inherit either endpoint.

`resolveEffectiveImplementationLaunchDate` in `shared/lib/classification/resolve-implementation-launch-date.ts` owns this resolution; Safety Score compilation uses the same fixed-clock result for track-record facts.

### Mint Authority Taxonomy

Mint Authority is a reviewed native-issuance taxonomy. It covers canonical deployment(s) and controls that can create durable native liabilities or expand, relax, or replace their issuance constraints: direct minters, minter admins, proxy/cap admins, facilitators, off-chain signer systems, governance, and wrapper-local or inherited issuance. Bridge Risk owns representations and cross-chain machinery, including bridge mint/burn, adapters, lockboxes, messaging, limits, upgrades, and administrators. The same controller may appear in both modules when it exercises distinct powers, but a bridge capability is never compiled as global Mint Authority risk. Since safety `9.1` the taxonomy has no score of its own: Safety Score V9 compiles the reviewed native controls into the Economic Control pillar's mint component, and that component is the mint score every surface shows. Missing data produces explicit V9 evidence gaps and an `NR` mint state; it never implies safety.

Bridge vocabulary is not valid in active Mint Authority data, and an asset with no local native issuance carries the reviewed `mintAuthority.review.noLocalIssuance` exception instead of an invented native route. The [registry authoring boundary](https://github.com/TokenBrice/pharos-watch/blob/main/docs/stablecoin-data.md#mint-authority-and-bridge-risk-ownership) owns deployment identity and forbidden active values.

Compact `mintAuthoritySummary` projections in coverage and market tables carry review-route labels, not scores. The browser list generator and runtime display share `resolveMintAuthorityStatusKind` in `shared/lib/classification/mint-authority.ts`. An `unknown` native mint path stays `Unknown` regardless of review confidence or competing controls; it never defaults to `Governed`. A missing profile remains omitted from compact JSON. The adjacent mint score and band come from the published V9 mint component.

Mint paths distinguish permissionless collateralized issuance from issuer-operated, permissioned, off-chain-attested, facilitator, hybrid and inherited issuance. A route's reviewed controls, not its display label, determine mint risk. Literal path/posture labels and tones belong to `shared/lib/classification.ts`; posture bands are descriptive, not report-card grades.

Reconciled or prudentially supervised unbounded minting requires independently established process evidence; reconciliation and supervision are distinct facts. Known adverse authority is unbounded power without a qualifying process, not proof of measured non-reconciliation or an active incident. Governance delays, minority vetoes and operational governance do not make issuance economically bounded or remove severe-surge eligibility. The [live mint posture ladder](https://github.com/TokenBrice/pharos-watch/blob/main/docs/mint-authority-scoring.md#mint-posture-derivation-and-quality-ladder-932) owns process admission, bands, caps, precedence and seasoning; `shared/lib/safety-score-v9/mint-posture.ts` owns shared resolver sets. Unknown reconciliation grants no new R1 anchor.

`none-resolved` and `none-resolved-mint` are two scopes of one finding:

- `none-resolved` is whole-of-chain: no control anywhere on the mint path holds privileged ability of any kind — including upgrade or parameter authority — and a wrapper may only use it when its reviewed parent is also `none-resolved`.
- `none-resolved-mint` is mint-scoped: no control can mint or authorize minting on this asset, while other control domains may exist. Upgrade and parameter authority do not disqualify it, and it makes no claim about a wrapper's parent.

Safety Score V9 derives its mint posture mint-scoped, so a share wrapper over a governed parent derives `none-resolved` from facts the whole-of-chain curated value can never assert. `none-resolved-mint` is the annotation that states the same fact at the same scope. It is a benign posture: the depeg resolver treats it as neither fragile nor risky and awards only the weak R1 published attribution, never the strong whole-of-chain rung. Only strong anchors affect the tier, so this weak rung does not move the verdict.

Mint controls derive a stable controller identity from `chain + address`; EVM addresses are case-normalized while case-sensitive non-EVM addresses are preserved. `failureDomainKeys` are reserved for reviewed off-chain common modes that an address cannot express. `controllerAssetId` may identify the tracked native asset whose issuance system owns a reused controller. The V9 dependency evaluator uses that directionality to avoid making the controller's native asset depend on downstream products while keeping foreign products exposed to the shared controller. These fields affect V9 attribution, evidence, dependency, and Economic Control evaluation as applicable; there is no current standalone Mint Authority Score. `upgradeability` records proxy model, implementation/admin addresses, mint-logic mutability, delay, observation point, sources, and the exact existing control label that owns an upgradeable path. `mintIncidents.status` is required; `resolvedAt` is optional for historical remediation and forbidden on an active incident.

### Infrastructure Tagging

Pharos supports a small structured infrastructure layer for shared technical foundations that users may want to recognize across multiple issuers or forks.

Current support:

- `infrastructures: ["liquity-v1"]` &mdash; classic LUSD-style Liquity v1 forks
- `infrastructures: ["liquity-v2"]` &mdash; BOLD-style Liquity v2 forks
- `infrastructures: ["m0"]` &mdash; coins built on the M0 issuance platform

This is intentionally narrower than the general classification system:

- use `infrastructures` for concrete shared-foundation cohorts that deserve dedicated badges, filters, and discovery pages
- keep `tags` for loose editorial labels that do not need first-class routing or filtering semantics

**Liquity v1** is the classic LUSD-style pattern:

- 110% liquidation threshold / minimum collateral ratio
- Stability Pool liquidation path
- no ongoing borrower interest
- forks share source code with the upstream Liquity codebase but operate independently with their own reserves

**Liquity v2** is the BOLD-style pattern:

- user-set borrower rates
- Stability Pools
- Liquity-style redemptions across branch-like collateral markets
- forks share source code with the upstream Liquity v2 codebase but operate independently

**M0** is an issuance-platform lineage rather than a code lineage:

- coins are built on M0's smart-contract rails (minter governance, the SwapFacility, the `MExtension.sol` contract pattern)
- M0 provides the issuance machinery; reserve composition is set by the issuer and **may or may not include the underlying $M token**
- some M0-built coins are simple $M wrappers; others manage diversified collateral via M0's infrastructure
- a governance issue at the M0 protocol level potentially affects every M0-built coin, even though their day-to-day operations and reserves are independent

The `infrastructures` field is an array because a coin could in principle belong to multiple infrastructures (e.g., a hypothetical Liquity v2 fork that also wraps M0); in practice every currently-tagged coin has exactly one entry.

### Bluechip Grade

`BluechipGrade` in `shared/types/core.ts` owns the grade vocabulary; `GRADE_ORDER` in `src/lib/bluechip.ts` checks complete ordering. It is a separate external rating, not a Safety Score.

## Non-USD Peg Handling

Peg deviation for non-USD stablecoins requires the peg currency's USD value. `shared/lib/peg-rates.ts` prefers usable `fxFallbackRates` from `sync-fx-rates.ts` for fiat pegs regardless of peer count; without FX it uses the same-`pegType` median. Peers must have an observed, positive finite price and at least $1M circulating USD. With metadata supplied, commodity prices are normalized by `commodityOunces` and `COMMODITY_MEDIAN_EXCLUDES` removes reviewed outliers. Gold/silver use the qualifying median at three contributors or more; thinner groups prefer an available metals/FX fallback, otherwise retain the median. `PegRatesResult` contains `rates`, per-currency `sources`, and qualifying-contributor `counts`. Deviation is `((price / pegRef) - 1) * 10000` basis points.

Those `fxFallbackRates` are produced by `sync-fx-rates`. Provider cadence and fallback behavior are documented in the [pricing pipeline](https://pharos.watch/docs/pricing-pipeline/); `worker/src/lib/fx-config.ts` owns the primary and secondary fiat-source sets.

CZK and PLN use the primary ECB/Frankfurter business-daily source; AED uses the secondary calendar-daily currency API because ECB does not publish AED. The shared taxonomy owns the canonical DefiLlama peg types, display symbols, and FX/price-validation bounds for all three currencies. RAKBank's pre-launch dirham asset (`aed-rakbank`) uses `AED`. ILS and GEL assets remain unchanged; adding these three currencies does not establish ILS or GEL support.

## Commodity & Non-DefiLlama Stablecoins

Gold, silver, and some fiat stablecoins are not in DefiLlama's stablecoin API. These use the same canonical `ticker-issuer` ID format as all other stablecoins (e.g., `xaut-tether`, `kag-kinesis`, `jpyc-jpyc`) and are distinguished by their `detailProvider` field (`"commodity"` or `"coingecko"`) and `geckoId`/`protocolSlug` fields in `StablecoinMeta`.

The Worker's `sync-stablecoins` cron derives the supplemental set from `ACTIVE_STABLECOINS`: all gold/silver pegs plus entries with `detailProvider === "coingecko"`. It splits commodity tokens from fiat CoinGecko-only tokens, fetches CoinGecko/DefiLlama data, shapes DefiLlama-compatible rows and merges them into cached `peggedAssets`. Plain-par fiat assets without market price/cap can use on-chain supply valued at a fresh/static FX peg reference; configured protocol-inventory cases subtract observed non-circulating balances. NAV/yield-bearing assets never substitute `$1` or an FX peg for a missing token price, but may value on-chain supply with a trusted reserve or vault NAV from `loadReserveNavSupplyPrice` or `resolveVaultNavSupplyPrice`; without either market price or trusted NAV, that fallback fails closed. Tracked CoinGecko-provider assets retain last-known-good supplemental preservation even without a `geckoId`.

Gold/silver token price normalization and sanity validation both use the `commodityOunces` field, so fractional-ounce assets are compared against the correct per-token gold/silver reference instead of full-ounce spot. For the dedicated single-token gold slugs (`tether-gold`, `paxos-gold`), the DefiLlama protocol API supplies current market cap only; all other protocol slugs fall through to the CoinGecko market-cap/curated on-chain order. `circulatingPrevDay/Week/Month` are left `null` by the supplemental lane and are filled afterwards from the D1 `supply_history` table under a ±30% reasonableness gate, or restored from last-known-good cache. Silver tokens currently use the CoinGecko market/supply fallback; when historical data is unavailable, these fields are `null` and the frontend shows "N/A" rather than a misleading 0%.
