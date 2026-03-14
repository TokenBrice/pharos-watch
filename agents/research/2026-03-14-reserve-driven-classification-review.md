# Reserve-Driven Classification Review — Design Research

_March 2026 — triggered by fxUSD reclassification (decentralized → centralized-dependent after WBTC share reached 57%)_

---

## Executive summary

fxUSD was the symptom. The disease is systemic: **16 of 28 live-enabled coins show meaningful drift between curated reserves and live data**, including 4 with >20-point collateral score discrepancies. At least 5 "decentralized" coins have >30% centralized-custody collateral. And the risk tier assignment system is fragmented — a canonical mapping exists but most adapters and all curated data ignore it.

The problem has three distinct layers, each needing a different solution:

| Layer | What's broken | Scale | Best fix |
|---|---|---|---|
| **Composition staleness** | Curated pct splits drift from reality | 16/28 live coins, unknown for 128 without sync | Live → scoring passthrough + drift alerting |
| **Classification inconsistency** | Governance type doesn't match actual collateral custody | ≥5 coins | Build-time invariant rules |
| **Risk tier fragmentation** | No enforcement between adapter risk assignments and canonical mapping | All adapters + all curated data | Canonical mapping enforcement in tests |

---

## Scale of the problem right now

### Composition drift audit (live vs curated)

Comparison of all 28 live-enabled coins' API snapshots against curated `StablecoinMeta.reserves`:

**Critical drift (>20pt score difference) — 4 coins:**

| Coin | Score diff | Key finding |
|---|---|---|
| Neutrl NUSD | **+37** | Curated: 80% delta-neutral strategies. Live: 94.5% stablecoins. Complete risk profile inversion. |
| Noon USN | **-36** | Curated: 40% USDC/USDT + 30% T-bills. Live: 58% private credit (high risk). Reserves restructured. |
| DEURO | **-27** | Live: 62% WFPS (Wrapped Frankencoin Pool Share) — entirely absent from curated. Recursive BTC dependency. |
| Mu AZND | **+25** | Live: 33% short-term cash (very-low) missing from curated. Actual risk lower than scored. |

**High drift (10–20pt) — 4 coins:**

| Coin | Score diff | Key finding |
|---|---|---|
| OpenDollar USDO | +20 | Risk tier mismatch: curated labels TBILL as "low", live as "very-low". BENJI replaced by VBILL. |
| Felix feUSD | +16 | Live: 100% HYPE. Curated: 40% BTC/ETH/SOL. Possible adapter gap or stale curated. |
| Frankencoin ZCHF | -14 | BOSS token (43% of live) completely absent from curated. Different risk picture. |
| Aegis YUSD | -13 | Live organizes by custodian (Copper/Fireblocks), not position type. Ontological mismatch. |

**Medium drift (large composition shift, moderate score impact) — 1 coin:**

| Coin | Score diff | Key finding |
|---|---|---|
| Falcon USDf | -5 | BTC: 45% → 86%. Stablecoins: 30% → 3%. Massive concentration shift. |

**Lower-priority drift (structural/labeling, <5pt score) — 7 coins:**
BOLD, M, MUSD, USDN, USDe, YZUSD, USDaf. Mostly adapter disaggregation differences or gradual ratio shifts.

**Well-aligned — 9 coins:** crvUSD, infiniFi, USND, fxUSD (just fixed), LUSD, MUSD (Mezo), btcUSD, syrupUSDC, syrupUSDT.

**Missing curated data:** wsrusd-reservoir has live data but no curated reserves at all.

### Classification mismatches

Coins classified as `"decentralized"` with significant centralized-custody collateral:

| Coin | Direct centralized-BTC % | Assets | Concern |
|---|---|---|---|
| **crvUSD** | **69%** | WBTC / cbBTC | Largest centralized-custody share of any "decentralized" coin. BitGo + Coinbase are single points of failure. |
| **DEURO** | **~40% direct + recursive** | WBTC/cbBTC/kBTC + 62% WFPS | WFPS itself contains WBTC/cbBTC. Effective centralized-custody BTC exposure likely >60%. |
| **Frankencoin ZCHF** | **30%** | WBTC 12% + cbBTC 18% | Confirmed by live data granularity. |
| **Mezo btcUSD** | **up to 100%** | tBTC, WBTC, SolvBTC, cbBTC | Unknown split between trustless tBTC and centralized variants. |
| **Bitcoin USD** | **up to 100%** | BTC/WBTC/BTCB/cbBTC | Same unknown split. |

**The crvUSD question is particularly consequential.** It's a top-20 coin by TVL. Reclassifying it to `centralized-dependent` would affect its safety score, its "DeFi" badge, and its downstream dependents (coins that list crvUSD as a dependency).

---

## Three layers, three different problems

### Layer 1: Composition staleness (the pct splits are wrong)

