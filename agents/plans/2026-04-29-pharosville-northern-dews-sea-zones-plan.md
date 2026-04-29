# PharosVille Northern DEWS Sea-Zone Reorganization Plan

Date: 2026-04-29
Status: specialist-reviewed; review feedback integrated
Scope: research and implementation plan only; no app code changed by this pass

## Request

Assess the current PharosVille state and the handover at
`agents/handoffs/2026-04-29-pharosville-map-sea-composition-polish-handover.md`,
then identify the most impactful remaining enhancement opportunities. The main
target is to reorganize the DEWS sea logic into the largest continuous sea block
above the island:

- left/harbor/shore side: largest calm zone for CALM stablecoin-ships
- slightly right: smaller and more turbulent WATCH zone
- further right: smaller, more agitated ALERT zone
- further right/up: turbulent WARNING seas
- top-right/near the north pole: most treacherous DANGER seas

Each water zone must be named, visually coherent, and drive correct
DEWS-related ship behavior.

## Assumptions And Ambiguities

- This is a visual/world-model reorganization only. It should not add Worker
  endpoints, data sources, scoring changes, D1 migrations, methodology changes,
  production fixture data, or mobile canvas support.
- "Above the island" is interpreted in the current isometric map as the
  continuous water component with lower screen-y / lower `x + y` than the
  island. The current land minimum diagonal is `x + y = 50`; the connected
  water component above that line contains `1275` water tiles and is the
  largest available northern sea block. This condition is necessary but not
  sufficient for "right/up"; implementation tests must also assert rendered
  screen-x increases and rendered screen-y decreases from CALM to DANGER.
- "Left to right" is interpreted by rendered isometric screen x
  (`(tile.x - tile.y) * 16`), not raw tile x. This matches how a user scans the
  map.
- "Next to the north pole" is ambiguous and must be resolved explicitly before
  app code is changed. North Froze Pole is currently the triangular frozen-water
  area near tile origin `{ x: 0, y: 0 }`, while the visual top-right northern
  edge is high tile x / low tile y. Preferred interpretation for this plan:
  keep North Froze Pole's freeze-tracker semantics separate, place Danger Strait
  on the rendered top-right northern edge, and document that "north pole" means
  the northern edge of the map rather than raw adjacency to `{ x: 0, y: 0 }`.
  If product intent requires literal adjacency to the existing North Froze Pole,
  reshape or move the North Froze Pole visual area in the same implementation
  slice and update its tests/docs; do not silently call `{40,0}` "next to"
  `{0,0}`.
- "CALM DEWS score stablecoin-ships" should include ships with an explicit
  fresh CALM row in `stress.signals[]`, plus normal no-risk ships that have no
  active peg/deviation/DEWS escalation. The detail evidence should distinguish
  those two cases.

## Current State Evidence

This pass inspected the current worktree, not only the handover.

Validation run during research:

- `npm test -- src/app/pharosville/systems/world-layout.test.ts src/app/pharosville/systems/pharosville-world.test.ts src/app/pharosville/systems/motion.test.ts src/app/pharosville/renderer/hit-testing.test.ts` passed: 4 files, 56 tests.
- `npm run check:harbor-palette` passed: 42 non-test PharosVille source files.
- `npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville renders desktop canvas shell"` passed against the current static export.

Current map statistics from `buildPharosVilleMap()`:

- map size: `56 x 56`
- water ratio: `0.8657525510204082`
- land tiles: `421`
- land bounds: `x=21..48`, `y=17..43`, `x+y=50..78`
- land centroid: approximately `{ x: 35.00, y: 29.14 }`
- terrain counts:
  - `water`: `1791`
  - `deep-water`: `351`
  - `brackish-water`: `246`
  - `warning-water`: `80`
  - `storm-water`: `72`
  - `harbor-water`: `65`
  - `frozen-water`: `62`
  - `alert-water`: `48`
  - land/shore/elevated/road total: `421`
