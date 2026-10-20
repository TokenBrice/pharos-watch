# Methodology Page Contract

`/methodology/` is the public long-form explanation of scoring and dependency exposure. `src/app/methodology/page.tsx` owns metadata, breadcrumb/Article/visible FAQ JSON-LD and reader guide; section bodies live under `src/app/methodology/sections/`.

## Methodology editing entry

[ADR-3](./architecture.md#adr-3) is the single methodology-change checklist and version authority. Use the [source map](#section--source-mapping) to find the domain owner, [Definitions](#definitions) for shared terms and [context anchors](#methodology-context-anchors) for app links. This guide owns editing/navigation, not copied formulas or release history.

## Route & Structure

`MethodologySections` in `sections/methodology-sections.tsx` owns ordered composition. `src/lib/methodology-content.ts` owns non-React IDs/titles/markdown summaries; `METHODOLOGY_SECTIONS` in `methodology-shared.tsx` owns navigation. Keep them coherent with public fragments and export.

Methodology and changelog navigation use the shared horizontal sticky banner. Active pills stay visible as the reader scrolls; hash jumps retain disclosure reveal and sticky-offset alignment. The methodology banner keeps its overflow fade and reader/input controls.

This route intentionally has no signature hero/frost One Beam: it is a long-form reference exception to [feature-page heroes](./design-language.md#feature-page-heroes). Reader mode shows summary, facts and preconditions; detailed evidence/version/worked-example content belongs inside `MethodologyDetails`. Both mode controls share `pharos.methodology.mode` localStorage and same-tab notification, with Reader as hydration-safe server snapshot. Shared detail attributes coordinate authored disclosures.

Static reference tables use `ContentTable` row/column data, retaining public table IDs, accessible labels, cell formatting and width constraints when consolidating markup.

Changelog routes use `src/app/methodology/[slug]/page.tsx` and the shared changelog shell; params/sitemap derive from registered `publicPath`, not per-lane pages. Register only lanes with standalone context. Retired Mint Authority has history at `/methodology/#mint-authority-score`, not a live standalone route. Version bodies belong in structured changelog data; extend `StructuredChangelogDetail` only for new schema block kinds, not prose releases. Missing commit provenance is `commits: []`, never fabricated hashes or unreleased placeholders.

`MethodologyContentSchema` in `shared/types/editorial-content.ts` owns changelog shapes, including recursive detail blocks and six-value weight tuples. Type-only inferred readonly views serve renderers, version resolution and Worker projectors without adding Zod/editorial-schema runtime edges through methodology infrastructure. `scripts/lib/editorial-content.ts` retains reference traversal, not a second shape authority.

History landing pages render the latest two complete releases and compact summaries for older versions. Every historical version fragment, plus table fragments in structured bodies, remains a static link to its full evidence at `/methodology/<slug>/archive/v<major>/`. `shared/lib/methodology-versions/archives.ts` derives these major-version shards from the same registry, bounding route growth rather than creating a page per release. Archive pages have their own canonical URL and generated Markdown twin; public inventory, sitemap and metadata alternates enroll the same archive set. Safety's historical summary tables remain on the overview and V8 archive.

Known version-specific `/methodology/pdf/*.pdf` aliases redirect directly to the matching archive and generated version fragment; unknown PDF paths retain the generic `/methodology/` fallback. Redirect tests bind every published alias to a registered release and its rendered archive anchor.

## Section → Source Mapping

| Domain | Owning contract | Runtime entry |
| --- | --- | --- |
| Pricing | [Pricing](./pricing-pipeline.md) | `worker/src/lib/price-consensus.ts`, sync-stablecoins enrichment |
| PSI | [Stability Index](./stability-index.md) | `worker/src/lib/stability-index.ts`, `shared/lib/psi-policy.ts` |
| Safety / exposure | [Report cards](./report-cards.md), [Dependency map](./dependency-map.md) | `shared/lib/safety-score-v9/`, `shared/lib/dependency-exposure.ts` |
| Published mint component | [Mint authority](./mint-authority-scoring.md) | `shared/lib/safety-score-v9/control.ts`, `mint-posture.ts` |
| Liquidity / redemption | [DEX](./dex-liquidity.md), [Redemption](./redemption-backstops.md) | DEX cron, `shared/lib/exit-route-scoring.ts` |
| Classification | [Taxonomy](./stablecoin-taxonomy-pages.md) | `shared/lib/classification.ts`, `filter-tags.ts` |
| Flows / yield | [Flows](./mint-burn-flows.md), [Yield](./yield-intelligence.md) | `worker/src/lib/mint-burn-scoring.ts`, `shared/lib/yield-scoring.ts` |
| Peg / DEWS / DDR | [Depeg](./depeg-detection.md), [DEWS](./dews.md), [Resolver](./depeg-resolver.md) | `shared/lib/peg-score.ts`, `worker/src/lib/dews.ts`, `shared/lib/depeg-resolver/` |
| Freeze / chain health | [Blacklist](./blacklist-tracker.md), [Chain Health](./chain-health.md) | blacklist cron/contracts, `shared/lib/chains/health.ts` |

### Exposure mode lookup

Public `/methodology/#dependency-exposure-methodology` explains structural look-through over the full published collateral/wrapper graph, independent of Explore filters. Roots are excluded from dependent counts; direct is one hop, indirect longer. Basket shares sum weighted upstream shares; serial shares use the maximum; combined uses the larger, not their sum. Dependents count once across roots and shared backing books once in USD, while layers can overlap; direct/indirect gross totals are not additive independent holdings.

USD uses accepted-publication `circulatingUsdAtEvaluation`, never current-cap fallback. Show generation, methodology, `asOfSec`, supply clock and held state. Missing publication-bound supply keeps rows with unknown USD/reason and excludes them from known totals. Missing coverage metadata is not an empty gap list. Explain weights/cycles, measured/reviewed versus current composition, role dependencies not drawn and known relationships excluded from the scored graph. Empty mapped results prove no absence of external dependencies; peg/liquidity/confidence transmission is out of scope.

Offline modeled scenarios remain distinct from lookup/history: one root per selection, production evaluator including role dependencies, publication-bound ranking/supply and shared books counted once. The [Dependency Map](./dependency-map.md) owns modeled shock admission. Public copy states artifact generation/age and freshness budget, labels earlier-generation results, withholds stale/unavailable numbers and preserves NR. Models are not forecasts and never change canonical cards, journals, identity or policy. Historical examples are study links, not runnable historical presets.

## Update Rules

Follow all four [ADR-3](./architecture.md#adr-3) targets for behavior/version changes: runtime version, owning methodology explanation, structured changelog and public methodology copy/examples. Versions increase numerically with at most two decimal places. Unchanged-behavior prose cleanup needs no methodology bump.

Safety and Pricing current-rule paragraphs and canonical history links are authored once in `src/lib/methodology-content.ts` through `defineMethodologySectionContent` and projected into both HTML and Markdown. Keep source-specific admission, failure, identity, supply and original-clock exceptions in the current evidence/technical disclosures; formulas and JSX tables stay in their technical sections. Release dates, research ledgers, calibration and replay outcomes link to immutable major-version archive fragments instead of parallel diaries. Before removing prose, census every unique current obligation and public fragment against its retained destination; parity tests protect both projections and resolve history links against the structured registry. This editorial consolidation changes no methodology version or historical changelog bytes.

Active PSI limits/bands, PYS constants, chain weights and producer cadences import their shared authorities; flow and PSI ranges state precise half-open bounds with the maximum endpoint included. Keep frozen historical values and authored worked examples intact when deriving current-policy labels.

Update section body and markdown summary when explanation changes; composition only when order/sections change. Shell FAQ/metadata/guide claims are runtime-facing too. Retarget definitions/context, static params and sitemap together when IDs/public paths move. Pricing source changes also update [About disclosure](./about-page.md), its runtime roster, [pricing update rules](https://pharos.watch/docs/pricing-pipeline/#update-rules) and [supply pipeline](./supply-snapshot.md#supply-pipeline); the integrity ledger is [pricing appendix](./process/pricing-pipeline-appendix.md#data-integrity-guardrails). Native mint display/filter/export changes propagate to detail, homepage, coverage and Screener; do not recreate a separate mint scoring lane.

Producer explanations follow runtime ownership: DDR cadence comes from `CRON_INTERVALS["compute-depeg-resolver"]`, not stablecoin-sync placement. Lifecycle Active describes collection eligibility, not blanket aggregate membership; PSI monetary scope follows listing-class admission. The pricing source inventory describes current adapters and their admission qualifications; retired providers belong in the canonical pricing changelog, and DexScreener exact-pool fallback remains distinct from the address-provider lane.

## Definitions

`src/lib/definitions.ts` is the single term source. Listed entries supply citation-ready A–Z long text, `#definitions` and `#def-<key>` anchors, DefinedTermSet JSON-LD and markdown export. Tooltip/context/glossary consumers project the same entries; do not copy them. Numeric text interpolates owning constants, not manual weights/bands. Product names are not definitions. Preserve the `/learn/glossary/` redirect to `/methodology/#definitions`.

Check metric explanations against their producers: yield consistency distinguishes unavailable history/variance (public PYS NR with a missing-inputs reason) from measured zero variance; chain Quality excludes unrated supply and withholds the factor/composite below its coverage gate; Environment uses matched L2BEAT stage/risk evidence before unmatched-chain tier fallback. These are existing scoring semantics, not new formulas or missing-data penalties.

## Methodology-Context Anchors

`src/lib/methodology-context.ts` projects definitions into `METHODOLOGY_CONTEXT`; shared `MethodologyHint`/`ScoreBadgeWrapper` owns tooltip routing. Retain every public fragment referenced by app/help links or migrate all callers. Blacklist context maps to `#blacklist-tracker-methodology`; Bluechip and PoR map to `#safety-scores-methodology`, not invented standalone sections.

Safety Score identity intentionally has no inline version superscript; table rows use tooltip-only badges with header context. Retired mint terminal history does not expose a standalone Version history link; current mint hints use Safety Score identity/changelog.

### Blacklist tracker {#blacklist-tracker}

[Blacklist tracker](./blacklist-tracker.md) owns freeze/release/destroy interpretation. UI/archive identity is distinct from reviewed live scanner admission: never infer scanning from UI membership, or absence of freeze controls from scanner omission.

### Bluechip rating {#bluechip}

[Bluechip](./bluechip-ratings.md) owns external ratings. About's roster is an intersection of current external and Pharos A-tier grades, not a hidden safety/liquidity model; respect its explicit publication hold rather than infer membership from one feed.

### Proof of Reserves

[Stablecoin addition](./process/adding-a-stablecoin.md) owns PoR metadata authoring; [detail page](./stablecoin-detail-page.md) owns surfacing. Tier and cadence are independent. Reviewed absence (`none`) differs from unavailable evidence (`undisclosed`); where attestation is inapplicable omit the field rather than force either. Never copy tier vocabularies/colours here.

## Show Your Work

`ShowYourWorkPanel` reads visible payload inputs, not another model. Safety uses native pillar breakdowns (Backing contributions, Exit routes/modifiers/caps, Economic Control binding/diagnostic components), with no invented weights or V8 raw-input fallback. Preserve technical keys/adjustments. Explicit `pharos.show-work` preference wins over `?show-work=1`; PegScore decomposition is not a Worker payload promise.

## Verification Shortcuts

Domain owners above route focused checks. `check:editorial-content` validates structured changelog registration/body/references; public section/export sync and context-fragment tests protect navigation. Source policy/registry constants, not this editing map, are the audit authority.
