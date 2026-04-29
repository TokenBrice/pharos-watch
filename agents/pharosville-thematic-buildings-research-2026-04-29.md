# PharosVille Thematic Buildings Research

Date: 2026-04-29
Status: recommendation note

## Scope

Explore new PharosVille main-island buildings that represent Pharos data surfaces, are not necessarily tied to individual ships, and can use Pixellab-generated pixel-art sprites with stateful animation.

Assumptions:

- This is research and prioritization, not implementation.
- Use existing API payloads and frontend hooks first. Do not add worker endpoints, D1 migrations, or new data providers just to support a building.
- Keep the current `/pharosville/` desktop-only canvas contract, DOM detail parity, reduced-motion determinism, and no-CSP-relaxation rules.
- "Freeze island" should be treated as a northern frozen district/outcrop on the main island unless a later map-layout pass explicitly approves a detached island.

## Existing PharosVille Shape

Current world data already covers:

- Lighthouse: PSI composite status from `/api/stability-index`.
- Docks: top chain stablecoin supply and chain health from `/api/chains`.
- Ships: active stablecoins, chain presence, peg/DEWS risk placement, report-card class.
- Risk water: DEWS band breadth from `/api/stress-signals`.
- Cemetery: dead/frozen assets from static merged cemetery data.

Current technical constraints:

- `public/pharosville/assets/manifest.json` is schema v1 and describes static PNG sprites only.
- `scripts/pharosville/validate-assets.mjs` caps the v0.1 manifest at 34 assets. Current manifest has 24 assets, so five static building sprites fit, but frame-by-frame animations would require either a sprite-sheet convention or a validator/schema update.
- Selectable entities are currently lighthouse, docks, ships, ship clusters, and graves. Buildings need a new world node type plus detail-panel, hit-test, renderer, and accessibility-ledger parity.
- The canvas renderer already has procedural motion for water, lights, ships, mist, sky, and lighthouse effects. The lowest-risk first pass is a Pixellab static building sprite plus canvas-drawn particles/glow/smoke keyed to data.
- True Pixellab `animate_object` frames are feasible but need manifest/runtime support for frame URLs, frame timing, asset validation, and reduced-motion freeze behavior.

## Scoring Criteria

Scores are qualitative:

- Visual quality: silhouette, sprite appeal, animation potential.
- RPG fit: whether the metaphor feels native to an old-school island town.
- Data fit: whether it maps to a real Pharos collection surface without duplicating current ship/dock/lighthouse semantics.
- Implementation effort: lower is better; includes data hooks, world model changes, renderer changes, asset pipeline, docs/tests.
- Misread risk: lower is better; whether users might overread the metaphor as advice, complete market coverage, or methodology change.

## Top 5 Recommendations

### 1. Royal Mint And Burn Foundry

Data surface: mint/burn flows, `/api/mint-burn-flows`, `useMintBurnFlows()`.

Metaphor:

An island mint with a brass coin press, small furnace, quenching trough, ingot crates, and coin chute. Mint pressure makes the press thump and coin sparks rise; burn/redemption pressure makes the furnace glow and coins melt into ingots.

Why it ranks first:

- Directly matches the user's example.
- Strongest readable motion: press, smoke, sparks, furnace glow, coin chute.
- Excellent old-school RPG fit: foundry/workshop buildings are natural town landmarks.
- Existing response already exposes aggregate gauge, coin rows, hourly mint/burn/net buckets, top activity, scope, and sync state.

Implementation effort: Medium.

Needs one new PharosVille query, one building node, one Pixellab sprite, procedural effects, and detail facts. It should not require backend work. Caveat copy must say "configured issuance-chain events", not complete global supply creation/destruction.

Pixellab prompt seed:

`old-school 16-bit maritime isometric RPG pixel art royal coin mint foundry, brass coin press, small furnace, quenching trough, coin chute, ingot crates, pale limestone island town materials, transparent background, no text, no logos`

Animation states:

- `minting`: press thump, gold sparks, coin chute activity.
- `burning`: furnace glow, ember plume, melted coin drip.
- `balanced/quiet`: slow chimney smoke, low lantern flicker.
- `stale`: muted smoke and dimmed lamps.