- the largest top/above-island connected water component with `x + y < 50`
  contains `1275` tiles, spanning `x=0..49`, `y=0..49`, with current terrain
  composition `818 water`, `246 brackish-water`, `149 deep-water`,
  `62 frozen-water`.

Current DEWS areas and risk anchors:

| Band | Label | Area tile | Current terrain | Risk placement | Current geography |
| --- | --- | ---: | --- | --- | --- |
| CALM | Calm Anchorage | `{30,42}` | `harbor-water` | `safe-harbor` | lower harbor/southwest island |
| WATCH | Watch Breakwater | `{27,44}` | `water` | `breakwater-edge` | lower-left/southwest water |
| ALERT | Alert Channel | `{40,44}` | `alert-water` | `harbor-mouth-watch` | lower/southeast water |
| WARNING | Warning Shoals | `{49,46}` | `warning-water` | `outer-rough-water` | lower-right/southeast water |
| DANGER | Danger Strait | `{55,53}` | `storm-water` | `storm-shelf` | bottom-right/southeast edge |
| freeze area | North Froze Pole | `{0,0}` | `frozen-water` | none | northern frozen wedge |

Relevant current modules:

- `systems/world-layout.ts` owns terrain predicates, `REGION_TILES`, dock
  slots, lighthouse tile, cemetery, and water helpers.
- `systems/pharosville-world.ts` owns `DEWS_AREA_PLACEMENTS`,
  `DEWS_AREA_LABELS`, `AREA_LABEL_TILES`, `SHIP_WATER_ANCHORS`,
  `waterZoneForPlacement()`, and ship construction.
- `systems/risk-placement.ts` maps active depeg, peg deviation, and fresh DEWS
  rows to `ShipRiskPlacement`. It currently has no explicit CALM entry in
  `DEWS_PLACEMENT`.
- `systems/motion.ts` groups ship behavior into `ShipWaterZone` values
  `safe`, `muddy`, `storm`, `fog`, and `ledger`. This means WATCH and CALM
  share behavior, and ALERT and WARNING share behavior.
- `systems/area-labels.ts` is the current shared source for printed water-label
  drawing, hitbox, and follow-selected offsets.
- `renderer/geometry.ts` is already the shared geometry source for area labels,
  assets, hit targets, and follow-selected anchors.
- `renderer/world-canvas.ts` already draws printed cartographic labels after
  terrain and before atmosphere/entities. It also has per-terrain water
  texture hooks.
- `systems/palette.ts` defines water terrain styles for alert, brackish, deep,
  fog, frozen, harbor, storm, warning, and generic water. It does not have
  explicit `calm-water` or `watch-water` terrain styles.

The handover is broadly accurate for the completed map/sea polish. It is no
longer an implementation backlog for printed labels or sea circles. It still
identifies two residual risks that remain useful: there is no dedicated
automated pixel assertion for absence of circular water overlays, and no
ground-noise density assertion.

## Specialist Review Outcome

Three read-only specialist reviews were completed and folded into this plan:

- World-model/geography review: required concrete rendered right/up ordering,
  explicit North Froze Pole ambiguity handling, connected-component invariants
  for all anchors/routes, and a full risk-water map instead of a DEWS-only map.
- Renderer/UX review: made all-label browser checks mandatory, tightened
  CALM/WATCH terrain requirements, required unique CALM/WATCH texture styles,
  and added a typography carveout decision for printed map labels.
- Motion/accessibility/validation review: required exact placement predicates
  for CALM/WATCH, reduced-motion static equivalents, cluster DOM parity, and
  stronger all-band motion/detail/ledger tests.

## Most Impactful Remaining Opportunities

### P0 - Move DEWS Geography Into The Northern Sea Block

The current DEWS zones are visually and semantically split across the lower /
southeast water. The user-requested change is high-impact because it makes the
map read as one coherent risk sea: calm near the protected shore, then
increasing hazard as ships move right/up toward the north/top-right danger
water.