This is the most common and most automatable issue. The curated `reserves` array was accurate at curation time but composition has since evolved. The live sync already tracks reality — the data just doesn't feed into scoring.

**Key data model finding:** The `computeCollateralQualityFromReserves()` function in `report-cards.ts` only reads `pct` and `risk` from each slice. Live adapter slices carry both. This means **live data is type-compatible with scoring right now** — no schema changes needed.

However, `deriveDependencies()` also reads reserves and relies on `coinId` fields to build the dependency graph. Most live adapters do NOT populate `coinId` (only `single-asset`, `erc4626-single-asset`, and `asymmetry` do). So **dependency inference must remain on curated data** even if collateral scoring switches to live.

### Layer 2: Classification inconsistency (the governance label is wrong)

This requires human judgment. A protocol using WBTC doesn't automatically become "centralized-dependent" — that depends on whether the protocol has fallback mechanisms, how deeply coupled the custody risk is, etc. But the curation process today offers zero guardrails. A coin can be committed as `"decentralized"` with 100% WBTC and no test will fail.

### Layer 3: Risk tier fragmentation (the same asset gets different risk labels)

The canonical mapping `CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL` in `shared/lib/reserve-asset-risk.ts` exists and covers ~23 common assets (ETH, WETH, WBTC, cbBTC, wstETH, etc.). But:

- Only 3 of 15 adapters reference it (crvusd, collateral-positions-api, fx)
- The remaining 12 adapters hardcode their own risk tables
- Curated reserves in stablecoins.ts assign risk tiers manually per slice with no validation
- The only enforced consistency check is for ETH/WETH specifically (in `stablecoins.test.ts`)

This means the same asset (e.g., WBTC) could theoretically get "low" in curated data and "medium" from a live adapter, producing different scores from identical composition. This must be fixed before live → scoring passthrough ships, or the score jumps on transition would be confusing artifacts rather than real changes.

---

## Design directions (revised)

### Direction 1 — Live reserves → collateral score passthrough

Wire live reserve snapshots into `buildReportCardsSnapshot()` for the collateral quality sub-factor. When a fresh live snapshot exists, use it instead of curated reserves for that one calculation.

**What's technically needed:**
- `buildReportCardsSnapshot()` already receives the D1 database binding. It would pull `reserve_composition` rows alongside the other queries.
- `computeCollateralQualityFromReserves(slices)` accepts `ReserveSlice[]` — live slices are the same type and carry `pct` + `risk`.
- Dependency inference stays on curated `meta.reserves` — no change to `deriveDependencies()`.

**Safety rails needed:**
- Freshness gate: only use live data if snapshot is < 48h old (reuse existing `LIVE_RESERVE_FRESHNESS_SEC`).
- Minimum slice count: ≥ 2 slices (prevents adapter failures returning a single "Unknown" slice from poisoning scores).
- Score delta alerting: if the live-derived score differs from curated-derived by >15 points, emit a warning in the cron status/alert system. This catches adapter bugs and real composition shifts that may require classification review.
- Adapter risk consistency: prerequisite — enforce canonical risk tiers across all adapters first (see Direction 6), so the switch from curated to live doesn't introduce score artifacts from inconsistent risk assignments.

**What this fixes:** collateral quality score accuracy for 28 coins. Fully automatic. No curator work per update.

**What this doesn't fix:** governance classification, dependency graph, the 128 coins without live sync.

**Score impact:** for the 4 critical-drift coins alone, scores would shift 25–37 points. NUSD and AZND would improve; USN and DEURO would deteriorate. These are correct movements — they reflect reality.

### Direction 2 — Drift detection + review queue

Compare live snapshots to curated data on a schedule. Flag significant divergences for human review.

**Drift signal design:**
- **Score delta > 5pt:** curated data likely stale, needs pct update.
- **Dominant slice missing:** live's largest slice doesn't match any curated slice by name — possible new asset or restructuring.
- **Classification tension:** live data implies centralized-custody collateral > 30% but governance is "decentralized" (combines with Direction 3 rules).

**Ontological vs real drift:** some "drift" is the adapter disaggregating differently (e.g., M0 breaking "100% T-bills" into T-bills + tokenized treasuries + cash). The YUSD case (organized by custodian instead of position type) is structural, not compositional. Drift detection should compare **weighted score**, not raw slice names, to filter out benign ontological differences.

**Surfacing options:**
- **/status integration (recommended):** lightweight, internal, fits existing data-quality patterns. A "Reserve Drift" section showing coins with significant live-vs-curated delta, sortable by impact.
- **CLI script:** `npm run check:reserve-drift` for local curation sessions. Quick to build but easy to forget.
- **GitHub Issues:** high-ceremony for what's essentially a curation-workflow signal. Reserve for cases where drift persists >30 days without action.

