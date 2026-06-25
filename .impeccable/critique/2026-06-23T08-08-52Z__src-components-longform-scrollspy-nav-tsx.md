---
target: LongformScrollspyNav on stablecoin detail pages
total_score: 26
p0_count: 0
p1_count: 3
timestamp: 2026-06-23T08-08-52Z
slug: src-components-longform-scrollspy-nav-tsx
---

# Critique — LongformScrollspyNav (banner variant), stablecoin detail pages

Inspected live at localhost:3000/stablecoin/usdt-tether across desktop 1440, mobile 390, light+dark. detect.mjs clean.

## Design Health Score

| #     | Heuristic                   | Score | Key Issue                                                                    |
| ----- | --------------------------- | ----- | ---------------------------------------------------------------------------- |
| 1     | Visibility of System Status | 1     | Active pill ~2% fill delta light mode; highlight lags one section            |
| 2     | Match System/Real World     | 3     | Labels + icons clear                                                         |
| 3     | User Control & Freedom      | 3     | Hash sync, back-button, shareable anchors                                    |
| 4     | Consistency & Standards     | 2     | Ignores core-rail frost pill + SectionBanner divider; invents 3rd chip vocab |
| 5     | Error Prevention            | 3     | n/a non-destructive                                                          |
| 6     | Recognition vs Recall       | 3     | Labeled+iconed; mobile hides 2/6 behind fade                                 |
| 7     | Flexibility & Efficiency    | 3     | Focusable; no accelerator                                                    |
| 8     | Aesthetic & Minimalist      | 2     | "Jump to" orphan caption; pill row <50% of full-width bar                    |
| 9     | Error Recovery              | 3     | n/a                                                                          |
| 10    | Help & Documentation        | 3     | self-explanatory                                                             |
| Total |                             | 26/40 | Acceptable                                                                   |

## Anti-Patterns Verdict

Partially AI-feeling: lands on identical-rounded-full-chip group (lazy section-nav default). No hard ban tripped. detect.mjs clean. Active pill bg-muted (L≈0.965) vs inactive bg-background/80 (L≈0.985) = ~2% delta in light; flips to near-white high-contrast button in dark (theme-unstable because it rides neutral surface tokens).

## Priority Issues

- [P1] Active state barely registers + theme-unstable. Fix: adopt .pharos-rail-tab-active frost recipe (frost wash + inset ring + lit frost-blue icon + beam). cmd: colorize.
- [P1] Active detection lags one section. Observer targets 44px heading strips w/ 15% band (rootMargin -20%/-65%); between headings nothing in band so highlight freezes. Sweep: overview-top=>Context active; activity-top=>Liquidity active. Fix: observe content wrappers / compute from scroll ranges. cmd: harden.
- [P1] Banner variant never sets aria-current (rail variant does, line 217). Runtime ariaCurrent:null on active pill. SR users get no active announcement. Fix: add aria-current to banner anchor. cmd: harden.
- [P2] Desktop composition empty/unanchored: rightSlot hidden lg:hidden, "Jump to" centered orphan over pills filling <50% of 1157px bar. Fix: inline label / constrain width / keep rightSlot at lg. cmd: layout.
- [P2] Third nav vocabulary vs SectionBanner divider + core frost pill. Fix: unify. cmd: colorize/typeset.

## Persona Red Flags

Alex (power user, primary): highlight lags, can't trust position. Sam (a11y): no aria-current on banner + sub-3:1 active color = double failure. Casey (mobile): History/Explore off-screen behind fade, active pill not auto-scrolled into view (core rail does this).

## Minor

- Unrelated: DEX pool list duplicate React keys (Ethereum-WETH-USDT-uniswap-v3) x5.
- Label "Jump to" (>=sm) vs "Sections:" (<sm) copy inconsistency.
- showDepthHint gradient nearly imperceptible.
