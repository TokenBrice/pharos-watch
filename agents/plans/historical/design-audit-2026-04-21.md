# Pharos Design Audit: Conveying Uniqueness Through Design

**Date:** 2026-04-21  
**Auditor:** Kimi Code CLI  
**Scope:** Full-site design language, information architecture, and visual storytelling  
**Baseline:** Verified against `docs/design-language.md` (March 24, 2026), production OG images, and component source.

---

## 1. Executive Summary

Pharos has one of the most sophisticated stablecoin risk-intelligence stacks in the market — dynamic safety grades computed from 4 weighted dimensions with transitive dependency scoring, a "VIX for stablecoins" (PSI), a forward-looking depeg early warning system (DEWS), and industry-leading blacklist coverage across 35+ stablecoins on 9 chains. The design system is mature, consistent, and principled.

**The gap:** The *visual presentation* often defaults to a dense dashboard paradigm when the *data* demands narrative storytelling. A first-time visitor landing on the homepage sees a professional table and charts — but nothing that immediately screams "you can't get this anywhere else." The uniqueness is buried in methodology docs and `?` tooltips rather than being surface-level obvious.

**Verdict:** Pharos looks unmistakably *competent* and *trustworthy*. It does not yet look unmistakably *unique* at first glance.

---

## 2. What's Working (Protect These)

| Asset | Why It Works |
|-------|-------------|
| **DEWS Radar** | Visually distinctive, memorable, and immediately communicates "early warning." The animated sweep, threat-band rings, and pulsing dots are signature Pharos. |
| **Report Card Grade Glow** | The radial glow behind letter grades is a strong ownable visual. It elevates a simple badge into a theatrical moment. |
| **Cemetery Page** | The tombstone aesthetic is a deliberate, successful divergence. It proves Pharos can break its own rules for narrative effect. |
| **Digest Editorial Typography** | The Newsreader/Courier pairing creates genuine editorial authority. It feels like intelligence, not blogging. |
| **Monospace Numbers** | The Geist Mono number treatment signals precision and separates Pharos from generic SaaS dashboards. |
| **Semantic Color Discipline** | The OKLch token system and severity-based color usage keep the UI readable and state-driven without decorative noise. |
| **FeaturePageShell Consistency** | Methodology badges, version history links, and breadcrumb patterns create deep trust for power users. |

---

## 3. The Core Problem: Density Without Differentiation

