# Risks And Validation

Note: `08-implementation-plan.md` is the current source of truth for v0.1 acceptance gates. This file has been reconciled for `/pharosville/` replacement and desktop-only world scope, but defer to `08` where details differ.

## Major Risks

### 1. Decorative Map Instead Of Analytical Tool

Risk:

The page looks impressive but users cannot infer meaningful stablecoin state.

Mitigation:

- Lock a data-to-visual contract before art generation.
- Require every canvas element to map to a data field or navigation role.
- Keep exact values in DOM detail panels.
- Test with real Pharos data, not only fixtures.

### 2. Too Many Stablecoins

Risk:

215+ boats make the world unreadable.

Mitigation:

- Top assets as individual ships.
- Long-tail fleet clusters by chain/risk/type.
- Zoom and filters reveal more detail.
- DOM ledger always lists complete counts.
- Never animate all ships at once.

### 3. Misleading Risk Placement

Risk:

A stablecoin appears safe or dangerous due to missing or stale data rather than actual peg status.

Mitigation:

- Missing data gets a distinct fog/customs state.
- Stale endpoint metadata affects district fog/warnings.
- Detail panel shows data age and source status.
- Unit tests cover missing peg summary, missing DEWS, stale report cards.

### 4. Narrow-Screen Failure

Risk:

ClaudeVille is desktop-only, and PharosVille v0.1 intentionally does not render the world below `1280px`. Users can still hit the route on smaller screens.

Mitigation:

- Render a polished DOM desktop-only fallback below `1280px`.
- Do not mount the query-backed world component below `1280px`.
- Do not fetch the asset manifest, decode sprites, or initialize canvas below `1280px`.
- Include links to existing analytical pages.
- Playwright fallback screenshot and request-block assertions required.

### 5. Canvas Accessibility

Risk:

Screen-reader and keyboard users lose the page's meaning.

Mitigation:

- Canvas is decorative/interactive but not sole content.
- DOM ledger mirrors visual encodings.
- Keyboard list selects entities.
- Detail panel uses semantic HTML.
- Motion can be disabled.

### 6. Asset Inconsistency

Risk:

Pixellab-generated assets vary in perspective, palette, or readability.

Mitigation:

- Manifest-first workflow.
- Small asset batches.
- Shared style anchor.
- Actual-size review in browser.
- Asset validator.
- Versioned cache busting.

### 7. Performance

Risk:

Large canvas, DPR, many sprites, and particles degrade frame rate.

Mitigation:

- DPR cap.
- Terrain cache.
- Visible tile culling.
- Cluster low-priority ships.
- Cap particles.
- Pause when hidden.
- Use reduced-motion static mode for deterministic visual tests.

### 8. API Overfetching

Risk:

The page loads too many endpoints or per-coin histories.

Mitigation:

- Use aggregate endpoints only in v1.
- No per-coin history/detail fetches in canvas.
- Respect existing hook stale/refetch timing.
- Link to detail pages for deep dives.

## Validation Matrix

| Area | Validation |
| --- | --- |
| Data adapter | Unit tests for normal, missing, stale, overloaded, and fixture inputs |
| Map layout | Invariant tests for water ratio, required districts, no dock overlap |
| Projection | Tile-to-screen and screen-to-tile roundtrip tests |
| Hit testing | Click tests for ships, docks, lighthouse, graves, clusters |
| Clustering | Deterministic clusters and max visible ship count |
| Asset manifest | Existence, dimensions, anchors, version, no production placeholders |
| Accessibility | Keyboard selection path and DOM ledger assertions |
| Reduced motion | Deterministic screenshot and no active tweens |
| Performance | Canvas pixel budget, entity caps, manual FPS profiling |
| Visual quality | Playwright screenshot baselines for desktop world and `<1280px` fallback |
| Build | `npm run build`, `npm run lint`, `npm test`, `npm run test:merge-gate` |

## Acceptance Criteria For MVP

- The map visibly reads as a sea-first island city with roughly 86% water.
- Lighthouse is the central visual anchor and accurately reflects PSI.
- Major chains appear as docks sized by stablecoin TVL.
- Top stablecoins appear as distinct ship classes.
- Peg-risk placement is understandable without reading docs.
- Dead/frozen stablecoins appear in a cemetery area.
- All visual encodings are documented in the DOM ledger.
- Selecting any visible major entity opens exact data.
- Long-tail stablecoins are represented through clusters, not lost.
- Page renders the full world on desktop and a clear no-runtime fallback below `1280px`.
- Reduced-motion mode is stable and readable.
- No Pixellab secrets are shipped client-side.
- No new Worker endpoint is required for MVP.
