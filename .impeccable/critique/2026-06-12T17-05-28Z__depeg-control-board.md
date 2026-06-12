---
target: depeg-control-board
total_score: 21
p0_count: 1
p1_count: 2
timestamp: 2026-06-12T17-05-28Z
slug: depeg-control-board
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Good status badges and gauge states; gauge needles at 2px stroke are hard to read at a glance; sort direction invisible. |
| 2 | Match System / Real World | 3 | Domain-correct terminology; "Cross-check" vague; "worst -6988" strips bps unit inconsistently. |
| 3 | User Control and Freedom | 2 | No "clear all filters"; sort direction not shown; no dismiss/mark-reviewed on rows. |
| 4 | Consistency and Standards | 2 | border-l-2 side stripes active on every row (banned); three different metrics all use identical h-1.5 bars. |
| 5 | Error Prevention | 2 | Empty filter state is one plain line with no action path. |
| 6 | Recognition Rather Than Recall | 2 | DEWS / bps / Peg Score have no tooltips or definitions anywhere; mobile column headers hidden. |
| 7 | Flexibility and Efficiency | 2 | No keyboard sort shortcuts; sort direction not visible; page size fixed; sort key not URL-serialized. |
| 8 | Aesthetic and Minimalist Design | 2 | Left-stripe borders banned; all four linear bars visually identical; deviation bar caps at 500bps (false equivalence). |
| 9 | Error Recovery | 2 | "No stablecoins match these filters." with no escape path. |
| 10 | Help and Documentation | 1 | No tooltips anywhere on any metric. |
| **Total** | | **21/40** | **Acceptable** |

## Anti-Patterns Verdict

LLM: No AI-slop tells. Domain specificity is real. Two project-specific violations: border-l-2 stripes (flat-card harmonization rule broken) and KPI gauge trio (hero-metric template anti-pattern).
Deterministic scan: clean, [].

## Overall Impression

Functionally solid but has a visual equality problem — every row and metric carries the same weight regardless of severity. Biggest opportunity: make severity legible at a scan.

## Priority Issues

P0: border-l-2 side stripes still active — banned by flat-card harmonization. Fix: remove border-l-2, replace with full-row bg tints.
P1: DeviationBar caps at 500bps — SUSD -6899bps and ALUSD -416bps render identically. Fix: three-segment log scale.
P1: KPI gauge trio follows hero-metric anti-pattern. Fix: redesign as horizontal threat ticker strip.
P2: DEWS cell over-encodes two fields with four elements (score + letter + word + bar). Fix: remove linear gauge.
P2: Peg Score and Peg % duplicate data across two columns. Fix: merge into Peg Health column.

## Persona Red Flags

Alex: No sort direction visible; deviation bars give false visual equivalence; no "clear all filters."
Jordan: DEWS, bps, Peg Score undefined; score scale unclear (0 = bad? unrated?).
