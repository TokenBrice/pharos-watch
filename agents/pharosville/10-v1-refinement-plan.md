# PharosVille v1 Refinement Plan

Created: 2026-04-28

## Purpose

Refine the current `/pharosville/` beta from a barebones Canvas 2D island map into a more populated, more alive, more inspectable Pharos data world.

This is not a redesign from scratch. The current route, desktop gate, world model, asset manifest, Canvas 2D renderer, and visual tests are the baseline. ClaudeVille is the inspiration source for world-building, renderer discipline, and sprite-pipeline patterns; PharosVille must remain a precise stablecoin analytics surface, not a fantasy reskin.

## Assumptions

- Keep `/pharosville/` as the public beta route.
- Keep Canvas 2D. Do not introduce Pixi/WebGL or relax CSP.
- Keep the desktop gate: screens below `1280px` wide or `760px` tall must not mount world queries, canvas runtime, manifest fetches, or sprite decoding.
- Use existing data only for the refinement pass: stablecoins, chains, PSI, peg summary, DEWS stress signals, report cards, cemetery entries, and response freshness.
- Every new visual cue needs DOM parity through details, map key, ledger, keyboard navigation, or a visible status surface.
- Motion must encode state or interaction feedback. It should not be decorative noise.

## Swarm Findings

Six read-only subagents explored the current implementation, ClaudeVille, data grammar, motion, UX/accessibility, and implementation sequencing. The useful consensus:

- The active route is `page.tsx` -> `client.tsx` -> `pharosville-desktop-data.tsx` -> `pharosville-world.tsx`.
- The older `harbor-scene-client.tsx`/`layers`/`sprites` stack is not mounted by `/pharosville/`; do not build new work there unless the route is intentionally reactivated or the dead path is cleaned up.
- Docs currently overstate mounted UI. `docs/pharosville-page.md` describes toolbar/minimap/detail surfaces, while visual tests assert toolbar, minimap, and detail panel absence.
- The current canvas feels bare because the mounted UI is almost only canvas + fullscreen, the map has only five fixed buildings, ships expose only a subset of computed visual channels, and `world.effects` is empty.
- ClaudeVille's best transferable pattern is not its fantasy theme; it is the stable data-to-place contract: durable domains become landmarks, active entities become bodies, relationships become paths, recent changes become capped effects, and exact data stays in DOM.

## Product Direction

PharosVille should read as a living maritime risk room:

- The lighthouse is PSI.
- Docks are chains.
- Ships are active stablecoins.
- Ship distance and risk zone are peg/depeg first, with DEWS escalation.
- Weather is aggregate DEWS breadth and data freshness, not generic atmosphere.
- Fog is stale, missing, or low-confidence evidence.
- Cemetery island is dead/frozen asset history.
- DOM panels answer: "why does this look this way?"

The first screen should be self-explaining without turning into a tutorial. The user should see an alive map, sparse but meaningful labels, a visible selection/detail surface, and precise evidence on demand.

## Success Criteria

- Eligible desktop renders a populated canvas plus visible status, detail, and control affordances without overlap at `1440 x 1000`.
- Fallback view below `1280 x 760` still makes zero world runtime/data/asset requests.
- Every selectable entity has a visible or keyboard-accessible detail path.
- Map key and detail panel explain all visual encodings.
- Reduced motion still renders one deterministic frame and does not schedule continuous RAF.
- Normal motion keeps one RAF loop total and reports bounded debug counters.
- Current asset manifest stays under the `34` asset cap unless a separate cap change is approved.
- Visual tests, unit tests, and docs are updated in the same implementation branch.

## Visual Grammar

### Districts

| District | Data | Visual | DOM parity |
| --- | --- | --- | --- |
| Beacon Point | `stability.current` | Lighthouse great-fire hue/intensity, flicker speed, stale/unlit state | PSI score, band, component summary, freshness |
| Chain Docks | `chains.chains[]` | Dock footprint, warehouses, cargo stacks, dock lamps, concentration draft | Supply, rank/share, health, stablecoin count, concentration, top coins |
| Safe Harbor | normal peg/DEWS | Calm inner-water moorings and low-intensity wakes | "No active peg or DEWS stress" evidence |
| Breakwater / Harbor Mouth / Outer Rough / Storm Shelf | peg deviation, active depeg, DEWS | Risk zones, buoys, storm rings, rescue lights | Exact reason, source fields, deviation/stress values |
| Data Fog Bank | stale/missing/low confidence | Static or animated fog patches over affected ships/zones | Stale/missing source group and price confidence |
| Ledger Mooring | NAV tokens missing peg row | Protected quay, ledger marker | NAV explanation before generic fog |
| Cemetery Island | cemetery data | Tombstones, candle/plaque variants, cause/date layout | Cause, date, epitaph/obituary, archive link |
| Peg Horizon | peg cohorts | Distant flags/embassies, secondary context | Cohort counts in key/ledger if rendered |

### Ships

Keep ships active-only. Make existing channels visible before adding new data:

- Position: current `riskPlacement`, refined within-zone offset by deviation bps or DEWS score.
- Scale: market cap using clamped sqrt/log scale rather than only coarse thresholds.
- Hull: backing class (`treasury-galleon`, `crypto-caravel`, `algo-junk`).
- Rigging: governance class.
- Pennant: peg currency, not stress.
- Aura/storm ring: DEWS stress redundancy.
- Wake: recent supply change direction/magnitude; static mark under reduced motion.
- Tether/rope: dominant chain when that chain has a rendered dock.
- Overlay: yield, NAV, watch grade markers.

### Population

Add life as semantic child marks first, not as independent selectable entities:

- Warehouses and cargo stacks on docks from `stablecoinCount` and top stablecoins.
- Watch posts/inspectors for WATCH+ or D/F assets near a dock.
- Ledger clerks for NAV/missing-evidence cases.
- Rescue lights near active depeg/DANGER ships.
- Buoys along risk boundaries.
- Grave candles/plaques for cemetery entries with richer archive metadata.
- Dock lamps and sea glints as capped ambient effects.

If any mark becomes selectable, it must gain a real node, `detailId`, keyboard row, and ledger sentence.

## ClaudeVille Borrow List

Borrow:

- Data-to-place contract from `docs/visual-experience-crafting.md`.
- Manifest-first asset discipline and validation mindset.
- Deterministic identity/placement from stable IDs.
- Sorted drawable pass and strict one-loop Canvas 2D architecture.
- Motion budget thinking: selected > semantic activity > recent event > ambient.
- World canvas / DOM truth separation.

Do not borrow:

- ClaudeVille's fantasy/rune/quest-board brand.
- Its Node/WebSocket runtime.
- Its provider/agent identities or palette.
- Its full particle/weather volume.
- Any canvas-only detail pattern.

Ready-made ClaudeVille assets can be used as visual references for categories such as docks, vegetation, clouds, buoys, props, and terrain. Default implementation should regenerate or restyle Pharos-specific assets through the existing PharosVille manifest pipeline instead of copying the fantasy art wholesale.

## Implementation Phases

### Phase 0 - Reconcile Contract Drift

Goal: make docs, tests, and product intent agree before adding volume.

Tasks:

- Update `docs/pharosville-page.md` to describe the current baseline and the intended v1 refinement.
- Decide explicitly that visible detail/status/control DOM is part of v1.
- Update `tests/visual/pharosville.spec.ts` expectations that currently require toolbar/detail absence.
- Keep the fallback no-request contract unchanged.
- Add a short note in this research pack if the old `harbor-scene-client.tsx` path is retained only as historical code.

Validation:

```bash
npm run check:verified-doc-links
npm run check:doc-source-paths
```

### Phase 1 - Visible DOM Parity And Discoverability

Goal: make the current world understandable and inspectable without changing the map art heavily.

Files:

- `src/app/pharosville/pharosville-world.tsx`
- `src/app/pharosville/pharosville.css`
- `src/app/pharosville/components/detail-panel.tsx`
- `src/app/pharosville/components/map-key.tsx`
- `src/app/pharosville/components/query-status-banner.tsx`
- `src/app/pharosville/components/keyboard-entity-browser.tsx`
- `src/app/pharosville/components/world-toolbar.tsx`
- `tests/visual/pharosville.spec.ts`

Tasks:

- Mount a compact visible status strip with data freshness, PSI band, entity count, and key/detail toggles.
- Mount a persistent detail rail, defaulting to the lighthouse.
- Make the detail panel explain "why this appears here" with source fields, stale state, and links.
- Mount a compact keyboard entity browser, grouped by lighthouse, docks, stressed ships, fogged ships, clusters, and cemetery.
- Make the world shell keyboard-focusable with clear focus behavior.
- Replace raw toolbar labels with icon-first controls from lucide where practical.
- Keep 44px target sizes for controls.
- Improve loading/error/partial-stale messaging through `QueryStatusBanner`.
- Preserve fullscreen behavior.

Acceptance:

- Mouse click, keyboard browser selection, and Escape clear all update selected detail.
- Selection announcement remains polite and not noisy.
- Canvas is not the only path to exact values.

### Phase 2 - World Model Semantic Enrichment

Goal: make the data model capable of a denser world before renderer changes.

Files:

- `src/app/pharosville/systems/world-types.ts`
- `src/app/pharosville/systems/pharosville-world.ts`
- `src/app/pharosville/systems/detail-model.ts`
- `src/app/pharosville/systems/visual-cue-registry.ts`
- `src/app/pharosville/systems/ship-visuals.ts`
- `src/app/pharosville/systems/risk-placement.ts`
- `src/app/pharosville/systems/chain-docks.ts`
- `src/app/pharosville/systems/clustering.ts`
- `src/app/pharosville/systems/world-layout.ts`

Tasks:

- Populate `world.effects` for fog, storm, and recent-change cues.
- Add dock detail fields needed for richer DOM: global share/rank when available, concentration, top stablecoins, and change windows if already in response.
- Add ship detail fields: peg currency, backing, governance, dominant chain, price confidence, current deviation bps, active depeg, DEWS band/score, report-card grade/dimensions, supply change.
- Refine ship scale with tested floor/ceiling.
- Add deterministic child-mark planning data for dock warehouses/cargo/watch posts without making them independently selectable.
- Keep long-tail clustering on water and keep cluster details exact.
- Add/extend visual cue registry entries for every new encoding.

