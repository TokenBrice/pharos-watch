# Wrapper / Staked Variant Framework Design

Date: 2026-04-22 (revised post-review 2026-04-22)
Status: Revised — incorporates findings from 4 specialized plan reviewers (data-model, scoring, UI, integration)
Methodology target: Report Cards v7.08 → **v7.10** (substantial — new taxonomy + scoring rules + ceiling). Note: `v7.1` is numerically less than `v7.08` per `compareMethodologyVersions()` in `shared/lib/methodology-version.ts`; the correct next step after `v7.08` per the CLAUDE.md rule is either `v7.09` (incremental) or `v7.10` (substantial) or `v8.0` (major). This change is substantial, so **v7.10**.

## Problem

Pharos tracks 215 stablecoins, including 18 first-class wrapper/staked variants (e.g. sUSDS, stUSDS, sUSDe, stkGHO.v1, sBOLD, msY, bUSD0, sUSDai). Between 2026-04-21 and 2026-04-22, 8 new risk-wrapper assets were added (`busd0-usual`, `stusds-sky`, `stkgho-umbrella-aave`, `stcusd-cap`, `said-gaib`, `msy-main-street`, `yusd-yieldfi`, `sbold-k3-capital`), bringing the total wrapper count to 18. The website and data pipeline currently do a poor job of expressing the relationship between a wrapper and its base:

1. **Data layer** — the wrapper→parent relationship is encoded across seven loosely-coupled surfaces (`pegReferenceId`, `reserves[].coinId` + `depType`, `liveReservesConfig.expectedAssetAddress`, `dependencies[]`, `canonical-order.json` adjacency, `yield-config-variants.ts`, redemption-backstop `notes`). None is canonical; they disagree — e.g. `stusds-sky` uses `depType: "collateral"` instead of `"wrapper"`, `susdai-usd-ai` has no `coinId` on its reserve slices. `pegReferenceId` is semantically overloaded, doing three different jobs (peg inheritance, reserve-linkage, starting-asset pointer).
2. **UI layer** — `pegReferenceId` has zero consumers in `src/`. The only user-visible wrapper signal anywhere is the `(wrapper)` suffix inside the Report Card Dependencies callout. Reserve-treemap tiles aren't hyperlinked, the directory table shows variants as flat rows with only an overloaded `NAV` string, command palette doesn't group, filter bar has no variant toggle. The one first-class visual treatment (dashed violet wrapper edges in the contagion graph) lives on `/safety-scores/`, not embedded per-coin.
3. **Scoring layer** — inheritance is partial and asymmetric. PegScore inherits via `pegReferenceId` + `navToken` for navTokens (works on all 9 new entries). Dependency Risk ceiling is `parent_score − 3` via reserve-slice `depType: "wrapper"`. Decentralization has a blunt `GovernanceQuality: "wrapper" = 10` that under-scores immutable parents and over-scores single-entity parents. Resilience and Liquidity inherit nothing. A latent bug: `activeDepegBps` is keyed on `meta.id`, so a parent's D/F cap does not cascade.

Industry research (DefiLlama, CoinGecko, Aave, Sky, Ethena, Pendle, Morpho, Yearn, Frax, LlamaRisk, Chaos Labs, Bluechip) confirms no public analytics platform solves all three cleanly. Reciprocal parent↔variant navigation and parent-grouped list views are genuine ecosystem gaps. LlamaRisk and Bluechip both endorse an "inherit parent risk, overlay wrapper-specific risks, never score safer than parent on shared factors" model; we adopt it.

## Design principles (decided)

1. **Typed archetypes drive behavior.** Wrappers are not homogeneous. We codify four economic archetypes as a first-class `variantKind` enum; scoring overlays, UI badges, and redemption logic are keyed on it.
2. **Dimension-split scoring inheritance.** Systemic dimensions (Peg, Decentralization, Resilience) inherit from parent by default; execution dimensions (Liquidity) stay independent; structural coupling (Dependency Risk) uses ceiling enforcement. Per-archetype overlays modulate both sides.
3. **Hard parent-ceiling on overall grade.** `wrapper.overallGrade ≤ parent.overallGrade` enforced after computation. No launch-phase soft mode — enforce from day one.
4. **Flat list view with bidirectional badges + taxonomy hub.** Keep the market-cap-sorted directory flat; add archetype-colored badges, parent-variants cards, and a `/stablecoins/variants/[parent-id]/` taxonomy hub integrated into the top navigation.
5. **One field, one job.** Split the overloaded `pegReferenceId` into a canonical `variantOf` pointer and a narrowly-scoped residual peg-inheritance override.

## Section 1: Variant Taxonomy

Four archetypes (collapsing `yield-optimizer` into `strategy-vault` — indistinguishable in practice):

| Archetype | Economic exposure | Current examples |
|---|---|---|
| `savings-passthrough` | Passive ERC-4626 over parent. No external strategy. Exit = unwrap. NAV drifts up with yield only. | sDAI, susds-sky (sUSDS), sUSDe, sfrxUSD, scrvUSD, cUSDO, sYUSD |
| `strategy-vault` | Active deployment into external strategies (Pendle/Morpho/credit/GPU loans/box-spreads/lending pool LP). New reserve book independent of parent. NAV can fall on losses. Exit = queued/cooldown. | msY, yUSD-YieldFi, sAID, sUSDai, stcUSD (Cap), syrupUSDC/syrupUSDT (Maple) |
| `risk-absorption` | Bears bad-debt, slashing, or utilization-constrained exits for the host protocol. Principal at risk from upstream events. | stkGHO.v1 (Aave Umbrella), stUSDS (Sky risk-capital), sBOLD (Liquity SP) |
| `bond-maturity` | Fixed-maturity locked principal. Early exit may be below par. | bUSD0 |

**Scope rule.** `variantOf` MUST point at a tracked stablecoin. Cross-chain bridged deployments and wrappers of untracked bases stay out-of-scope (handled by existing `tradedContracts[]` or not modeled).

**Inheritance profile.**

| Dimension | savings-passthrough | strategy-vault | risk-absorption | bond-maturity |
|---|---|---|---|---|
| Peg | inherit parent | **independent** (NAV ≠ peg) | inherit parent (bad-debt depeg risk) | **independent** (bond floor) |
| Decentralization | inherit + wrapper-contract overlay | inherit + vault-governance overlay | inherit + slashing-governance overlay | inherit + issuer overlay |
| Resilience | inherit parent | **independent** (own reserve book) | inherit + bad-debt collateral overlay | inherit + maturity overlay |
| Liquidity | parent-liquidity − cooldown-haircut | queue/NAV floor | utilization + cooldown cap | pre-maturity flat cap |
| Dependency Risk | ceiling = parent − 3 | ceiling = parent − 5 | ceiling = parent − 5 | ceiling = parent − 8 |