### 2. Frost Ward Keep

Data surface: blacklist/freeze tracker, `/api/blacklist-summary`, `useBlacklistSummary()`.

Metaphor:

A northern ice-ward keep or frozen magistrate office with barred vault doors, blue lanterns, chain locks, frost-cracked stone, and sealed ledgers. Higher recent freeze activity grows frost, brightens cold lanterns, and tightens animated lock chains.

Why it ranks second:

- Adapts the "freeze island" idea while keeping the main-island contract.
- Very high sprite appeal and distinctive contrast against the current warm lighthouse/harbor palette.
- The data is concrete: recent events, active frozen value, frozen addresses, destroyed total, and per-symbol supported event/frozen totals.
- Strong semantic separation from cemetery: this is active issuer intervention, not failed/frozen lifecycle status.

Implementation effort: Low-Medium.

`BlacklistSummaryResponse` is compact and already has a dedicated hook. The main work is adding the building entity and keeping observed event history separate from resolved blacklistability exposure.

Pixellab prompt seed:

`old-school 16-bit maritime isometric RPG frozen warden keep, ice-blue lanterns, barred stone vault door, chain lock, frost on roof, sealed ledger chest, northern island outcrop materials, transparent background, no text, no logos`

Animation states:

- `recent-freeze`: frost pulses outward, blue lantern flare, chain snap/lock motion.
- `large-active-frozen`: thicker ice rim and slow cold mist.
- `quiet`: faint frost sparkle.
- `stale`: frost turns gray and lanterns stop pulsing.

### 3. Exit Route Gatehouse

Data surface: DEX liquidity plus redemption backstops, `/api/dex-liquidity`, `/api/redemption-backstops`, existing liquidity/redemption report-card inputs.

Metaphor:

A canal-lock customs house at the edge of town: tidegate doors, a small ferry slip, waterwheel, market awnings, and guarded route ledgers. Deep, active exit routes open the gates and move water; thin or concentrated routes leave the lock low and slow.

Why it ranks third:

- Combines two related "can capital leave?" data families without adding another ship layer.
- Strong nautical/RPG fit on an island map.
- Visuals can be stunning without clutter: water level, lock doors, ferry lantern, market bustle.
- It complements existing docks: docks say where stablecoins live; the gatehouse says how exits look.

Implementation effort: Medium-High.

`DexLiquidityMap` is per-coin and needs a small aggregate model, but `buildDexSnapshot()` already demonstrates a simple global volume/turnover derivation. Redemption backstops need an aggregate coverage summary from `RedemptionBackstopsResponse`. Keep caveats explicit: DEX telemetry and modeled redemption routes are not guarantees of safe exit.

Pixellab prompt seed:

`old-school 16-bit maritime isometric RPG canal lock customs gatehouse, small ferry slip, tidegate doors, waterwheel, market awnings, ledger crates, limestone harbor town style, transparent background, no text, no logos`

Animation states:

- `deep-exit`: lock gates open, waterwheel turns, bright ferry lantern.
- `thin-exit`: low water, slow wheel, narrow gate opening.
- `concentrated`: one side gate dominates, warning lantern.
- `stale`: still water and dim office window.

### 4. Yield Orchard And Moonwell

Data surface: yield intelligence, `/api/yield-rankings`, `useYieldRankings()`.

Metaphor:

A terraced orchard or moonwell garden where coin-fruit trees, irrigation channels, and a small windmill represent current published yield opportunities. The scene grows brighter with represented source breadth and animates gently with current selected-source context.

Why it ranks fourth:

- Highest "delight" potential while still fitting an RPG town.
- Easy to make visually distinct from industrial foundry/frost/gatehouse landmarks.
- Existing yield payload has rankings, median APY, risk-free rate, benchmark context, selected/alternate source provenance, and update time.
- Useful because yield is a major Pharos collection surface not currently present in PharosVille.

Implementation effort: Medium.

The data hook is straightforward, but copy must avoid implying "higher APY = better". The detail panel should show current published yield context, source count, benchmark/risk-free context, and freshness, not advice.

