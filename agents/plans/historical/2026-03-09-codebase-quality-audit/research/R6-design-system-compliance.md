---
title: "Audit design system compliance: tokens, typography, spacing, color, component consistency"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "xhigh"
done: false
---

## Goal

Produce a comprehensive `RESEARCH-REPORT.md` cataloguing every design system violation detectable through code analysis — focused on hardcoded values that should use tokens, typography inconsistencies, spacing irregularities, color misuse, and component pattern inconsistencies.

## Context

This is a **read-only research task**. You are NOT implementing changes — you are producing a detailed audit report.

Pharos uses a 3-layer design token architecture documented in `docs/design-tokens.md` and a design language documented in `docs/design-language.md`. Read both documents before starting the audit.

**Design system essentials:**
- **Theme:** Dark-first financial dashboard (light mode supported)
- **Fonts:** Geist Sans (UI text) + Geist Mono (**all** numbers, values, percentages, scores)
- **Brand accent:** Frost-blue `oklch(0.72 0.14 248)` — sparingly, for navigation active states and brand touches
- **Color rule:** Semantic only — color communicates state (health, risk, trend direction), never decoration
- **Classification labels/colors:** All defined in `shared/lib/classification.ts` — never defined locally
- **Tailwind classes must be static strings** — never constructed dynamically

**Scope:** All components in `src/components/` (excluding `ui/`), all pages in `src/app/`, all lib files that define colors/styles.

**Reference files to read first:**
- `docs/design-tokens.md` — token architecture
- `docs/design-language.md` — typography, spacing, cards, tables, charts, interactive states
- `shared/lib/classification.ts` — canonical classification labels and colors
- `shared/lib/psi-colors.ts` — PSI band colors

## Task

### 1. Typography Compliance

- **Numbers not in monospace:** Find numeric values (prices, supplies, percentages, scores, counts) rendered without `font-mono` or Geist Mono. **All numbers should use monospace.** This is a core brand signal.
- **Heading hierarchy:** Check heading usage (`h1`-`h6`) across pages for consistency. Are similar page types using the same heading structure?
- **Font size inconsistency:** Similar elements using different font sizes. E.g., stat card values using `text-2xl` in one component and `text-xl` in another.
- **Font weight inconsistency:** Similar emphasis levels using different weights across components.
- **Text transform inconsistency:** Labels using `uppercase` in some places and sentence case in others for the same type of content.

### 2. Color Compliance

- **Hardcoded colors:** Hex values (`#fff`, `#1a1a2e`), `rgb()`, `hsl()`, or `oklch()` in component code instead of Tailwind semantic color classes or design tokens. Inline `style={{ color: ... }}` overrides.
- **Decorative color:** Color used for decoration rather than communicating state. Gradients, background accents, or borders that don't convey meaning.
- **Classification color violations:** Components defining their own risk/grade/band colors instead of importing from `shared/lib/classification.ts`.
- **Inconsistent status colors:** The same state (e.g., "healthy", "warning", "critical") using different colors in different components.
- **Dark/light mode gaps:** Colors that work in dark mode but not light mode (or vice versa). Hardcoded colors that don't adapt to theme.
- **Brand accent misuse:** Frost-blue used for elements beyond navigation active states and brand touches.

### 3. Spacing Compliance

- **Hardcoded spacing:** Pixel values in inline styles (`padding: 8px`, `margin: 12px`) instead of Tailwind spacing scale.
- **Non-standard spacing:** Tailwind spacing values that don't follow the project's spacing scale. Check for arbitrary values (`p-[7px]`, `gap-[13px]`) that should snap to the scale.
- **Inconsistent gaps:** Similar layouts (card grids, stat groups, section spacing) using different gap values across pages.
- **Inconsistent padding:** Card components with different internal padding patterns. Page-level padding inconsistencies.
- **Vertical rhythm:** Inconsistent spacing between sections on similar page types.

### 4. Component Pattern Consistency

- **Card patterns:** Compare all card-like components. Are they using the same shadcn Card primitive? Same border-radius, padding, shadow? Flag deviations.
- **Table patterns:** Compare all table/data-grid components. Same header style? Same row hover? Same cell alignment (numbers right-aligned, text left-aligned)?
- **Stat/KPI patterns:** Compare all stat display components. Same layout structure? Same value formatting? Same subtext style?
- **Chart patterns:** Compare all chart components. Same axis styling? Same tooltip style? Same legend position? Same grid lines?
- **Badge/tag patterns:** Compare all badge-like elements (status badges, category tags, grade labels). Same border-radius, padding, font size?
- **Button/action patterns:** Compare all interactive elements. Same button sizes for same contexts? Same icon sizes?

