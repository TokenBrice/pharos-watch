# Pharos Sharing Feature: Comprehensive Review & Improvement Analysis

**Date:** 2026-03-19  
**Scope:** Complete audit of all sharing functionality across frontend and Worker  
**Status:** Research Complete

---

## Executive Summary

The Pharos sharing feature consists of three distinct mechanisms:

1. **Dynamic OG Images** (Worker-generated, 4 endpoints) - Satori-based SVG→PNG rendering
2. **Static OG Images** (11 pages using pre-generated PNGs)
3. **Client-Side Sharing** (ShareButton component + Compare canvas renderer)

Current coverage is **partial** - only 4 pages have dynamic OG images, while the majority rely on static images that don't reflect real-time data. Client-side sharing is limited to specific pages.

---

## Current Implementation Inventory

### 1. Dynamic OG Image Endpoints (Worker)

| Endpoint | Template | Data Points | Share Button |
|----------|----------|-------------|--------------|
| `/api/og/stablecoin/:id` | `StablecoinCard` | Grade, Price, DEWS, Liquidity, PSI, Market Cap, 7D Flow, Sparkline | ✅ Yes (hero-card) |
| `/api/og/safety-scores` | `SafetyScoresCard` | Grade Distribution (A+-F), Market Pulse, Coverage % | ✅ Yes |
| `/api/og/depeg` | `DepegCard` | Active Depegs, PSI, DEWS Distribution, Coins at Peg | ✅ Yes |
| `/api/og/stability-index` | `StabilityIndexCard` | PSI Score, Band, 24h Delta, Sparkline, All Bands | ❌ No |

### 2. Pages with Static OG Images

| Page | Current OG Image | Status |
|------|------------------|--------|
| `/` (Homepage) | `/og-card.png` | Static |
| `/liquidity` | `/og-liquidity.png` | Static |
| `/yield` | `/og-yield.png` | Static |
| `/chains` | `/og-chains.png` | Static |
| `/coverage` | `/og-coverage.png` | Static |
| `/compare` | `/og-compare.png` | Static |
| `/portfolio` | `/og-portfolio.png` | Static |
| `/digest` | `/og-digest.png` | Static |
| `/cemetery` | `/og-cemetery.png` | Static |
| `/dependency-map` | `/og-dependency-map.png` | Static |
| `/telegram` | `/og-telegram.png` | Static |
| `/start` | `/og-start.png` | Static |

### 3. Client-Side Sharing Components

| Component | Location | Features |
|-----------|----------|----------|
| `ShareButton` | `src/components/share-button.tsx` | Copy link, Copy image, Download PNG |
| `useCompareShareActions` | `src/hooks/useCompareShareActions.ts` | Twitter share, Web Share API, Canvas download |
| `downloadChartPng` | `src/lib/chart-export.ts` | Simple chart PNG export |

---

## Detailed Gap Analysis

### A. Missing Dynamic OG Images (High Priority)

#### 1. Liquidity Page (`/liquidity`)
**Current State:** Static `og-liquidity.png`
**Suggested Data Points:**
- Top 5 coins by liquidity score
- Average liquidity score across market
- Total DEX liquidity (USD)
- Best/worst liquidity performers
- Pool diversity metric

**Implementation:** New `/api/og/liquidity` endpoint

#### 2. Yield Page (`/yield`)
**Current State:** Static `og-yield.png`
**Suggested Data Points:**
- Top yield opportunities (3-5 listings)
- Best APY currently available
n- Yield provider diversity count
- Risk-adjusted yield leaders

**Implementation:** New `/api/og/yield` endpoint

#### 3. Chains Page (`/chains`)
**Current State:** Static `og-chains.png`
**Suggested Data Points:**
- Top 5 chains by stablecoin TVL
- Total chains tracked
- Healthiest chain (highest score)
- Chain with most diverse stablecoins

**Implementation:** New `/api/og/chains` endpoint

#### 4. Coverage Matrix (`/coverage`)
**Current State:** Static `og-coverage.png`
**Suggested Data Points:**
- Total coins tracked
- Coverage percentage (coins with complete data)
- Breakdown by data type (prices, reserves, liquidity)
- Recently added coins count

**Implementation:** New `/api/og/coverage` endpoint

### B. Existing OG Images - Data Enhancement Opportunities

#### Stablecoin Card Improvements
**Currently Shows:**
- Grade, Price, DEWS, Liquidity Score, PSI, Market Cap, 7D Flow

**Missing Data Points:**
1. **24h Change** - Critical for traders (currently has 7d flow but not 24h)
2. **Backing Type** - Fiat/Crypto/RWA/Algorithmic
3. **Governance Type** - Centralized/Decentralized/CeFi-Dependent
4. **Peg Currency** - USD/EUR/Gold (shown but could be more prominent)
5. **Peg Score** - Distinct from overall grade
6. **Reserves Audited** - Yes/No indicator
7. **Redemption Backstop Score** - Key safety metric
8. **Dependency Risk** - Varies/Critical/etc.

