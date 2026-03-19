# Share Image Improvement Implementation Plan

**Date:** 2026-03-19  
**Scope:** Improve existing dynamic OG image endpoints ONLY  
**Exclusions:** NO new endpoints, NO new ShareButtons, NO static→dynamic migrations

---

## Overview

This plan focuses exclusively on enhancing the 4 existing dynamic OG image endpoints:

1. `/api/og/stablecoin/:id` → `stablecoin-card.tsx`
2. `/api/og/safety-scores` → `safety-scores-card.tsx`
3. `/api/og/depeg` → `depeg-card.tsx`
4. `/api/og/stability-index` → `stability-index-card.tsx`

Plus the shared base template: `shared.tsx`

---

## Phase 1: Foundation - Logo Integration

### Task 1.1: Add Full Logo Support to Base Template
**File:** `worker/src/lib/og-templates/shared.tsx`

**Changes:**
- Import and render `pharos-logo-full.png` as base64 data URI
- Position: Top-left, replacing text "PHAROS"
- Maintain "pharos.watch" URL on right side
- Adjust spacing to accommodate logo height (~40px)

**Implementation Details:**
```typescript
// Add to CardFrame component
// Logo will be embedded as base64 to work with Satori
// Height: 40px, maintain aspect ratio
// Position: 48px from top, 56px from left
// Text subtitle shifts right of logo
```

**Testing:**
- Verify logo renders correctly in Satori
- Check text alignment with logo
- Ensure no layout breaks with long titles

---

## Phase 2: Stablecoin Card Enhancements

### Task 2.1: Add Additional Data Points
**File:** `worker/src/api/og.tsx` (data fetch) + `worker/src/lib/og-templates/stablecoin-card.tsx` (display)

**New Data to Fetch:**
- `pegScore` - 30-day peg stability score (0-100)
- `backing` - Collateral type (fiat/crypto/rwa/algorithmic)
- `governance` - Centralized/decentralized/CeFi-dependent
- `redemptionScore` - Redemption backstop score (0-100)
- `prevDayPrice` - For 24h change calculation

**SQL Queries to Add:**
```sql
-- Peg score from peg_summary
SELECT peg_score FROM peg_summary WHERE stablecoin_id = ? LIMIT 1

-- Backing/governance from stablecoin metadata (already have via meta)
-- Just need to pass through

-- Redemption backstop score from report_cards
SELECT redemption_backstop_score FROM report_card_scores WHERE stablecoin_id = ? LIMIT 1

-- 24h price change from supply_history
SELECT price FROM supply_history WHERE stablecoin_id = ? ORDER BY snapshot_date DESC LIMIT 2
```

**Template Layout Changes:**

Current layout (5 metrics in one row):
```
GRADE | PEG | DEWS | LIQUIDITY | PSI
```

New layout (2 rows):
```
Row 1: GRADE | PEG | DEWS | LIQUIDITY | PSI | PEG SCORE
Row 2: MARKET CAP | 24H CHANGE | 7D FLOW | BACKING | GOVERNANCE | REDEMPTION
```

**Visual Polish:**
- Color-code 24h change (green/red)
- Color-code 7d flow (green/red)
- Add subtle icons or labels for backing/governance types
- Ensure grade color matches report card coloring

---

### Task 2.2: Add Coin Logo (If Feasible)
**Research Task:**

Satori supports `<img>` with data URIs. Options:
1. **Pre-generate base64 logos** - Build script to convert coin logos to base64, store in KV
2. **Fetch on-demand** - Query DefiLlama/CDN for logo, convert to base64
3. **Skip for now** - Text-only is cleaner, logos add complexity

**Recommendation:** Option 3 - Skip logos for now. The full Pharos logo in header provides branding, coin symbol text is clear.

---

## Phase 3: Safety Scores Card Enhancements

### Task 3.1: Add Top/Bottom Performers Section
**File:** `worker/src/api/og.tsx` + `worker/src/lib/og-templates/safety-scores-card.tsx`

**New Data to Fetch:**
- Top 3 coins by safety score (grade A+, A, A-)
- Bottom 3 coins by safety score (grade D, F, or lowest scores)
- Week-over-week grade changes (improved/declined)

**SQL Query Addition:**
```sql
-- Top performers (need report_card_scores table query)
SELECT stablecoin_id, grade, score FROM report_card_scores 
WHERE score > 0 ORDER BY score DESC LIMIT 3

-- Bottom performers
SELECT stablecoin_id, grade, score FROM report_card_scores 
WHERE score > 0 ORDER BY score ASC LIMIT 3
```

**Template Layout:**

Current:
```
[Grade Distribution: A+ F count count ...]
[Market Pulse: A+       Coverage: 85%]
[      87.5/100          158 coins   ]
```

New:
```
[Grade Distribution - Horizontal Bar Chart]
[A+ A A- B+ B B- C+ C C- D F] with bars

[Market Pulse: A+    Coverage: 85%]

Top 3 Safest        Bottom 3 Riskiest
• USDC (A+)         • USDT-Fake (F)
• USDT (A)          • BadCoin (D)
• DAI (A-)          • RiskCoin (D)
```

