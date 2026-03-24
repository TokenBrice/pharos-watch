# Pharos Design Polish Implementation Plan

**Status**: Draft  
**Author**: Kimi Code  
**Date**: 2026-03-18  
**Estimated Duration**: 5-6 days  
**Risk Level**: Low (polish only, no structural changes)

---

## Overview

This plan details the implementation of design polish across four phases. Each phase builds on the previous, with clear acceptance criteria and minimal cross-dependencies.

**Core Principles Throughout**:
- Maintain semantic color usage (color = state, never decoration)
- Preserve data density (don't sacrifice information for aesthetics)
- Use existing token system (no hardcoded values)
- Respect `prefers-reduced-motion`

---

## Phase 1: High-Impact Visual Hierarchy

**Duration**: 2 days  
**Goal**: Improve scannability and risk signal visibility

### 1.1 Table Row Risk Indicators

**Files**:
- `src/components/stablecoin-table.tsx`
- `src/app/globals.css` (add utility)

**Implementation**:

Add left-edge accent bars to table rows based on risk signals:

```tsx
// In stablecoin-table.tsx, modify the TableRow render (around line 323)
// Calculate risk level for each row

const getRowRiskLevel = (coin: StablecoinData, pegScores?: Map<string, PegSummaryCoin>, reportCards?: Record<string, ReportCard>) => {
  const pegCoin = pegScores?.get(coin.id);
  const reportCard = reportCards?.[coin.id];
  
  // Check for depeg (worst)
  if (pegCoin?.pegScore !== null && pegCoin?.pegScore !== undefined && pegCoin.pegScore < 60) {
    return 'depeg';
  }
  // Check for poor grade
  if (reportCard?.overallGrade && ['D', 'F'].includes(reportCard.overallGrade)) {
    return 'poor';
  }
  // Check for warning grade
  if (reportCard?.overallGrade === 'C') {
    return 'warning';
  }
  return 'normal';
};

// Apply to TableRow className
className={`group cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none transition-colors duration-150 ${
  riskLevel === 'depeg' ? 'border-l-[3px] border-l-red-500 bg-red-500/[0.03]' :
  riskLevel === 'poor' ? 'border-l-[3px] border-l-orange-500 bg-orange-500/[0.02]' :
  riskLevel === 'warning' ? 'border-l-[3px] border-l-amber-500 bg-amber-500/[0.02]' :
  ''
}`}
```

**Acceptance Criteria**:
- [ ] Rows with peg score < 60 show red left border
- [ ] Rows with D/F grade show orange left border
- [ ] Rows with C grade show amber left border
- [ ] Hover state still works on risk rows
- [ ] Virtual scrolling maintains risk indicators correctly
- [ ] Works in both light and dark mode

### 1.2 Enhanced Grade Badge Styling

**Files**:
- `src/components/stablecoin-table.tsx` (grade cell)
- `src/components/report-card.tsx` (overall grade badge)
- `src/lib/report-cards.ts` (verify color definitions)

**Implementation**:

Enhance D/F grade visibility with subtle animation:

```tsx
// In globals.css, add:
@keyframes pharos-risk-pulse {
  0%, 100% { box-shadow: 0 0 0 0 oklch(0.7 0.2 25 / 0.2); }
  50% { box-shadow: 0 0 0 3px oklch(0.7 0.2 25 / 0); }
}

.animate-risk-pulse {
  animation: pharos-risk-pulse 2s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .animate-risk-pulse {
    animation: none;
  }
}
```

Apply to D/F grade badges:

```tsx
// In stablecoin-table.tsx grade cell
<Badge
  variant="outline"
  className={`text-xs font-mono px-1 py-0 transition-all duration-200 ${
    REPORT_CARD_GRADE_COLORS[reportCards[coin.id].overallGrade]
  } ${['D', 'F'].includes(reportCards[coin.id].overallGrade) ? 'animate-risk-pulse border-red-500/50' : ''}`}
>
```

**Acceptance Criteria**:
- [ ] D/F grades have subtle pulsing shadow animation
- [ ] Animation respects `prefers-reduced-motion`
- [ ] Badge border is slightly stronger for low grades
- [ ] Table and detail page grades match

### 1.3 Table Striping for Scanning

**Files**:
- `src/app/globals.css`
- `src/components/stablecoin-table.tsx`

**Implementation**:

Add subtle alternating row backgrounds:

```css
/* In globals.css, add to @layer components */
.pharos-table-striped tbody tr:nth-child(even) {
  background-color: oklch(0.97 0.003 260 / 40%);
}

.dark .pharos-table-striped tbody tr:nth-child(even) {
  background-color: oklch(1 0 0 / 3%);
}

/* Ensure hover overrides stripe */
.pharos-table-striped tbody tr:nth-child(even):hover {
  background-color: var(--table-row-hover);
}
```

Apply to table:

```tsx
// In stablecoin-table.tsx
<table className="min-w-[420px] sm:min-w-[820px] w-full caption-bottom text-sm pharos-table-striped">
```

**Acceptance Criteria**:
- [ ] Every other row has subtle background tint
- [ ] Hover state clearly visible on striped rows
- [ ] No visual jump when scrolling (virtual rows maintain pattern)
- [ ] Works in both themes

### 1.4 Card Elevation Systematization

**Files**:
- `src/app/globals.css`
- Audit all card usages

**Implementation**:

Define elevation levels:

```css
/* In globals.css, add semantic elevation tokens */
:root {
  --elevation-rest: 0 1px 2px oklch(0 0 0 / 6%), 0 8px 20px oklch(0 0 0 / 4%);
  --elevation-raised: 0 2px 6px oklch(0 0 0 / 7%), 0 14px 32px oklch(0 0 0 / 8%);
  --elevation-featured: 0 16px 36px rgba(148,163,184,0.18);
}

.dark {
  --elevation-rest: 0 1px 2px oklch(0 0 0 / 30%), 0 10px 30px oklch(0 0 0 / 22%);
  --elevation-raised: 0 2px 6px oklch(0 0 0 / 32%), 0 18px 44px oklch(0 0 0 / 28%);
  --elevation-featured: 0 20px 44px rgba(2,6,23,0.28);
}
```

Update card component to use tokens:

```css
[data-slot="card"] {
  border-color: var(--card-border);
  box-shadow: var(--elevation-rest);
  transition:
    box-shadow var(--motion-duration-base) var(--motion-ease-standard),
    border-color var(--motion-duration-fast) var(--motion-ease-standard),
    background-color var(--motion-duration-fast) var(--motion-ease-standard);
}

.pharos-interactive-card:hover {
  box-shadow: var(--elevation-raised);
}

.pharos-card-featured {
  box-shadow: var(--elevation-featured);
}
```

**Audit & Update**:
- [ ] Homepage PSI card uses `--elevation-featured`
- [ ] Report card radar container uses subtle glow matching grade
- [ ] All interactive cards use `pharos-interactive-card`

**Acceptance Criteria**:
- [ ] Elevation tokens defined in semantic layer
- [ ] All cards use token system (no hardcoded shadows)
- [ ] PSI card has featured elevation
- [ ] Hover elevation consistent across all interactive cards

---

## Phase 2: Motion & Interaction Polish

**Duration**: 2 days  
**Goal**: Add purposeful micro-interactions and smooth transitions

### 2.1 Table Row Hover Enhancement

**Files**:
- `src/components/stablecoin-table.tsx`
- `src/app/globals.css`

**Implementation**:

Enhance row hover with subtle movement:

```css
/* In globals.css */
[data-slot="table-row"] {
  transition: 
    background-color var(--motion-duration-fast) var(--motion-ease-standard),
    transform var(--motion-duration-fast) var(--motion-ease-standard);
}

[data-slot="table-row"]:hover {
  transform: translateX(2px);
}

@media (prefers-reduced-motion: reduce) {
  [data-slot="table-row"]:hover {
    transform: none;
  }
}
```

Add left-border reveal on hover:

```tsx
// In table row className
className={`group cursor-pointer ... border-l-[3px] border-l-transparent hover:border-l-frost-blue/60 transition-all duration-150`}
```

**Acceptance Criteria**:
- [ ] Rows subtly shift right (2px) on hover
- [ ] Left border reveals frost-blue accent on hover
- [ ] Transition feels snappy (150ms)
- [ ] Reduced motion disables transform

### 2.2 Enhanced Skeleton/Loading States

**Files**:
- `src/components/ui/skeleton.tsx`
- `src/components/homepage-client.tsx`
- `src/app/globals.css`

**Implementation**:

Create shimmer effect skeleton:

```css
/* In globals.css */
@keyframes pharos-shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

.skeleton-shimmer {
  background: linear-gradient(
    90deg,
    var(--p-neutral-200) 0%,
    var(--p-neutral-100) 50%,
    var(--p-neutral-200) 100%
  );
  background-size: 200% 100%;
  animation: pharos-shimmer 1.5s ease-in-out infinite;
}

.dark .skeleton-shimmer {
  background: linear-gradient(
    90deg,
    var(--p-neutral-800) 0%,
    var(--p-neutral-700) 50%,
    var(--p-neutral-800) 100%
  );
  background-size: 200% 100%;
}

@media (prefers-reduced-motion: reduce) {
  .skeleton-shimmer {
    animation: none;
    background: var(--p-neutral-200);
  }
  .dark .skeleton-shimmer {
    background: var(--p-neutral-800);
  }
}
```

Update Skeleton component:

```tsx
// In src/components/ui/skeleton.tsx
function Skeleton({ 
  className, 
  variant = "default",
  ...props 
}: React.ComponentProps<"div"> & { variant?: "default" | "shimmer" }) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "rounded-md",
        variant === "shimmer" ? "skeleton-shimmer" : "animate-pulse bg-muted",
        className
      )}
      {...props}
    />
  );
}
```

Apply shimmer to chart skeletons:

```tsx
// In homepage-client.tsx ChartSkeleton
<Skeleton className="h-full w-full" variant="shimmer" />
```

**Acceptance Criteria**:
- [ ] Skeleton component supports shimmer variant
- [ ] Chart skeletons use shimmer (more engaging than pulse)
- [ ] Shimmer respects reduced motion
- [ ] Works in both themes

### 2.3 KPI Number Count-Up Consistency

**Files**:
- `src/components/kpi-bar.tsx`
- Audit other numeric displays

**Implementation**:

Ensure all changing numbers use count-up:

```tsx
// In kpi-bar.tsx, verify all numeric displays use useCountUp
// Currently: psiScoreNum, mcapAbbr.short
// Add for: totalVol24h, netFlow24h

const animatedVol = useCountUp(totalVol24h / 1e9, { 
  decimals: 2, 
  prefix: "$", 
  suffix: "B" 
});

const animatedFlow = useCountUp(netFlow24h / 1e9, { 
  decimals: 2, 
  prefix: getNetPrefix(netFlow24h),
  suffix: "B" 
});
```

**Acceptance Criteria**:
- [ ] All KPI numbers animate on load/data change
- [ ] Animation duration consistent (800-1200ms)
- [ ] Decimals appropriate for each metric
- [ ] No jarring jumps when data updates

### 2.4 Live Indicator Breathing Animation

**Files**:
- `src/components/kpi-bar.tsx`
- `src/app/globals.css`

**Implementation**:

Replace `animate-ping` with subtle breathing:

```css
/* In globals.css */
@keyframes pharos-breathe {
  0%, 100% { 
    opacity: 0.6;
    transform: scale(1);
  }
  50% { 
    opacity: 1;
    transform: scale(1.15);
  }
}

.animate-breathe {
  animation: pharos-breathe 3s ease-in-out infinite;
}
```

Apply to live indicator:

```tsx
// In kpi-bar.tsx PrimarySnapshotCard
<span className="relative flex h-2 w-2">
  <span className="animate-breathe absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
</span>
```

**Acceptance Criteria**:
- [ ] Live dot breathes gently (not pings aggressively)
- [ ] Still clearly indicates "live" status
- [ ] Animation is subtle, not distracting
- [ ] Respects reduced motion

### 2.5 Theme Toggle Icon Morph

**Files**:
- `src/components/sidebar.tsx` (ThemeSidebarItem)
- `src/app/globals.css`

**Implementation**:

Add crossfade transition for theme icons:

```css
/* In globals.css */
.theme-icon-enter {
  animation: pharos-fade-in-up 200ms var(--motion-ease-standard);
}

.theme-icon-exit {
  animation: pharos-fade-in-up 200ms var(--motion-ease-standard) reverse;
}
```

Wrap icons in transition container:

```tsx
// In sidebar.tsx ThemeSidebarItem
<div className="relative h-4 w-4">
  <Sun 
    className={`h-4 w-4 absolute transition-all duration-200 ${
      isDark ? 'opacity-0 rotate-90 scale-50' : 'opacity-100 rotate-0 scale-100'
    }`} 
  />
  <Moon 
    className={`h-4 w-4 absolute transition-all duration-200 ${
      isDark ? 'opacity-100 rotate-0 scale-100' : 'opacity-0 -rotate-90 scale-50'
    }`} 
  />
</div>
```

**Acceptance Criteria**:
- [ ] Sun/moon icons crossfade with rotation
- [ ] Transition is 200ms
- [ ] No layout shift during transition
- [ ] Works smoothly on repeated toggles

---

## Phase 3: Edge Case Refinement

**Duration**: 1 day  
**Goal**: Polish empty states, errors, and mobile interactions

### 3.1 Empty State Enhancement

**Files**:
- `src/components/empty-state-illustration.tsx`
- `src/components/stablecoin-table.tsx`

**Implementation**:

Create Pharos-branded empty state:

```tsx
// Enhance empty-state-illustration.tsx
export function EmptyStateIllustration({ 
  variant,
  title,
  description 
}: { 
  variant: "search" | "data" | "error";
  title?: string;
  description?: string;
}) {
  const icons = {
    search: <Search className="h-8 w-8 text-frost-blue/60" />,
    data: <BarChart3 className="h-8 w-8 text-frost-blue/60" />,
    error: <AlertCircle className="h-8 w-8 text-red-400" />,
  };

  const defaults = {
    search: { title: "No results found", description: "Try adjusting your search or filters" },
    data: { title: "No data available", description: "Check back later for updates" },
    error: { title: "Something went wrong", description: "Please try refreshing the page" },
  };

  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="mb-4 rounded-full bg-frost-blue/10 p-4 border border-frost-blue/20">
        {icons[variant]}
      </div>
      <h3 className="text-lg font-semibold text-foreground">
        {title || defaults[variant].title}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground max-w-xs">
        {description || defaults[variant].description}
      </p>
    </div>
  );
}
```

**Acceptance Criteria**:
- [ ] Empty states have frost-blue branded icon container
- [ ] Clear title and description
- [ ] Three variants: search, data, error
- [ ] Centered layout with proper spacing
- [ ] Works in both themes

### 3.2 Error State Styling

**Files**:
- `src/components/query-error-notice.tsx`
- `src/app/globals.css`

**Implementation**:

Enhance error notice with icon and better styling:

```tsx
// In query-error-notice.tsx
<div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
  <div className="flex items-start gap-3">
    <AlertCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
    <div className="flex-1">
      <p className="text-sm font-medium text-red-700 dark:text-red-400">
        Failed to load data
      </p>
      <p className="text-sm text-red-600/80 dark:text-red-300/80 mt-1">
        {error.message}
      </p>
      {onRetry && (
        <Button 
          variant="outline" 
          size="sm" 
          onClick={onRetry}
          className="mt-3 border-red-500/30 hover:bg-red-500/10"
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          Try again
        </Button>
      )}
    </div>
  </div>
</div>
```

**Acceptance Criteria**:
- [ ] Error notice has red border and subtle background
- [ ] Alert icon present
- [ ] Retry button styled consistently
- [ ] Clear error message display

### 3.3 Mobile Utility Dock Animation

**Files**:
- `src/components/mobile-utility-dock.tsx`
- `src/app/globals.css`

**Implementation**:

Add slide-up entrance:

```css
/* In globals.css */
@keyframes pharos-slide-up {
  from {
    transform: translateY(100%);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.animate-slide-up {
  animation: pharos-slide-up 300ms var(--motion-ease-decelerate);
}
```

Apply to dock:

```tsx
// In mobile-utility-dock.tsx
<div className={`fixed ... ${isVisible ? 'animate-slide-up' : 'translate-y-full opacity-0'}`}>
```

Enhance shadow on appearance:

```css
.mobile-dock-visible {
  box-shadow: 
    0 -4px 20px oklch(0 0 0 / 10%),
    0 -8px 40px oklch(0 0 0 / 8%);
}
```

**Acceptance Criteria**:
- [ ] Dock slides up from bottom on scroll
- [ ] Shadow intensifies when visible
- [ ] Transition is smooth (300ms)
- [ ] Hidden state has no pointer events

### 3.4 Report Card Radar Glow

**Files**:
- `src/components/radar-chart.tsx`
- `src/components/report-card.tsx`

**Implementation**:

Add grade-colored glow behind radar:

```tsx
// In report-card.tsx, around the radar container
const gradeGlowColors = {
  A: 'oklch(0.5 0.2 145 / 0.15)',
  B: 'oklch(0.5 0.15 250 / 0.15)',
  C: 'oklch(0.6 0.15 85 / 0.15)',
  D: 'oklch(0.6 0.2 55 / 0.15)',
  F: 'oklch(0.5 0.2 25 / 0.2)',
};

<div 
  className="absolute inset-0 rounded-full blur-3xl"
  style={{ 
    background: `radial-gradient(circle at center, ${gradeGlowColors[card.overallGrade]}, transparent 70%)`,
    opacity: 0.6 
  }}
/>
```

**Acceptance Criteria**:
- [ ] Radar has subtle glow matching grade color
- [ ] Glow is behind the chart, not interfering
- [ ] Works for all grade levels
- [ ] Subtle enough to not distract

---

## Phase 4: Systematic Audit

**Duration**: 1 day  
**Goal**: Consistency pass across typography, spacing, and interactions

### 4.1 Typography Consistency Audit

**Files to Audit**:
- All page.tsx files
- All component files with text

**Checklist**:

| Element | Should Use | Audit Result |
|---------|-----------|--------------|
| Section labels | `pharos-kicker` | ⬜ |
| Page titles | `text-3xl/4xl font-extrabold tracking-tight` | ⬜ |
| Card titles | `text-lg font-semibold tracking-tight` | ⬜ |
| Numeric data | `font-mono tabular-nums` | ⬜ |
| Body text | `text-sm text-muted-foreground` | ⬜ |

**Fixes**:
- Replace any `text-xs uppercase` section labels with `pharos-kicker`
- Ensure all numbers use `tabular-nums`
- Verify tracking consistency on headings

### 4.2 Spacing Token Audit

**Files to Audit**:
- All component files

**Checklist**:

| Pattern | Should Use | Audit Result |
|---------|-----------|--------------|
| Section gaps | `space-y-6` or `gap-6` | ⬜ |
| Card internal | `gap-4` | ⬜ |
| Tight groups | `gap-2` or `gap-1.5` | ⬜ |
| Card padding | `py-4 px-4` | ⬜ |

**Fixes**:
- Replace any arbitrary spacing (e.g., `gap-[13px]`) with token values
- Ensure section dividers use consistent pattern

### 4.3 Focus Ring Verification

**Files to Audit**:
- All interactive components

**Checklist**:

Verify these elements use `pharos-focus-ring`:
- [ ] All buttons (including icon buttons)
- [ ] All links
- [ ] All table rows
- [ ] All card links
- [ ] All input fields
- [ ] All dropdown triggers

**Fixes**:
Add `pharos-focus-ring` to any missing elements.

### 4.4 Reduced Motion Audit

**Files to Audit**:
- `src/app/globals.css`
- All animated components

**Checklist**:

Verify all animations respect `prefers-reduced-motion`:
- [ ] Table row hover transform
- [ ] Skeleton shimmer
- [ ] Risk pulse animation
- [ ] Live breathe animation
- [ ] Entrance animations
- [ ] Count-up animations (should jump to final value)

**Fixes**:
Add media query overrides where missing.

### 4.5 Theme Contrast Audit

**Files to Audit**:
- All components with conditional theme styling

**Checklist**:

| Element | Light Mode | Dark Mode | Audit Result |
|---------|-----------|-----------|--------------|
| Muted text | `--text-secondary` | `--text-secondary` | ⬜ |
| Borders | `--border-default` | `--border-default` | ⬜ |
| Card backgrounds | `--card` | `--card` | ⬜ |

Verify no hardcoded colors like `text-gray-400` or `border-gray-200`.

---

## Testing & Verification

### Pre-Implementation
- [ ] Run `npm run build` to ensure clean baseline
- [ ] Run `npm run lint` to check for issues
- [ ] Take screenshots of key pages for comparison

### Per-Phase Testing
- [ ] Visual regression on homepage
- [ ] Visual regression on stablecoin detail page
- [ ] Table interaction testing (sort, filter, scroll)
- [ ] Mobile responsive testing
- [ ] Theme toggle testing
- [ ] Keyboard navigation testing

### Final Verification
- [ ] Run full build: `npm run build`
- [ ] Run lint: `npm run lint`
- [ ] Run tests: `npm test`
- [ ] Test on real mobile device
- [ ] Test with `prefers-reduced-motion: reduce`
- [ ] Test with keyboard only

---

## Rollback Plan

If issues arise:

1. **Phase 1**: Can rollback individual components
2. **Phase 2**: CSS animations can be disabled via feature flag
3. **Phase 3**: Empty states fallback to previous version
4. **Phase 4**: Purely additive, no rollback needed

---

## Success Metrics

**Quantitative**:
- Build passes without errors
- Lighthouse accessibility score ≥ 95
- No visual regression in key user flows

**Qualitative**:
- Table scanning feels faster
- Risk signals are immediately visible
- Interactions feel responsive and polished
- Design feels cohesive across all states

---

## Documentation Updates

After implementation, update:
- [ ] `docs/design-language.md` (if patterns change)
- [ ] `docs/design-tokens.md` (if new tokens added)
- [ ] This plan with "completed" markers

---

## Appendices

### A. New CSS Classes Summary

| Class | Purpose | Location |
|-------|---------|----------|
| `.pharos-table-striped` | Alternating row backgrounds | globals.css |
| `.skeleton-shimmer` | Shimmer loading effect | globals.css |
| `.animate-breathe` | Subtle pulse for live indicator | globals.css |
| `.animate-slide-up` | Mobile dock entrance | globals.css |
| `.animate-risk-pulse` | Low grade warning | globals.css |

### B. Modified Components Summary

| Component | Changes |
|-----------|---------|
| `stablecoin-table.tsx` | Risk indicators, striping, hover |
| `report-card.tsx` | Radar glow, enhanced badges |
| `kpi-bar.tsx` | Breathing animation, count-up consistency |
| `sidebar.tsx` | Theme toggle morph |
| `skeleton.tsx` | Shimmer variant |
| `empty-state-illustration.tsx` | Branded empty states |
| `query-error-notice.tsx` | Enhanced error styling |
| `mobile-utility-dock.tsx` | Slide animation |

### C. Token Additions

| Token | Value | Purpose |
|-------|-------|---------|
| `--elevation-rest` | Shadow | Card default |
| `--elevation-raised` | Shadow | Card hover |
| `--elevation-featured` | Shadow | Hero cards |

---

**End of Plan**
