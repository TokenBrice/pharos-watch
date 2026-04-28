# PharosVille Ship Liveliness Motion Plan

Created: 2026-04-28

## Goal

Bring PharosVille stablecoin ships to life without turning the page into a decorative game layer:

- every rendered ship has visible deterministic movement in normal motion
- ships visit docks based on the chains where they have positive supply
- peg/DEWS status controls how much time a ship spends near safe island water, muddy/rough water, or the storm shelf
- the same motion model powers canvas drawing, hit testing, detail follow behavior, and DOM explanations
- reduced-motion users keep a deterministic, non-animated frame with no running RAF loop

## Assumptions

- Accepted first implementation scope: all individually rendered `world.ships` move, and long-tail `shipClusters` get subtle deterministic ambient motion. The current world clusters the long tail after 80 ships; changing to 215 individually drawn ships is a separate level-of-detail/culling project and is not included in this plan.
- No new Worker/API data source is required. Chain presence comes from `StablecoinData.chainCirculating`; peg state comes from `peg-summary`; DEWS comes from `stress-signals`.
- This is a visualization/data-mapping change, not a methodology change, as long as thresholds and scoring logic are not modified.
- Mobile/tablet behavior remains the existing desktop-only DOM fallback.

## Current Root Cause

The current implementation has two conflicting behaviors:

1. `buildShips()` first assigns a risk placement tile from `resolveShipRiskPlacement()`.
2. `placeDockedShips()` then moves ships with a rendered dominant-chain dock to dock mooring tiles.

That makes docks visible, but it erases the spatial peg-risk signal for ships whose dominant chain is in the top-six docks. The renderer then draws every ship at `ship.tile`, adding only bobbing for selected/top/recent ships through `motion.animatedShipIds`. There is no route, phase, docking state, or shared animated position for hit testing.

## Most Promising Direction

Keep the world model semantic and static; add a deterministic motion layer at render time.

- `ShipNode.tile` becomes the ship's risk anchor / reduced-motion representative tile.
- Dock visits become itinerary metadata, not permanent tile relocation.
- `motion.ts` builds a route for every rendered ship.
- The renderer samples that route each frame.
- Hit testing samples the same route for current clickable rectangles.
- The DOM detail panel and accessibility ledger explain the route and source fields.

This resolves the core conflict: ships can visibly dock, but their peg status still determines where they spend most of their time.

## Data Model Changes

Update `src/app/pharosville/systems/world-types.ts`.

Add chain-presence and route-explanation fields:

```ts
export interface ShipChainPresence {
  chainId: string;
  currentUsd: number;
  share: number;
  hasRenderedDock: boolean;
}

export interface ShipDockVisit {
  chainId: string;
  dockId: string;
  weight: number;
  mooringTile: { x: number; y: number };
}

export type ShipWaterZone = "safe" | "muddy" | "storm" | "fog" | "ledger";
```

Extend `ShipNode`:

```ts
chainPresence: ShipChainPresence[];
dockVisits: ShipDockVisit[];
dominantChainId: string | null;
homeDockChainId: string | null;
riskZone: ShipWaterZone;
```

Keep existing fields:

- `tile`: risk anchor, not a dock overwrite
- `dockChainId`: compatibility alias for `homeDockChainId`
- `riskPlacement`: existing granular placement
- `placementEvidence`: existing source explanation

Definitions:

- `dominantChainId` = largest positive canonical chain, rendered or not.
- `homeDockChainId` = largest positive canonical chain that has a rendered top-six dock.
- `dockChainId` = `homeDockChainId` for compatibility with existing detail/tests.

This matters when a stablecoin's largest chain has no rendered dock but a secondary chain does. The ship should still be able to visit the secondary rendered dock; it should not become `null` unless no positive chain has a rendered dock.

## Chain Presence

Create a pure helper, either inside `pharosville-world.ts` or as `systems/ship-chain-presence.ts`.

Inputs:

