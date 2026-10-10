# Classification System, Peg Handling & Gold Stablecoins

> **Agent navigation** — Start at [Classification entry](#classification-entry); use the focused taxonomy headings instead of reading the complete classification chapter.

## Classification entry

For catalog flags, read [Type](#type-governance-field-internally), [Backing](#backing), [Peg Currency](#peg-currency), and [Listing Class And Lifecycle](#listing-class-and-lifecycle), plus [Additional Metadata](#additional-metadata) for the field being changed. Authoring and admission rules remain in the [registry editing entry](./stablecoin-data.md#registry-editing-entry).

For reviewed controls, use [Mint Authority Taxonomy](#mint-authority-taxonomy), [Implementation Age Policy](#implementation-age-policy), or [Infrastructure Tagging](#infrastructure-tagging). Price/peg work uses [Non-USD Peg Handling](#non-usd-peg-handling) and [Commodity & Non-DefiLlama Stablecoins](#commodity--non-defillama-stablecoins), not the entire taxonomy.

Display taxonomies are owned by `shared/lib/classification.ts` and its typed children: PYS text/gauges share one band ladder, status badges/runway bars share labels, and mint/redemption descriptors retain their compact and coverage variants. PSI chart colors, text classes, and animation timings share one descriptor; methodology tables consume its text styles.

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

[Stablecoin Listing Policy](./listing-policy.md) owns the class tests, the class precedence order, the lifecycle table, and the eligibility and review rules.

An unresolved mechanism review cannot validate its currently authored class by identity. CI preserves delisted, variant, credit-fund, and NAV/T-bill precedence first; a remaining unresolved mechanism stays `stable-value-investment` until resolved rather than entering core aggregates.

### Additional Metadata

Key fields on `StablecoinMeta` (see `shared/types/core.ts` plus `shared/types/stablecoin-meta-schemas.ts` for the typed/schema source):

- `id: string` — stablecoin ID in canonical ticker-issuer format (e.g., `"usdt-tether"`, `"usdc-circle"`)
- `llamaId?: string` — DefiLlama numeric stablecoin ID for `stablecoins.llama.fi` calls when internal IDs diverge
- `detailProvider?: "defillama" | "coingecko" | "commodity"` — explicit detail data source selector (migration field replacing ID-prefix heuristics)
- `marketAvailability?: "market-traded" | "limited-trading" | "non-traded-utility" | "legacy-or-wind-down"` — descriptive availability label for issuer/regulatory coverage audits; currently used to preserve eurostablecoins.xyz market-status distinctions for EUR stablecoins without changing runtime cache admission
- `collateral?: string` — description of the collateral backing
- `pegMechanism?: string` — description of the peg maintenance mechanism
- `mechanismArchetype?: MechanismArchetype` — taxonomy owned by `MECHANISM_ARCHETYPE_VALUES` in `shared/types/stablecoin-taxonomy.ts` and re-exported through `shared/types/core.ts`. When set, the coin detail page's Mechanism module (`PegStabilityCard`) draws the coin's resolved mechanism flow (`MechanismFlow`) plus a matching `/learn/mechanisms/<slug>/` link. Labels, short labels, one-liners and slug helpers live only in `shared/lib/classification.ts`; the route contract is [learn-mechanisms-page.md](./learn-mechanisms-page.md).
- `mechanismArchetypeReview?: MechanismArchetypeReview` — sourced base-metadata review with a `resolved` or `unresolved` disposition, reviewer, evidence date, rationale and sources. A reviewed unresolved row deliberately blocks classification instead of guessing. Native V10 families also require an own exact-token resolved review admitted after its UTC day and before the existing mechanism-overlay expiry boundary.
- `implementationLaunchDate?: string` — launch boundary for the currently deployed mechanism when it materially differs from the product's `launchDate`. The same fuzzy formats are supported, but track-record consumers use the latest possible date in the stated period as a conservative age lower bound.
- `archetypeOverride?: boolean` — when `true`, this coin's `mechanismArchetype` is an intentional, sourced departure from its parent variant's archetype. Redundant same-archetype overrides are invalid.
- `commodityOunces?: number` — troy ounces per token (for gold- and silver-pegged stablecoins)
- `geckoId?: string` — CoinGecko coin ID for price/mcap lookups (commodity and non-DefiLlama tokens)
- `cmcSlug?: string` — verified CoinMarketCap slug for fallback price lookups. Omit invalid mappings rather than substituting a same-symbol asset. The September 22 identity review corrected USDP to `paxos-standard` (CMC 3330, exact Ethereum contract) and removed CMC-rejected mappings for CAP cUSD, Plume PUSD and Re Protocol reUSD without verified replacements. The available CUSD listings belong to Celo and Coin98, not CAP.
- `protocolSlug?: string` — DefiLlama protocol slug for commodity TVL data and, for dedicated single-token gold products, mcap data
- `proofOfReserves?: ProofOfReserves` — proof configuration plus an optional sourced `latestReport` that distinguishes assurance method, assets-only versus assets-and-liabilities scope, and liability reconciliation
- `links?: StablecoinLink[]` — external links (website, docs, twitter)
- `jurisdiction?: Jurisdiction` — regulatory jurisdiction
- `mica?: MicaProfile` — EU MiCA authorization status, EMT/ART token type, competent authority, issuer entity, significance flag, and sourced register/reference links. See [mica-tracker.md](./mica-tracker.md).
- `genius?: GeniusProfile` — U.S. GENIUS Act implementation-watch posture: applicability, authorization status, issuer pathway, regulator fields, reserve/redemption disclosure presence, negative-evidence review, reviewer metadata, and source references. See [compliance-page.md](./compliance-page.md).
- `contracts?: ContractDeployment[]` — chain deployment identities: token contracts, or explicit `kind: "native-denom"` bank denominations. Native XRPL issued currencies use `amountEncoding: { kind: "xrpl-issued-currency" }` with `decimals: null`; native bank denominations may retain unknown decimals. `ContractDeploymentSchema` in `shared/types/stablecoin-meta-schemas.ts` owns the encoding and scale rules.
- `dependencies?: DependencyWeight[]` — upstream stablecoin dependencies (for report cards)
- `dependencyReview?: DependencyReview` — sourced review required for manual-only dependency relationships that reserve composition cannot express; reviewed relationships must exactly match those authored edges
- `blacklistabilityReview?: BlacklistabilityReview` — required for every tracked asset and the canonical source of its reviewed `true`, `false`, `"possible"`, or `"inherited"` freeze/blacklist status, evidence, reviewer, and review date
- `collateralQuality? / custodyModel?` — reviewed resilience and custody fields used by live Selector constraints and DDR depeg-duration verdicts
- `governanceQuality?` — legacy metadata key displayed as **Control posture** on stablecoin detail pages. Its six values describe where operational authority sits (`immutable-code`, `dao-governance`, `multisig`, `regulated-entity`, `single-entity`, or `wrapper`); the field is descriptive only and is not a Safety Score V9 input. Missing values remain hidden rather than rendering an inferred or unknown posture.
- `oracleRisk?: OracleRiskProfile` — reviewed price-authority and CDP oracle setup, with optional review provenance and collateral-branch rows. `not-applicable` means there is no price-sensitive control to score; `top-level-only` records an applicable mint, redemption, NAV, or exchange-rate authority without inventing liquidation branches; `branches-required` activates the collateral-market review; `unresolved` records a reviewed asset whose disclosed sources cannot yet settle which of the three applies. `role` names what the price authority is for, since both roles share the tier vocabulary but describe different exposures: `collateral-pricing` values borrower collateral inside a liquidation engine (a wrong price undercollateralizes the coin's own debt), `coin-price-feed` prices the coin itself or the assets behind it with no liquidation engine consuming it (the exposure sits with whoever consumes the price, including third-party integrators). The scored taxonomy separates `oracleless` from `privileged-internal-pricing`. Branch evidence can record feed provider/path/address/chain, heartbeat and staleness bounds, fallback behavior, observation block/date, collateral parameters, liquidation behavior, backstops, shutdown/bad-debt handling, and sources.
- `bridgeRouteRisk?: BridgeRouteRiskProfile` — reviewed cross-chain route setup, with route tier, summary, provenance, confidence, optional protocol evidence, sources, deployment-level `routes[]`, and structured `controls[]`. Each route identifies its exact chain/contract deployment, issuance/transfer semantics, reviewed tier, scope (`global`, `canonical`, `peripheral`, or `unknown`), and optional controller/failure-domain evidence. Each structured control names the route deployments it governs and the bridge capabilities it can exercise. Routes that are liabilities against one shared lockbox may carry the same `representationId`; this binds an observed pooled lockbox balance to an exact reviewed member inventory without implying per-destination supply. Safety Score V9 combines these reviewed identities with bounded runtime materiality evidence and fails closed when a required route fact is unresolved.
- `infrastructures?: Infrastructure[]` — structured infrastructure-lineage list (`"liquity-v1"` / `"liquity-v2"` / `"m0"`) used for UI badges, cohort filters, and discovery hubs. An array so a coin can belong to more than one infrastructure simultaneously, though in practice each coin currently has zero or one entry.
- `variantOf?: string` / `variantKind?: VariantKind` — post-launch parent-variant metadata for tracked pure wrappers, savings passthroughs, strategy vaults, risk-absorption legs, or bond-maturity products with direct exposure to another tracked stablecoin. Active children require active parents; quarantined, delisted and frozen children may retain readable historical relationships. `VARIANT_KIND_VALUES` in `shared/types/core.ts` owns the exact enum.
- `pegReferenceId?: string` — id of the tracked stablecoin used as this coin's peg-deviation reference (drives severe active-depeg cap inheritance from a parent). For tracked variants it is invariant-bound to equal `variantOf` (enforced in `shared/lib/stablecoins/schema.ts` and `validate-variants.ts`)
- `reserves?: ReserveSlice[]` — reserve composition data; slices may add structured asset class, obligor, risk factors, liquidity horizon, or evidenced maximum maturity without encoding a score
- `reserveReview?: ReserveReview` — sourced, dated review of reserve composition and known unknown exposure; per-slice non-link dispositions bind the current index, name and percentage without manufacturing a tracked-asset dependency. Reviewed class, obligor, liquidity and residual facts can still affect Backing without a `coinId`.
- `custodyProfile?: CustodyProfile` — reviewed providers, optional sourced shares, legal safeguards, reuse posture, provenance, and uncertainty behind the current `custodyModel`; Safety Score V9 compiles applicable wrapper-custody evidence, while consistency checks remain advisory rather than auto-deriving a tier
- `yieldConfig?: YieldConfig` — yield intelligence configuration
- `tradedContracts?: ContractDeployment[]` — traded contract addresses separate from `contracts`
- `liveReservesConfig?: LiveReservesConfig` — live reserve sync configuration (see `docs/live-reserves.md`)
- `notices?: CoinNotice[]` — per-coin alert notices shown on detail pages
- `status?: "pre-launch" | "active" | "quarantined" | "delisted" | "frozen"` — lifecycle state; omitted rows are active
- `listingStatusReview?: StablecoinListingStatusReview` — dated reason and review provenance required for quarantined and delisted records; quarantined reviews also require `reviewBy`
- `priceBasis?: StablecoinPriceBasis` / `exitMechanism?: StablecoinExitMechanism` — enums owned by `STABLECOIN_PRICE_BASIS_VALUES` and `STABLECOIN_EXIT_MECHANISM_VALUES` in `shared/types/stablecoin-taxonomy.ts`; sourced delisting evidence only; CI forbids these fields on non-delisted rows
- `frozenAt?: string` / `obituary?: StablecoinObituary` — freeze date and cemetery/detail-page obituary content required for frozen tracked coins
- `launchDate?`, `announcedDate?`, `expectedLaunchDate?`, `launchPhase?`, `launchPhaseDetail?`, `featuredContent?`, `milestones?`, `dateHistory?` — launch/upcoming timeline metadata for pre-launch and newly launched assets
- `pegScoreCoverage?` — reviewed lower bound for PegScore and recent-window observation. Author only after replay plus continuous live coverage has been audited; record the exact `startDate`, the required `basis: "audited-replay-and-live"`, `reviewedAt`, an optional `replayRunId`, and `notes` describing the verified boundary. It takes precedence over age-derived tracking anchors and must not imply coverage before the reviewed date.
- `mintAuthority?: MintAuthorityProfile` — reviewed mint/burn authority evidence compiled into Safety Score V9's Economic Control mint component and used by detail-page authority summaries; profiles can also carry structured upgradeability, active/resolved incident state, observation points, and reviewed common failure-domain keys
- `tags?: string[]` — freeform tag array for filtering and categorization

Cross-domain reviewed incidents are not a `StablecoinMeta` classification field. `shared/data/safety-score-v9/incident-reviews-v1.json` owns events that need explicit control, wrapper-local, operational, or peg routing plus root-claim, deployment, integration-only, or holder-exit scope. Each event changes the existing component that owns its risk; it does not create another Safety Score pillar. Domain-native evidence such as `mintAuthority.mintIncidents` remains in its existing sidecar and must not be duplicated into the cross-domain registry.

Bridge, custody, mint-authority, and reserve-quality summaries share `RESEARCH_REVIEW_CONFIDENCE_LABELS` from `shared/lib/classification.ts`. Each summary retains its own missing/unknown-value fallback; oracle confidence keeps its separate vocabulary, including `limited`.

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
[mechanism-overlay evidence standard](./process/mechanism-overlay-evidence-standard.md#native-family-admission-and-grading).
Missing claim identity remains NR; unknown or undisclosed protections after admission remain
priced bounded facts. This code capability does not author catalog members, change reserve
percentages, grant new oracle tiers or add supply overrides.

### Implementation Age Policy

`launchDate` remains the product or project launch. Author `implementationLaunchDate` only when a later deployed mechanism, relaunch, or critical implementation boundary makes the product date misleading. The field requires a sourced `mechanismArchetypeReview`, cannot unambiguously predate `launchDate`, and cannot begin after its mechanism review date.

For `YYYY`, `YYYY-MM`, `YYYY-Qn`, and `YYYY-Hn`, track-record age uses the inclusive end of that period. When the period end is later than the fixed scoring `asOf` date, the `asOf` date is used, yielding zero claimed age for the unresolved part of the period. Tracked variants resolve effective implementation age from the newest required layer across the child and parent chain, with cycle detection; they do not blindly inherit either endpoint.

### Mint Authority Taxonomy

Mint Authority is a reviewed native-issuance taxonomy. It covers canonical deployment(s) and controls that can create durable native liabilities or expand, relax, or replace their issuance constraints: direct minters, minter admins, proxy/cap admins, facilitators, off-chain signer systems, governance, and wrapper-local or inherited issuance. Bridge Risk owns representations and cross-chain machinery, including bridge mint/burn, adapters, lockboxes, messaging, limits, upgrades, and administrators. The same controller may appear in both modules when it exercises distinct powers, but a bridge capability is never compiled as global Mint Authority risk. Since safety `9.1` the taxonomy has no score of its own: Safety Score V9 compiles the reviewed native controls into the Economic Control pillar's mint component, and that component is the mint score every surface shows. Missing data produces explicit V9 evidence gaps and an `NR` mint state; it never implies safety.

Bridge vocabulary is not valid in active Mint Authority data, and an asset with no local native issuance carries the reviewed `mintAuthority.review.noLocalIssuance` exception instead of an invented native route. [Stablecoin Data Registry](./stablecoin-data.md#mint-authority-and-bridge-risk-ownership) owns the exact authoring contract, the deployment identity, and the values that are forbidden on active records.

Compact `mintAuthoritySummary` projections in coverage and market tables carry review-route labels, not scores. An `unknown` native mint path stays `Unknown` even when reviewed; it never defaults to `Governed`. The adjacent mint score and band come from the published V9 mint component.

Mint path labels:

| Value                           | Meaning                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `immutable-user-collateralized` | Users can mint only through immutable collateralized protocol rules; no privileged mint, cap, or upgrade path is resolved.                   |
| `user-collateralized-governed`  | Users mint through protocol mechanics, but governance/admins can alter collateral modules, debt ceilings, rates, or related mint parameters. |
| `issuer-direct-mint`            | Issuer/operator/minter can create durable supply directly, usually expected to be backed by off-chain reserves.                              |
| `permissioned-minter`           | On-chain minter roles, registries, or allowlists can mint within authorization.                                                              |
| `offchain-attested-minter`      | Minting depends on backend signatures, RFQ/order settlement, service roles, or off-chain validation.                                         |
| `facilitator-bucket-mint`       | Approved facilitators/minters can mint within bucket or route capacity.                                                                      |
| `amo-or-custodian-hybrid`       | AMOs, custodians, or strategy contracts can mint, move, or allocate supply under governance-defined constraints.                             |
| `bridge-or-oft-synthetic`       | Deprecated historical readback only. Active destination bridge/OFT issuance belongs in `bridgeRouteRisk`, not Mint Authority.                |
| `m0-permissioned-minter`        | M0-specific approved minter/validator and extension-wrapper issuance semantics.                                                              |
| `wrapped-or-variant-inherited`  | Wrapper, staking, savings, or variant asset inherits authority from a parent plus wrapper mechanics.                                         |
| `unknown`                       | Not reviewed or insufficient evidence.                                                                                                       |

Authority posture labels are descriptive bands only; `MINT_AUTHORITY_POSTURE_VALUES` in `shared/types/core.ts` is the runtime authority: `none-resolved`, `none-resolved-mint`, `bounded-admin`, `partially-bounded-admin`, `unbounded-reconciled`, `unbounded-governed`, `unbounded-veto-guarded`, `unbounded-operationally-governed`, `concentrated-admin`, `collateral-gated`, `unbounded-adverse`, `compromised`, and `unknown`. Do not color or rank these like report-card grades.

`unbounded-reconciled` ("Unbounded, reconciled or prudentially supervised") names economically unbounded minting with independently established recurring reconciliation or prudential supervision; actual reconciliation and supervision facts remain distinct. It renders in the elevated tone, as do `concentrated-admin`, `collateral-gated` ("Collateral-gated admin"), `unbounded-adverse` ("Unbounded, adverse authority"), and `compromised` ("Compromised (active incident)"). Adverse authority is base 25 / Exposed / high centralized-mint cap 59 under existing proof/scope gates, with ordinary seasoning bounded by ceiling 39; it asserts known unbounded power without a qualifying process, not measured non-reconciliation or an active incident. Prudential-alone retains base 55 / Managed / no centralized-mint signal only when no D30/D29/H process qualifies. Unknown reconciliation remains a separate scoped C/U cause, never a numerical 55 grant. `unbounded-governed` ("Unbounded, governance-delayed"), `unbounded-veto-guarded` ("Unbounded, veto-guarded") and `unbounded-operationally-governed` ("Unbounded, operationally governed") render in the neutral tone and publish Governed only after [D29](./mint-authority-scoring.md#governed-unbounded-issuance-1002), [D30](./mint-authority-scoring.md#minority-veto-issuance-1003) or [D31 / H](./mint-authority-scoring.md#operationally-governed-issuance-1005) qualifies respectively. H is 55 / moderate centralized-mint cap 74 / seasoning ceiling 59; its discretionary changes require public token governance while reviewed formula interest and activity-bound compensation may execute immediately. Uniform D32 applies to all three; actor process does not make economic power bounded.

The depeg resolver's fragile-minter set contains `concentrated-admin`, `collateral-gated`, `unbounded-reconciled`, `unbounded-governed`, `unbounded-veto-guarded`, `unbounded-operationally-governed`, `unbounded-adverse`, and `compromised`. Its economically unbounded severe-surge subset contains all of those except `concentrated-admin` and `collateral-gated`, which surge at the elevated rung instead. Affirmative-governed, minority-veto and operationally governed issuance remain severe-capable and relax no verdict. The single shared band/set authority is `shared/lib/safety-score-v9/mint-posture.ts`; adverse satisfies neither no-privileged-mint predicate and unknown reconciliation grants no new R1 anchor. Current authoring accepts only the runtime vocabulary above across every registry status; historical structured changelog entries retain their period-specific vocabulary, without runtime aliases.

`none-resolved` and `none-resolved-mint` ("No privileged mint resolved" / "No privileged mint path") are the two *scopes* of one finding, and both render in the same minimized tone.

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

`BluechipGrade` is a union type in `shared/types/core.ts`: `"A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D" | "F"`. It is used by `GRADE_ORDER` in `src/lib/bluechip.ts` for compile-time completeness checking.

## Non-USD Peg Handling

Peg deviation for non-USD stablecoins requires the peg currency's USD value. `shared/lib/peg-rates.ts` prefers usable `fxFallbackRates` from `sync-fx-rates.ts` for fiat pegs regardless of peer count; without FX it uses the same-`pegType` median. Peers must have an observed, positive finite price and at least $1M circulating USD. With metadata supplied, commodity prices are normalized by `commodityOunces` and `COMMODITY_MEDIAN_EXCLUDES` removes reviewed outliers. Gold/silver use the qualifying median at three contributors or more; thinner groups prefer an available metals/FX fallback, otherwise retain the median. `PegRatesResult` contains `rates`, per-currency `sources`, and qualifying-contributor `counts`. Deviation is `((price / pegRef) - 1) * 10000` basis points.

Those `fxFallbackRates` are produced by the `sync-fx-rates` cron. Its cadence bucket and claim, provider fallback order, and Chainlink/Open Exchange Rates overlays are documented in [pricing-pipeline.md](./pricing-pipeline.md); `PRIMARY_FX_CURRENCIES` and `SECONDARY_FX_CURRENCY_TO_PEG` in `worker/src/lib/fx-config.ts` own which fiat pegs come from Frankfurter/ECB and which come from the secondary daily currency API.

CZK and PLN use the primary ECB/Frankfurter business-daily source; AED uses the secondary calendar-daily currency API because ECB does not publish AED. The shared taxonomy owns the canonical DefiLlama peg types, display symbols, and FX/price-validation bounds for all three currencies. RAKBank's pre-launch dirham asset (`aed-rakbank`) uses `AED`. ILS and GEL assets remain unchanged; adding these three currencies does not establish ILS or GEL support.

## Commodity & Non-DefiLlama Stablecoins

Gold, silver, and some fiat stablecoins are not in DefiLlama's stablecoin API. These use the same canonical `ticker-issuer` ID format as all other stablecoins (e.g., `xaut-tether`, `kag-kinesis`, `jpyc-jpyc`) and are distinguished by their `detailProvider` field (`"commodity"` or `"coingecko"`) and `geckoId`/`protocolSlug` fields in `StablecoinMeta`.

The Worker's `sync-stablecoins` cron derives the supplemental set from `ACTIVE_STABLECOINS`: all gold/silver pegs plus entries with `detailProvider === "coingecko"`. It splits commodity tokens from fiat CoinGecko-only tokens, fetches CoinGecko/DefiLlama data, shapes DefiLlama-compatible rows and merges them into cached `peggedAssets`. Plain-par fiat assets without market price/cap can use on-chain supply valued at a fresh/static FX peg reference; configured protocol-inventory cases subtract observed non-circulating balances. NAV/yield-bearing assets never substitute `$1` or an FX peg for a missing token price, but may value on-chain supply with a trusted reserve or vault NAV from `loadReserveNavSupplyPrice` or `resolveVaultNavSupplyPrice`; without either market price or trusted NAV, that fallback fails closed. Tracked CoinGecko-provider assets retain last-known-good supplemental preservation even without a `geckoId`.

Gold/silver token price normalization and sanity validation both use the `commodityOunces` field, so fractional-ounce assets are compared against the correct per-token gold/silver reference instead of full-ounce spot. For the dedicated single-token gold slugs (`tether-gold`, `paxos-gold`), the DefiLlama protocol API supplies current market cap only; all other protocol slugs fall through to the CoinGecko market-cap/curated on-chain order. `circulatingPrevDay/Week/Month` are left `null` by the supplemental lane and are filled afterwards from the D1 `supply_history` table under a ±30% reasonableness gate, or restored from last-known-good cache. Silver tokens currently use the CoinGecko market/supply fallback; when historical data is unavailable, these fields are `null` and the frontend shows "N/A" rather than a misleading 0%.
