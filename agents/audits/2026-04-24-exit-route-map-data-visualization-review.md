# Exit Route Map Data Visualization Review

Date: 2026-04-24

Scope: `/liquidity/` Exit Route Map as currently represented by `src/components/exit-route-map.tsx`, `src/components/exit-route-instrument.css`, and the liquidity stats test coverage. This review is against `docs/data-visualization.md`.

## Overall Verdict

The visualization is directionally strong: it uses a concrete routing metaphor, real DEX aggregate fields, SVG, focusable route marks, source caveats, and reduced-motion-gated animation. It is no longer just a decorative Sankey-style card.

The main remaining opportunities are not about adding more effects. They are about making the scene conform to the documented Pharos visualization contract: pure model boundaries, non-linear tested encodings, centralized data-color ownership, first-class mobile/fallback parity, and clearer explanatory scaffolding.

## Highest-Value Opportunities

### 1. Split the view-model and geometry out of the React scene

`docs/data-visualization.md` requires a pure TypeScript view-model boundary before the presentational SVG. The current implementation moved the visualization to its own component file, which helps, but `src/components/exit-route-map.tsx` still mixes API transformation, selection derivation, route scaling, throat geometry, SVG path construction, and React rendering in one file.

Current examples:
- `buildLiquidityExitRouteModel()` lives beside JSX instead of in a pure model module.
- `routeScale()`, `crowdingBand()`, `organicDashArray()`, `balanceRailDashArray()`, label compaction, and path construction are local scene helpers.
- Route path strings and throat geometry are constructed inside `ExitRouteInstrumentScene`.

Recommended improvement:
- Extract a pure model/math module, for example `src/components/exit-route-map-model.ts`.
- Keep `buildLiquidityExitRouteModel()`, route item building, crowding banding, route scale functions, packet counts, dash-state functions, label compaction, and geometry helpers there.
- Leave `exit-route-map.tsx` to render the model and own interaction state.

Why it matters:
- This brings the module in line with the doc's pure view-model rule.
- It makes floors, ceilings, scaling, and malformed-input behavior easy to test without DOM rendering.
- It lowers the risk of future visual changes accidentally changing liquidity semantics.

### 2. Replace the linear route scale with tested non-linear scaling

`docs/data-visualization.md` says magnitude channels should be non-linear because stablecoin and chain data spans many orders of magnitude, and every size needs explicit floors and ceilings with tests. The current `routeScale(sharePct, min, max)` is a linear clamp from `0` to `45`.

Current issue:
- A route at `49%` and a route at `80%` both hit the same visual max.
- Mid-tail values can still compress too tightly.
- The scaling helper is not exported or directly tested.

Recommended improvement:
- Use a documented non-linear function for width, stroke, packet radius, and lane height, likely `sqrt(sharePct / domainMax)` or a piecewise scale by share band.
- Preserve explicit floors and ceilings for every size channel.
- Add tests for monotonicity, floor, ceiling, NaN/null/negative handling, and oversized shares.

Why it matters:
- The visual shape becomes more truthful across skewed DEX depth distributions.
- Future snapshots with one dominant chain or venue will not flatten meaningful differences.

### 3. Add a visible legend/encoding rail for the scene grammar

The doc requires outside-scene scaffolding: kicker, section title, freshness line, legend rail, methodology labels for coined terms, and a caveat line. The current card has a title, a caveat, and useful metric plates, but the encoding grammar is mostly implicit.

Current issue:
- Users have to infer that aperture width/lane width = TVL share.
- Users have to infer that throat width = HHI crowding.
- Users have to infer that rail/dash pattern relates to pool balance and organic quality.
- "Protocol doors", "chain lanes", and "crowding" are metaphor terms, but they are not defined with `MethodologyLabel` or a compact encoding key.

Recommended improvement:
- Add a small legend rail, not another heavy card: "door/lane width = share", "throat squeeze = crowding", "flow clarity = organic", "rail breaks = pool balance".
- Wrap coined or methodology-sensitive terms such as crowding, organic, and pool balance with the existing methodology hint component if a matching topic exists.
- Include a freshness line if the liquidity data hook exposes update cadence/timestamp.

Why it matters:
- It reduces first-read ambiguity without weakening the metaphor.
- It makes the chart understandable from the page alone, which is one of the doc's explicit requirements.

### 4. Correct the SVG accessibility root role and improve fallback parity

The doc says the SVG root should be `role="img"` with a stateful summary, while primary marks remain focusable buttons. The current root SVG uses `role="group"`, with focusable route marks inside. That makes interactive access possible, but it does not match the documented atomic scene summary pattern.

