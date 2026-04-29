# PharosVille Sea Zones And Ship Motion Comprehensive Plan

Date: 2026-04-29
Status: reviewed and revised plan; no runtime code changed

## Request

Settle PharosVille sea-zone design, sea-zone function, interaction behavior, and
Stablecoin-Ship movement logic.

The requested target state is:

1. Stablecoin-Ships normally move around the map, visiting harbors/chains where
   they have positive presence.
2. When ships are idle, they sit in the current DEWS-associated sea zone, or in
   Ledger Mooring for NAV stablecoins.
3. The five DEWS zones are:
   - Calm Anchorage for `CALM`, biggest
   - Watch Breakwater for `WATCH`, large
   - Alert Channel for `ALERT`, medium
   - Warning Shoals for `WARNING`, small
   - Danger Strait for `DANGER`, small
4. Each DEWS zone needs a distinct visual identity that gets more dramatic as
   DEWS severity rises.
5. Sea placement must preserve a neutral navigation path around the island.
6. Every zone must be adjacent to a map corner.
7. All five DEWS zones must be north of the island, above the island.
8. Ledger Mooring can live below the island.
9. Data Fog is unneeded and should be clearly removed.

## Assumptions

- This is a PharosVille-only route/world-model/renderer/test/docs change. It
  should not change Worker APIs, D1, DEWS formulas, stablecoin data, or mobile
  support.
- "North of the island" means DEWS region tiles, label tiles, ship anchors,
  terrain masks, and cluster bases sit above the current island land top bound
  (`min land y` is currently about `17`). A practical first invariant is
  `y <= 16` for authored DEWS placement points and semantic DEWS terrain.
- "Every zone must be adjacent to a corner" is a hard layout requirement, not a
  loose connected-component requirement. Implement it as a literal corner-edge
  adjacency contract: every named zone must include a connected semantic-water
  tile that is cardinally or diagonally adjacent to one of the four map corner
  tiles, or to a fixed `2 x 2` corner-adjacent slot that directly touches that
  corner. If exact adjacency makes the layout unusable in browser screenshots,
  pause and ask for product approval instead of silently weakening the rule.
- The neutral route around the island should be generic navigable water, not
  DEWS-colored terrain. DEWS and Ledger zones may touch corner-adjacent
  perimeter slots, but must not form a semantic wall around the island.
- Removing Data Fog means removing the named area, terrain ownership, ship risk
  placement, motion zone, details, accessibility ledger row, hit target, tests,
  and docs. Decorative fog or haze may remain only if it is non-analytical and
  not called Data Fog.
- Data quality remains real product information after Data Fog is removed. It
  should become an evidence caveat on ships/details/ledger, not a named sea
  zone.

## Success Criteria

- The only named risk-water areas are the five DEWS zones plus Ledger Mooring.
- There is no `data-fog` placement, `fog` ship water zone, Data Fog detail,
  Data Fog label, Data Fog hit target, Data Fog accessibility row, or Data Fog
  visual-test expectation.
- All five DEWS zones are visibly north of the island and are ordered as an
  escalation field from broad protected water to storm strait.
- Calm Anchorage is the largest DEWS terrain area; Watch Breakwater is large;
  Alert Channel is medium; Warning Shoals and Danger Strait are small.
- Every named zone satisfies the literal corner-edge adjacency contract and
  does not block the generic perimeter route around the island.
- Ledger Mooring remains below the island in an owned `ledger-water` basin and
  stays clear of top-chain harbor traffic.
- Normal-motion ships visibly move, visit rendered positive-chain harbors, and
  return to their current risk zone. For every ship with rendered dock visits,
  deterministic route samples over a full cycle must include at least one
  `departing`, `arriving`, or `sailing` state and must visit every scheduled
  rendered dock over bounded repeated cycles. Idle/reduced-motion ships sit in
  DEWS risk water or Ledger Mooring, not at harbor moorings.
- Canvas rendering, hit testing, selected/follow behavior, detail panels, debug
  state, and accessibility ledger all sample the same motion model.
- Focused unit tests, palette/assets checks, and PharosVille Playwright visual
  checks pass before completion is claimed.

## Sources Reviewed