- `StablecoinData.chainCirculating`
- rendered top-six `DockNode[]`

Rules:

- Canonicalize with `canonicalizeChainCirculating()`.
- Only count entries where `current > 0`.
- `chainPresence` is sorted by descending `currentUsd`.
- `share = currentUsd / sum(currentUsd)` for that stablecoin's attributed chain supply.
- `hasRenderedDock` is true when the chain ID is in `world.docks`.
- `dockVisits` is the intersection of positive chain presence and rendered docks.
- If no positive chain presence exists, expose `chainPresence: []` and no dock visits. Peg/DEWS risk placement still controls the ship's risk zone and route anchor; missing chain data only suppresses dock visits/cadence.

Do not use `asset.chains` for docking frequency. It is useful display metadata, but it is weaker than positive current chain supply.

## Dock Visit Weighting

Each ship should visit rendered docks where it has positive supply, weighted by supply share.

Recommended deterministic weighting:

1. Build `dockVisits` from rendered dock chains.
2. For each visit, set `weight = max(0.08, chainShare)` to avoid tiny-but-present chains disappearing entirely.
3. Normalize weights across rendered visits.
4. Use a stable hash of `ship.id` to choose the first visit index so large multichain ships do not all depart/arrive together.
5. Use a capped weighted stop count:
   - 1 rendered dock: one dock stop per cycle
   - 2-3 rendered docks: two dock stops per cycle
   - 4+ rendered docks: three dock stops per cycle

This gives chain breadth a visible effect while preventing USDC/USDT from living permanently in the harbor.

Build a deterministic `weightedDockStopSchedule` once per route:

- Convert normalized weights into a small repeated list, capped at six entries.
- Ensure every rendered positive dock appears at least once before repeats when possible.
- Stable-sort by descending weight, then rotate by `stableMotionPhase(ship.id)` so large multichain ships do not synchronize.
- Each cycle uses `stopCount` entries from that rotated list.

## Peg Zone Mapping

Keep `resolveShipRiskPlacement()` as the source of truth. Add a display grouping helper:

```ts
function waterZoneForPlacement(placement: ShipRiskPlacement): ShipWaterZone {
  if (placement === "safe-harbor" || placement === "breakwater-edge") return "safe";
  if (placement === "harbor-mouth-watch" || placement === "outer-rough-water") return "muddy";
  if (placement === "storm-shelf") return "storm";
  if (placement === "data-fog") return "fog";
  return "ledger";
}
```

Current source precedence should remain:

- active depeg beats everything and maps to `storm-shelf`
- current deviation maps by bps threshold
- DEWS escalates when peg evidence is not already decisive
- stale/missing evidence maps to `data-fog`, not storm
- NAV token without peg row maps to `ledger-mooring`

## Time Proportion Model

Use risk zone to control the proportion of each cycle spent near the risk anchor versus docked.

Suggested initial constants:

| Zone | Meaning | Risk-water dwell | Dock dwell | Transit |
| --- | --- | ---: | ---: | ---: |
| `safe` | close to island / safe water | 35% | 35% | 30% |
| `muddy` | rough/caution water | 55% | 20% | 25% |
| `storm` | active depeg / severe trouble | 78% | 6% | 16% |
| `fog` | stale/missing evidence | 70% | 0-8% | 22-30% |
| `ledger` | NAV / ledger mooring | 60% | 10% | 30% |

Interpretation:

- A safe ship spends most time around safe harbor and docks.
- A muddy ship visibly drifts away from the island but still makes dock calls.
- A storm ship mostly remains near the storm shelf and only rarely cuts toward a dock.
- A data-fog ship stays in fog/missing-evidence water; do not make stale evidence look like a depeg.

For ships with no rendered `dockVisits`, set `dock dwell = 0` and turn the dock segment into a small patrol around the risk anchor.

## Water-Only Routes

Do not interpolate in a straight line across the island. `REGION_TILES.safe-harbor` and dock tiles are shore-adjacent, and straight tile-space lines between risk anchors and dock moorings can cross land/road.