This is not a label-only move. It requires coordinated changes to terrain
predicates, region anchors, ship anchor arrays, open-water patrol waypoints,
cluster anchors, detail copy, tests, and visual snapshots.

### P0 - Make CALM/WATCH/ALERT/WARNING/DANGER First-Class Ship Behavior

Current behavior groups bands into only `safe`, `muddy`, and `storm` motion
zones. That is too coarse for "each water-zone must have correct
DEWS-related behaviours." CALM and WATCH should not feel identical, and ALERT
and WARNING should not feel identical. Fresh CALM evidence should also be
represented as CALM evidence instead of disappearing into generic "no active
peg or DEWS stress."

### P1 - Create A Single Risk-Water Area Definition Module

The current layout duplicates zone facts across `world-layout.ts`,
`pharosville-world.ts`, `area-labels.ts`, `motion.ts`, and `clustering.ts`.
The northern rewrite would be fragile if implemented as scattered constants.
Add one route-local source for risk-water area ids, labels, bands where
applicable, terrain, placement, label anchors, center/ellipse shape, ship
anchors, and behavior severity; then have existing systems consume that shape.
Make DEWS bands a subset of this map. Include `data-fog` and `ledger-mooring`
so details, clusters, accessibility text, and tests do not need ad hoc reverse
maps.

This is an abstraction with immediate value because the requested change
touches the same constants in several modules at once. Keep it route-local and
small, and keep renderer consumption one-way: renderer should receive derived
world nodes and terrain styles, not import DEWS scoring semantics directly.

### P1 - Resolve Brackish/Data Fog Competition In The Top Sea

The current `data-fog` region consumes `246` tiles in the same northern
component that should become the consolidated DEWS belt. If left untouched, it
will visually compete with the largest CALM/WATCH areas and make the new
organization muddy. The rewrite should either move data fog to a smaller
northwest/far-water pocket outside the main DEWS belt or shrink it so stale
evidence remains legible without taking over the requested calm/watch water.

### P1 - Strengthen Automated Guardrails For This Geography

The current tests prove water ratio, basic risk terrain anchors, route water
safety, and hit-target selectability. They do not prove the new north/above
island ordering, zone size hierarchy, or per-band behavior. Add focused tests so
future agents do not drift the risk sea back to the lower edge or collapse
WATCH/ALERT/WARNING behavior into a generic "muddy" bucket.

### P1 - Resolve Printed Label Typography As A Deliberate Carveout

Current water labels use a serif cartographic treatment, while
`docs/data-visualization.md` generally says scene labels should avoid serif
usage. Moving these labels into the most important risk area increases that
conflict. The implementation should either switch printed water labels to a
Pharos-approved Geist/mono treatment, or document a narrow PharosVille
cartographic-label exception in the route/data-visualization docs. Do not let
the sea rewrite preserve typography drift by accident.

### P2 - Continue Renderer Maintainability After The Sea Rewrite

The renderer is still large (`world-canvas.ts` is `3171` lines), but several
earlier maintainability findings have already been addressed: shared geometry
exists, hit testing is single-pass, toolbar entity counts include buildings,
stable random helpers are centralized, and base motion routes are split from
selection cue state. Renderer extraction remains valuable, but it should follow
the DEWS geography rewrite rather than mix with it.

## Proposed Northern Zone Model

Use the current top/above-island component (`x + y < 50`) as the primary belt.
Initial candidate anchors below are implementation starting points, not
snapshot-approved final art. They should be checked in the browser before
snapshot update.

