---
target: PharosWatchBot page hero
total_score: 30
p0_count: 1
p1_count: 1
timestamp: 2026-07-11T11-35-23Z
slug: src-app-pharoswatchbot-page-tsx-hero
---
# Critique: PharosWatchBot page hero (src/app/pharoswatchbot/page.tsx)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Live adoption figures present but buried mid-page |
| 2 | Match System / Real World | 4 | Alert families named in the user's own vocabulary |
| 3 | User Control and Freedom | 3 | n/a for a static page; /forget, snooze documented |
| 4 | Consistency and Standards | 2 | Hero breaks the light/flat/drawn Pharos language |
| 5 | Error Prevention | 3 | Recommended-default-first setup |
| 6 | Recognition Rather Than Recall | 3 | Command reference collapsed in details |
| 7 | Flexibility and Efficiency | 3 | Copyable commands, presets, deep links |
| 8 | Aesthetic and Minimalist Design | 2 | Occluded decorative screenshot = pure noise |
| 9 | Error Recovery | 3 | /health, honest TTL contract |
| 10 | Help and Documentation | 4 | Command ref, param legend, FAQ, methodology link |
| **Total** | | **30/40** | **Good** |

## Anti-Patterns Verdict

LLM assessment: body of the page is hand-built and trustworthy (mono alert bubbles, copyable commands, bounded-service honesty). The hero is the AI-generic tell: raw product screenshot behind a uniform 58% scrim on a #172534 navy block, the only dark island on a light-default site, zero frost-blue, no drawn metaphor.

Deterministic scan: static markup clean (exit 0; 2 broken-image hits are next/image test stubs, false positives). In-browser scan: 126 findings, heavily diluted by global chrome bleed (homepage tape strip owns the gradient-text/nested-card/cramped hits). Bot-page signal: line-length ~96ch on lead paragraphs (aim <80), cramped padding on dense dl rows, sr-only skip-link text-overflow FPs. No user-visible overlay (headless-only run).

## Priority Issues

- **[P0] Text/image collision at 768px.** max-w-3xl hero copy overruns the 48%-wide right image; the flat inset-0 scrim doesn't darken the overlap, so body copy renders on top of the mini-app's own UI labels. Broken hero at the most common tablet width. Fix: remove the screenshot (owner-aligned).
- **[P1] Hero violates the Pharos design language.** Only dark block on a light-default site, a photo where the system draws its metaphors, no frost-blue on the surface that most needs the beam, bespoke white CTA instead of system buttons. Fix: rebuild in-system, benefits-led, One-Beam-compliant.
- **[P2] priority image is dead weight on mobile.** At 390px CSS drops it to opacity 0.08 (invisible) yet it's fetched with priority — LCP/bandwidth cost, zero payoff. Resolved by removing the screenshot.
- **[P2] Lead paragraphs run ~96ch.** Detector line-length findings; cap at ~75ch.
- **[P3] Mini App carousel reads as a black void** against the flat light layout; needs a bordered device frame so it reads intentional.

## Persona Red Flags

- Jordan (first-timer): hero never explains what an alert is for before pushing an external "Open Bot"; the barely-visible screenshot teaches nothing.
- Casey (distracted mobile): fetches an invisible priority image; solid navy slab with no hook; converting reassurance is far below the fold.
- Alex (power user): command reference + param syntax both buried in collapsed details.

## Minor Observations

- tracking-normal override fights the display face's designed -0.025em.
- "See alert examples" may be the stronger conversion path than "Open Bot"; the examples grid is the proof.
- Live adoption figures (active chats, alerts delivered) are the page's one live-data moment — candidate for the hero beam.
- Hero eyebrow/headline/body/CTAs left-stacked with no rhythm anchor.

## Questions to Consider

- If the alert-examples grid is what sells the bot, why is it second, behind a hero showing a screenshot no one can read?
- Should the hero carry a live number (active watchers / alerts sent) so this marketing surface obeys the One Beam Rule instead of decorating around it?
- Is a dark hero justifiable at all on a light-default lighthouse product, or is the drawn lighthouse itself the hero this page is missing?