Add a pure path helper:

```ts
export interface ShipWaterPath {
  from: { x: number; y: number };
  to: { x: number; y: number };
  points: Array<{ x: number; y: number }>;
  cumulativeLengths: number[];
  totalLength: number;
}

export function buildShipWaterRoute(input: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  map: PharosVilleMap;
}): ShipWaterPath
```

Implementation guidance:

- Project both endpoints through `nearestWaterTile()` or `nearestAvailableWaterTile()` before routing.
- Route over `water` and `deep-water` tiles only.
- Use a simple A* or bounded BFS over the 64x64 tile grid; this runs at plan-build time, not every frame.
- Prefer `water` over `deep-water` for harbor movement, but allow deep water for storm/far routes.
- If no route is found, fall back to a two-step route through a deterministic water waypoint outside the island ellipse, then assert this fallback in tests.
- Sampling walks the precomputed polyline by cumulative segment length.

Required tests:

- safe-harbor to Ethereum dock samples never round to land/road/shore
- safe-harbor to TRON dock samples never round to land/road/shore
- storm-shelf to a rendered dock samples never round to land/road/shore
- no-route fallback still returns water/deep-water samples

## Motion Route Types

Extend `src/app/pharosville/systems/motion.ts` or split a small `ship-routes.ts`.

```ts
export type ShipMotionState =
  | "moored"
  | "departing"
  | "sailing"
  | "risk-drift"
  | "arriving";

export interface ShipMotionRoute {
  shipId: string;
  cycleSeconds: number;
  phaseSeconds: number;
  riskTile: { x: number; y: number };
  dockStops: Array<{
    chainId: string;
    dockId: string;
    weight: number;
    mooringTile: { x: number; y: number };
  }>;
  zone: ShipWaterZone;
  dockStopSchedule: string[]; // dock IDs, weighted and phase-rotated
  waterPaths: ReadonlyMap<string, ShipWaterPath>; // key: `${fromKey}->${toKey}`
  routeSeed: number;
}

export interface ShipMotionSample {
  shipId: string;
  tile: { x: number; y: number };
  state: ShipMotionState;
  zone: ShipWaterZone;
  currentDockId: string | null;
  heading: { x: number; y: number };
  wakeIntensity: number;
}
```

`PharosVilleMotionPlan` should include:

```ts
shipRoutes: ReadonlyMap<string, ShipMotionRoute>;
effectShipIds: ReadonlySet<string>; // capped wake/highlight set
shipPhases: ReadonlyMap<string, number>; // keep compatibility
```

Keep `MAX_ANIMATED_WORLD_ENTITIES` only for expensive effects. Basic position sampling applies to every rendered ship.

## Cycle Frequency

Docking frequency should increase with chain breadth and rendered dock breadth.

Suggested formula:

```ts
const positiveChainCount = ship.chainPresence.length;
const renderedDockCount = ship.dockVisits.length;
const base = 96;
const breadthBonus = Math.min(36, positiveChainCount * 7 + renderedDockCount * 5);
const jitter = stableOffset(`${ship.id}.cycle`, 8);
const cycleSeconds = clamp(42, 108, base - breadthBonus + jitter);
```

Effect:

- single-chain ships move slowly and dock occasionally
- multichain ships have shorter cycles and more harbor traffic
- no-chain/fog ships still drift, but do not imply verified dock activity

## Route Sampling

Add a pure function:

```ts
export function resolveShipMotionSample(input: {
  plan: PharosVilleMotionPlan;
  reducedMotion: boolean;
  ship: ShipNode;
  timeSeconds: number;
}): ShipMotionSample
```

Rules:

- In reduced motion, return `ship.tile` with state `"risk-drift"` and zero wake.
- In normal motion, sample by `((timeSeconds + route.phaseSeconds) % route.cycleSeconds) / route.cycleSeconds`.
- Build the current cycle's deterministic segment list:
  1. `risk-drift`
  2. `departing` to scheduled dock stop 1
  3. `moored` at scheduled dock stop 1
  4. `arriving` back to risk
  5. repeat for any additional scheduled dock stops
- Use `smoothstep` or ease-in-out interpolation for transitions; do not use bounce or elastic motion.
- Interpolate along precomputed `ShipWaterPath` polylines, not direct straight lines across the island.
- Add a very small perpendicular drift for `risk-drift` so ships are alive while lingering, but keep it bounded to water.
- Clamp or project sampled points to water tiles only when precomputing waypoints, not every frame.
- Heading comes from previous/next interpolation points and controls wake orientation.

Avoid allocating new arrays/maps inside the inner per-frame loop beyond the sample map generated for the frame.

Segment duration formula:

```ts
const stops = scheduledStops.length;
const riskSeconds = cycleSeconds * zoneConfig.riskDwell;
const dockSecondsEach = stops > 0 ? cycleSeconds * zoneConfig.dockDwell / stops : 0;
const transitSecondsEach = stops > 0 ? cycleSeconds * zoneConfig.transit / (stops * 2) : 0;
```

If `stops === 0`, the whole cycle becomes a bounded `risk-drift` patrol around the risk anchor. This preserves peg/DEWS proximity even when chain presence is missing.

## Collision And Mooring Slots

Keep this deterministic and simple.

- Reuse the existing `dockMooringTile()` idea, but apply it when building `dockVisits`, not by overwriting `ship.tile`.
- Assign slots per dock by stable sorting ships by market cap desc, then stablecoin ID.
- For a ship that visits multiple docks, slot index can be per dock chain to avoid stacking.
- Perfect collision avoidance during transit is out of scope for the first pass. Small phase offsets and different route lengths should prevent obvious stacking.

## Renderer Changes

Update `src/app/pharosville/renderer/world-canvas.ts`.

- Accept a `shipMotionSamples?: ReadonlyMap<string, ShipMotionSample>`.
- In `drawShips()`, use `sample.tile` instead of `ship.tile`.
- Draw all rendered ships with subtle movement.
- Keep wake drawing capped to `motion.plan.effectShipIds`, selected ship, or high-change ships.
- Use wake direction from `sample.heading` rather than the current fixed-left wake.
- Keep sail-logo drawing unchanged apart from using the sampled point.
- Add restrained water-zone treatment before entities:
  - safe: clearer shimmer/foam near island and docks
  - muddy: desaturated brown-green wash and broken foam around `harbor-mouth-watch`/`outer-rough-water`
  - storm: darker chop/whitecaps around `storm-shelf`
  - fog: low-alpha haze around `data-fog`

Do not turn water into red/amber/green status badges. Let location/weather carry the signal and let DOM details name the data source.

## Hit Testing And Selection

Update `src/app/pharosville/renderer/hit-testing.ts`.

- Accept `shipMotionSamples?: ReadonlyMap<string, ShipMotionSample>`.
- For ship targets, use the sampled tile.
- For non-ship targets, keep current behavior.
- Keep priority ordering with ships above docks so a docked ship remains clickable.

Update `src/app/pharosville/pharosville-world.tsx`.

- Maintain `currentShipMotionSamplesRef`.
- Maintain `currentHitTargetsRef`.
- Maintain one frame-state ref:

```ts
const frameStateRef = useRef<{
  samples: ReadonlyMap<string, ShipMotionSample>;
  targets: readonly HitTarget[];
  timeSeconds: number;
}>({ samples: new Map(), targets: [], timeSeconds: 0 });
```

- In `drawFrame()`, run this exact order:
  1. compute ship samples from current `motionPlan`, `world`, `timeSeconds`, and `reducedMotion`
  2. compute hit targets from those samples
  3. write `frameStateRef.current`
  4. derive selected/hovered target from frame targets
  5. draw the canvas with the same samples and selected/hovered targets
  6. update local/test debug fields from `frameStateRef.current`