Current issue:
- The root role is `group`, not `img`.
- Decorative section labels in the SVG are not explicitly `aria-hidden`.
- There is no parallel linear fallback list below the small-screen breakpoint.
- Mobile behavior currently preserves the SVG through horizontal scrolling, but it does not provide first-class linear feature parity.

Recommended improvement:
- Decide whether this should be an atomic image plus a separate interactive list, or an interactive group. If keeping interactive SVG marks, update `docs/data-visualization.md` or the implementation so the contract is explicit.
- Add an accessible route list/fallback with the same top protocol routes, chain lanes, values, shares, and selected state.
- Mark decorative SVG headings and purely atmospheric text `aria-hidden`.

Why it matters:
- This is the largest standards mismatch in the current implementation.
- A linear fallback is especially useful on mobile, where the current scene can require horizontal panning before the user understands both sides.

### 5. Add coarse-pointer/touch interaction rules

The doc calls for pointer-aware interaction: fine pointer hover/click, coarse pointer tap-to-preview/tap-to-commit when navigation or destructive actions are involved. The current marks update selection on `onMouseEnter`, `onFocus`, `onClick`, and keyboard activation, but there is no coarse-pointer-specific behavior.

Recommended improvement:
- Add a small interaction helper that can distinguish fine/coarse pointer behavior.
- At minimum, ensure touch targets are explicitly large enough and test that tapping a route updates the selected route without accidental page scroll conflict.
- Consider snap points for protocol side, throat, and chain side if the SVG stays horizontally scrollable on phones.

Why it matters:
- The current desktop interaction is sound, but mobile is still a scaled desktop scene rather than a deliberately adapted touch experience.

### 6. Centralize and test data color ownership

The doc allows local atmospheric palettes but says data colors should come from centralized token maps, with explicit unknown fallbacks. The scene imports protocol and chain color constants, which is good, but it also defines `EXTRA_HEX` locally and uses inline fallback hex values for tail/unknown routes.

Recommended improvement:
- Move deterministic long-tail accent generation or fallback route colors into `dex-display-constants` or a dedicated token/helper module.
- Prefer deterministic OKLCH hues for unknown protocol/chain ids, as described in the doc, instead of rotating a local array.
- Add tests that unknown protocols/chains get stable colors and that the "Other routes" fallback is intentional.

Why it matters:
- New route ids should remain stable across sessions and deployments.
- This avoids local color drift as more visualizations reuse the same entities.

### 7. Expand tests from structural rendering to visualization invariants

The existing tests cover model derivation, packet buckets, route rendering, logos, selected panel updates, and basic ARIA pressed state. That is useful, but the data-visualization doc asks for model invariants rather than snapshots.

Recommended additions:
- `routeScale` monotonicity, floor, ceiling, invalid input handling.
- `crowdingBand` thresholds including boundary values.
- `organicDashArray` and `balanceRailDashArray` semantics.
- compact-label behavior with full accessible label retained.
- root scene role/summary and decorative layer `aria-hidden` contract.
- interaction callback coverage for Enter and Space, not just focus and Enter.

Why it matters:
- These tests defend the data-to-visual grammar instead of only defending that the SVG exists.

### 8. Reduce the "AI dashboard" risk with more analytical restraint

The visual is substantially better than generic AI dark-card work, but a few tells remain: dark cyan instrument mood, glow-heavy selected state, metric cards to the side, and a dominant hero number in the center. These are not blockers, but they can make the surface feel more like a sci-fi dashboard than Pharos' precise analytical language.

Recommended improvement:
- Keep the routing-console metaphor, but tune the selected glow down and lean more on line weight, labels, and selection panel details.
- Treat the right rail as an instrument key instead of standalone KPI cards.
- Make the central `$6B` feel like a measured throughput inside the throat, not the hero of the whole module.

Why it matters:
- Pharos' strongest visualizations use metaphor to clarify structure. The exit map should remain a data instrument first.

## What Is Already Working

- The metaphor has the right data polarity: protocol entrances, central exit throat, and chain lanes map well to the available aggregate data.
- The implementation uses existing DEX liquidity data and does not imply unavailable protocol-by-chain edges.
- Source and caveat copy correctly avoid conflating secondary DEX exits with issuer redemption.
- The SVG is real DOM, not canvas.
- Primary marks are keyboard-focusable with selected state.
- Animation is CSS-based and gated by `prefers-reduced-motion`.
- Tail routes remain visible through the "Other routes" bucket.

## Suggested Execution Order

1. Extract and test the model/math helpers.
2. Fix scale semantics and add invariant tests.
3. Add legend rail/methodology scaffolding.
4. Add mobile/fallback list and pointer-aware touch handling.
5. Normalize color fallback ownership.
6. Polish visual restraint and verify with desktop/mobile screenshots.

This order keeps correctness and legibility ahead of aesthetic tuning.