Pharos commits to **data density over decoration** (Design Principle #1). This is correct for the audience. But density alone does not communicate uniqueness — it communicates thoroughness. Competitors can also build dense tables.

### Where uniqueness hides instead of shines:

1. **Homepage first impression:** The top fold is a masthead + metric pills + a table. The table is excellent, but it is interchangeable with DefiLlama, CoinGecko, or any tracker. The DEWS radar and PSI lighthouse — Pharos' two most distinctive visuals — live in the "Core Monitoring" band below the fold.

2. **Feature page leads:** Blacklist Tracker opens with "Issuer intervention, from freeze to wipe." Good copy, but it does not immediately convey *scale* or *unprecedented coverage*. The 35-coin, 9-chain, amount-provenance depth is invisible until you scroll to the table.

3. **Report cards on Safety Scores:** The grid of mini radars is beautiful, but the *methodological uniqueness* (transitive dependency ceilings, live reserve passthrough, redemption-backstop blending) is not visible in the card UI. A user sees "B+" and a radar — they do not see *why* Pharos' B+ is different from anyone else's B+.

4. **Stablecoin Detail pages:** The dependency callout is a blue-bordered text block. The contagion map — one of Pharos' most powerful unique tools — is not prominently surfaced in the hero or report card.

5. **About page:** The OG image reveals a very utilitarian layout. For a product whose core value is "honest classification" and "unprecedented coverage," the about page feels like a settings panel rather than a manifesto.

---

## 4. Recommendations: Ranked by Impact vs. Effort

### TIER 1: High Impact, Low Effort (Do These First)

#### 1.1 Add a "Pharos Difference" manifesto strip to the homepage
**Effort:** Low (reuses existing card + icon + data primitives)  
**Impact:** High (reframes every first visit)

Insert a single horizontal band directly below the masthead and above the market table. Use 3–4 lockups that communicate scope + uniqueness:

```
[ 197 Stablecoins Tracked  ]  [ 35-Coin Blacklist Coverage  ]  [ 4-Dimension Safety Model  ]  [ Live Reserve Feeds  ]
```

Each lockup should use an existing icon + mono number + short label. This is not decorative — it is a **framing device** that tells the user "this is not CoinGecko" before they see the first row of data.

*Implementation:* Reuse `pharos-card-shell`, existing Lucide icons (`ShieldAlert`, `Eye`, `Activity`, `Radio`), and existing data constants (`ACTIVE_STABLECOINS.length`, blacklist tracker coin count, etc.).

---

#### 1.2 Rewrite FeaturePageShell lead copy on signature pages to lead with uniqueness
**Effort:** Low (copy-only changes)  
**Impact:** High (changes narrative framing without changing code architecture)

Current blacklist lead:
> "Issuer intervention, from freeze to wipe. Circle, Tether, Paxos, and other centralized issuers can freeze..."

Proposed:
> **"The only public tracker covering 35 stablecoins across 9 chains."**  
> "Circle, Tether, Paxos, and other centralized issuers can freeze, unblock, pause, or destroy balances. We record every on-chain action with amount provenance — so you see not just *who* got frozen, but how confident we are in the *value* involved."

Apply the same treatment to Safety Scores (lead with "Letter grades computed from live reserve feeds, transitive dependency scoring, and redemption-backstop blending") and Yield (lead with "Risk-adjusted yield ranked against T-bill and €STR benchmarks").

---

#### 1.3 Add visual provenance/freshness indicators to Report Cards and Blacklist table
**Effort:** Low (new badge variants + tooltip content)  
**Impact:** Medium-High (directly surfaces data sophistication)

- On report card dimension rows: a small `Live · 2h` or `Curated` or `Stale` micro-badge next to reserve-dependent scores.
- On blacklist table amounts: subtle iconography or color-coding indicating `event-time`, `historical_balance`, `snapshot`, or `derived`.
- This turns invisible data quality into visible trust signals.

---

#### 1.4 Elevate the About page to a manifesto
**Effort:** Low-Medium (copy + layout shuffling, no new components)  
**Impact:** Medium-High (critical for sharing/linking)

The About page is often the second page a curious visitor opens. It currently reads like a feature list. Restructure it:

1. **Hero statement:** "Most trackers show price. Pharos shows risk." (or similar)
2. **The "Why" narrative:** 2–3 paragraphs on the problem (honest classification, issuer power, hidden dependencies)
3. **The "What" grid:** Keep the existing feature cards, but lead with the *problem each solves*.
4. **The "How" evidence:** The data source list is excellent — make it visually denser and more impressive (it is a genuine moat).

---

### TIER 2: High Impact, High Effort (Strategic Investments)

#### 2.1 Redesign the homepage top fold to lead with PSI + DEWS as a command center
**Effort:** High  
**Impact:** Very High (transforms first impression from "tracker" to "intelligence platform")

Current hierarchy: Masthead → Table → Core Monitoring (DEWS/PSI/Flow/Safety) → Research Surfaces.

Proposed hierarchy:
1. **Masthead** (keep)
2. **Command Center Band:** A two-column layout on desktop:
   - **Left:** The PSI lighthouse card (larger, more dramatic) + 24h/7d/30d deltas.
   - **Right:** The DEWS radar (larger, with an outer ring showing total elevated count).
   Both should feel like **instruments**, not charts.
3. **Market Safety Pulse:** The existing grade-distribution bar, but presented as a "market health" narrative ("A/B share: 62% · D/F pressure: 8%").
4. **Then** the stablecoin table.

This borrows from the existing `/stability-index/` and `/depeg/` page visual language and brings it to the homepage. The table remains accessible but is no longer the *first* thing you see.

---

#### 2.2 Build "How to Read This" guided introductions for Report Cards and DEWS
**Effort:** High  
**Impact:** High (bridges the power-user/complexity gap)

The `?` methodology hints are good for reference, but they do not *teach*. Create a dismissible, step-by-step overlay (similar to onboarding tours) that appears once per user:

- **Report Card tour:** "This grade is not just a rating — it is computed from 4 dimensions. Here's what each axis means. Notice how Dependency Risk caps your grade based on upstream exposure."
- **DEWS tour:** "Each dot is a stablecoin. Distance from center = stress. Size = market cap. The sweep shows we update every 15 minutes."

This turns dense methodology into accessible narrative.

---

#### 2.3 Design a "Coverage Universe" visualization
**Effort:** High  
**Impact:** High (powerful trust signal + shareable asset)

Pharos tracks 197 coins across 100+ chains with 50+ data sources. This is a genuine moat that is currently invisible. Build a visualization — perhaps a network graph or a treemap — showing:
- Coins by peg currency
- Coins by backing type
- Data source overlay (which coins have live reserves, which have blacklist coverage, etc.)

This could live on `/coverage/` or as a homepage module. It answers the question: "Why should I trust Pharos over anyone else?"

---

#### 2.4 Add a "Dependency Risk" visual pathway on stablecoin detail pages
**Effort:** High  
**Impact:** High (surfaces the most unique analytical feature)

The contagion map and dependency callouts exist but feel separate. Create a visual thread:
1. In the **Hero Signals Rail**, add a fifth pill: "Dependencies".
2. In the **Report Card**, visualize the dependency ceiling: a small bar or arrow showing "Score without dependency cap: 78 · With cap: 62".
3. In the **Dependency section**, replace the text list with a mini Sankey or tree diagram showing upstream flow.
4. Surface the **Contagion Simulator** as a CTA from this section, not just as a separate page.

---

### TIER 3: Medium Impact, Low Effort (Polish & Personality)

#### 3.1 Give the Blacklist Tracker a subtle "forensic" aesthetic
**Effort:** Low  
**Impact:** Medium (adds personality and fits the data)

The Cemetery page gets a bespoke memorial aesthetic. The Blacklist Tracker — which deals with issuer power, freezes, and seizures — deserves a similarly intentional treatment. Consider:
- A very subtle document/paper texture or scanline effect on the table background (keep it dark, but add "file" personality).
- Event-type icons that feel more like evidence tags than generic badges.
- A "Case File" treatment for the USDS and EURC special-case cards.

*Constraint:* Do not break the design token system. Use CSS variables and component tokens.

---

#### 3.2 Add "insight sparklines" or inline annotations to the stablecoin table
**Effort:** Low-Medium  
**Impact:** Medium (makes the table feel alive with Pharos-native intelligence)

In the main table, add small inline visual cues when Pharos has unique intelligence on a coin:
- A tiny red dot or `!` when a coin has a recent blacklist event.
- A brief amber flash when DEWS is elevated.
- A small dependency chain icon when a coin has upstream exposure.

These should be subtle — not noisy — but they transform the table from a market-data mirror into a Pharos-curated intelligence feed.

---

#### 3.3 Upgrade the default OG image
**Effort:** Low  
**Impact:** Medium (improves shareability and brand perception)

The current `og-image.png` is just the Pharos logo on a dark background. Replace it with a composite that includes:
- The PSI score + band
- A mini DEWS radar
- A sample grade badge (A+ or B+)
- The tagline

This ensures that when someone shares Pharos on social media, the preview communicates the *product*, not just the *brand*.

---

#### 3.4 Unify the "special surface" energy for Yield and Liquidity pages
**Effort:** Low-Medium  
**Impact:** Medium

The Yield page already has a strong scatter-plot personality. Lean into it:
- Add benchmark reference lines that feel like "trading desk" overlays.
- Use the terminal/data-tape aesthetic for the leaderboard (Courier mono for APY numbers, similar to the Digest body copy).

For Liquidity: treat DEX venue names like exchange tickers — mono, compact, scannable.

---

### TIER 4: Lower Priority / Avoid

| Recommendation | Reason |
|----------------|--------|
| Complete visual redesign | Unnecessary. The foundation is strong. |
| Add decorative animations (particle effects, floating orbs) | Violates Design Principle #1 (density over decoration) and Anti-Reference #1 (no Web3 marketing fluff). |
| Change the color palette | The OKLch system and frost-blue accent are working. |
| Add glassmorphism, blur-heavy cards, or gradient backgrounds | Explicitly forbidden by Anti-References. |
| Replace tables with card grids for density | Tables are correct for this audience. |

---

## 5. Page-Level Notes

| Page | Current State | Opportunity |
|------|--------------|-------------|
| **Homepage** | Table-first, dense, functional. | Lead with PSI + DEWS as instruments; add manifesto strip; push table to "Explore" position. |
| **Safety Scores** | Beautiful radar grid, strong grade glow. | Surface dependency-ceiling logic visually; add "How to read" tour; lead copy should emphasize live reserves + transitive scoring. |
| **Blacklist** | Clean stats + chart + table. | Add forensic aesthetic; surface amount-provenance quality; lead with coverage scale (35 coins / 9 chains). |
| **Stablecoin Detail** | Comprehensive, well-sectioned. | Elevate dependency risk in hero; add reserve-freshness badges; surface contagion simulator CTA. |
| **About** | Functional feature list. | Manifesto treatment: lead with problem, then evidence (data sources), then features. |
| **Coverage** | Likely table-heavy (not audited in detail). | Prime candidate for the "Coverage Universe" visualization. |
| **Cemetery** | Excellent, distinctive, authored. | **Protect exactly as-is.** This is the proof that Pharos can break pattern for narrative effect. |
| **Digest** | Strong editorial aesthetic. | Protect. Consider extending the "intelligence briefing" visual language to other narrative surfaces (e.g., methodology changelogs). |

---

## 6. Success Metrics

After implementing Tier 1 + one Tier 2 item, a visitor should be able to answer within 10 seconds:

1. **What is this?** → A stablecoin risk-intelligence platform, not just a price tracker.
2. **Why is it different?** → It has safety grades, a stability index, a freeze tracker, and live reserve data that no one else combines.
3. **Can I trust it?** → Yes — the methodology is versioned, the sources are listed, and the data freshness is visible.

---

*End of audit.*