- Pointer hover/click handlers should read `currentHitTargetsRef.current`, not a stale React memo.
- Debug state should expose enough for Playwright:
  - `shipMotionSamples` or compact `{ id, x, y, state, zone }[]`
  - current `targets`
  - `motionFrameCount`
- Use one debug helper to mutate frame-level debug fields. Avoid split ownership where React effects and RAF write conflicting `targets`.
- Do not set React state every frame for samples/targets.
- For "Follow selected", if selected entity is a ship and a current sample exists, follow the sampled tile; otherwise use the static tile.

## DOM And Accessibility Changes

Update `src/app/pharosville/systems/detail-model.ts`.

For ships, add facts:

- `Risk water`: safe / muddy / storm / fog / ledger
- `Home dock`: dominant rendered dock label or "No rendered dock"
- `Chains present`: count and top chain symbols/IDs
- `Docking cadence`: e.g. "Frequent; 4 positive chain deployments, 3 rendered dock stops"
- `Route source`: `stablecoins.chainCirculating, pegSummary.coins[], stress.signals[]`

Update `AccessibilityLedger` ship rows to include route summary:

- chain presence count
- rendered dock stops
- risk zone
- placement evidence

Update `visual-cue-registry.ts`:

- Add `cue.ship.motion`:
  - visual: "ship route and docking cadence"
  - source: `stablecoins.peggedAssets[].chainCirculating, pegSummary.coins[], stress.signals[]`
  - failure: "reduced-motion static risk position / data fog"
  - DOM equivalent: "ship detail route facts and accessibility ledger"

Do not assume a visible MapKey is in scope. In the current worktree, tests may assert that the PharosVille MapKey is absent while the accessibility ledger remains the guaranteed DOM equivalent. If a visible key is re-enabled separately, update its tests explicitly; this motion plan should rely on detail facts and `AccessibilityLedger` for DOM parity.

Do not announce continuous movement through ARIA live regions. Only announce selection changes as today.

## Reduced Motion Contract

Preserve the current contract:

- `reducedMotion === true` draws one deterministic frame.
- no persistent RAF loop
- `motionFrameCount` remains 0 in tests
- no sampled position drift over time
- details/ledger still describe the route and cadence textually

Reduced motion representative position should be the risk anchor, not dock mooring, because peg state is the more important static semantic signal.

## Test Plan

Unit tests:

- `pharosville-world.test.ts`
  - canonical chain presence excludes zero/negative entries
  - aliases canonicalize through `canonicalizeChainCirculating()`
  - chain-presence shares normalize to 1 for positive attributed supply
  - dominant unrendered chain plus secondary rendered chain sets `homeDockChainId` to the secondary rendered chain
  - multichain ship exposes positive chain presence
  - dock visits include only rendered top-six docks
  - risk tile is not overwritten by dock mooring
  - active depeg remains storm-zone even with a dominant rendered dock
- `motion.test.ts`
  - every visible `world.ships` has a route
  - chain breadth reduces cycle duration / increases dock cadence
  - reduced-motion sample equals static risk tile
  - normal-motion sample changes over time
  - storm-zone route spends more cycle time near storm than docks
  - sampled positions round to `water` or `deep-water` across safe/muddy/storm routes
  - effect/wake IDs remain capped
- `hit-testing.test.ts`
  - moving ship target rect follows sampled position
  - docked/moving ship remains selectable above dock hitbox
- `visual-cue-registry.test.ts`
  - route/docking cue exists with source and DOM equivalent
- `risk-placement.test.ts`
  - do not duplicate stale active-depeg coverage if the existing test remains present

Playwright tests:

- Normal motion:
  - RAF starts
  - at least one ship sample changes between two timestamps
  - clicking a moving ship at its current debug target selects the right detail
  - avoid flakiness by reading the target immediately before clicking, or by choosing a ship currently in a `moored` dwell state