**Invariants enforced.**
1. `wrapper.overallGrade ≤ parent.overallGrade` (hard cap after compute; mirrored in stressed-grade recomputation path at `shared/lib/report-card-overall.ts:computeStressedGrades()`).
2. `wrapper.pegScore ≤ parent.pegScore` for archetypes where peg inherits. See §3.1 for the two permitted implementations (data-substitution → cap redundant; compute-own-then-cap → cap active).
3. **Topological guarantee**: parent is scored before variant for ALL archetypes, not just those with a `depType: "wrapper"` reserve slice. This requires extending `topologicalOrder()` at `worker/src/lib/report-cards-snapshot-card.ts:205-225` to treat `variantOf` as an explicit predecessor — `deriveDependencies()` alone does not guarantee this for strategy-vault (schema-exempt from the parent reserve-slice rule).

## Section 2: Data Model

### 2.1 New fields on `StablecoinMeta`

Files: `shared/types/core.ts`, `shared/lib/stablecoins/schema.ts`.

```ts
variantOf?: string;     // canonical parent id (must exist in ACTIVE_STABLECOINS)
variantKind?: VariantKind;  // "savings-passthrough" | "strategy-vault" | "risk-absorption" | "bond-maturity"
```

**Schema invariant:** `variantOf` ↔ `variantKind` co-require (presence of one without the other is a validation error). Pre-launch entries may declare intent with `variantKind` alone without `variantOf`.

### 2.2 `pegReferenceId` scoped down

Retained as a narrow, optional override: "use this coin's peg score as my peg score." Usually equals `variantOf` but may differ. Cleanup on the 18 existing entries:

| Archetype | pegReferenceId after migration |
|---|---|
| savings-passthrough | equals `variantOf` (unchanged) |
| risk-absorption | equals `variantOf` (unchanged — bad-debt depeg inherits from parent) |
| strategy-vault | **stripped** — NAV ≠ peg; peg computed from wrapper's own data |
| bond-maturity | **stripped** — bond floor is independent |

Net: `pegReferenceId` shrinks from 18 to ~11 entries, each semantically clean.

### 2.3 Reserve-slice cleanup

- `stusds-sky` — change slice `depType: "collateral"` → `"wrapper"` (required for dependency-ceiling logic to fire).
- `susdai-usd-ai` — replace existing slices with `{ coinId: "usdai-usd-ai", depType: "wrapper", pct: 100 }`. The PYUSD + GPU-loan decomposition belongs on USDai's own reserves, not re-exposed through the wrapper.
- **Schema rule:** if `variantKind ∈ { savings-passthrough, risk-absorption, bond-maturity }`, at least one reserve slice must have `coinId === variantOf` and `depType === "wrapper"`. Strategy-vault exempt.

### 2.4 Parent-side derivation (no authored parent data)

Parents never carry a `variants: string[]` field. Inverse index built at catalog load:

```ts
// shared/lib/stablecoins/variants.ts (new)
getVariantOf(id: string): StablecoinMeta | null
getVariants(parentId: string): StablecoinMeta[]
getVariantRelationship(id: string): { parent, kind, siblings } | null
```

Mirrors `getRelatedStablecoins()` pattern at `src/lib/related-stablecoins.ts`.

### 2.5 Redemption two-leg inheritance

New optional field on `RedemptionBackstopEntry`:

```ts
inheritsFromVariantOf?: {
  legHaircut: number;     // 0..1, multiplier on parent's effective-exit score
  cooldownDays?: number;  // unwrap cooldown before parent's redemption engages
  floorRatio?: number;    // bond-maturity only — min redeemable as fraction of par
};
```

Scorer resolves wrapper-exit as `min(wrapperLeg_score, parentLeg_score × legHaircut)`. Replaces narrative-only `notes` prose in `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts` and `queue-redeem.ts`. Populate on the 8 existing wrapper redemption configs using cooldown/haircut already described in their `notes`.

### 2.6 `flags.navToken` semantics clarified

- `navToken` is purely a behavior flag ("peg irrelevant, price appreciates").
- It does NOT imply "is a wrapper." The canonical is-a-wrapper test is `typeof variantOf === "string"`.
- Tokenized RWA funds (USYC, USDY, USTB, OUSG, mTBILL, tbill-openeden, thbill-theo) retain `navToken: true` without `variantOf` — they are standalone NAV products, not variants.
- **Preserved on all 11 inheriting wrappers** (savings-passthrough + risk-absorption). `navToken: true` remains authored post-migration so existing skip paths continue to work: `worker/src/cron/detect-depegs.ts:405`, `worker/src/cron/dews/scoring.ts:95`, `worker/src/api/peg-summary.ts:173`, `worker/src/cron/yield-config.ts:34-38`, `worker/src/api/backfill-depegs.ts:171`, `worker/src/lib/safety-scores.ts:131`, `worker/src/lib/publish-report-card-cache.ts`. None of the 18 wrappers drop `navToken` in migration.

### 2.7 API contract impact of `pegReferenceId` strip

`pegReferenceId` is currently emitted by `/api/peg-summary`, `/api/report-card-snapshot`, and static `_site-data/stablecoin/[id]` datasets. Removing it from 7 entries (6 strategy-vault + 1 bond-maturity) is a breaking field removal. Document in `docs/api-reference.md` Phase-4 update and changelog. External consumers (bluechip.org per `docs/bluechip-ratings.md`) may be scraping — coordinate if needed.

## Section 3: Scoring Model

Code references are to current paths; modifications listed per file.

### 3.1 PegScore — dual-branch resolution

File: `worker/src/lib/report-cards-snapshot-card.ts` (`resolvePegInput()` at lines 54-86).

**Critical:** the legacy `navToken + pegReferenceId` path MUST be preserved alongside the new `variantOf + variantKind` path. 7 standalone NAV RWAs depend on the legacy path without `variantOf`: USYC, USDY, USTB, OUSG, mTBILL, tbill-openeden, thbill-theo.

Algorithm:

1. **Direct data**: if `directPeg.pegScore != null`, use it. Skip inheritance.
2. **Variant branch** (new): if `variantOf` is set AND `variantKind ∈ { savings-passthrough, risk-absorption }` AND direct is null, substitute parent's `PegSummaryCoin` from `pegDataById.get(variantOf)` and set `inheritedFromVariantOf: true`.
3. **Legacy NAV-RWA branch** (preserved): if `flags.navToken === true` AND `pegReferenceId != null` AND branches 1 and 2 didn't fire, substitute referenced coin's `PegSummaryCoin` and set `inheritedFromReference: true`.
4. **Fall-through**: return direct peg (may be null → wrapper scores NR).

Strategy-vault and bond-maturity score peg from wrapper's own price data via branch 1, else NR.