Core docs:

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-and-api-limits.md`
- `docs/design-context.md`
- `docs/design-language.md`
- `docs/design-tokens.md`
- `docs/pharosville-page.md`
- `docs/data-visualization.md`

Agent docs:

- `agents/pharosville/CURRENT.md`
- `agents/pharosville/MOTION_POLICY.md`
- `agents/pharosville/VISUAL_INVARIANTS.md`
- `agents/pharosville/SCENARIO_CATALOG.md`
- `agents/pharosville/TESTING.md`
- existing untracked plans:
  - `agents/plans/2026-04-29-pharosville-dews-sea-zone-reallocation-plan.md`
  - `agents/plans/2026-04-29-pharosville-sea-zone-layout-next-plan.md`

Code/test surfaces:

- `src/app/pharosville/pharosville-desktop-data.tsx`
- `src/app/pharosville/pharosville-world.tsx`
- `src/app/pharosville/systems/world-types.ts`
- `src/app/pharosville/systems/risk-water-areas.ts`
- `src/app/pharosville/systems/world-layout.ts`
- `src/app/pharosville/systems/risk-placement.ts`
- `src/app/pharosville/systems/risk-water-placement.ts`
- `src/app/pharosville/systems/pharosville-world.ts`
- `src/app/pharosville/systems/area-labels.ts`
- `src/app/pharosville/systems/motion.ts`
- `src/app/pharosville/systems/clustering.ts`
- `src/app/pharosville/systems/detail-model.ts`
- `src/app/pharosville/systems/visual-cue-registry.ts`
- `src/app/pharosville/systems/palette.ts`
- `src/app/pharosville/components/accessibility-ledger.tsx`
- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/renderer/geometry.ts`
- `src/app/pharosville/renderer/hit-testing.ts`
- `tests/visual/pharosville.spec.ts`

Research subagents covered topology, motion/interaction, visual design,
verification/docs, and product semantics/accessibility.

## Specialist Review Pass

After the draft plan was written, five specialist reviewers checked it:

- Prompt-adherence review: failed the first draft on softened corner adjacency
  and insufficiently measurable "often move" behavior. The revised plan now
  treats literal corner-edge adjacency and normal-motion transit as hard
  requirements.
- Topology review: requested dynamic land-bound checks, neutral-terrain
  connectivity via `terrainKindAt()`, fixed corner slots, top-corridor
  coverage, rendered label-anchor checks, cluster checks, and dock-mooring
  clearance. These are now included.
- Motion/interaction review: requested risk-zone idle placement, no `ship.tile`
  harbor overloading, detail/ledger copy changes, stronger moving-target tests,
  and cluster evidence aggregation. These are now included.
- Visual review: requested renderer-function-specific instructions,
  `THREAT_BAND_HEX`-backed palette constants, label readability/occlusion
  tests, caps on danger visuals, and a label typography decision. These are now
  included.
- Test/docs review: requested mandatory updates for old Data Fog tests/docs,
  missing targeted test lanes, doc checks, and snapshot workflow notes. These
  are now included.

## Current State

PharosVille currently uses a solid source-of-truth split:

- `risk-water-areas.ts` defines placement keys, labels, DEWS mappings, region
  tiles, label tiles, terrain, valid terrain, motion zones, anchors, and scatter
  radius.
- `world-layout.ts` makes those zones real terrain via predicates inside
  `terrainKindAt()`.
- `risk-placement.ts` maps active depeg, peg deviation, NAV, DEWS stress, stale
  evidence, and missing/low-confidence evidence to `ShipRiskPlacement`.
- `pharosville-world.ts` builds areas and ships, assigning each ship a
  `riskTile`, `riskPlacement`, `riskZone`, and `riskWaterLabel`.
- `motion.ts` builds route plans from each ship's dock visits and risk tile.
- `geometry.ts` and `hit-testing.ts` consume current motion samples.
- `detail-model.ts` and `accessibility-ledger.tsx` provide DOM truth for the
  canvas encoding.

Current placements conflict with the new request:

| Area | Current issue |
| --- | --- |
| Calm Anchorage | Region and anchors are west/southwest of island, not north of it. |
| Watch Breakwater | Partly in the top sea, but still reaches toward the central/lighthouse lane. |
| Alert Channel | Mostly north and usable. |
| Warning Shoals | North, but must keep clear of lighthouse label/sprite occlusion. |
| Danger Strait | North/top-right and close to target. |
| Data Fog | Still a full risk placement, area, terrain, motion zone, label, detail, ledger row, cluster group, and visual-test expectation. |
| Ledger Mooring | Already bottom-right/below-island with `ledger-water`; should remain but be checked against neutral route and harbor-clearance rules. |