**Visual Improvements:**
- Add coin logo (currently text-only)
- Color-code metrics (green/red for changes)
- Add "Last Updated" timestamp

#### Safety Scores Card Improvements
**Currently Shows:**
- Grade distribution (all grades A+ to F)
- Market Pulse grade + score
- Coverage ratio

**Missing Data Points:**
1. **Top 3 Best Grades** - Which coins are safest
2. **Bottom 3 Worst Grades** - Risk warning
3. **Grade Trend** - Week-over-week change
4. **Newly Rated Coins** - Fresh coverage
5. **Most Improved** - Biggest positive movers

**Visual Improvements:**
- Bar chart instead of raw numbers for distribution
- Sparkline for market pulse over time
- Highlight "A" grades visually

#### Depeg Card Improvements
**Currently Shows:**
- Active depeg count
- PSI score/band
- DEWS distribution
- Coins at peg

**Missing Data Points:**
1. **Active Depeg Names** - Which coins are depegged now
2. **Largest Depeg Magnitude** - Worst offender bps
3. **Recent Depegs** (24h) - New events
4. **Recovery Rate** - How many recovered this week
5. **Historical Context** - Comparison to last week

**Visual Improvements:**
- List depegged coins by severity
- Red/yellow/green gradient for DEWS distribution

#### Stability Index Card Improvements
**Currently Shows:**
- PSI score, band, 24h delta
- Sparkline (14-day)
- All bands with current highlighted

**Missing Data Points:**
1. **7D Average** - Broader trend context
2. **All-Time High/Low** - Historical context
3. **Market Stress Contributors** - Which factors driving PSI
4. **Flight to Quality Indicator** - Risk-off behavior

**Visual Improvements:**
- Add the Pharos full logo (currently text-only "PHAROS")
- Better band visualization (thermometer-style)

### C. Client-Side Sharing Gaps

#### Pages Missing Share Buttons
| Page | Has ShareButton? | Priority |
|------|------------------|----------|
| `/stability-index` | ❌ No | High |
| `/liquidity` | ❌ No | High |
| `/yield` | ❌ No | High |
| `/chains` | ❌ No | Medium |
| `/coverage` | ❌ No | Low |
| `/compare` | ❌ No (has canvas export) | Medium |
| `/digest` | ❌ No | Low |
| `/cemetery` | ❌ No | Low |
| `/portfolio` | ❌ No | Medium |
| `/dependency-map` | ❌ No | Low |

#### Compare Page Canvas Sharing
**Current:** `compare-share-image.ts` generates canvas-based cards
**Issues:**
1. Uses `/pharos-icon.png` not `/pharos-logo-full.png` as requested
2. No QR code for mobile sharing
3. No direct Twitter card preview
4. Limited to 2-3 coins (no scrolling/long-form option)

---

## Visual Branding Inconsistencies

### Current Logo Usage

| Location | Logo Used | Issue |
|----------|-----------|-------|
| OG Cards (shared.tsx) | Text "PHAROS" | Should use full logo PNG |
| Compare Canvas | `/pharos-icon.png` (36x36) | Should use full logo |
| ShareButton | None | N/A (uses text) |

### Recommended Logo Integration

**Full Logo:** `public/pharos-logo-full.png`
- Use in all OG image headers
- Maintain aspect ratio (height: 40px)
- Position: Top-left, 40px from edges

**Icon Logo:** `/pharos-icon.png`
- Keep for favicon and small UI elements
- Not for share cards

---

## Technical Architecture Observations

### Strengths
1. **Satori-based rendering** - Fast, deterministic SVG→PNG
2. **15-min cache** - Good balance of freshness vs performance
3. **Modular templates** - Easy to add new card types
4. **Type-safe** - Full TypeScript coverage

### Improvement Areas

#### 1. Error Handling
Current: Returns 500 with plain text on errors
Recommended: Return fallback static image with error logging

#### 2. Font Loading
Current: Fonts embedded in WASM
Recommended: Verify all weights load correctly (Geist Sans/Mono)

#### 3. Image Optimization
Current: PNG output only
Recommended: Consider WebP for smaller sizes (30-50% savings)

#### 4. Cache Invalidation
Current: Time-based (15 min)
Recommended: Add manual invalidation endpoint for urgent updates

---

## Prioritized Improvement Roadmap

### Phase 1: Critical (Immediate Impact)

1. **Add ShareButton to Stability Index page**
   - File: `src/app/stability-index/page.tsx`
   - Add `ogImage` endpoint if not dynamic
   - Add `<ShareButton ogPath="/api/og/stability-index" />`

