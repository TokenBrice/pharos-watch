# Alt-Pegs Differentiation Review

Date: 2026-04-23

Scope:
- `docs/alt-pegs-page.md`
- `docs/design-context.md`
- `docs/design-language.md`
- `src/app/alt-pegs/client.tsx`
- `src/app/alt-pegs/alt-peg-cohort-history-chart.tsx`
- `src/components/non-usd-share-chart.tsx`
- `src/app/alt-pegs/static-link-hub.tsx`
- `src/lib/alt-peg-market.ts`

Quick read:
- The route already has a strong product contract: current-state-first ordering, a clean market-structure job, and crawlable cohort links.
- The current surface is useful but still reads like a summary page more than a signature Pharos destination.
- The key editorial opportunity is to tell the truth about breadth vs concentration, not just show more charts.

Grounding notes:
- Latest local snapshot sampled during review: alt-pegs are about 2.26% of tracked stablecoin market cap.
- Gold is about 71.5% of the alt-peg market, so the current headline story is concentration, not diversified non-USD adoption.
- The page currently mixes a 24h non-USD-share history feed with hourly-backed cohort history, which is exactly where trust issues can emerge.
- The cohort-growth chart is the most likely source of the "too dense" and "starts too big too early" feedback.

Most promising direction:
- Turn `/alt-pegs/` into an "outside-the-dollar intelligence" surface instead of a clean chart page.
- Add synthesis modules that answer:
  - Is non-USD growth broadening or just concentrating?
  - Which cohorts are actually earning relevance?
  - Which cohorts are big but fragile because they depend on one coin, thin liquidity, or weak peg behavior?
  - Where should the user go next inside Pharos to validate what they just saw?

Likely high-value modules:
- Broadening vs concentration scorecard
- Driver-of-change / gainers-and-losers attribution
- Cohort credibility matrix tying market cap to liquidity / depeg / safety signals
- Annotated trust-preserving history views with share / absolute toggle and launch markers
- Better cohort drill-down destinations and prefilled adjacent-route jumps