Reduced motion currently parks docked ships at primary harbor moorings. That
conflicts with the new idle rule. Normal motion already cycles between dock
stops and risk water, but the route can be tuned so movement reads as the normal
state and risk-zone dwell reads as idle.

## Target Product Model

### Named Zones

The route should expose exactly six named sea zones:

| Zone | Type | Function |
| --- | --- | --- |
| Calm Anchorage | DEWS `CALM` | Broad northern protected basin for calm ships. |
| Watch Breakwater | DEWS `WATCH` | Large guarded northern perimeter water for early stress. |
| Alert Channel | DEWS `ALERT` | Medium directional channel that visually tightens the route. |
| Warning Shoals | DEWS `WARNING` | Small hazardous shoal field with sharper texture and reduced area. |
| Danger Strait | DEWS `DANGER` | Small storm strait at the severe end of the northern route. |
| Ledger Mooring | NAV exception | Quiet below-island basin for NAV tokens missing standard peg-summary rows. |

Data Fog should not be replaced by another named stale-data zone.

### Evidence Quality Without Data Fog

Preferred implementation:

- Remove evidence quality from sea-zone identity.
- Keep evidence quality in `PlacementEvidence` and expose it in ship detail
  facts and accessibility-ledger rows.
- Route stale, missing, or low-confidence non-NAV ships by the best available
  current risk signal:
  1. If there is a fresh active depeg or fresh peg deviation, use the existing
     depeg/deviation placement.
  2. If there is a fresh DEWS stress row, use that DEWS band placement.
  3. If no fresh risk row exists, place the ship in Calm Anchorage with an
     explicit evidence caveat such as `Evidence status: missing or
     low-confidence`. This avoids inventing a non-DEWS zone while preserving
     DOM truth that the placement is data-limited.
- NAV tokens without standard peg-summary rows continue to use Ledger Mooring
  before generic missing-evidence handling.

Rejected alternatives:

- Mapping stale evidence to Watch Breakwater would make Watch no longer mean
  DEWS `WATCH`.
- Keeping an internal hidden `data-fog` placement would preserve old complexity
  and violate the request to clearly remove Data Fog.
- Merging stale evidence into Ledger Mooring would corrupt the NAV-specific
  meaning of Ledger Mooring.

### Sea Topology

Implementation should re-author the DEWS field as a northern perimeter band:

- Calm Anchorage: northwest/northwest-center, largest, adjacent to the
  northwest corner by a connected semantic-water corner slot.
- Watch Breakwater: north/northwest perimeter, large, adjacent to the northwest
  or northeast corner by a connected semantic-water corner slot.
- Alert Channel: north-center, medium, adjacent to a top-left or top-right
  corner slot by a connected semantic-water spur and connected to both
  lower-risk and higher-risk DEWS neighbors.
- Warning Shoals: north/northeast, small, adjacent to the northeast corner
  by a connected semantic-water corner slot and clear of the lighthouse
  sprite/label lane.
- Danger Strait: far north/northeast, small, adjacent to the northeast corner
  by a connected semantic-water corner slot.
- Ledger Mooring: below island, adjacent to a lower map corner by a connected
  semantic-water corner slot, preferably southeast or lower-right if it stays
  clear of the EVM bay and top-chain docks.

The generic perimeter route should remain open around the island:

- Keep a generic-water ring west, south, east, and north/northeast of island
  land. Because all DEWS zones move north, the top corridor must be tested as
  deliberately as the west/south/east corridors.
- Test neutral route connectivity using `terrainKindAt()`, not `tileKindAt()`.
  `tileKindAt()` collapses semantic water to canonical `water`, so it can hide
  a route that actually crosses DEWS or Ledger terrain. Define an explicit
  neutral-terrain allowlist such as `water`, `deep-water`, and intentionally
  allowed `harbor-water`.
- Do not let semantic DEWS terrain occupy the lighthouse west/south clearance
  lane.
- Do not let Ledger Mooring form a bottom semantic wall. It should be a small
  owned basin with generic water around it.

### First-Pass Geometry Direction

Do not treat these as art-approved final coordinates. They are implementation
starting points to validate with screenshots and tests:

| Zone | Initial region direction | Size direction |
| --- | --- | --- |
| Calm Anchorage | Broad northwest/top-left basin above `y <= 16`, with label readable left of center. | Largest DEWS area. |
| Watch Breakwater | Large top-left/top-center belt above island, separate from Calm by texture and label. | Large, smaller than Calm. |
| Alert Channel | Narrower top-center directional channel. | Medium. |
| Warning Shoals | Top-right shoal field, north of lighthouse footprint. | Small. |
| Danger Strait | Far top-right storm water, near but not under the lighthouse/beam. | Smallest or tied-small. |
| Ledger Mooring | Bottom/right or bottom-center ledger basin below the island. | Small exception basin. |

The exact coordinate set should be chosen after adding failing topology tests,
because the current `56 x 56` map has a tight top band around the northeast
lighthouse headland.

Do not preserve the old DEWS tile counts. The current west/south Calm and Watch
areas are too large to move wholesale into the `y <= 16` northern band while
leaving a neutral top corridor. First-pass target ranges should be expressed as
ratios or broad counts inside the final northern DEWS field, for example:

| Zone | First-pass size target |
| --- | --- |
| Calm Anchorage | About 30-40% of DEWS semantic-water tiles; still the largest zone. |
| Watch Breakwater | About 22-30%; clearly large but smaller than Calm. |
| Alert Channel | About 15-22%; medium transition zone. |
| Warning Shoals | About 8-14%; small. |
| Danger Strait | About 6-12%; small and not larger than Warning unless screenshots require a tied-small terminal strait. |

These ranges should leave enough neutral `terrainKindAt()` water to route
around the island and through the top perimeter.

## Implementation Plan

### Phase 0 - Baseline And Guardrails

Tasks:

- Confirm current dirty files with `git status --short --untracked-files=all`.
  Do not overwrite the existing untracked plan files.
- Capture current area coordinates, land bounds, terrain counts, and rendered
  screenshot before editing.
- Add or update tests before changing geography so the current implementation
  fails the new request:
  - no `Data Fog` in area/source/type surfaces;
  - all DEWS region tiles, label tiles, rendered label anchors from
    `areaLabelPlacementForArea()`, ship anchors, cluster tiles, and semantic
    terrain tiles are north of dynamic `minLandY`;
  - Ledger Mooring terrain, region tile, label tile, rendered label anchor, and
    ship anchors are below dynamic `maxLandY`;
  - DEWS terrain area sizes follow the target ratio bands and ordering without
    preserving old counts;
  - each named zone has literal corner-edge adjacency through a fixed
    corner-adjacent slot, not merely through a large connected water component;
  - generic neutral perimeter terrain remains connected around the island,
    including the north/top corridor;
  - Ledger Mooring remains below island and clear of both dock tiles and actual
    computed dock mooring traffic.
- Add movement guardrails before changing motion:
  - every normal-motion ship with rendered dock visits has `departing`,
    `arriving`, or `sailing` samples over a cycle;
  - repeated cycles visit every scheduled rendered dock;
  - reduced-motion samples for DEWS and Ledger ships resolve to risk water, not
    harbor moorings.

Acceptance:

- Tests encode the new target before implementation changes begin.
- The plan owner can point to which tests fail on the pre-change code.

### Phase 1 - Remove Data Fog As Product Semantics

Owned files:

- `src/app/pharosville/systems/world-types.ts`
- `src/app/pharosville/systems/risk-water-areas.ts`
- `src/app/pharosville/systems/world-layout.ts`
- `src/app/pharosville/systems/risk-placement.ts`
- `src/app/pharosville/systems/pharosville-world.ts`
- `src/app/pharosville/systems/area-labels.ts`
- `src/app/pharosville/systems/motion.ts`
- `src/app/pharosville/systems/clustering.ts`
- `src/app/pharosville/systems/detail-model.ts`
- `src/app/pharosville/systems/visual-cue-registry.ts`
- `src/app/pharosville/systems/palette.ts`
- `src/app/pharosville/systems/palette.test.ts`
- `src/app/pharosville/components/accessibility-ledger.tsx`
- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/renderer/hit-testing.test.ts`
- `src/app/pharosville/systems/pharosville-world.test.ts`
- `src/app/pharosville/systems/risk-placement.test.ts`
- `src/app/pharosville/systems/motion.test.ts`
- `src/app/pharosville/systems/clustering.test.ts`
- `src/app/pharosville/systems/visual-cue-registry.test.ts`
- `tests/visual/pharosville.spec.ts`

Tasks:

- Remove `data-fog` from `ShipRiskPlacement`.
- Remove `fog` from `ShipWaterZone`.
- Remove Data Fog from `SHIP_RISK_PLACEMENTS` and `RISK_WATER_AREAS`.
- Remove `isDataFog()` and `brackish-water` as an analytical terrain if it is
  now unused. If brackish remains for purely decorative non-analytical terrain,
  remove all Data Fog naming and cue semantics.
- Remove or rename unused `fog-water`, `brackish` texture paths, `riskWaterAreaColor("fog")`,
  and renderer branches so no remaining code visually implies a stale-evidence
  sea district.
- Remove Data Fog label placement, detail rows, accessibility rows, hit-target
  expectations, cluster cases, motion cases, and visual-test entries.
- Reword visual cue registry strings that currently mention data fog as a
  failure state.
- Update `resolveShipRiskPlacement()` so stale/missing/low-confidence evidence
  follows the evidence-quality model above.
- Add explicit detail/ledger facts for stale, missing, or low-confidence
  evidence so users do not infer that calm placement means high data confidence.

Acceptance:

- `rg -n "Data Fog|data-fog|risk zone fog|\\bfog\\b" src/app/pharosville tests/visual docs agents/pharosville`
  returns only allowed non-analytical prose or no matches, after intentional
  docs updates.
- Current tests no longer assert Data Fog in `risk-water-areas`, `world-layout`,
  `risk-placement`, `motion`, `clustering`, `hit-testing`, `visual-cue-registry`,
  `pharosville-world`, or `tests/visual/pharosville.spec.ts`.
- Missing/low-confidence non-NAV ships still build, render, and expose evidence
  caveats.
- NAV missing-peg-summary ships still route to Ledger Mooring.

### Phase 2 - Re-Author Northern DEWS Geography

Owned files:

- `src/app/pharosville/systems/risk-water-areas.ts`
- `src/app/pharosville/systems/world-layout.ts`
- `src/app/pharosville/systems/risk-water-placement.ts`
- `src/app/pharosville/systems/area-labels.ts`
- `src/app/pharosville/systems/world-layout.test.ts`
- `src/app/pharosville/systems/risk-water-areas.test.ts`
- `src/app/pharosville/systems/area-labels.test.ts`

Tasks:

- Move Calm Anchorage region, label, anchors, scatter radius, and terrain mask
  into the north/northwest sea.
- Move Watch Breakwater fully north of the island.
- Keep Alert Channel north-center but retune it to sit between Watch and
  Warning without entering the lighthouse clearance lane.
- Keep Warning Shoals and Danger Strait top-right, but validate full label and
  sprite clearance against the lighthouse.
- Keep Ledger Mooring below the island in `ledger-water`, with generic water
  around it.
- Update terrain predicates in the same patch as area constants so labels,
  anchors, and terrain never drift apart.
- Add literal corner-edge adjacency helpers to tests. Suggested implementation:
  - define fixed corner-adjacent slots around each corner rather than searching
    one large generic-water component;
  - assert every named zone has at least one connected semantic-terrain tile in
    its assigned corner-adjacent slot;
  - allow multiple zones to share a corner area by using distinct adjacent
    slots, but keep the actual corner tile and a neutral perimeter corridor
    navigable;
  - assert neutral corner/perimeter corridors connect through
    `terrainKindAt()` neutral water around the island.
- Add screen-space lighthouse clearance checks for the full rendered label
  rectangles, not only tile centers. Existing label/hit testing should remain
  part of the acceptance path and should be extended if lighthouse beam
  clearance becomes literal.

Acceptance:

- Every DEWS region tile, label tile, rendered label anchor, ship anchor, and
  cluster tile is on matching semantic water north of the island.
- Every DEWS terrain mask is north of the island except any intentional
  one-tile visual feathering approved by tests.
- Ledger Mooring is below the island, not counted as DEWS, and not adjacent to
  top-ten dock traffic or computed dock mooring traffic.
- The neutral perimeter route remains connected through explicit neutral
  terrain, including the top/northeast corridor.

### Phase 3 - Make Ship Idle And Movement Match The New Rules

Owned files:

- `src/app/pharosville/systems/motion.ts`
- `src/app/pharosville/systems/pharosville-world.ts`
- `src/app/pharosville/systems/detail-model.ts`
- `src/app/pharosville/components/accessibility-ledger.tsx`
- `src/app/pharosville/renderer/geometry.ts`
- `src/app/pharosville/renderer/hit-testing.ts`
- `src/app/pharosville/pharosville-world.tsx`
- `src/app/pharosville/systems/motion.test.ts`
- `tests/visual/pharosville.spec.ts`

Tasks:

- Change reduced-motion and static idle sampling:
  - DEWS ships use `ship.riskTile` and `state: "risk-drift"`;
  - Ledger/NAV ships use their Ledger Mooring `riskTile`;
  - dock visits remain in detail facts but are not the static idle position.
- Stop rewriting `ship.tile` to a representative dock mooring in the world
  model. Keep idle/fallback geometry anchored to `riskTile`; if a dock
  representative is still needed for facts or route starts, keep it explicit in
  `dockVisits` or a separate field instead of overloading `ship.tile`.
- Treat harbor mooring as an active visit state, not the default idle state.
- Keep normal-motion routes cycling between rendered dock stops and risk water.
- Tune route cadence so ships measurably read as often moving:
  - add a hard unit-test/browser-test threshold that normal-motion samples for
    docked ships include `departing`, `arriving`, or `sailing`, not just tiny
    `risk-drift`;
  - shorten overly long cycles until the threshold passes while preserving
    slow, legible movement;
  - keep deterministic phases;
  - keep route sample budgets bounded;
  - preserve higher-risk dwell ordering, but ensure transit remains visible.
- Update `ZONE_DWELL` so risk-zone idle is the main non-sailing pause and dock
  dwell is shorter than current idle behavior.
- Review `dockStopCount()` and `weightedDockStopSchedule()` so ships with broad
  rendered chain presence visit multiple harbors over cycles.
- Define "visit harbors/chains present" as rendered positive-chain presence:
  routes must schedule all rendered positive-chain dock stops over bounded
  repeated cycles, while non-rendered positive chains remain exposed in `Chains
  present` detail/ledger facts.
- Ensure open-water patrols for dockless ships use current/adjacent DEWS zones
  and not removed Data Fog waypoints.
- Update detail copy:
  - `Representative position` should describe DEWS/ledger idle placement;
  - `Docking cadence` should remain chain-presence cadence, not transfers;
  - `Route source` stays `stablecoins.chainCirculating, pegSummary.coins[],
    stress.signals[]`;
  - add `Evidence status` if evidence is stale/missing/low-confidence.

Acceptance:

- Reduced-motion selected ship samples are stable and located in risk water or
  Ledger Mooring.
- Normal-motion samples move over time, include real transit states, visit every
  scheduled rendered dock over bounded repeated cycles, and stay selectable
  through moving hit targets.
- Docked visits remain visible in normal motion but do not become idle truth.
- Detail panel and accessibility ledger explain both route visits and idle risk
  water.
- Cluster detail aggregates evidence status, chain presence, home-dock, and
  cadence caveats enough that Calm clusters containing caveated evidence do not
  read as fully normal Calm ships.

### Phase 4 - Establish Distinct Escalating Visual Identities

Owned files:

- `src/app/pharosville/systems/palette.ts`
- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/systems/palette.test.ts`
- `scripts/check-pharosville-colors.mjs` only if the guard needs intentional
  expansion