| Band | Label | Proposed role | Candidate center / label | Terrain |
| --- | --- | --- | --- | --- |
| CALM | Calm Anchorage | largest protected water along the left/west shore side of the northern sea | center around `{17,31}` or `{20,28}` | `calm-water` |
| WATCH | Watch Breakwater | smaller, mild chop right/up of calm | center around `{25,20}` or `{24,22}` | `watch-water` |
| ALERT | Alert Channel | tighter current right/up of watch | center around `{32,12}` or `{31,13}` | `alert-water` |
| WARNING | Warning Shoals | smaller warning field right/up of alert | center around `{37,5}` or `{36,6}` | `warning-water` |
| DANGER | Danger Strait | smallest/most hazardous rendered top-right northern edge | center around `{40,0}` or `{41,1}` | `storm-water` |
| Freeze | North Froze Pole | separate frozen-water path for blacklist/freeze activity | keep `{0,0}` semantic tile, retune label if needed | `frozen-water` |
| Stale/missing evidence | Data Fog | degraded evidence, not confirmed stress | shrink/move away from the main DEWS belt | `brackish-water`/`fog-water` |

Suggested size hierarchy:

- candidate centers should satisfy increasing screen x and decreasing screen y
  in the same assertion, not just a raw coordinate order.
- CALM is largest by tile count.
- WATCH is smaller than CALM.
- ALERT is smaller than WATCH.
- WARNING is smaller than ALERT or similar but visually harsher.
- DANGER is smallest or tied-smallest, visually most hazardous.

Do not make this hierarchy depend on live band counts. Live counts belong in
details/ledger; geography is the fixed legend.

## Implementation Roadmap

### Phase 0 - Rebaseline And Preserve Active Work

Goal: avoid stale handover assumptions and concurrent-agent conflicts.

Tasks:

- Run `git status --short --untracked-files=all`.
- Re-read `docs/pharosville-page.md`, `agents/pharosville/CURRENT.md`,
  `VISUAL_INVARIANTS.md`, `TESTING.md`, and this plan.
- If source code changed since this plan, recompute the current map stats:
  water ratio, land bounds, northern connected-water component size, current
  area tiles, and terrain counts.
- Capture a before screenshot only if the implementation owner plans to update
  pixels. Use `tests/visual/.../pharosville-desktop-shell-linux.png` plus an
  optional `agents/screenshots/` artifact.

Acceptance:

- The implementer can state current dirty files and updated map stats before
  editing.

### Phase 1 - Add A Route-Local Risk-Water Area Definition

Goal: make the north-zone rewrite a single data change rather than scattered
magic numbers.

Primary files:

- `src/app/pharosville/systems/world-types.ts`
- new `src/app/pharosville/systems/risk-water-areas.ts` or equivalent
- `src/app/pharosville/systems/world-layout.ts`
- `src/app/pharosville/systems/pharosville-world.ts`
- `src/app/pharosville/systems/area-labels.ts`
- `src/app/pharosville/systems/clustering.ts`
- `src/app/pharosville/systems/motion.ts`

Tasks:

- Introduce a small `RISK_WATER_AREAS` table keyed by `ShipRiskPlacement`:
  - `riskPlacement`
  - `band`
  - `label`
  - `terrain`
  - `center`
  - `labelPlacement`
  - `ellipse` or predicate inputs
  - `shipAnchors`
  - `motionZone`
  - `visualStyleLabel`
- Add a `DEWS_WATER_ZONES` derived view or helpers keyed by `DewsAreaBand` if
  useful, but keep `data-fog` and `ledger-mooring` in the full risk-water map.
- Keep the existing `ShipRiskPlacement` strings unless there is a strong reason
  to rename them. Renaming `safe-harbor`, `breakwater-edge`,
  `harbor-mouth-watch`, `outer-rough-water`, and `storm-shelf` would be a broad
  detail/test churn and is not required if display copy exposes the human zone
  names.
- Add display helpers such as `riskWaterLabelForPlacement()` and
  `dewsBandForPlacement()` so details and tests do not reverse-map ad hoc.
- Keep `North Froze Pole` out of the DEWS table. It is blacklist/freeze
  telemetry, not a DEWS band.
- Add the first failing or updated unit tests in this phase, before moving
  pixels: geography ordering, placement-to-terrain mapping, risk-placement
  matrix, and DOM label helpers. This keeps the subsequent terrain rewrite from
  becoming a snapshot-only change.

