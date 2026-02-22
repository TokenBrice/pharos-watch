# About Page Redesign

## Problem

The about page is a dense wall of text (~517 lines) that mixes project overview with deep technical reference (Peg Score formulas, liquidity multiplier tables). It's hard to scan, especially on mobile where `flex gap-2` with `shrink-0` labels causes overflow.

## Design

### Structure (5 sections, down from 6)

1. **Hero / Why Pharos** — TokenBrice intro + mission, 3 sentences max
2. **What Pharos Tracks** — 2x3 responsive grid of icon cards (Lucide icons). Each: icon + title + one-liner
3. **Classification** — 3-tier explanation in 2-3 sentences with inline colored badges
4. **Data Pipeline** — CSS flow diagram: grouped sources -> Worker+D1 -> Dashboard. Replaces 12-item flat list
5. **Footer** — Open source link + contact, unchanged

### Content removed

- Peg Score Methodology section (formulas, thresholds, decay, reference rates)
- Liquidity Score Methodology section (6 components, quality multipliers, per-pool signals, aggregate metrics)
- Per-item paragraph descriptions in "What Pharos Tracks"
- Detailed data source descriptions (trimmed to name + purpose)

### Visuals added

- **Feature grid**: 6 cards, responsive 2x3 desktop / 1-col mobile. Lucide icon per card with accent color
- **Data pipeline diagram**: Pure CSS/HTML, three columns (Sources -> Worker -> Dashboard), stacks vertically on mobile

### Mobile fixes

- Feature grid single-column
- Pipeline diagram stacks vertically
- No `flex gap-2` + `shrink-0` overflow patterns
- Standard card padding throughout

### Preserved

- FAQPage JSON-LD structured data (updated for shorter content)
- Breadcrumb navigation
- Colored left borders on cards
- Open source + contact footer