**Visual Polish:**
- Grade distribution as horizontal bars (SVG in Satori)
- Color-code top performers (green tones)
- Color-code bottom performers (red tones)
- Add coin symbols (not full names, save space)

---

### Task 3.2: Add Trend Indicator
**File:** `worker/src/lib/og-templates/safety-scores-card.tsx`

**Data:** Week-over-week change in average safety score

**Visual:**
- Small up/down arrow next to Market Pulse
- Trend percentage: "↑ 2.3% vs last week"
- Color: Green for improvement, red for decline

---

## Phase 4: Depeg Card Enhancements

### Task 4.1: Add Currently Depegged Coins List
**File:** `worker/src/api/og.tsx` + `worker/src/lib/og-templates/depeg-card.tsx`

**New Data to Fetch:**
- Active depeg events with coin names and deviation magnitude
- Severity ranking (worst depegs first)

**SQL Query Modification:**
```sql
-- Current query only counts
-- New query gets details
SELECT 
  d.stablecoin_id,
  s.name,
  s.symbol,
  d.deviation_bps,
  d.started_at
FROM depeg_events d
JOIN stablecoins s ON d.stablecoin_id = s.id
WHERE d.ended_at IS NULL
ORDER BY ABS(d.deviation_bps) DESC
LIMIT 5
```

**Template Layout:**

Current:
```
[Active Depegs: 3]  [PSI: 45.2 FRACTURE]
[DEWS Distribution pie/bar]  [Coins at Peg: 155]
```

New:
```
[Active Depegs: 3]          [PSI: 45.2 FRACTURE]

Currently Depegged (Top 5):
• XYZ (-245 bps)    • ABC (-89 bps)
• DEF (-156 bps)    • GHI (-45 bps)
• JKL (-112 bps)

[DEWS Distribution]         [Coins at Peg: 155]
```

**Visual Polish:**
- Depeg list sorted by severity (worst first)
- Color-code severity: >200 bps = red, 100-200 = orange, <100 = yellow
- Add "bps" unit for clarity

---

### Task 4.2: Add Recovery Statistics
**File:** `worker/src/lib/og-templates/depeg-card.tsx`

**New Data:**
- Depegs recovered in last 24h
- Depegs started in last 24h

**Visual:**
- Small stats row: "Recovered today: 2 | New today: 1"
- Helps show if situation improving or worsening

---

## Phase 5: Stability Index Card Enhancements

### Task 5.1: Add Market Context Section
**File:** `worker/src/api/og.tsx` + `worker/src/lib/og-templates/stability-index-card.tsx`

**New Data to Fetch:**
- 7-day average PSI (broader trend)
- All-time high/low PSI (historical context)
- Flight to Quality status (from stability index samples)

**SQL Query Additions:**
```sql
-- 7-day average
SELECT AVG(score) FROM stability_index_samples WHERE stored_at > ?

-- All-time high/low
SELECT MAX(score), MIN(score) FROM stability_index_samples

-- Flight to quality (from latest sample)
SELECT flight_to_quality, flight_intensity FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1
```

**Template Layout:**

Current:
```
[PSI: 78.5 STEADY]  [Δ24h: +2.3]
[Sparkline: 14-day trend]
[Bands: BEDROCK STEADY TREMOR... with highlight]
```

New:
```
[PSI: 78.5 STEADY]  [Δ24h: +2.3]  [7D Avg: 76.2]

[Large Sparkline: 14-day trend]

Context:
• All-time high: 94.2 (Jan 15)
• All-time low: 34.8 (Mar 3)
• Flight to Quality: Active (↑ intensity)

[Bands visualization]
```

**Visual Polish:**
- Larger sparkline (main visual element)
- Band visualization as horizontal bar with current position marker
- Flight to Quality indicator with arrow direction

---

### Task 5.2: Enhanced Band Visualization
**File:** `worker/src/lib/og-templates/stability-index-card.tsx`

**Current:** Simple text list with bold current band

**New:** Thermometer-style visualization
- Horizontal bar segmented by bands
- Current PSI position marked with indicator
- Color gradient: Blue (Bedrock) → Green → Yellow → Orange → Red (Meltdown)

---

## Phase 6: Shared Visual Polish

### Task 6.1: Consistent Color System
**File:** `worker/src/lib/og-templates/shared.tsx`

**Define and Export:**
```typescript
// Semantic colors for data visualization
export const SEMANTIC_COLORS = {
  positive: '#22c55e',   // Green for good/up
  negative: '#ef4444',   // Red for bad/down
  warning: '#f59e0b',    // Orange for caution
  neutral: '#94a3b8',    // Gray for neutral
  highlight: '#5ba3d9',  // Frost blue for highlights
};

// Grade colors (consistent with report cards)
export const GRADE_COLORS = {
  'A+': '#22c55e', 'A': '#22c55e', 'A-': '#4ade80',
  'B+': '#5ba3d9', 'B': '#5ba3d9', 'B-': '#7dd3fc',
  'C+': '#f59e0b', 'C': '#f59e0b', 'C-': '#fbbf24',
  'D': '#f97316', 'F': '#ef4444', 'NR': '#94a3b8',
};
```

