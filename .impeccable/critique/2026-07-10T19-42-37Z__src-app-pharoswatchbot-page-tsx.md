---
target: /pharoswatchbot page
total_score: 29
p0_count: 1
p1_count: 2
timestamp: 2026-07-10T19-42-37Z
slug: src-app-pharoswatchbot-page-tsx
---
# Critique: /pharoswatchbot (src/app/pharoswatchbot/page.tsx)

## Environment finding (load-bearing)
The desktop layout everyone has been reviewing locally is **broken by stale Tailwind CSS, not by the page's code**. The long-running dev server AND the 19:51 `out/` export both serve a global CSS bundle missing every arbitrary-value class introduced in today's rewrite (`h-[330px]`, `sm:h-[400px]`, `lg:h-[460px]`, `lg:text-[3.5rem]`, `lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]`, `lg:grid-cols-[minmax(0,0.9fr)_minmax(320px,0.66fr)]`) while containing classes from the same file/commit that existed earlier (`bg-[#1e3a5f]`). A fresh Tailwind v4 scan+compile (verified via @tailwindcss/node + oxide Scanner) picks up ALL of them. Effect of the stale CSS: setup and Mini App sections collapse to single column at 1440px, carousel renders as a giant black band. With corrected CSS injected, the page renders as designed and is good. Live prod is unaffected (78 unpushed commits; old page still deployed). Action: restart dev server / clear `.next`, and verify a clean build's CSS contains `460px`/`1.28fr` before pushing.

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of system status | 3 | Live pulse + timestamps strong; marketing screenshots leak stale state ("Last delivery May 22", "@TokenBrice") |
| 2 | Match system/real world | 2 | DEWS never defined on page; "formatter-derived", "bounded delivery", "low-cardinality deltas" |
| 3 | User control and freedom | 3 | Carousel auto-advances while reading (pause exists); details reversible |
| 4 | Consistency and standards | 2 | Double title stutter; sky-700 command labels + frost step numerals vs One-Beam; 6 CTA labels for 5 destinations |
| 5 | Error prevention | 3 | Copy buttons, param legend, group-admin notes |
| 6 | Recognition vs recall | 3 | `<types>/<targets>` grammar leans on memory; legend mitigates |
| 7 | Flexibility and efficiency | 4 | Deep links, copyable commands, presets, dual command/Mini-App paths |
| 8 | Aesthetic and minimalist design | 2 | Ops telemetry clutter; reliability hedges stated 3-4×; dangling 5th alert card |
| 9 | Error recovery | 3 | Degraded-telemetry fallback copy thoughtful |
| 10 | Help and documentation | 4 | Collapsed 28-command reference + FAQ + methodology link |
| **Total** | | **29/40** | **Good — solid foundation, address weak areas** |

## Anti-Patterns Verdict
Not template slop — real formatter-derived alert bubbles, honest adoption numbers, disciplined progressive disclosure (4.6k px collapsed vs ~11.5k expanded). The tell is **engineer-slop voice**: the "X, not Y" contrastive tic ×4 ("bounded, not guaranteed" / "evidence, not a delivery guarantee" / "not a guaranteed emergency pager" / "not a fixed capacity limit"), em dashes in ~6 copy strings, ops vocabulary on a conversion page. Deterministic scan: CLI detector 0 findings on the 4 TSX files; runtime DOM detector 104 findings — 47 line-length (90–104ch paragraphs), 31 cramped-padding (mostly alert-example rows), 25 sr-only "overflows" (all false positives), 1 hero overflow-clip (by design).

## Priority Issues
- **[P0] Stale-CSS pipeline** (environment, not design): clear `.next`, restart dev, verify clean build CSS contains `460px`/`1.28fr` before push. Without this, the next deploy could ship the broken desktop if the build reuses the cache.
- **[P1] Double-title stutter**: shell H1 "PharosWatchBot" sits directly above hero eyebrow repeating "PharosWatchBot · Free Telegram alerts…". Drop the name from the eyebrow (keep "Free Telegram alerts for 410 tracked stablecoins").
- **[P1] DEWS never defined**: first mention should carry ~8 words ("DEWS, Pharos's depeg early-warning score") — hero paragraph or first alert card tagline.
- **[P2] Reliability hedges repeated 3-4×**: hero fine-print line, pulse-board footnotes, ReliabilityContract, load-test caveat. Keep ReliabilityContract as the single home; cut the hero fine print, the "5,000 watcher load scenarios" line, and the pulse footnote.
- **[P2] Ops telemetry on a public page**: "Denied today", "Queued deliveries", "Mutations today", "Open → first mutation (P50)" belong on /status. Keep chats, follows, chart, most-followed.
- **[P2] Marketing screenshots leak personal/stale state**: "@TokenBrice", old "Last delivery" dates. Regenerate with a neutral demo account.
- **[P2] Dangling 5th alert card**: Reserve Drift sits beside an empty cell. Full-width fifth row or merge Launch+Reserve.
- **[P3] Copy pass**: "These are the alerts" heading; em dashes; "formatter-derived"; consolidate 6 CTA labels; neutral ink for 01/02/03 numerals and sky-700 group labels (One-Beam).
- **[P3] Orphaned data**: `GROWTH_SUPPORT` and `TELEGRAM_HOW_IT_WORKS_CARDS` in telegram-content.ts are exported but rendered nowhere.

## Persona Red Flags
- **Jordan (first-timer)**: hits "DEWS" in hero, "formatter-derived examples from all five families" before knowing what a family is, "bps"/"reason lines" — no glossary path until the footer methodology link.
- **Alex (power user)**: the one-line command is ~1,900px down; notices stale screenshot state and reads it as an unmaintained product; 6 CTA labels waste his scan.
- **Casey (mobile)**: hero good (CTA in first viewport), but ~7,000px collapsed mobile page; the pulse→mini-app→reliability text wall buries the FAQ.

## Minor Observations
- Lead paragraphs run 90–104ch; tighten to ~max-w-2xl.
- Alert-example rows flagged cramped by the detector (children flush against card bg).
- Footnote `<p>`s after the reliability and pulse `<dl>`s lack top margin.
- Dark alert bubbles inside white cards skirt nested-card; defensible as content mockups.
- Mini-app carousel panel is a large dark region on desktop (dark-mode screenshot on dark frame); consider a lighter frame or tighter sizing.

## Questions to Consider
1. If the whole page exists to get one tap on one sensible default, why eight t.me links to five destinations instead of one command repeated?
2. Is the ReliabilityContract reassuring the visitor, or the author? Would folding every caveat into the FAQ lose a single conversion?
3. Is "754 active chats" courage or friction — at what number does honest evidence start converting?