Acceptance:

- The current world can be built from the table without changing behavior yet,
  or behavior changes are limited to indirection.
- Renderer code continues to consume `AreaNode`, `TerrainKind`, and
  `WATER_TERRAIN_STYLES`; it does not import DEWS scoring semantics.
- Tests still pass.

### Phase 2 - Move Terrain And Area Labels To The Northern Sea

Goal: put named water zones into the top/above-island continuous sea block.

Primary files:

- `src/app/pharosville/systems/world-layout.ts`
- `src/app/pharosville/systems/pharosville-world.ts`
- `src/app/pharosville/systems/area-labels.ts`
- `src/app/pharosville/systems/palette.ts`
- `src/app/pharosville/renderer/world-canvas.ts` only for texture/styling hooks

Tasks:

- Add explicit `calm-water` and `watch-water` terrain kinds. Reusing generic
  `water` or `harbor-water` would make the two requested zones either visually
  indistinct or semantically conflated with chain harbors.
- Update `TerrainKind`, water terrain sets, palette styles, and texture
  handling for those new terrains.
- Add distinct `WaterTextureKind` entries and `WATER_TERRAIN_STYLES` records for
  `calm-water` and `watch-water`; preserve the existing palette invariant that
  rendered water terrains are separable by color and texture.
- Move the fixed DEWS area tiles/label anchors into the northern belt.
- Replace current lower/southeast risk terrain predicates:
  - `isAlertChannel()`
  - `isWarningShoals()`
  - `isDangerStrait()`
  with north-belt predicates from the table.
- Decide whether the old lower `harbor-water` cove remains harbor-only. Do not
  conflate chain harbor water with CALM if `calm-water` exists.
- Shrink or move `isDataFog()` so brackish water no longer dominates the main
  CALM/WATCH belt.
- Preserve `isNorthFrozePole()` as a separate frozen area. If Danger Strait
  visually crowds it, retune the North Froze Pole label placement, not the
  semantic freeze source.
- Keep deep-water perimeter capped and water ratio within the existing
  `0.85..0.88` contract unless the visual change intentionally updates that
  contract.
- Tighten `isPlacementWaterTile()` and nearest-placement helpers so every DEWS
  placement requires its named terrain set. CALM and WATCH must no longer accept
  any generic water tile.
- Move `REGION_TILES`, area semantic tiles, label anchors, ship anchors, cluster
  bases, and open-water patrol waypoints into the same northern connected
  component. Do not leave behavior anchors in the old southeast sea.

Acceptance:

- `terrainKindAt()` returns the correct terrain for all five proposed DEWS
  area tiles.
- All five DEWS area semantic tiles and label anchors are water in the northern
  component.
- Top/above-island ordering holds by screen x and screen y:
  `CALM.x < WATCH.x < ALERT.x < WARNING.x < DANGER.x` and
  `CALM.y > WATCH.y > ALERT.y > WARNING.y > DANGER.y` after `tileToIso()`.
- DEWS zone tile counts follow the requested hierarchy: CALM largest, DANGER
  smallest/most constrained.
- North Froze Pole remains selectable as frozen water and does not become a DEWS
  danger zone.
- Old southeast `alert-water`, `warning-water`, and `storm-water` DEWS
  placements are removed or no longer reachable from DEWS risk placement.

### Phase 3 - Make Per-Band Ship Placement And Motion Behavior Explicit

Goal: make visiting ship behavior match the new five-zone model.

Primary files:

- `src/app/pharosville/systems/risk-placement.ts`
- `src/app/pharosville/systems/pharosville-world.ts`
- `src/app/pharosville/systems/world-types.ts`
- `src/app/pharosville/systems/motion.ts`
- `src/app/pharosville/systems/clustering.ts`

Tasks:

