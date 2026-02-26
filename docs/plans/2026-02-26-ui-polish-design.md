# UI Polish & Refinement Design

**Date:** 2026-02-26
**Approach:** Component-First, Then Page Sweep (Approach C)
**Scope:** Visual polish + micro-interactions + targeted refinements (no new features)

---

## Guiding Principle

Refine, enhance, augment — not redesign. Every change should feel like a natural evolution. The dashboard's identity and structure remain intact. When in doubt between two options, choose the one that feels quieter and more confident.

## Approach

**Phase 1:** Polish shared components (cards, tables, badges, buttons, chart wrappers) — the building blocks that appear everywhere.
**Phase 2:** Page-level sweep to fix layout, spacing, and page-specific issues.

Changes cascade from components to pages, so ~80% of improvements propagate automatically.

---

## Section 1: Typography & Label Normalization

**Problem:** Small labels use a mix of `text-[11px]`, `text-[10px]`, and `text-xs` (12px) for similar roles. Font weight varies between `font-semibold` and `font-medium` for equivalent label hierarchy levels.

**Changes:**
- Standardize all uppercase meta-labels to `text-xs` (12px) — eliminate custom pixel sizes like `text-[11px]` and `text-[10px]`
- Standardize KPI/card section labels: `text-xs font-semibold uppercase tracking-wider text-muted-foreground`
- Standardize large stat values: `text-xl font-extrabold font-mono tabular-nums`
- Ensure all section headings use `text-xl font-semibold tracking-tight` uniformly

---

## Section 2: Card & Container Refinement

**Problem:** Cards are consistent at the component level but usage patterns create subtle inconsistencies — some cards have `p-0 overflow-hidden` overrides, internal spacing varies, and the left accent border is applied inconsistently across similar card types.

**Changes:**
- Ensure all data summary cards (Live Indicators, category stats) consistently use the `border-l-[3px]` accent pattern
- Normalize internal card padding: `CardContent` children should use `space-y-3` for stacked items uniformly
- Add subtle hover elevation to all clickable cards: `hover:shadow-md transition-shadow duration-150`
- Tighten `CardHeader` bottom spacing where it creates too much gap before content
- Ensure `CardFooter` "view all" links have consistent styling: `text-xs text-muted-foreground hover:text-foreground transition-colors`

---

## Section 3: Homepage Hero Elevation

**Problem:** The hero is functional but doesn't command attention the way a premium fintech dashboard should. The identity zone is compact but could feel more confident. The KPI bar dividers and internal spacing could be refined.

**Changes:**
- **Identity zone:** Add a subtle frosted-glass background or very light surface treatment behind the Pharos name + subtitle for more presence
- **KPI bar:** Tighten internal cell padding; ensure 24h change indicators are visually aligned with values; soften dividers to `divide-border/50`
- **Section transition:** Add a small section label ("Live Indicators") with `text-xs font-semibold uppercase tracking-wider text-muted-foreground` before the 6-card grid if missing
- **Breathing room:** Ensure consistent vertical spacing between identity zone → KPI bar → Live Indicators (`space-y-6`)

---

## Section 4: Table & Data Grid Polish

**Problem:** Tables have rough edges — very subtle row hover states, varying header styling between tables, and sticky header backdrop blur can feel disconnected.

**Changes:**
- **Row hover:** Increase to `hover:bg-muted/40` for better feedback
- **Sticky header:** Uniform `bg-muted/80 backdrop-blur-sm` with subtle bottom border across all tables
- **Sortable columns:** Add a subtle always-visible (dimmed) directional arrow rather than only on active sort
- **Numeric alignment:** Audit all numeric columns for consistent `text-right font-mono tabular-nums`
- **Cell padding:** Standardize to `px-3 py-2` for regular cells, `px-3 py-1.5` for compact/dense tables
- **Empty state:** Consistent empty state across all tables: `text-muted-foreground text-center py-12`

---

## Section 5: Interactive States & Micro-Interactions

**Problem:** Hover/focus/active states are not always consistent across custom components vs shadcn primitives. Some elements lack transitions, causing jarring state changes.