**Hard-cap semantic (resolved).** The cap `wrapper.pegScore ≤ parent.pegScore` is **redundant in branch 2** (substitution makes scores identical). The cap's actual purpose: when a strategy-vault variant has direct price data (branch 1), its computed score could in principle exceed parent's — cap at parent in `scorePegStability()` post-scoring. Gated on `variantKind != null` + parent score present. Savings-passthrough and risk-absorption can skip the cap (substitution already enforces equality).

**Bug fix:** when branch 2 or branch 3 fires, return inherited `activeDepegBps = activeDepegPeakBpsById.get(variantOf ?? pegReferenceId)`, so parent's D/F cap from `shared/lib/report-card-active-depeg.ts:4-7` cascades (currently keyed on `meta.id` and silently drops).

**Parent-NR semantics:** when parent's `pegScore` is null (parent itself NR), branch 2 does not produce a score; wrapper falls through to branch 3 or branch 1 (typically also null) → wrapper is NR. Acceptable degradation.

### 3.2 LiquidityScore — synthesis + two-leg blend

File: `shared/lib/report-card-peg-liquidity.ts` (`scoreLiquidity()` at lines 247-317).

**Signature change required.** Current signature is `scoreLiquidity(liq, redemption, options?: { activeDepegBps })`. Extend to `scoreLiquidity(liq, redemption, options?: { activeDepegBps, variantContext?: { meta, parentMeta, parentLiquidityScore, inheritsFromVariantOf } })`. Update all ~19 existing test call sites at `shared/lib/__tests__/report-cards.test.ts:221-563` + worker caller at `worker/src/lib/report-cards-snapshot-card.ts:128`.

**Design intent (corrected):** `inheritsFromVariantOf` drives synthesis as a **two-leg blend**, not a fallback gated on absence. The correct guard is `if (meta.variantKind)`, not `!dexLiq && !redemption`. When a wrapper has its own redemption config (like the 8 existing wrappers) AND `inheritsFromVariantOf` is populated, the final score is `min(wrapperLegScore, parentLegScore × legHaircut × cooldownHaircut)`. This lets `inheritsFromVariantOf` actually influence scoring for every inheriting wrapper.

**Archetype synthesis per variantKind:**

| Archetype | Wrapper-leg (from own redemption, if any) | Parent-leg synthesis | Combine |
|---|---|---|---|
| savings-passthrough | direct, if present | `parentLiquidityScore × legHaircut × cooldownHaircut` | `min(...)` — the more-constraining leg wins |
| strategy-vault | direct, if present (queue-redeem typical) | floor-capped at 60 | `min(...)` |
| risk-absorption | direct, if present | `parentLiquidityScore × legHaircut × cooldownHaircut × utilizationHaircut`, floor at 35 | `min(...)` |
| bond-maturity | direct, if present (bond exit route) | flat 40 pre-maturity; `parent.liquidityScore × 0.95` at/after maturity (if `maturityDate` stored) | `min(...)` |

**Cooldown-haircut formula (corrected).** Old formula flat-lined at 7 days, making sUSDe (7d) and sUSDai (30d) score identically. New smoothed formula preserves ordering past 7d:

```
cooldownHaircut(days) = 1 − min(days/30, 0.5)
```

Examples: 0d → 1.0, 1d → 0.97, 7d → 0.77, 14d → 0.53, 30d → 0.5 (floor).

**No-liquidity-penalty bypass.** `NO_LIQUIDITY_PENALTY = 0.9` at `shared/lib/report-card-overall.ts:51` fires when `dimensions.liquidity.score == null`. Synthesized wrappers return non-null scores → penalty does not fire. Intended behavior.

**Strategy-vault empty-reserves floor.** A strategy-vault without authored reserves inherits `"native"` (score 100) via `inferResilienceDefaults()`. This over-scores grossly. **New rule**: strategy-vault with empty reserves OR reserves that are solely `{coinId: variantOf, depType: "wrapper", pct: 100}` clamp `collateralQuality` to `"rwa"` (score 50) until explicit reserves are authored. See §3.3 for Resilience treatment.

### 3.3 Resilience — real enum + strategy-vault floor

File: `shared/lib/report-card-resilience.ts` (`resolveResilienceFactors()` at lines 175-188).

Add optional `parentMeta` parameter. Per-archetype behavior:

| Archetype | collateralQuality | custodyModel |
|---|---|---|
| savings-passthrough | inherit parent, override allowed | inherit parent, override allowed |
| strategy-vault | **independent** (from wrapper's own `reserves`), with clamp floor | independent |
| risk-absorption | inherit parent, **downgrade 1 tier** | inherit |
| bond-maturity | inherit parent, downgrade 1 tier pre-maturity | inherit |

**Downgrade tier uses the actual `CollateralQuality` enum** from `shared/types/core.ts:89, 113`:

```ts
type CollateralQuality = "native" | "rwa" | "eth-lst" | "alt-lst-bridged-or-mixed" | "exotic";
```

Ordered by `COLLATERAL_QUALITY_SCORE` at `shared/lib/report-card-resilience.ts:34-40`: `native (100) → eth-lst (66) → rwa (50) → alt-lst-bridged-or-mixed (20) → exotic (0)`. `downgradeTier()` maps: `native → eth-lst`, `eth-lst → rwa`, `rwa → alt-lst-bridged-or-mixed`, `alt-lst-bridged-or-mixed → exotic`, `exotic → exotic` (floor).

**Strategy-vault floor.** Per §3.2: when a strategy-vault has no authored reserves OR only a parent-self-reference slice, clamp `collateralQuality` to `"rwa"` (score 50). Prevents `inferResilienceDefaults()` from returning `"native"` (score 100) for an under-modeled vault.

### 3.4 Decentralization — parent's COMPUTED score, not raw quality

File: `shared/lib/report-card-governance.ts` (`scoreDecentralization()` at lines 59-99).

Replace flat `GOVERNANCE_QUALITY_SCORE["wrapper"] = 10` with archetype-aware `resolveVariantGovernanceScore(wrapperMeta, parentDecentralizationScore)`:

**Critical:** the base must be parent's **computed decentralization score** (which includes the chain-infrastructure penalty at `shared/lib/report-card-governance.ts:69-84`, e.g. Base-deployed parents get `×0.75`), NOT the raw `GOVERNANCE_QUALITY_SCORE[parentMeta.governanceQuality]`. Using raw quality silently discards ~25pts for non-Ethereum parents.

Plumbing requires a `decentralizationScoreById: Map<string, number>` analogous to the existing `overallScores` map in `worker/src/lib/report-cards-snapshot-card.ts:179-203`. Populate in the same topological loop (parent scored first via extended `topologicalOrder()` per §3.8).

```ts
resolveVariantGovernanceScore(meta, parentDecentralizationScore) {
  const overlay = {
    "savings-passthrough": -3,   // wrapper-contract upgradeability
    "strategy-vault": -10,        // vault governance + solver/oracle risk
    "risk-absorption": -8,        // slashing governance
    "bond-maturity": -5,          // issuer governance
  }[meta.variantKind];
  return Math.max(parentDecentralizationScore + overlay, MIN_VARIANT_SCORE);  // 10
}
```

**Chain-penalty exemption retained** — parent's computed score already includes the chain factor; don't re-apply to wrapper.

**Legacy enum value** `GOVERNANCE_QUALITY_VALUES["wrapper"]` retained for JSON schema backward-compat. After migration, no tracked entries use `governanceQuality: "wrapper"` (the 4 that do today — `stkgho-umbrella-aave`, `stcusd-cap`, `msy-main-street`, `sbold-k3-capital` — move to `variantKind`-driven path). Runtime dead code; flag for deprecation in follow-up.

### 3.5 Dependency Risk

File: `shared/lib/report-card-dependency.ts` (lines 100-108).

Replace flat `wrapperPenalty = 3` with archetype-keyed map:

```
savings-passthrough: −3  (unchanged)
strategy-vault: −5
risk-absorption: −5
bond-maturity: −8
```

Existing ceiling machinery (`ceiling = upstream_score − penalty`) retained.

### 3.6 Overall grade ceiling — base + stressed paths

File: `shared/lib/report-card-overall.ts` (after `computeOverallGrade()` at lines 54-57 **AND** inside `computeStressedGrades()` at line 150).

```
if (variantOf && parentOverallGrade != null && wrapper.overallGrade > parentOverallGrade) {
  wrapper.overallGrade = parentOverallGrade
  wrapper.overallCapped = true  // new field on ReportCard, threaded to UI
}
```

**Critical:** the stress-mode simulator at `/safety-scores/` re-computes wrapper scores via `computeStressedGrades()` when a parent is stressed (parent is upstream via reserve dep + `variantOf`). The cap MUST fire in both paths or the stress simulator will show wrappers with higher grades than their stressed parent — a user-visible contradiction.

Add `overallCapped?: boolean` to the `ReportCard` type at `shared/types/report-cards.ts` (top-level, not just per-dimension). Surface in the Overall summary card UI (Phase 3 update to `report-card.tsx`).

**Parent-NR behavior:** if parent `overallGrade` is null (parent NR), skip the cap and log. Either `overallCapped: false` or don't set the flag — wrapper proceeds with its own computed grade. Document explicitly.

Hard-enforced from day one (no log-only launch phase per user decision).

### 3.7 Overlay magnitudes as data

To enable post-ship calibration without redeploy, extract overlay constants to `shared/lib/variant-overlays.ts`:

```ts
export const VARIANT_GOVERNANCE_OVERLAY: Record<VariantKind, number> = {
  "savings-passthrough": -3,
  "strategy-vault": -10,
  "risk-absorption": -8,
  "bond-maturity": -5,
};

export const VARIANT_DEPENDENCY_PENALTY: Record<VariantKind, number> = {
  "savings-passthrough": 3,
  "strategy-vault": 5,
  "risk-absorption": 5,
  "bond-maturity": 8,
};

export const VARIANT_LIQUIDITY_FLOOR: Record<VariantKind, number> = {
  "savings-passthrough": 0,     // no floor — parent drives
  "strategy-vault": 60,
  "risk-absorption": 35,
  "bond-maturity": 40,
};

export const MIN_VARIANT_GOVERNANCE_SCORE = 10;
```

Consumers import from this module — one source of truth, easy calibration.

### 3.8 Topological order — variantOf as explicit predecessor

File: `worker/src/lib/report-cards-snapshot-card.ts:205-225` (`topologicalOrder()`).

Current `visit()` only follows `deriveDependencies(meta)` (reserve `coinId` + manual `dependencies[]`). Strategy-vault wrappers are schema-exempt from the parent reserve-slice rule (§2.3), so their parent may NOT appear in their dependencies — meaning the parent is NOT scored first, breaking ceiling enforcement (§3.6) and decentralization inheritance (§3.4).

**Fix:** in `visit(id)`, also recurse into `meta.variantOf` when present:

```ts
function visit(id: string) {
  if (visited.has(id)) return;
  visited.add(id);
  const meta = metaById.get(id);
  if (!meta) return;
  // Existing dependency edges
  for (const dep of deriveDependencies(meta)) {
    visit(dep.id);
  }
  // NEW: variantOf as explicit predecessor
  if (meta.variantOf) {
    visit(meta.variantOf);
  }
  order.push(id);
}
```

Cycle-safe: `variantOf` cannot be self; schema rejects `variantOf === id`.

### 3.9 UI-facing transparency

Each inherited dimension carries `inheritedFromVariantOf: true` into the rendered report card (existing `inheritedFromReference` pattern on peg — extend to all 5 dimensions). Surfaces as an "inherited from [parent-symbol]" chip on the dimension card.

New top-level `ReportCard.overallCapped: boolean` surfaces as an "Overall capped at [parent-symbol]'s grade" chip in the Overall summary card.

### 3.10 Observability

Add `console.info` emission when the overall cap fires (captured by Cloudflare Logs, 10% head-sampled per `wrangler.toml:28`):

```ts
console.info("[report-card] overall capped", {
  wrapperId: meta.id,
  raw: rawOverallGrade,
  parentId: meta.variantOf,
  parentGrade: parentOverallGrade,
});
```

Enables post-deploy analysis of how often the cap fires and for which archetypes — feeds back into overlay-magnitude calibration.

## Section 4: UI Surface Map

### 4.1 Wrapper detail page

- **Hero chip** (slot in `hero-card.tsx` adjacent to classification pills at line ~223-251 `HeroClassificationLine`): "Variant of [parent-logo] [parent-symbol] · [archetype-label]", clickable to parent. Matches existing pill visual dialect (use same class as `InfrastructureChip` at `hero-card.tsx:141`: `rounded-full border border-border/50 bg-*/10 px-2.5 py-0.5 text-[11px] font-semibold`, with `pharos-focus-ring`).
- **"Underlying asset" section** (new): inserted at `src/app/stablecoin/[id]/client.tsx:297` **above `NoticesAndSummarySection`**, NOT above `KeyInfoCard` (which sits after the Safety zone). This places the parent introduction before the Report Card's inheritance chips reference it. Reuses the `CollateralUsageItem` row template at `stablecoin-detail/collateral-usage-section.tsx:50-70` for visual symmetry.
- **KeyInfoCard addition**: add a `Variant of [parent]` chip in the existing pill row at `key-info-card.tsx:91-99` (same visual slot as the `Yield-Bearing` emerald chip).
- **Report Card inheritance chips**: small "inherited from [parent-symbol]" chip per inherited dimension. For the overall summary card: "Overall capped at [parent]" when `card.overallCapped === true`.
- **Scrollspy**: `DETAIL_SECTION_DEFS` at `client.tsx:90-102` gets **two distinct keys**:
  - `underlying: { id: "underlying-asset", label: "Underlying" }` — gated on `viewModel.isVariant`
  - `variants: { id: "variants-card", label: "Variants" }` — gated on `viewModel.hasVariants`
  Each new section must render with matching `id` attr so scrollspy anchors resolve. `useStablecoinDetailViewModel` extended with `isVariant` + `hasVariants` flags.
- **Reserve treemap hyperlinks**: Recharts renders `<g><rect><text>` in SVG; `<Link>` is not valid SVG. Use `<a xlink:href={buildStablecoinUrl(slice.coinId)}>` inside `TreemapCell` at `src/components/reserve-treemap.tsx:36-104`. Preserves middle-click, right-click, SEO.

### 4.2 Parent detail page

- **"Variants" card** (new): rendered **independently**, not conditional on `CollateralUsageSection`'s presence. Positioned in the Context & details zone before `CollateralUsageSection`. Uses `getVariants(parentId)`. Entry template reuses `CollateralUsageItem` for visual consistency.
- **`CollateralUsageSection` partitioned**: wrapper entries move out of this section into the new Variants card. Section stays for genuine collateral users (DAI-backed, GHO-borrowers, etc.).

### 4.3 Main directory table

- **Archetype badge in Symbol column** (`stablecoin-table-row.tsx`): use the shadcn `Badge` primitive at `src/components/ui/badge.tsx` with `variant: "outline"` + a CSS class derived from semantic-layer tokens (see below).
  - `savings-passthrough` → "Savings" / cyan token
  - `strategy-vault` → "Strategy" / amber token
  - `risk-absorption` → "Risk-Abs" / violet token (aligns with existing contagion-graph wrapper color)
  - `bond-maturity` → "Bond" / slate token
  - Chip must `stopPropagation` on click to avoid double-navigation (row is already `role="link"`).
- **Semantic color tokens** (follow design-tokens convention in `docs/design-tokens.md:47-66`, matching `--psi-*` / `--dews-*` / `--severity-*`): author new CSS custom properties in `src/styles/tokens/semantic.css`:
  ```css
  --variant-savings-bg, --variant-savings-text
  --variant-strategy-bg, --variant-strategy-text
  --variant-risk-abs-bg, --variant-risk-abs-text
  --variant-bond-bg, --variant-bond-text
  ```
  Use via `bg-[var(--variant-savings-bg)] text-[var(--variant-savings-text)]` in static Tailwind (arbitrary-value syntax; still a static string — Tailwind class linter-compliant).
- **Parent-symbol subtitle** under wrapper's symbol for scan-ability.
- **Peg column disambiguated — terse labels + tooltip** (stablecoin-table-row.tsx:191-201); long strings like `"NAV·strategy"` or `"→ SYRUPUSDC"` overflow the narrow mono/tabular-nums column. Use 2–5 char labels with `title` attr for the long form:
  - `"NAV"` — standalone NAV product (no `variantOf`), `title="NAV token"`
  - `"→ P"` — variant with peg inheritance, `title="Peg inherits from {parentSymbol}"`
  - `"Strat."` — strategy-vault, `title="NAV-priced strategy vault"`
  - `"Bond"` — bond-maturity, `title="Bond with maturity redemption"`

### 4.4 Filter bar

Files: `src/hooks/use-homepage-filters.ts:12-33`, `src/components/filter-bar.tsx:78` (grid template), `shared/types/core.ts:253` (`FilterTag` enum), `shared/types/core.ts:435` (`getFilterTags()`).

**New "Variant" filter group with 5 chips**: Base / Savings / Strategy / Risk-abs / Bond.

**Plumbing required (or filter is cosmetic):**
1. Extend `FilterTag` enum at `shared/types/core.ts:253` with: `variant-base`, `variant-savings-passthrough`, `variant-strategy-vault`, `variant-risk-absorption`, `variant-bond-maturity`.
2. Update `getFilterTags()` at `shared/types/core.ts:435` to emit `variant-${meta.variantKind}` for variant coins or `variant-base` otherwise.
3. Add filter group to `FILTER_GROUPS` in `use-homepage-filters.ts:12-33`.
4. Extend grid template at `filter-bar.tsx:78` from `lg:grid-cols-[1fr_1.2fr_0.6fr_1fr_1.2fr]` (5 tracks) to 6 tracks OR restructure to two rows at `lg` breakpoint.

Without steps 1-2, the filter UI will toggle URL state but `StablecoinFilteredTable` won't filter rows.

### 4.5 Taxonomy hub

**Correction:** `StablecoinTaxonomyHub` at `src/components/stablecoin-taxonomy-hub.tsx:9-17` takes `pages` (hub-of-hubs, not a stablecoin list). The per-taxonomy list component is `StablecoinTaxonomyPage` at `src/components/stablecoin-taxonomy-page.tsx:1-42` with hardcoded `kind ∈ "backing" | "governance" | "infrastructure"` at lines 14-18. Extend its `kind` union to include `"variant"`.

**Routes:**
- `/stablecoins/variants/` (index) — reuses `StablecoinTaxonomyHub` with a `pages: VARIANT_TAXONOMY_PAGES` array (one entry per parent with ≥1 variant).
- `/stablecoins/variants/[parent]/` (per-parent, param renamed from `[parent-id]` to `[parent]` to match convention at `src/app/stablecoins/backing/[backing]/`). Reuses extended `StablecoinTaxonomyPage` with `kind: "variant"` and a `filterTag: variant-${kind}` produced by `getFilterTags()`.
- `generateStaticParams` guards against dangling parents: `ACTIVE_STABLECOINS.filter(c => c.variantOf && ACTIVE_IDS.has(c.variantOf)).map(c => c.variantOf!)` using `ACTIVE_IDS` from `shared/lib/stablecoins/index.ts:74`.

**Nav integration:**
Add a `Variants` entry to `src/lib/nav-config.ts` under the `TRACK` group. **Note:** contrary to §4.5's original phrasing, the existing taxonomy routes (`/stablecoins/backing/`, `/peg/`, `/governance/`, `/infrastructure/`) are NOT currently present in `nav-config.ts:59-97`. The "Variants" entry is a standalone addition under TRACK, sitting alongside existing entries like `/chains`, `/liquidity`, `/depeg`.

**Sitemap + robots.** Extend `src/app/sitemap.ts` (or equivalent sitemap generator) to enumerate `/stablecoins/variants/` plus each `/stablecoins/variants/[parent]/` route. Without this, the 20 new pages are orphaned from Google. `npm run seo:check` verifies the emitted sitemap.

Static generation footprint: ~20 parent routes × 1 per parent. Minimal build-time impact.

### 4.6 Command palette

File: `src/components/command-palette.tsx:140-163`, `:273-292` (`sectionOrder`), `:473` (sublabel render).

**Structural work** — the palette has a fixed `sectionOrder = ["Recent", "Stablecoins", "Pages", "Actions"]` and filters by `r.section`. Adding per-parent sub-groups requires extending the section model with a dynamic sub-label, updating `flatResults` for keyboard navigation, and adjusting the render at line 473. Not a ~4-line change; treat as its own task.

**Behavior**: when a search matches across a parent + its variants, group results under a single "Variants of [parent-symbol]" header with the parent-first, variants-below order. Non-variant results render flat as today.

### 4.7 Yield leaderboard

File: `src/components/yield-leaderboard-table-row.tsx` (actual row renderer — not `yield-leaderboard.tsx`).

Double-logo overlay in coin column (Pendle-style): parent logo as a small corner badge on the wrapper's logo. No existing double-logo pattern in the repo — this is a new sub-component. Fallback if visual QA rejects: small "V" pill with tooltip.

### 4.8 Comparison pages

File: `src/components/comparison-table.tsx`, `src/lib/compare-pages.ts`.

- When comparing wrapper↔parent: "Inheritance" row explaining inherited vs independent dimensions.
- When comparing two wrappers of same parent: auto-highlight divergent archetype dimensions.

### 4.9 Contagion graph

File: `src/components/contagion-graph.tsx`, `contagion-graph-model.ts`.

Wrapper edge style (dashed violet) already exists. **Integration with existing `focusMode` state machine** at `contagion-graph.tsx:64` (`"all" | "neighborhood"`) — extend with a new `"variants"` focus mode. Add a `ToggleGroup` entry for it; keyboard-nav already works via `handleNodeKeyDown` at `client.tsx:184`. Update `aria-label` and tooltip ("click a parent to zoom into its variant cluster").

### 4.10 OG images + JSON-LD

- Wrapper OG image at `/api/og/stablecoin/[id]` (verified via `ShareButton` at `hero-card.tsx:659`): corner badge reading "Variant of [parent]".
- JSON-LD `Dataset` payload at `src/app/stablecoin/[id]/page.tsx:148-203` — `variantOf` is NOT a recognized Schema.org `Dataset` property. Correct mapping:
  - `isBasedOn: parent && `${SITE_URL}${buildStablecoinUrl(parent.id)}#dataset`` — standard `CreativeWork → CreativeWork` pointer, recognized by scrapers.
  - Append to the existing `identifier` array: `{ "@type": "PropertyValue", propertyID: "variantKind", value: meta.variantKind }`.

Google tolerates unknown top-level properties but ignores them; `isBasedOn` + `identifier` surface in rich-results parsing.

### 4.11 Unchanged components

`DepegHistory` (already hidden for navTokens), `BlacklistSection`, `FlowsSection`, `DistributionSection`, `DexLiquidityCard`, `ExploitNoticeBanner`.

## Section 5: Migration Plan

Atomic rollout is acceptable since the wrapper catalog was established 2026-04-21/22 and has no long-running production baseline to preserve. Phases below exist as PR organization, not as gated-deploy boundaries. Implementer may collapse to a single PR.

### Phase 1: Foundation

Blocks Phase 2 and 3. Single-PR size.

- Schema fields: add `variantOf`, `variantKind`; `VariantKind` enum; schema co-require invariant (with explicit `path: ["variantOf"]` in Zod refine).
- New file: `shared/lib/stablecoins/variants.ts` with inverse-index helpers. Verify `@shared/lib/stablecoins/variants` alias path resolves; if alias maps to directory index, re-export from `shared/lib/stablecoins/index.ts`.
- Extend `topologicalOrder()` at `worker/src/lib/report-cards-snapshot-card.ts:205-225` to visit `meta.variantOf` as an explicit predecessor (§3.8).
- Migrate 18 JSON entries: add `variantOf` + `variantKind`; strip `pegReferenceId` from strategy-vault and bond-maturity entries (6 coins).
- Fix 2 data bugs: `stusds-sky` reserve `depType`, `susdai-usd-ai` reserve slices.
- Audit the 12 non-strategy-vault wrapper entries for the required `{coinId: variantOf, depType: "wrapper"}` reserve slice; repair any that don't have it before enabling the refinement in the schema.
- Update **existing test** at `shared/lib/__tests__/stablecoins.test.ts:245` (asserts `susdai.pegReferenceId` — replace with `variantOf` + `variantKind` assertions).
- Add schema invariant tests: both refines reject malformed metas; count `ACTIVE_STABLECOINS.filter(c => c.variantOf).length === 18`.
- Extend `RedemptionBackstopConfig` schema with `inheritsFromVariantOf` (the **input** type at `shared/lib/redemption-backstop-configs/shared.ts:51` — NOT the output `RedemptionBackstopEntry`). Thread the field through the emitted `RedemptionBackstopEntry` at `shared/lib/redemption-backstop-scoring.ts` so Phase 2 liquidity scorer can read it.
- Populate `inheritsFromVariantOf` on **all 10 existing wrapper redemption configs** — 8 in `stablecoin-redeem.ts` / `queue-redeem.ts` (susds-sky, sdai-sky, sfrxusd-frax, scrvusd-curve, cusdo-openeden, susde-ethena, syusd-aegis, susdai-usd-ai) **plus 2 in `queue-redeem.ts:72-119` (syrupusdc-maple, syrupusdt-maple)**.
- Reconcile `YIELD_VARIANT_MAP` at `worker/src/cron/yield-config-variants.ts` — delete duplicate entries for the 18 first-class wrappers (or add a runtime assertion to prevent drift).
- Verify `canonical-order.json` adjacency — document accepted non-adjacent pairs (fiat-anchor variants: yusd-yieldfi, syrupusdc-maple, syrupusdt-maple).
- Audit `worker/src/api/` for any public emission of `pegReferenceId`; document breaking removal in `docs/api-reference.md` + changelog.
- Verification: `npm test shared/lib/__tests__/stablecoins.test.ts`, `npm run check:doc-counts`, schema round-trip unit tests.

### Phase 2: Scoring (can parallel with Phase 3)

- `resolvePegInput()` — **dual-branch** (variantOf-variant path OR legacy navToken+pegReferenceId path for 7 standalone NAV RWAs) + `activeDepegBps` propagation + hard cap (only active for strategy-vault with direct price data).
- `scoreLiquidity()` — **signature change**: accept `variantContext?: { meta, parentMeta, parentLiquidityScore, inheritsFromVariantOf }`. Update all call sites (~19 in `shared/lib/__tests__/report-cards.test.ts` plus the worker caller). Two-leg blend: `min(wrapperLeg, parentLeg × legHaircut × cooldownHaircut)`. New cooldown-haircut formula: `1 − min(days/30, 0.5)`.
- `resolveResilienceFactors()` parent inheritance + tier-downgrade overlay using **real enum values** (`native → eth-lst → rwa → alt-lst-bridged-or-mixed → exotic`). Strategy-vault floor at `"rwa"` when reserves empty.
- `resolveVariantGovernanceScore(wrapperMeta, parentDecentralizationScore)` — uses parent's **computed** decentralization score (includes chain penalty), not raw `GOVERNANCE_QUALITY_SCORE[quality]`. Requires new `decentralizationScoreById: Map<string,number>` populated in topological loop.
- Extract overlay magnitudes + floors + MIN_VARIANT_SCORE to `shared/lib/variant-overlays.ts`.
- Archetype-keyed dependency `wrapperPenalty` via new `VARIANT_DEPENDENCY_PENALTY` constant.
- Overall-grade parent-ceiling enforcement at `computeOverallGrade()` **AND inside `computeStressedGrades()`** at line 150 (critical for stress simulator).
- Add `overallCapped?: boolean` to the top-level `ReportCard` type at `shared/types/report-cards.ts`. Thread through snapshot assembly.
- Surface `inheritedFromVariantOf` per dimension + `overallCapped` at top level into rendered report card.
- Add `console.info("[report-card] overall capped", {...})` log emission when cap fires.
- Unit tests per archetype × inheritance path (target ~20-25 cases covering 4 archetypes × 5 dimensions × inherited/direct paths + non-variant NAV RWA regression).
- Integration test: build snapshot for `usds-sky` + `susds-sky` + `stusds-sky`; assert ordering, caps, inheritance flags.
- Pre-merge grade-diff table: after build, extract old vs new grades for 18 wrappers into markdown table; paste in PR body.
- Verification: snapshot-diff per wrapper; `cd worker && npx tsc --noEmit`; scoring unit tests; integration test.

### Phase 3: UI (can parallel with Phase 2)

- `src/styles/tokens/semantic.css` — new `--variant-*` tokens (savings/strategy/risk-abs/bond).
- `src/lib/variant-display.ts` — centralized VARIANT_DISPLAY using shadcn `Badge` primitive at `src/components/ui/badge.tsx`.
- Wrapper hero chip + `UnderlyingAssetSection` inserted **at `client.tsx:297` above `NoticesAndSummarySection`** (not above `KeyInfoCard`). Reuses `CollateralUsageItem` row template. KeyInfoCard also gets a "Variant of [parent]" chip in the existing pill row at `key-info-card.tsx:91-99`.
- Scrollspy: **two distinct keys** in `DETAIL_SECTION_DEFS` — `underlying` (wrapper page) and `variants` (parent page) — gated on `viewModel.isVariant` and `viewModel.hasVariants`.
- Dimension inheritance chips per dimension card. Top-level "Overall capped at [parent]" chip when `overallCapped`.
- Reserve treemap hyperlinks — SVG-native `<a xlink:href>` inside `TreemapCell`, NOT `<Link>` (which doesn't work in SVG). Add `tabIndex`, focus ring, `aria-label`.
- Parent "Variants" card — **independent positioning**, not conditional on `CollateralUsageSection`. `CollateralUsageSection` partition.
- Directory table archetype badge (with `stopPropagation`) + parent-symbol subtitle + **terse** peg-column disambiguation (`"→ P"` / `"Strat."` / `"Bond"` / `"NAV"` + `title` attr).
- Filter-bar — extend grid template from 5 to 6 columns at `lg`. Extend `FilterTag` enum at `shared/types/core.ts:253` with `variant-*` values. Emit from `getFilterTags()` at `shared/types/core.ts:435` or filter is cosmetic.
- Taxonomy hub: extend `StablecoinTaxonomyPage.kind` union with `"variant"`. `/stablecoins/variants/` uses `StablecoinTaxonomyHub` (hub-of-hubs). `/stablecoins/variants/[parent]/` (param renamed from `[parent-id]`) uses extended `StablecoinTaxonomyPage` with `filterTag: variant-${kind}`. Guard `generateStaticParams` with `ACTIVE_IDS`. Add "Variants" entry to `src/lib/nav-config.ts` under TRACK group.
- Extend `src/app/sitemap.ts` + robots.txt emission for 20 new routes.
- Command palette — structural: extend section model with dynamic sub-labels + keyboard-nav update.
- Yield leaderboard double-logo overlay — target is `src/components/yield-leaderboard-table-row.tsx` (NOT `yield-leaderboard.tsx`). New sub-component (no existing double-logo pattern).
- Comparison-page inheritance row + wrapper-vs-wrapper divergence highlight.
- Contagion graph — extend existing `focusMode` state machine at `contagion-graph.tsx:64` with new `"variants"` mode; aria-label + tooltip updates.
- OG image + JSON-LD `isBasedOn` + `identifier` PropertyValue (not custom `variantOf` top-level property).
- Playwright smoke: wrapper + parent pair + taxonomy hub + directory table badges + filter interaction.
- Verification: `npm run build`, `npm run seo:check`, Playwright smoke.

### Phase 4: Documentation + methodology

- Report Cards methodology bump: v7.08 → **v7.10** (substantial; new taxonomy + scoring rules + ceiling). Update `currentVersion` constant in `shared/lib/safety-score-version-data.ts:4` AND the `## Overall Grade (v7.xx)` heading in `docs/report-cards.md`. Run `npm run check:doc-sync` to confirm version label matches.
- New `methodology/variants` page with the archetype/inheritance tables from §1 (route under `src/app/methodology/`).
- Update `docs/report-cards.md` with variant-inheritance section; replace flat `wrapper = 10` prose.
- Update `docs/report-cards-input-reference.md` with `variantOf` / `variantKind`.
- Update `docs/architecture.md` with variant topology diagram.
- Update `agents/process/adding-a-stablecoin.md` with new required fields + promotion rule + reserve-slice convention.
- Update `docs/api-reference.md` — document `pegReferenceId` removal from 7 entries as a breaking API contract change.
- Update `resilience-classify` skill to note that wrapper `collateralQuality` may be runtime-downgraded per archetype rules (don't author assuming final score equals authored).
- `/about` page mentions the variant model.
- **Changelog entry**: file goes at `src/data/changelogs/YYYY-MM-DD.ts` (not `changelog/` — that directory doesn't exist). Reference `src/data/changelogs/types.ts` for shape. Compatible with `skills/changelog-collect`.
- Verification: `npm run check:doc-counts`, `npm run check:doc-sync`, `npm run test:merge-gate`.

### Classification notes (per-coin authorial decisions)

- **sBOLD** — placed under `risk-absorption` because Liquity Stability Pool liquidation-loss absorption dominates the K3 strategy flavor. Confirm in methodology notes; flip to `strategy-vault` if docs indicate otherwise. **Sign-off by @tokenbrice required before merge.**
- **stcUSD (Cap)** — placed under `strategy-vault` because operator borrowing + strategy yield generation dominates. The restaker slashing-protection layer is a safety feature on top, not a risk-absorption primary. Borderline; review at ship. **Sign-off by @tokenbrice required before merge.**
- **syrupUSDC / syrupUSDT (Maple)** — `strategy-vault` with `variantOf` pointing at `usdc-circle` / `usdt-tether` respectively. The parent is the fiat anchor, not a protocol-native base; acceptable semantic stretch consistent with "starting asset" usage elsewhere. **Sign-off by @tokenbrice required before merge.**
- **yUSD (YieldFi) — `variantOf: usdc-circle`**: similarly a fiat-anchor parent. **Acknowledged operational outcome**: the overall-grade hard cap from §3.6 will cap yUSD / syrupUSDC / syrupUSDT at `usdc-circle`'s grade (~92-95) and similarly syrupUSDT at `usdt-tether`'s grade. Philosophically correct under the LlamaRisk "wrapper ≤ parent on shared factors" principle, but flag in the PR description and methodology so the calibration decision is explicit. Operator can later add a per-archetype cap override if the fiat-anchor case warrants it.
- **sUSDe** — `savings-passthrough` (ERC-4626 over USDe, 7-day cooldown on unstake). Cooldown expressed via `inheritsFromVariantOf.cooldownDays = 7`.
- **bUSD0** — `bond-maturity` with `floorRatio` populated from Usual docs (rt-bUSD0 vs floor redemption).

### Operational safeguards

- **snapshot-safety-grade-history cron**: the daily `0 8 * * *` cron at `worker/src/cron/snapshot-safety-grade-history.ts` will persist ~18 wrapper grade diffs to D1 on first fire post-deploy. Expected to trigger Telegram alerts via the dispatch-telegram-alerts chain. **Mitigation**: one-time alert mute window around deploy; document expected changes in PR body.
- **Pre-merge grade-diff table**: Phase 2 verification requires extracting `_site-data/report-cards.json` (or equivalent) after local build and producing a markdown table `{id, oldGrade, newGrade, inheritedDims[], capped}` for all 18 wrappers. Paste into PR body.
- **Deploy concurrency**: if the implementer chooses multi-PR slicing, honor the rule from `agents/plans/2026-04-20-phase-1-3-audit-remediation-plan.md:17` — serial merges through the `production-deploy` concurrency group in `.github/workflows/deploy-cloudflare.yml`. Atomic single-PR path is safer default.
- **Rollback playbook**: if post-deploy grades are clearly wrong: (a) revert merge on `main`; (b) Worker rollback via `wrangler rollback` — automated in existing CI at `deploy-cloudflare.yml:156-184`; (c) Pages auto-redeploys prior artifact; (d) D1 untouched (no migration); (e) `snapshot-safety-grade-history` rows from bad deploy remain as audit trail. Document in PR body.
- **D1 storage shape audit**: verify `worker/src/lib/report-card-cache.ts` persists cards as JSON blobs (not columnar). If columnar, a backward-compatible ALTER TABLE migration is required (per CLAUDE.md D1 rule). Grep confirms JSON blob today; re-verify at implementation time.
- **API contract change**: `pegReferenceId` removal from 7 entries is a breaking emission change. Document in `docs/api-reference.md` Phase 4 update + changelog. Coordinate with bluechip.org if applicable.

### Success criteria

- `npm run test:merge-gate` passes.
- `npm run check:doc-counts` passes.
- `cd worker && npx tsc --noEmit` passes.
- Every wrapper's overall grade is either unchanged or has a documented, reviewed diff.
- Every surface in §4 renders variant affordances for at least one wrapper + parent pair in Playwright smoke.

## Open decisions deferred to implementation

1. **Cooldown-haircut formula** — set to `1 − min(cooldownDays/30, 0.5)` (§3.2). Examples: 0d→1.0, 7d→0.77, 14d→0.53, 30d→0.5 (floor). Preserves ordering past 7 days. Tunable post-ship via `shared/lib/variant-overlays.ts`.
2. **Overlay magnitudes** — governance `−3/−10/−8/−5`, dependency `3/5/5/8`, liquidity floors `0/60/35/40`. Extracted to `shared/lib/variant-overlays.ts` (§3.7) for post-ship calibration without code redeploy.
3. **Aggregate dedup** — distinguishing "raw" vs "distinct" market cap on the homepage and chain aggregates is a separate methodology concern; not in scope for this framework. Track as a follow-up.
4. **Yield-only variants in `YIELD_VARIANT_MAP`** (~25 wrappers not first-class today — sDOLA, sGHO legacy, stUSR, etc.) — retain their current representation. A follow-up project can evaluate promotion or lightweight variant-metadata badging per the archetype rule.
5. **Fiat-anchor parent-ceiling** — `yusd-yieldfi`, `syrupusdc-maple`, `syrupusdt-maple` all get capped at `usdc-circle` / `usdt-tether` grades by §3.6. Philosophically correct but operator may want a per-archetype override later; documented as an acknowledged behavior, not a blocker.

## Appendix: Current state summary (from parallel audits 2026-04-21)

- **Data model audit** — 18 first-class wrappers; 7 loosely-coupled encoding surfaces; `pegReferenceId` overloaded across three semantics; `stusds-sky` depType bug; `susdai-usd-ai` missing `coinId`; no parent-side array; relationship for parent→children is inverse-index only.
- **UI treatment audit** — `pegReferenceId` has zero consumers in `src/`; the only visible wrapper signal is `(wrapper)` suffix in Report Card dependencies; reserve treemap tiles non-interactive; contagion graph is the one first-class visual (dashed violet).
- **Scoring architecture audit** — PegScore inherits, Dependency Risk has principled ceiling, Decentralization has blunt flat proxy, Resilience and Liquidity inherit nothing. `activeDepegBps` keyed on wrong id. Five surgical insertion points identified.
- **Industry patterns** — DefiLlama deduplicates at base; CoinGecko uses "Rehypothecated token" tag; Aave uses task-tab architecture; Sky tiered presentation with expert-user gating for riskier wrapper; Ethena single-page paired toggle; Pendle double-logo market card; LlamaRisk/Bluechip consensus: inherit parent + overlay specifics, never safer than parent on shared factors; reciprocal parent↔variant navigation and accordion-grouping are unfilled ecosystem gaps.

Source audits retained in `/tmp/claude-1000/...` task outputs; summarized findings are authoritative in this spec.