Visual direction:

| Zone | Visual identity |
| --- | --- |
| Calm Anchorage | Protected jade basin, broad smooth strokes, sparse shimmer, low turbulence. |
| Watch Breakwater | Teal-blue guarded water, crosswind strokes, dashed breakwater/buoy rhythm, more texture than Calm. |
| Alert Channel | Directional current lane with restrained amber edge accents and stronger diagonals. |
| Warning Shoals | Ochre/orange shoal field, sandbar blocks, jagged chop, hazard stakes/foam. |
| Danger Strait | Near-black storm water, sparse red danger accents, heavy whitecaps, diagonal undertow cuts, strongest motion. |

Tasks:

- Centralize DEWS water label/accent colors in `palette.ts` instead of
  scattering hardcoded label colors.
- Add PharosVille DEWS label/accent exports backed by
  `THREAT_BAND_HEX` from `shared/lib/classification.ts`, then test exact
  `CALM/WATCH/ALERT/WARNING/DANGER` band-to-color mapping. Replace
  `dewsAreaColor()` hardcoded renderer values with those centralized exports.
- Keep color semantic, not decorative; the escalation should be visible through
  texture density, shape language, and motion intensity as well as hue.
- Avoid letting Danger red dominate the lighthouse/PSI beacon. Danger should be
  local texture contrast plus sparse red marks only; explicitly avoid global
  storm overlays, large red fills, lighthouse-beam competition, or extra
  animation clocks.