**Changes:**
- **Hover consistency:** Ensure all clickable elements have `transition-colors` at minimum
- **Focus ring:** Verify all interactive elements use `focus-visible:ring-[3px] focus-visible:ring-ring/50`
- **Card click feedback:** Add `active:scale-[0.995]` to navigating cards for subtle press confirmation
- **Loading skeleton normalization:** Standardize to `animate-pulse` with `bg-muted`
- **Chart fade-in:** All charts use `animate-in fade-in duration-300` when data loads
- **Badge hover on links:** Where badges wrap links, add subtle `hover:brightness-110` feedback

---

## Section 6: Spacing & Alignment Normalization

**Problem:** Spacing values drift slightly across similar contexts — `gap-3` vs `gap-4` in comparable grids, `space-y-2` vs `space-y-3` for similar stacked layouts.

**Changes:**
- **Grid gaps:** Standardize all card grids to `gap-3 sm:gap-5`
- **Section spacing:** `space-y-6` between major sections on page level, `space-y-4` within card bodies
- **Section header margins:** All section headings get `mb-4` consistently
- **Page padding:** All pages use `px-4 lg:px-6 py-6`
- **Inline element gaps:** `gap-1.5` for tight pairs (icon + text), `gap-2` for looser groupings

---

## Section 7: Targeted Refinements

**Problem:** Small details where tightening the execution raises perceived quality.

**Changes:**
- **Number formatting:** Audit all large numbers for consistent compact notation (`$1.2B`, `$340M`, `$12.5K`) with uniform decimal places
- **Tooltip improvements:** Recharts tooltips use `font-mono` + formatted numbers + `rounded-lg` + theme-aware border consistently; custom tooltips match
- **Timestamps:** Freshness indicators use consistent relative formatting ("2h ago", "just now") with `text-xs text-muted-foreground`
- **Scroll-to-top:** Uses `fade-in` + `shadow-md` treatment matching other floating elements
- **Responsive edge cases:** Audit KPI bar at `sm` breakpoint for label truncation; audit Live Indicators at `lg`

---

## Section 8: Visual Hierarchy Through Restraint

**Problem:** Some elements are visually "loud" but informationally secondary — borders competing with text, labels as prominent as values, structural decoration pulling focus from data.

**Changes:**
- Audit every view for visual weight distribution: the most important data should have the highest prominence
- Mute secondary elements: lighter borders (`border-border/50`), reduced font-weight on supporting text, lower opacity on structural elements
- Reduce border prominence where borders serve only as dividers (not accent or semantic meaning)
- Ensure labels are always visually subordinate to the values they describe — smaller, lighter, more muted
- Where multiple visual treatments overlap (border + shadow + background), remove the least necessary one

**Principle:** Eye goes to data first, structure second, decoration never.

---

## Section 9: Optical Alignment & Vertical Rhythm

**Problem:** Elements may be CSS-aligned but not optically aligned. Icons sitting 1px off text midlines. Numeric values in adjacent KPI cells not lining up. Badge text appearing off-center. Leading whitespace in formatted numbers throwing off visual centering.

**Changes:**
- Audit icon + text pairs for optical vertical centering — apply micro-adjustments where `items-center` isn't sufficient
- Ensure numeric values in adjacent cards/cells align on the same baseline
- Check badge text vertical centering (line-height vs padding balance)
- Verify formatted numbers with different lengths (`$1.2B` vs `$340M`) don't create perceived misalignment in grids
- Ensure consistent leading/trailing space handling for all formatted values

**Principle:** If it feels "off" even though you can't articulate why, it's probably an optical alignment issue.

---

## Section 10: State Parity (Dark/Light + Loading/Loaded)

**Problem:** Polish often regresses in one theme or during state transitions. Loading skeletons that don't match content dimensions cause layout shifts. Empty states that use different spatial footprints break visual continuity.

**Changes:**
- Verify every refinement in both light and dark themes — shadow intensity, border opacity, hover state visibility all behave differently
- Ensure loading skeletons match the exact dimensions and border-radius of the content they replace (no layout shift on load)
- Ensure empty states occupy the same spatial footprint as populated states
- Audit hover state visibility in dark mode specifically — subtle `bg-muted/40` may be invisible on dark surfaces
- Check that colored badges maintain sufficient contrast in both themes

**Principle:** The illusion of quality breaks when any transition between states causes a visual jump.

---

## Verification Criteria

Every change must:
1. Build successfully (`npm run build`)
2. Look correct in both light and dark mode
3. Not degrade accessibility (WCAG 2.1 AA minimum)
4. Not introduce layout shifts between loading and loaded states
5. Maintain responsive behavior across all breakpoints