Pixellab prompt seed:

`old-school 16-bit maritime isometric RPG terraced yield orchard moonwell garden, coin-fruit trees, small windmill, irrigation channel, glowing well, harvest baskets, limestone island town style, transparent background, no text, no logos`

Animation states:

- `broad-coverage`: windmill turns, irrigation sparkles, more fruit glints.
- `high-median-apy`: brighter harvest glow, bounded so it does not read as safety.
- `source-switch/anomaly`: one tree flickers amber.
- `stale`: still windmill and dull well.

### 5. Dependency Loom / Chainworks

Data surface: dependency graph in `/api/report-cards`, especially `dependencyGraph.edges`.

Metaphor:

A chainworks or loom hall where an artisan machine weaves anchor chains and golden threads between upstream hubs. Heavier direct dependencies tighten thicker threads around the building; systemic hubs create stronger rhythmic pulses.

Why it ranks fifth:

- Strong data fit: dependencies are one of Pharos' distinctive analytical surfaces.
- Existing PharosVille already fetches report cards, so no new query is needed.
- The building can make hidden upstream risk visible without tying it to ship movement.
- Excellent RPG fit if framed as a guild workshop, forge, or loom.

Implementation effort: Medium-High.

A simple first pass can show only the building plus local pulsing thread arcs. A richer version with threads to ships or districts risks clutter and needs careful culling, depth ordering, and hit-testing. Detail text must avoid transitive-loss or guaranteed-exposure claims.

Pixellab prompt seed:

`old-school 16-bit maritime isometric RPG chainworks loom hall, bronze gear loom weaving glowing anchor chains, stone workshop, hanging chain hooks, small ledger table, transparent background, no text, no logos`

Animation states:

- `high-hub-concentration`: loom gears turn faster and threads pulse thicker.
- `many-direct-dependents`: more thread arcs around the workshop.
- `quiet`: slow gear idle.
- `stale`: threads desaturate and stop pulsing.

## Runner-Up Ideas

- Reserve Vault: high RPG fit, good visual quality, but global reserve data is more uneven unless derived from report-card raw inputs or many per-coin reserve calls. Better after a dedicated reserve aggregation model exists.
- Coverage Cartographers' Guild: semantically honest for feature/data reach, but visually risks becoming meta and less emotionally legible than the top five.
- Daily Digest Scriptorium: charming and easy, but the digest is editorial output rather than primary market telemetry.
- Non-USD Embassy Row: visually strong flags/banners, but `/alt-pegs/` already has a distinctive celestial/world-map metaphor, and PharosVille already has limited main-island space.
- Upcoming Launch Workshop: easy and fun, but pre-launch data is lower priority than the live monitoring surfaces.
- Peg Clinic/Scale House: clear, but ships and DEWS/risk water already encode peg stress, so this would duplicate current PharosVille semantics.

## Recommended Implementation Sequence

1. Add a generic `BuildingNode` world type with `buildingType`, `assetId`, `tile`, `status`, `detailId`, and optional `animationState`.
2. Implement only two buildings first: Royal Mint And Burn Foundry plus Frost Ward Keep. They are the clearest data metaphors, visually differentiated, and easiest to explain.
3. Use one static Pixellab PNG per building and procedural canvas overlays for the first release. Keep these assets `deferred` unless visual review proves they must be critical.
4. Extend the detail index, hit testing, accessibility ledger, and visual cue registry before adding more sprites.
5. Add true frame-based Pixellab object animations as a manifest v2 follow-up, preferably with sprite sheets rather than separate manifest entries for every frame.
6. After the first two pass visual and performance review, add Exit Route Gatehouse, Yield Orchard, and Dependency Loom in that order.

## Validation Notes

Targeted checks for implementation:

- `npm run check:pharosville-assets`
- `npm test -- src/app/pharosville`
- `npm run test:visual -- tests/visual/pharosville.spec.ts`
- manual browser review with normal motion and `prefers-reduced-motion: reduce`
- docs updates: `docs/pharosville-page.md`, `docs/architecture.md`, and `docs/data-visualization.md` if data mapping, manifest, or animation rules change