- Add explicit fresh CALM handling in `risk-placement.ts`:
  - active depeg still outranks all DEWS rows
  - fresh peg deviation still outranks lower-risk DEWS where current precedence
    says it should
  - fresh DEWS `DANGER`, `WARNING`, `ALERT`, `WATCH`, and `CALM` map to their
    matching water zones
  - stale DEWS still maps to data fog, not active risk water
  - no peg issue/no DEWS row still maps to Calm Anchorage but with evidence
    "No active peg or DEWS stress"
- Expand `ShipWaterZone` from `safe | muddy | storm | fog | ledger` to
  `calm | watch | alert | warning | danger | fog | ledger`, or introduce an
  equivalent per-band behavior field if the type churn is too large.
- Update `ZONE_DWELL`, drift radius, wake intensity, and open-water patrol
  waypoints so:
  - CALM ships drift broadly and calmly in the large western/northern calm zone
  - WATCH ships visit smaller breakwater water with mild turbulence
  - ALERT ships dwell more tightly in the channel and show more wake/current
  - WARNING ships prefer shoals and higher-risk dwell
  - DANGER ships dwell longest in the storm strait with strongest capped wake
- Move `SHIP_WATER_ANCHORS` into the new zone table or generate it from it.
- Ensure long-tail clusters use the new zone anchors and remain count-capped.
- Keep rendered dock visits separate from risk water. Docking cadence still
  means positive rendered-chain presence, not transfers or issuer operations.
- Define a reduced-motion static equivalent for every per-band behavior. If
  representative reduced-motion ship placement stays at a rendered harbor
  mooring, selected/focused ships must still expose a static risk-water anchor
  cue or equivalent non-animated relation to the named area. For DANGER/WARNING,
  do not rely on wake animation as the only visible severity cue.
- Preserve the existing calm positive-chain transit contract: calm ships with
  rendered docks should still show meaningful dock cadence in normal motion and
  not become permanently parked in the risk zone.

Acceptance:

- A fixture ship with each fresh DEWS band gets the matching risk placement,
  terrain, water-zone label, and motion zone.
- Motion route samples stay water-only.
- DANGER and WARNING ships dwell near their risk water more than docks.
- CALM positive-chain ships still have visible transit/dock cadence.
- CALM and WATCH no longer collapse into indistinguishable motion details.
- Wake intensity, drift radius, dwell ratio, and patrol bounds are ordered or
  otherwise explicitly different across CALM, WATCH, ALERT, WARNING, and
  DANGER.
- Reduced-motion debug still reports no RAF loop and static samples, while DOM
  and static visual cues preserve the named risk-water meaning.
- Details expose human-readable zone names, not only internal `riskPlacement`
  and old `riskZone` values.

### Phase 4 - Update Details, Accessibility, And Visual Cue Parity

Goal: keep canvas semantics discoverable without reading pixels.

Primary files:

- `src/app/pharosville/systems/detail-model.ts`
- `src/app/pharosville/components/accessibility-ledger.tsx`
- `src/app/pharosville/systems/visual-cue-registry.ts`
- `docs/pharosville-page.md`
- `agents/pharosville/CURRENT.md`
- `agents/pharosville/VISUAL_INVARIANTS.md`
- `agents/pharosville/SCENARIO_CATALOG.md`
- `agents/pharosville/VISUAL_REVIEW_ATLAS.md`

Tasks:

- Add a ship detail fact like `Risk water area: Calm Anchorage / Watch
  Breakwater / Alert Channel / Warning Shoals / Danger Strait / Data Fog /
  Ledger Mooring`.
- Keep or de-emphasize the internal `Risk placement` fact. If retained, it
  should not be the only user-facing explanation.
- Update cluster details to show the named water area.
- Update area details to state the water behavior and source fields.
- Update the accessibility ledger to include the named area and DEWS band or
  fog/ledger caveat for ships, ship clusters, and areas.
- Update visual-cue registry wording for the north-belt organization and
  per-band motion behavior.
