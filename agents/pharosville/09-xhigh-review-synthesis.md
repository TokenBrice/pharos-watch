# XHigh Review Synthesis

Created: 2026-04-28

## Review Setup

Five xhigh reviewers examined `08-implementation-plan.md` from independent angles:

- product and data semantics
- frontend architecture and repo integration
- Canvas rendering and performance
- accessibility, UX, and interaction design
- art direction and Pixellab asset pipeline

The review verdict was conditional go. The concept is feasible and compelling, but v0.1 needs stricter sequencing and guardrails so the map remains analytical, accessible, performant, and shippable.

## Corrections Applied To The Plan

### Product And Data Semantics

- `08` is now the source of truth: PharosVille owns `/pharosville/`; `/lighthouse/` is legacy redirect-only.
- Production must never render fixture/default market data as live analytics.
- Risk placement now uses per-source freshness instead of a global stale flag.
- NAV missing peg summary is handled before generic missing-data fog.
- Deviation thresholds are explicitly absolute bps.
- PSI, DEWS, and peg semantics are separated:
  - lighthouse = PSI composite
  - ship distance = peg/depeg first, with DEWS escalation
  - weather = aggregate DEWS breadth
- Chain dock footprint uses `totalUsd`; crowded/dominant cues use `dominantStablecoin.share` or `healthFactors.concentration`, not global `dominanceShare`.
- Optional-data districts are navigation-only or dimmed in v0.1 unless the matching hook is loaded.
- Recent-change cues include both absolute and percentage movers with minimum-dollar thresholds.
- `ship-visuals.ts` and `visual-cue-registry.ts` are now explicit plan artifacts.

### Frontend Integration

- Docs, public docs registry, LLM output, smoke expectations, and visual tests must update in the same PR that changes `/pharosville/`.
- A pure model PR can land first only if it is unused by the public route.
- The desktop gate now precedes query hooks, world model creation, canvas loading, manifest fetch, and sprite decode.
- The plan now calls out `shared/lib/public-docs.ts`, `docs/README.md`, `docs/scripts.md`, and `scripts/lib/validate-contract.mjs`.
- Dynamic browser-only canvas loading must happen from a Client Component, not through `ssr:false` in the Server Component.
- Visual route mocks must cover both `/api/*` and `/_site-data/*` forms.

### Rendering And Performance

- V0.1 is smaller and concrete: placeholder Canvas 2D, basic camera, culling, clustering, DOM parity, reduced-motion deterministic render, and visual/perf tests.
- Full sprite coverage and rich motion move to v0.1.x/v0.2 unless the baseline is already stable.
- Minimal `camera.ts` moved into the first canvas milestone so culling is testable.
- Canvas budget ownership is centralized in `systems/canvas-budget.ts`.
- Numeric backing-store caps were added.
- Mount lifecycle now includes `ResizeObserver`, `visibilitychange`, desktop `matchMedia`, context loss/restore, and cache release by zeroing offscreen canvases.
- Reduced motion is invalidation-driven through `requestRender()` / `needsContinuousFrame()`.
- Entity caps now cover visible ships, graves, labels, hit-test candidates, animated entities, and overflow clustering.

### Accessibility And UX

- DOM parity moved into the first selectable canvas milestone.
- The page needs `accessibility-ledger`, `map-key`, `keyboard-entity-browser`, and `detail-panel` before interactive canvas release.
- Keyboard selection and focus behavior are deterministic:
  - pointer selection keeps focus and announces via `aria-live`
  - keyboard selection moves focus to the detail heading
  - Escape clears selection and returns focus to the origin
  - filter/data refresh removal clears or preserves selection predictably
- Detail panels must answer "why this appears here" with exact source fields, timestamps, confidence, and links.
- Toolbar/detail controls require 44px targets; canvas hit slop should be at least 24px where sprites are smaller.
- The map key must explain the visual grammar in-app.

### Art And Pixellab Pipeline

- V0.1 core art target is 28-34 assets; 45-60 is a later ceiling.
- The manifest schema is now explicit with root style/version/defaults and per-asset anchor, footprint/hitbox, load priority, prompt, and provenance fields.
- Tile generation should use a `64 x 32` isometric slot and `128 x 128` 4x4 Wang sheets where appropriate.
- Anchor semantics are defined before asset generation.
- Critical/deferred staged sprite loading is required.
- Production validation fails for missing required sprites; checkerboards are dev diagnostics only.
- Pixellab guardrails now reject public tokens, generated URLs, unsafe manifest content, bad PNGs, path traversal, duplicates, and asset sprawl.
- Asset visual gates include actual-scale contact sheets and focused screenshots before baseline updates.

## Remaining Implementation Decisions

- Whether beta `/pharosville/` should remain in sitemap/LLM exports while `noindex,follow` is active. The plan allows it only if docs call out beta status.
- Whether PR 0 lands as an unused model-only slice or PR 1 performs the first route-visible replacement with docs/tests in the same change.
- Whether the first production art pass ships in v0.1 or waits for v0.1.x after placeholder renderer validation.

## Bottom Line

The revised plan is more constrained than the original, but stronger. V0.1 should optimize for a clear, data-correct, inspectable island-city prototype with excellent structure, not for maximum sprite volume or motion. Once the world model, renderer budgets, DOM parity, and visual tests hold, the asset pass can safely make the experience look exceptional without weakening correctness.
