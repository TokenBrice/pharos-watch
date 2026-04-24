Date: 2026-04-23

# Alt-Pegs Map Implementation Plan

## Goal

Replace the current fiat region chip board in `src/app/alt-pegs/static-link-hub.tsx` with a fiat-only geography lens that:

- keeps static crawlable links into `/stablecoins/[peg]/`
- uses a subdued world map plus broad region overlays for fiat cohorts
- keeps `Gold`, `Silver`, and `CPI` explicitly off-map in a single sidecar
- preserves a readable mobile fallback instead of shrinking dense map labels

## Success Criteria

1. The static HTML still contains crawlable fiat and non-geographic cohort links.
2. Desktop/tablet renders a clear fiat geography panel, not a generic card grid.
3. `Gold`, `Silver`, and `CPI` are visually grouped as off-map references with explicit explanatory copy.
4. Small screens retain a usable route-picker layout.
5. Route tests, lint, typecheck, and a Pages-impacting build pass.

## Plan

1. Rework `static-link-hub.tsx` into:
   - desktop geography panel for fiat cohorts
   - shared helper components for map links / sidecar cards
   - mobile region-grid fallback
2. Update `static-link-hub.test.tsx` for the new copy and structure.
3. Update `docs/alt-pegs-page.md` to reflect the new crawlability surface behavior.
4. Validate with targeted tests plus lint, typecheck, and build.
5. Run xhigh GPT-5.4 review subagents on the diff, address findings, and commit.