Acceptance:

- Pure model tests prove deterministic output.
- Hostile inputs (`null`, missing rows, stale flags, empty arrays) clamp gracefully.
- The ledger and detail panel can describe every new visual cue.

### Phase 3 - Canvas Population Pass, Code-Drawn First

Goal: make the map visibly richer without taking on asset churn.

Files:

- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/renderer/hit-testing.ts` only if target geometry changes
- `src/app/pharosville/systems/motion.ts` only for static phase/cap data

Tasks:

- Replace five hardcoded buildings with deterministic city/dock scenery derived from world data and authored coordinates.
- Add dock warehouses, cargo stacks, seawalls, lamps, cranes, buoys, and cemetery details as code-drawn pixel forms.
- Draw ship pennants/overlays even when sprite hull assets are used.
- Add static ropes to rendered dominant docks.
- Draw fog/storm/recent-change effects from `world.effects`.
- Add sparse labels: lighthouse PSI band, top dock labels, cluster counts, selected/hovered/stressed ship labels.
- Improve selection rings from rectangle boxes to asset-aware or isometric outlines.
- Keep label count capped and zoom-aware.

Acceptance:

- Pixel stats still show water-dominant scene.
- Dense fixture remains legible at `1440 x 1000`.
- Reduced-motion screenshot is deterministic after visual baseline update.

### Phase 4 - Motion And Life Budget

Goal: add life without making the financial surface feel chaotic.

Files:

- `src/app/pharosville/systems/motion.ts`
- `src/app/pharosville/pharosville-world.tsx`
- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/pharosville.css`

Tasks:

- Keep exactly one RAF loop in normal motion.
- Keep zero continuous RAF in reduced motion after the deterministic draw.
- Make `motion.ts` the single source of animated entity caps, ambient effect caps, and deterministic phases.
- Add debug-only counters to `window.__pharosVilleDebug`: animated entity count, ambient effect count, frame timing, and motion budget version.
- Add subtle lighthouse lantern intensity keyed to PSI.
- Add capped water glints and dock lamp flickers.
- Add selected/hovered one-shot feedback using refs, not per-frame React state.
- Freeze all loops into static marks under reduced motion.

Budgets:

- Animated ships <= `80`.
- Ambient non-ship effects target <= `96` water glints, <= `24` dock lamps, <= `20` fog/storm marks.
- Main canvas backing pixels <= `8,000,000`.
- Total declared backing budget <= `14,000,000`.
- No per-frame React state updates.

### Phase 5 - Asset Batch

Goal: replace the most visible code-drawn primitives with authored Pharos-style sprites.

Files:

- `public/pharosville/assets/manifest.json`
- `public/pharosville/assets/**`
- `scripts/pharosville/validate-assets.mjs` only if schema/cap changes
- `src/app/pharosville/renderer/world-canvas.ts`

Asset priorities, staying under the current `34` asset cap:

- Dock warehouse/cargo stack.
- Dock lamp or beacon buoy.
- Fog patch overlay.
- Storm water/foam overlay.
- Crane or harbor equipment.
- Grave candle/plaque.
- Data-fog ledger marker.
- Risk buoy.
- Optional small vegetation/shore prop.

Rules:

- Bump `style.assetVersion`.
- Keep critical first-render assets minimal.
- No orphan PNGs.
- No generated URLs, tokens, placeholders, or debug assets in production manifest.
- Update visual snapshots only after browser review.

### Phase 6 - Optional Data Layers

Only after Phases 1-5 hold:

- Mint/burn flow cargo markers.
- DEX-liquidity cranes/channels.
- Yield garden or lighthouse side district.
- Blacklist/freezing watch posts.

These require explicit data-source/API/methodology/doc review if they add new data or alter existing methodology behavior. Prefer lazy or selected-entity loading over route-wide per-coin fanout.

## Validation Plan

Focused commands during implementation:

```bash
npm run check:pharosville-assets
npm run check:harbor-palette
npx vitest run src/app/pharosville
npm run build
npx playwright test tests/visual/pharosville.spec.ts
```

For DOM/interaction PRs:

```bash
npx vitest run src/app/pharosville
npm run build
npx playwright test tests/visual/pharosville.spec.ts
```

For final deploy-impacting branch:

```bash
npm run test:merge-gate
```

Worker type checks are needed only if a phase touches `shared/`, `worker/`, API contracts, deploy scripts, or new data-source plumbing.

## Immediate First Slice

Start with Phase 1. It has the highest product leverage and the lowest rendering risk:

- Mount visible detail rail, status/key, and compact toolbar.
- Make keyboard browsing usable.
- Update visual tests to stop asserting absence of detail/toolbar.
- Update `docs/pharosville-page.md` to match actual mounted behavior.

This makes PharosVille more engaging immediately, and it creates the DOM parity needed before richer canvas population can be trusted.