- Update `docs/pharosville-page.md` because this changes route behavior and
  visual semantics.
- Update agent docs if the new `RISK_WATER_AREAS` source becomes canonical for
  future work.

Acceptance:

- Detail panel and ledger expose exact DEWS band, named water area, source
  fields, and stale/fog caveats.
- Detail/ledger tests cover all five fresh DEWS bands, fresh CALM versus
  no-DEWS-row calm, stale DEWS to Data Fog, and clustered long-tail ships.
- No analytical meaning exists only in canvas color/texture/motion.

### Phase 5 - Visual Atmosphere And Renderer Polish

Goal: make each water zone visibly coherent after the geography is correct.

Primary files:

- `src/app/pharosville/systems/palette.ts`
- `src/app/pharosville/renderer/world-canvas.ts`
- potential follow-up extraction into route-local water/terrain renderer module

Tasks:

- CALM: lowest DEWS-severity water marks, sparse protected ripples, low wake.
- WATCH: mild DEWS-watch marks, modest breakwater/current treatment.
- ALERT: visible directional current marks tied to alert severity.
- WARNING: warning-band marks with higher contrast and shoal-like interruption,
  but no ornamental clutter.
- DANGER: highest-severity storm marks with capped contrast and static
  reduced-motion equivalent.
- North Froze Pole: keep frozen-water ice seams/cold texture distinct from
  Danger Strait storm texture.
- Data Fog: keep brackish/fog visual language clearly tied to stale/missing
  evidence, not danger.
- Any new animated water, wake, or texture variation must use the existing route
  motion input and reduced-motion constants. Do not add independent timers,
  CSS animations, or renderer-local clocks.
- Resolve printed water-label typography before snapshot approval: either use a
  Pharos-approved label stack or document a narrow PharosVille cartographic
  exception in `docs/data-visualization.md` / `docs/pharosville-page.md`.
- Add pixel/visual assertions if feasible:
  - no circular detached water overlays
  - all five labels are selectable and present in debug/detail state
  - stressed DANGER fixture visually/detail-selects Danger Strait

Acceptance:

- At `1440 x 1000`, the northern belt reads as a deliberate left-to-right risk
  escalation.
- It is possible to identify all five DEWS zones without opening details.
- The scene remains dark-first and semantic, not decorative or one-note.

### Phase 6 - Focused Tests And Validation

Goal: prove behavior before snapshot updates. Start the unit-test portion of
this phase immediately after Phase 1 table extraction; do not wait until all
visual work is complete.

Add or update unit tests:

- `systems/world-layout.test.ts`
  - northern connected-water component remains large enough
  - each DEWS zone tile/label/anchor is water
  - zones are above the island by `x + y < landMinDiag` or an explicit
    top-belt bound
  - zones are ordered by screen x from CALM to DANGER
  - zones are ordered upward by rendered screen y from CALM to DANGER
  - zone tile counts satisfy the size hierarchy
  - `REGION_TILES`, area semantic tiles, label anchors, ship anchors, cluster
    bases, and patrol waypoints for DEWS placements are all inside the same
    northern connected component
  - old southeast DEWS terrain predicates are gone or no longer reachable by
    DEWS risk placement
  - North Froze Pole remains frozen and separate
- `systems/pharosville-world.test.ts`
  - live counts still attach to the correct labels
  - one fixture ship per DEWS band maps to matching risk placement and named
    water area
  - CALM evidence is represented when a fresh CALM stress row exists
- `systems/risk-placement.test.ts`
  - fresh CALM maps to calm placement
  - stale CALM/DANGER maps to data fog
  - active depeg still outranks DEWS
  - peg-deviation precedence remains intentional
  - no DEWS row with stale source maps to data fog rather than calm/danger