---

### Task 6.2: Typography Consistency
**File:** `worker/src/lib/og-templates/shared.tsx`

**Standards:**
- Headers: Geist Sans, 32px, weight 700
- Labels: Geist Sans, 14px, weight 400, uppercase, letter-spacing 0.06em
- Values: Geist Mono, 36-44px, weight 700
- Secondary: Geist Sans, 16-18px, weight 400

**Ensure:**
- All templates use consistent font sizes
- Proper fallbacks for Satori font loading
- Sufficient contrast ratios

---

### Task 6.3: Add "Last Updated" Timestamp
**File:** `worker/src/lib/og-templates/shared.tsx`

**Change:**
- Add small timestamp in footer: "Updated: 2026-03-19 14:32 UTC"
- Font: 12px, muted color
- Shows data freshness for users

---

## Implementation Order

### Sprint 1: Foundation (Days 1-2)
1. Task 1.1: Logo integration in shared template
2. Task 6.1: Color system standardization
3. Task 6.2: Typography audit/fixes

### Sprint 2: Stablecoin Card (Days 3-4)
4. Task 2.1: Additional data points (24h change, backing, governance, etc.)
5. Test with various coin types (USD, EUR, Gold, NAV tokens)

### Sprint 3: Safety Scores & Depeg (Days 5-6)
6. Task 3.1: Top/bottom performers
7. Task 3.2: Trend indicator
8. Task 4.1: Depegged coins list
9. Task 4.2: Recovery stats

### Sprint 4: Stability Index (Days 7-8)
10. Task 5.1: Market context section
11. Task 5.2: Enhanced band visualization
12. Task 6.3: Last updated timestamp

### Sprint 5: Testing & Polish (Days 9-10)
13. Visual regression testing for all 4 endpoints
14. Performance testing (render time <100ms)
15. Edge case handling (missing data, empty states)

---

## Files Modified

### Worker
1. `worker/src/lib/og-templates/shared.tsx` - Logo, colors, typography, timestamp
2. `worker/src/lib/og-templates/stablecoin-card.tsx` - New layout, more metrics
3. `worker/src/lib/og-templates/safety-scores-card.tsx` - Performers list, bars
4. `worker/src/lib/og-templates/depeg-card.tsx` - Depeg list, recovery stats
5. `worker/src/lib/og-templates/stability-index-card.tsx` - Context, thermometer
6. `worker/src/api/og.tsx` - Additional SQL queries, data mapping

### Frontend (Metadata Only)
7. `src/lib/page-metadata.ts` - Verify OG image URLs still correct (no changes expected)

---

## Testing Checklist

### Visual Testing
- [ ] Logo renders correctly on all 4 card types
- [ ] No layout breaks with long coin names
- [ ] Color coding works for positive/negative values
- [ ] Grade colors match report card colors
- [ ] Text is readable at 1200x628 resolution

### Data Testing
- [ ] All SQL queries return data within 50ms
- [ ] Graceful handling when data is null/missing
- [ ] Correct calculations for 24h/7d changes
- [ ] Top/bottom performers correctly sorted

### Performance Testing
- [ ] Each endpoint renders in <100ms
- [ ] WASM initialization still cached properly
- [ ] Memory usage stable under load

### Edge Cases
- [ ] Coin with no peg score (NR)
- [ ] Coin with active depeg (warning styling)
- [ ] Safety scores with no rated coins
- [ ] Depeg page with 0 active depegs
- [ ] Stability index at extreme values (0 or 100)

---

## Success Metrics

| Metric | Before | Target After |
|--------|--------|--------------|
| Data points on stablecoin card | 9 | 14+ |
| Safety scores card insights | 12 grades | 12 grades + top/bottom + trend |
| Depeg card lists coins | No | Yes (top 5) |
| Stability index context | PSI only | PSI + 7D avg + ATH/ATL + FTQ |
| Visual polish (grade coloring) | Basic | Consistent semantic colors |
| Brand consistency | Text logo | Full Pharos logo |
| Data freshness indicator | No | Yes (timestamp) |

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Satori logo rendering issues | High | Test early with base64 embedding |
| SQL query performance | Medium | Add indexes if needed, cache aggressively |
| Layout breaks with new data | Medium | Test with extreme data values |
| Card becomes too crowded | Medium | Prioritize key metrics, use tooltips/sparklines |
| Increased render time | Low | Profile queries, optimize templates |

---

## Notes

- **No breaking changes** to existing API responses
- **Cache headers remain** 15-min TTL
- **Backward compatible** - same OG paths, enhanced content only
- **Font files** remain embedded (no external font loading)
- **Base64 logo** should be ~5-10KB, acceptable for edge caching