### Direction 3 — Classification rules as build-time invariants

Test-suite rules that prevent committing governance classifications incompatible with reserve compositions.

**Revised rules (informed by the actual data):**

```
Rule A (hard fail): If combined pct of centralized-custody BTC assets
        (WBTC, cbBTC, LBTC) > 30%, governance must NOT be "decentralized".
        Exception: explicit opt-in allowlist with documented justification.

Rule B (warning): If governance is "decentralized" but no on-chain native
        crypto slices (ETH, staked ETH, native BTC) have combined pct > 50%.

Rule C (hard fail): If any curated reserve slice names a known canonical asset
        (from CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL) at a risk tier that
        doesn't match the canonical mapping, fail the test.
```

**Note on tBTC:** tBTC uses threshold cryptography (decentralized custody), not a single custodian. It should be excluded from Rule A's centralized-custody list. This is a real distinction — the rules need an explicit centralized-custody asset set, not "all wrapped BTC."

**Impact if Rule A were active today:** crvUSD (69%), DEURO (~40%), ZCHF (30%), btcUSD (unknown — needs audit), Bitcoin USD (unknown — needs audit) would all fail. fxUSD would have failed before the fix. This is exactly the behavior we want.

**Implementation:** a new test file like `shared/lib/__tests__/classification-invariants.test.ts` that iterates `TRACKED_STABLECOINS` and checks each rule. The allowlist (for coins that knowingly violate a rule with documented justification) would be a simple `Set<string>` in the test file.

### Direction 4 — Staleness tracking (`reservesLastVerified`)

Add `reservesLastVerified?: string` (ISO date) to `StablecoinMeta`. Enforce freshness via test:

- Top-50 by TVL: warn at 90 days, error at 180 days.
- All others: warn at 180 days.
- Coins with live reserves: the live sync freshness is separate (already tracked). This field tracks when a **human last verified the curated classification and risk tiers match reality**, not when data was last fetched.

**Important distinction:** staleness tracking answers "has a human looked at this recently?" — it complements but doesn't replace automated drift detection. A human might verify that a coin is still correctly classified even when the composition hasn't changed.

### Direction 5 — Extend live reserve coverage

128 coins lack live sync. But not all are equally risky for drift:

- **Stable-structure coins** (RWA-backed, single custodian, fixed collateral): USDC, USDT, PYUSD, etc. Their composition rarely shifts. Low priority for live sync. Staleness tracking (Direction 4) is sufficient.
- **Dynamic-structure coins** (CDPs, delta-neutral, multi-vault, DeFi protocols): composition can shift dramatically in weeks. These are the highest-value targets for new adapters.
- **Opaque coins** (no public API, no proof-of-reserve dashboard): can't build adapters. Manual research with staleness tracking is the only option.

Priority ordering for new adapters should be: high TVL × dynamic structure × available data source.

### Direction 6 — Canonical risk tier enforcement (NEW — prerequisite for Direction 1)

Before feeding live data into scoring, ensure risk tier assignments are consistent across the system.

**What exists today:**
- `CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL` in `shared/lib/reserve-asset-risk.ts` covers 23 assets.
- Only 3 of 15 adapters reference it. The rest hardcode their own mappings.
- Curated reserves don't validate against it at all (except ETH/WETH).

**Proposed enforcement:**
1. **Expand the canonical mapping** to cover all commonly-appearing reserve assets.
2. **Test: adapter consistency** — for each adapter that has a local risk mapping, assert every entry matches the canonical mapping. Adapters can add new assets not in canonical (with a "medium" default), but they can't contradict it.
3. **Test: curated consistency** — for each curated reserve slice whose name matches a canonical asset, assert the risk tier matches. (Rule C from Direction 3.)
4. **Adapters should import `getCanonicalReserveAssetRisk`** instead of maintaining local copies.

**Build cost:** low. Mostly test additions + adapter refactors to use the canonical mapping.

---

## Prioritized recommendations

### Tier 0 — Batch fix right now (manual work, no code changes)

Update curated reserves for the 9 coins with significant scoring impact identified in the drift audit. This is the `reserve-research` skill applied repeatedly. Priority order:
1. Noon USN (completely wrong reserves)
2. Neutrl NUSD (inverted risk profile)
3. DEURO (WFPS dependency absent)
4. Falcon USDf (BTC concentration doubled)
5. Frankencoin ZCHF (BOSS token absent)
6. Felix feUSD (verify adapter vs curated)
7. OpenDollar USDO (risk tier mismatch + asset replacement)
8. Aegis YUSD (ontological mismatch)
9. Mu AZND (cash component missing)

Also: add curated reserves for wsrusd-reservoir (currently null).

Classification re-review needed for: crvUSD, DEURO, ZCHF, btcUSD, Bitcoin USD. The crvUSD decision in particular deserves a standalone research note given its downstream impact.