- Keep labels readable above ships and terrain, and keep hitboxes aligned with
  label rendering.
- Decide label typography explicitly: either move canvas water labels to the
  Pharos UI font stack or document a PharosVille cartographic-label exception
  if the existing serif treatment is intentionally retained.
- Prefer procedural texture updates first. Do not add generated terrain assets
  unless procedural rendering cannot meet the visual distinction requirement.
- Make renderer edits concrete:
  - `drawCalmWaterTexture`: lowest density, slowest shimmer, broad horizontal
    strokes, sparse reflections.
  - `drawWatchWaterTexture`: medium-low density, guarded/crosswind strokes,
    dashed breakwater or buoy rhythm, motion faster than Calm.
  - `drawAlertChannelTexture`: medium density, directional diagonal current,
    restrained amber accent strokes, pulse faster than Watch.
  - `drawWarningShoalTexture`: high density, jagged chop, sandbar/block marks,
    ochre/orange hazard accents, faster and sharper than Alert.
  - `drawDangerStraitTexture`: highest local density, near-black undertow cuts,
    heavy whitecaps, sparse red semantic ticks, fastest water texture while
    staying inside the single route-owned canvas clock.
- Add minimum screen-space spacing checks between DEWS labels at the default
  camera and a specific screenshot review item for Calm/Watch/Alert separation
  in the compressed northern band.

Acceptance:

- Palette tests verify water terrain zones remain visually separable.
- Palette tests verify DEWS label/accent color mapping comes from
  `THREAT_BAND_HEX` or documented PharosVille companions.
- Label and hitbox tests verify each area has an unoccluded click point, does
  not overlap lighthouse/dock rectangles, and remains readable in browser
  screenshots.
- `npm run check:harbor-palette` passes.
- Browser screenshots show a clear Calm -> Watch -> Alert -> Warning -> Danger
  escalation without label/sprite occlusion.

### Phase 5 - Interaction And DOM Parity

Owned files:

- `src/app/pharosville/systems/detail-model.ts`
- `src/app/pharosville/components/accessibility-ledger.tsx`
- `src/app/pharosville/systems/visual-cue-registry.ts`
- `src/app/pharosville/systems/clustering.ts`
- `src/app/pharosville/renderer/geometry.ts`
- `src/app/pharosville/renderer/hit-testing.ts`
- `tests/visual/pharosville.spec.ts`

Tasks:

- Update named area detail panels to say DEWS threat level clearly.
- Preserve area selection for the five DEWS zones and Ledger Mooring.
- Remove Data Fog selection and make its former location blank/generic unless
  used by another valid zone.
- Ensure the accessibility ledger lists only current named areas.
- Ensure ship and cluster detail rows use `riskWaterLabel`, `riskZone`,
  `riskPlacement`, `Evidence status`, `Home dock`, `Chains present`, and
  `Docking cadence` consistently.
- Update cluster member summaries or aggregate facts so removed Data Fog
  uncertainty remains visible when long-tail caveated ships are grouped into a
  DEWS area.
- Keep printed water-area labels above entity sprites and selectable.
- Confirm moving-ship hit testing uses the same motion samples as rendering,
  and update browser tests to require `departing`, `arriving`, or `sailing`
  before clicking a moving target.

Acceptance:

- Clicking every remaining named area opens the correct detail panel.
- Blank-map click still clears selection.
- Selected/follow behavior works for moving ships after idle placement changes.
- The DOM ledger remains sufficient without inspecting canvas pixels.

### Phase 6 - Docs And Agent Corpus

Update verified docs in the implementation change:

- `docs/pharosville-page.md`: route contract, current phase, data mapping,
  motion budget, visual regression, update rules.
- `docs/architecture.md`: PharosVille route description and motion/data mapping
  paragraphs.