- Reduced motion:
  - no RAF loop
  - samples are stable across time
  - screenshots remain deterministic
- Stressed ship:
  - active depeg ship detail still says storm placement
  - sampled/static representative position is storm-proximate under reduced motion
- Fallback:
  - existing no-runtime/no-request behavior under viewport gate stays unchanged

Validation commands:

```bash
npm test -- src/app/pharosville
npm run lint
npm run typecheck
npm run build
npm run seo:check
npm run check:harbor-palette
npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"
npm run test:merge-gate
```

## Documentation Updates

Required:

- `docs/pharosville-page.md`
  - current phase behavior
  - data mapping target
  - DOM parity
  - visual regression expectations
- `docs/architecture.md`
  - PharosVille behavior summary and visual coverage note
- `docs/data-visualization.md`
  - required because ship motion becomes an analytical encoding inside the documented Canvas exception and reduced-motion contract
- `agents/pharosville/README.md`
  - link this plan

Not required unless scoring changes:

- `/methodology`
- methodology changelog/timeline docs

## Rollout Phases

### Phase 1: Model And Tests

Add chain presence, dock visits, risk zone, and route facts to `ShipNode`. Stop using `placeDockedShips()` to overwrite `ship.tile`; replace it with itinerary assignment. Update world-model and detail tests first.

Success criteria:

- a healthy multichain ship has rendered dock visits
- an active-depeg multichain ship keeps a storm risk tile
- a ship whose dominant chain is unrendered still uses its largest rendered positive chain as `homeDockChainId`
- reduced-motion representative placement is semantically meaningful

### Phase 2: Water Routes And Motion Plan

Add `ShipWaterPath`, `ShipMotionRoute`, `ShipMotionSample`, route builder, and sampler. Basic route samples cover all rendered ships; wake/effect budget remains capped.

Success criteria:

- every visible ship has a route
- samples are deterministic by ID and time
- chain breadth affects cycle/cadence
- sampled route positions stay on water/deep-water
- storm/fog behavior does not imply healthy dock activity

### Phase 3: Renderer And Hit Testing

Wire sampled positions into drawing, hit targets, selected rings, hover/click, debug, and follow-selected behavior. Avoid per-frame React state updates.

Success criteria:

- ships visibly move in normal motion
- moving ships remain clickable
- docked ships remain above dock hitboxes
- reduced motion still has no RAF loop

### Phase 4: Water Zones And DOM Parity

Add restrained environmental water treatment and route facts in the detail panel and accessibility ledger.

Success criteria:

- safe/muddy/storm/fog areas are readable but not badge-colored
- canvas is not the only source of motion/docking meaning
- detail panel and accessibility ledger explain source fields

### Phase 5: Visual Regression And Tuning

Update Playwright checks, run full validation, tune constants by screenshot and interaction behavior.

Success criteria:

- desktop shell remains nonblank and performant
- normal-motion test proves movement
- reduced-motion screenshots are stable
- focused interaction tests pass

## Risks And Guardrails

- Do not let docking cadence imply transaction frequency, bridge flow, or real-time transfers. It represents positive chain presence and supply share only.
- Do not represent stale/missing evidence as storm risk.
- Do not animate all 215 assets individually until there is a zoom/LOD plan and canvas budget proof.
- Do not use straight-line routes that cross land or roads.
- Do not move analytical truth into canvas only; every encoded signal needs DOM parity.
- Do not add bright particle effects, arcade movement, or storm drama that competes with data readability.
- Do not use React state for per-frame positions.
- Do not change viewport-gate behavior.

## Out-Of-Scope Follow-Up

The larger follow-up is literal per-asset rendering for all 215 active stablecoins:

- zoom-level LOD or culling policy
- performance budget proof for 200+ individual sprite/logo draws
- hit-target density strategy
- revised clustering/detail semantics

This first implementation deliberately resolves the current static-ship problem for all rendered ships without reopening entity-density design.