2. **Update OG Card Logo**
   - Modify `worker/src/lib/og-templates/shared.tsx`
   - Replace text "PHAROS" with `<img>` using `/pharos-logo-full.png`
   - Test rendering in Satori

3. **Enhance Stablecoin Card**
   - Add: 24h change, backing type, governance type
   - Add coin logo (if possible with Satori + data URIs)
   - Color-code positive/negative changes

### Phase 2: High Value (Data-Rich Sharing)

4. **Create `/api/og/liquidity` Endpoint**
   - New template: `LiquidityCard`
   - Data: Top 5 by liquidity, average score, total TVL
   - Add ShareButton to liquidity page

5. **Create `/api/og/yield` Endpoint**
   - New template: `YieldCard`
   - Data: Top 3-5 yields, best APY, provider count
   - Add ShareButton to yield page

6. **Create `/api/og/chains` Endpoint**
   - New template: `ChainsCard`
   - Data: Top 5 chains, total TVL, chain count
   - Add ShareButton to chains page

### Phase 3: Polish & Edge Cases

7. **Enhance Safety Scores Card**
   - Add top/bottom performers section
   - Add grade distribution bar chart
   - Add week-over-week trend

8. **Enhance Depeg Card**
   - List currently depegged coins (top 3)
   - Add magnitude indicator
   - Add recovery statistics

9. **Add ShareButton to All Major Pages**
   - Portfolio (medium priority)
   - Compare (integrate with existing canvas)
   - Coverage, Cemetery, Digest (lower priority)

### Phase 4: Advanced Features

10. **QR Code Generation**
    - Add QR code to share images for mobile-friendly access
    - Consider package: `qrcode` or similar

11. **Twitter Card Optimization**
    - Ensure all OG images meet Twitter Card specs (summary_large_image)
    - Test with Twitter Card Validator

12. **Embeddable Widgets**
    - Create `/api/embed/stablecoin/:id` for iframe embedding
    - Smaller, focused cards for external sites

---

## Implementation Notes

### Adding a New OG Endpoint (Reference)

Files to modify:
1. `worker/src/api/og.tsx` - Add handler function + route
2. `worker/src/lib/og-templates/{new-card}.tsx` - Create template
3. `worker/src/router.ts` - Already covered by `/api/og/*` pattern
4. Frontend page - Update `ogImage` URL + add ShareButton

### Logo Integration Challenge

Satori (the SVG renderer) has limited image support:
- Supports `<img>` with data URIs
- External URLs may not work in Worker environment
- **Solution:** Embed logo as base64 data URI in template

### Data Availability

All required data for Phase 1-3 is already available in:
- `loadStablecoinsCache()` - Coin data
- `loadDexLiquidityMap()` - Liquidity scores
- `loadReportCardCache()` - Safety grades
- D1 queries for PSI, DEWS, depegs

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Pages with dynamic OG | 4 | 8+ |
| Pages with ShareButton | 3 | 10+ |
| OG image freshness | 15 min | 15 min (maintain) |
| Average OG render time | <100ms | <100ms (maintain) |
| Share feature usage | Unknown | Add analytics |

---

## Related Files Reference

### Frontend
- `src/components/share-button.tsx` - Share UI component
- `src/hooks/use-compare-share-actions.ts` - Compare sharing logic
- `src/lib/chart-export.ts` - Simple PNG export
- `src/lib/compare-share-image.ts` - Canvas renderer for compare
- `src/lib/page-metadata.ts` - OG metadata builder

### Worker
- `worker/src/api/og.tsx` - Main OG endpoint handler
- `worker/src/lib/og-templates/shared.tsx` - Base card frame
- `worker/src/lib/og-templates/stablecoin-card.tsx`
- `worker/src/lib/og-templates/safety-scores-card.tsx`
- `worker/src/lib/og-templates/depeg-card.tsx`
- `worker/src/lib/og-templates/stability-index-card.tsx`

### Public Assets
- `public/pharos-logo-full.png` - Full logo (use this)
- `public/pharos-icon.png` - Icon only (current, replace)
- `public/og-*.png` - Static OG images (deprecate gradually)

---

## Conclusion

The sharing feature has a solid foundation with Satori-based rendering and the ShareButton component. The main opportunities are:

1. **Expand dynamic OG coverage** to liquidity, yield, chains, coverage pages
2. **Enhance existing cards** with more data points (24h changes, backing types, top performers)
3. **Add missing ShareButtons** to stability-index, liquidity, yield, chains pages
4. **Integrate full Pharos logo** into all OG images
5. **Add visual polish** - color coding, logos, better typography

The recommended approach is Phase 1 first (logo update + stability index share), then Phase 2 (new endpoints), followed by iterative enhancements.