### 5. Interactive State Consistency

- **Hover states:** Compare hover effects across similar interactive elements. Same transition duration? Same visual change (opacity, background, border)?
- **Focus states:** Consistent focus ring styling across all focusable elements.
- **Active/pressed states:** Consistent across buttons and clickable elements.
- **Disabled states:** Consistent opacity/styling for disabled elements.
- **Selected/active states:** Navigation items, tabs, toggles — consistent active state styling.

### 6. Data Display Consistency

- **Number formatting:** Check how numbers are formatted across components. Same number of decimal places for same types of values? Same compact notation for large numbers?
- **Percentage formatting:** Consistent decimal places, sign display (+/-), color coding for positive/negative.
- **Date formatting:** Consistent format across components (relative vs absolute, format string).
- **Address/hash display:** Consistent truncation pattern for blockchain addresses and transaction hashes.
- **N/A display:** Consistent representation of missing data (dash, "N/A", "—", empty).

### 7. Dynamic Class Construction (Critical)

- **Tailwind purge violations:** Any dynamically constructed class strings (`className={`text-${color}-500`}`) that Tailwind's purge cannot detect. These classes won't be included in the production build. Flag every instance.

## Report Format

Produce `RESEARCH-REPORT.md` in the worktree root:

```markdown
# R6: Design System Compliance Audit Report

## Summary
- Files audited: N
- Findings by severity: N critical, N important, N minor
- Findings by category: N typography, N color, N spacing, N component, N interactive, N data-display, N purge

## Critical Findings (systematic violations affecting multiple pages)

### Finding C1: [Short description]
- **Category:** [Typography | Color | Spacing | Component Pattern | Interactive State | Data Display | Purge Violation]
- **Files:** `path:line` — `path:line`
- **Design token reference:** [which token/rule from design-tokens.md or design-language.md is violated]
- **Description:** [What the violation is and how it affects visual consistency]
- **Suggested fix:** [Concrete description — which token or class to use instead]
- **Effort:** [Low | Medium | High]
- **Scope:** [N files affected]

## Important Findings (inconsistencies across 2-3 components)
### Finding I1: ...

## Minor Findings (isolated violations)
### Finding M1: ...

## Typography Audit
| Element Type | Expected | Violations Found |
|-------------|----------|-----------------|
| All numbers/values | `font-mono` (Geist Mono) | [list of files not using monospace for numbers] |
| Page headings | Consistent h1-h6 hierarchy | [deviations] |
| Stat card values | [expected size] | [deviations] |
| ... | ... | ... |

## Color Audit
| Pattern | Source of Truth | Violations |
|---------|----------------|------------|
| Classification labels | `shared/lib/classification.ts` | [components defining own colors] |
| PSI band colors | `shared/lib/psi-colors.ts` | [components with local copies] |
| Status colors (health/warning/critical) | [token reference] | [inconsistencies] |
| Hardcoded hex/rgb values | Should use tokens | [list all instances] |

## Component Pattern Comparison
For each component family, compare patterns and flag inconsistencies:
- **Cards:** [comparison table]
- **Tables:** [comparison table]
- **Stats:** [comparison table]
- **Charts:** [comparison table]

## Dynamic Class Violations
Every instance of dynamically constructed Tailwind classes (MUST be fixed — they break in production):
- `path:line`: `[the dynamic class expression]`
```

## Acceptance Criteria

- `RESEARCH-REPORT.md` exists in the worktree root
- Agent read `docs/design-tokens.md` and `docs/design-language.md` before auditing
- Report covers all components in `src/components/` (except `ui/`) and pages in `src/app/`
- Every finding references the specific design token or rule being violated
- Every finding has exact `file:line` references
- Every finding has an effort estimate (Low/Medium/High) and risk level
- Typography audit specifically checks all numeric displays for `font-mono`
- Color audit specifically checks against `shared/lib/classification.ts` and `shared/lib/psi-colors.ts`
- Dynamic class construction violations are flagged as critical
- No code changes were made (read-only audit)