- `systems/motion.test.ts`
  - five motion zones route on water
  - all five DEWS route zones enforce their matching terrain set
  - DANGER/WARNING dwell near risk water
  - CALM positive-chain ships preserve transit/dock cadence
  - CALM/WATCH/ALERT/WARNING/DANGER use distinct route zones or behavior fields
  - wake intensity, dwell ratios, drift radii, and patrol bounds follow the
    intended severity ordering
  - reduced-motion samples remain static and no-RAF while retaining static risk
    meaning through details/ledger or selected static cues
- `renderer/hit-testing.test.ts`
  - all five DEWS labels are selectable at printed anchor positions
- `systems/visual-cue-registry.test.ts`
  - cue registry mentions the new north-belt water organization and DOM parity
- `systems/palette.test.ts`
  - includes `calm-water` and `watch-water`
  - keeps every rendered water terrain separable by color and texture

Add or update Playwright tests:

- desktop shell screenshot after manual visual approval
- stressed ship detail should expect `Danger Strait` or equivalent named risk
  water area, not only `storm-shelf` / `storm`
- required test that clicks `Calm Anchorage`, `Watch Breakwater`,
  `Alert Channel`, `Warning Shoals`, `Danger Strait`, and `North Froze Pole`
  through debug hit targets and verifies detail panel title
- required browser assertions for named risk-water detail text, label
  occlusion/collision at `1440 x 1000`, and normal/reduced-motion readability
  before snapshot updates

Focused validation commands for implementation owner:

```bash
npm test -- src/app/pharosville
npm run check:pharosville-assets
npm run check:harbor-palette
npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"
```

If docs/static export changed:

```bash
npm run typecheck
npm run lint
npm run build
npm run seo:check
```

Before push:

```bash
npm run test:merge-gate
```

## Files Expected To Change In Implementation

Likely app files:

- `src/app/pharosville/systems/world-types.ts`
- new `src/app/pharosville/systems/risk-water-areas.ts` or equivalent
- `src/app/pharosville/systems/world-layout.ts`
- `src/app/pharosville/systems/pharosville-world.ts`
- `src/app/pharosville/systems/risk-placement.ts`
- `src/app/pharosville/systems/motion.ts`
- `src/app/pharosville/systems/clustering.ts`
- `src/app/pharosville/systems/area-labels.ts`
- `src/app/pharosville/systems/palette.ts`
- `src/app/pharosville/systems/detail-model.ts`
- `src/app/pharosville/systems/visual-cue-registry.ts`
- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/renderer/hit-testing.test.ts`
- relevant `src/app/pharosville/systems/*.test.ts`
- `tests/visual/pharosville.spec.ts`
- `tests/visual/pharosville.spec.ts-snapshots/pharosville-desktop-shell-linux.png`

Likely docs/agent files:

- `docs/pharosville-page.md`
- `docs/data-visualization.md` if the serif/cartographic water-label treatment
  is retained as a deliberate PharosVille carveout
- `agents/pharosville/CURRENT.md`
- `agents/pharosville/VISUAL_INVARIANTS.md`
- `agents/pharosville/SCENARIO_CATALOG.md`
- `agents/pharosville/VISUAL_REVIEW_ATLAS.md`
- implementation handoff in `agents/handoffs/` if work spans sessions

## Explicit Non-Goals

- Do not change DEWS scoring thresholds or methodology.
- Do not change data producer cadence or API responses.
- Do not add a filter/sort UI or gameplay controls.
- Do not add mobile canvas support.
- Do not regenerate assets unless the existing terrain/texture language cannot
  carry the new zones.
- Do not re-open completed printed-label or island-shrink work except where the
  northern zone layout requires label-anchor retuning.

## Specialist Review Questions

Ask reviewers to focus on:

1. World-model/geography: Are the proposed northern zones consistent with
   current terrain/projection contracts, and are the right tests listed?
2. Renderer/UX: Will the atmosphere and labels read as Pharos analytical
   semantics rather than decorative fantasy/game art?
3. Motion/accessibility/validation: Does the plan preserve one motion clock,
   water-only routes, reduced-motion determinism, and DOM parity while adding
   correct per-band ship behavior?