### Tier 1 — Prevent recurrence (low build cost, high ROI)

1. **Direction 6: Canonical risk tier enforcement.** Required foundation for everything else. Expand the canonical mapping, add tests for adapter + curated consistency. Prevents risk tier conflicts from producing confusing score artifacts.

2. **Direction 3: Classification invariant tests.** A new test file with Rules A, B, C. Prevents future fxUSD-style misclassifications from being committed. Rule C (curated risk tiers must match canonical mapping) overlaps with Direction 6 and can share infrastructure.

### Tier 2 — Automated score accuracy (medium build cost)

3. **Direction 1: Live reserves → collateral score passthrough.** The infrastructure is 90% there. The main new code is in `buildReportCardsSnapshot()`: query `reserve_composition`, and for each live-enabled coin with fresh data, pass live slices to `computeCollateralQualityFromReserves()` instead of curated slices. Add the safety rails (freshness, minimum slices, delta alerting). Dependency inference stays on curated data.

4. **Direction 2a: Drift alerting on /status.** Once Direction 1 is live, drift detection becomes naturally visible (the delta between live-derived score and curated-derived score). Surface it on /status as a data-quality signal. When drift exceeds a threshold, it means the curated data (and potentially the classification) needs human review.

### Tier 3 — Systemic hygiene (low build cost, long-tail value)

5. **Direction 4: Staleness tracking.** Add `reservesLastVerified` to `StablecoinMeta`. CI warns when stale. Covers the 128 coins without live sync.

### Deprioritized

6. **Direction 5: Extend live coverage.** Valuable but high-effort and not blocked by or blocking any of the above. Drive by TVL priority in normal curation workflow.

---

## Design constraints for Direction 1 (the most architecturally consequential change)

If we proceed, these are the key constraints to resolve:

### Scoring scope: collateral quality only

Live slices feed **only** `computeCollateralQualityFromReserves()`. All other uses of `meta.reserves` remain on curated data:
- `deriveDependencies()` → curated (needs `coinId`)
- Blacklist "possible-inherited" check → curated (needs `coinId` to look up upstream `canBeBlacklisted`)
- Detail page reserve card → already uses live data via its own pipeline

### Data flow

```
buildReportCardsSnapshot()
  ├── query D1: reserve_composition (live slices, 28 coins)
  ├── for each coin:
  │     if live snapshot fresh + ≥ 2 slices:
  │       collateralScore = computeCollateralQualityFromReserves(liveSlices)
  │     else:
  │       collateralScore = computeCollateralQualityFromReserves(meta.reserves)
  │                         or COLLATERAL_QUALITY_SCORE[meta.collateralQuality]
  │
  │     dependencies = deriveDependencies(meta)  // always curated
  │     blacklistInherited = checkInherited(meta) // always curated
  └── assemble ReportCard[]
```

### What the API response should expose

The `rawInputs` on each `ReportCard` should indicate whether the collateral score used live or curated data (a new boolean `collateralFromLive?: boolean`). This lets the frontend show a subtle indicator and helps debugging.

### Score stability

When a coin first gets live sync, its collateral score might jump (up or down) depending on how stale the curated data was. This is correct behavior but could confuse users who see a sudden grade change. Mitigations:
- The safety-grade-history timeline already records daily snapshots. The change will appear as a single-day step.
- A tooltip or footnote on the detail page could note "Collateral quality now scored from live reserve data."
- The /status drift alert (Direction 2a) provides operator visibility into expected score transitions before they happen.

---

## Open questions

1. **crvUSD reclassification:** at 69% WBTC/cbBTC, this is the clearest remaining classification mismatch. But crvUSD is upstream of several other coins. What's the downstream impact of reclassifying it? Needs its own analysis.

2. **tBTC distinction:** tBTC (threshold custody) vs WBTC/cbBTC (centralized custody) — should the classification rules treat these differently? Current analysis says yes, but the risk tier for both is "medium" in the canonical mapping. The risk tier captures market/price risk; the classification rule captures custody/centralization risk. These are orthogonal dimensions.

3. **Adapter ontology divergence:** the YUSD case (organized by custodian vs position type) shows that some live/curated drift is structural, not compositional. Should the drift detection use score-only comparison (ignores ontological differences) or also flag structural mismatches (catches missing assets like BOSS in Frankencoin)?

4. **Direction 1 rollout:** all-at-once or gradual? All-at-once means up to 16 coins' scores change simultaneously on deploy. Gradual (coin-by-coin opt-in via a flag) is more conservative but adds complexity.

5. **Adapter risk tier migration path:** when Direction 6 ships and adapters are required to use canonical risk tiers, some live scores may change slightly. Should this be coordinated with Direction 1 rollout so the transition is clean?