- `docs/data-visualization.md`: remove Data Fog from PharosVille static/reduced
  motion descriptions and update named-area semantics.

Update agent docs in the same implementation change because the behavior becomes
canonical:

- `agents/pharosville/CURRENT.md`
- `agents/pharosville/MOTION_POLICY.md`
- `agents/pharosville/VISUAL_INVARIANTS.md`
- `agents/pharosville/SCENARIO_CATALOG.md`
- `agents/pharosville/VISUAL_REVIEW_ATLAS.md`
- `agents/pharosville/TESTING.md`

Acceptance:

- Docs no longer describe Data Fog as a named PharosVille area.
- Docs explicitly say idle ships sit in current DEWS zones or Ledger Mooring.
- Docs describe all five DEWS zones as north of the island.

## Test Plan

Focused unit tests:

```bash
npm test -- src/app/pharosville
```

Targeted lanes during implementation:

```bash
npm test -- src/app/pharosville/systems/risk-water-areas.test.ts
npm test -- src/app/pharosville/systems/world-layout.test.ts
npm test -- src/app/pharosville/systems/area-labels.test.ts
npm test -- src/app/pharosville/systems/risk-placement.test.ts
npm test -- src/app/pharosville/systems/motion.test.ts
npm test -- src/app/pharosville/systems/pharosville-world.test.ts
npm test -- src/app/pharosville/systems/clustering.test.ts
npm test -- src/app/pharosville/systems/palette.test.ts
npm test -- src/app/pharosville/systems/visual-cue-registry.test.ts
npm test -- src/app/pharosville/renderer/hit-testing.test.ts
```

Asset and palette checks:

```bash
npm run check:pharosville-assets
npm run check:harbor-palette
```

Browser/canvas checks:

```bash
npm run build
npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"
```

If the desktop canvas snapshot changes, update the Playwright snapshot only
after visual review confirms the new zone layout, then rerun:

```bash
npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"
```

Release-impacting route/CSS/static-export checks:

```bash
npm run lint
npm run typecheck
npm run build
npm run seo:check
npm run check:verified-doc-links
npm run check:doc-source-paths
```

Before pushing:

```bash
npm run test:merge-gate
```

## Main Risks

- **Data Fog removal can hide data-quality uncertainty.** Mitigation: evidence
  quality becomes explicit DOM/detail/ledger truth and optionally a ship-level
  visual cue, never a hidden sea-zone fallback.
- **Five DEWS zones north of the island may overcrowd the top band.**
  Mitigation: keep Calm broad but shallow, use top-left/top-right
  corner-adjacent slots, validate label rectangles in browser screenshots, and
  keep generic perimeter water open.
- **Literal corner adjacency can create awkward terrain spurs.** Mitigation:
  use fixed corner-adjacent slots, keep the actual corner tiles and perimeter
  corridors neutral, and stop for product approval if exact adjacency cannot
  work visually.
- **Changing reduced-motion idle placement can affect screenshots and
  interaction tests.** Mitigation: update unit tests first, then verify moving
  target hit testing and DOM parity in Playwright.
- **More dramatic danger visuals can overpower PSI lighthouse semantics.**
  Mitigation: use texture/motion escalation and restrained red accents.
- **Neutral path can be blocked by semantic terrain.** Mitigation: add a
  connected generic-water perimeter-route invariant before moving terrain.

## Open Decisions For Review

1. Confirm the stale/missing evidence fallback after Data Fog removal:
   preferred is current DEWS band when available, otherwise Calm Anchorage with
   explicit evidence caveat.
2. Confirm whether Ledger Mooring should stay in the current lower-right basin
   or move lower-center/below-harbor after screenshots.
3. Confirm how aggressive "often moving" should be after the hard transit
   threshold is met: shorter cycles, more transit share, or more dock stops per
   cycle.

## Review Checklist

Specialist review coverage completed for this plan:

- Prompt-adherence review against every bullet in the user request.
- Topology review for north-of-island, literal corner-edge adjacency, neutral
  path, lighthouse clearance, and Ledger Mooring placement.
- Motion/interaction review for idle semantics, harbor visits, reduced motion,
  moving hit targets, and DOM parity.
- Visual-design review for zone distinctness, escalation, palette guardrails,
  and label readability.
- Test/docs review for exact changed tests, docs, and validation commands.
