# PharosVille Scenery Brief

Date: 2026-04-29
Status: Phase 0 contract
Scope: `/pharosville/` visual-world grammar only

## Purpose

PharosVille is a data-driven maritime observatory island-city for stablecoin market health and market-structure telemetry across Pharos-tracked assets.

Primary user question: Where is stablecoin risk, market structure, and recent activity concentrated right now, and which exact Pharos surface should I inspect next?

## Transfer Boundary

This brief borrows bounded-world, cue-registry, manifest, motion-budget, and DOM-truth habits from ClaudeVille-style work. It does not copy fantasy-village scenery, cozy tone, decorative lore, or extra roleplay concepts into Pharos.

PharosVille remains dark-first, precise, semantic, maritime, and analytical. Avoid non-semantic palettes, generic Web3 glow/glass, decorative copy, new display typography systems, and scenery that competes with stablecoin-monitoring meaning.

## World Grammar

| Data concept | World element | Cue intent | DOM truth |
| --- | --- | --- | --- |
| Pharos Stability Index | Lighthouse | Systemic stability, watchfulness, degraded evidence | PSI score, band, source link |
| Chain stablecoin supply | Harbors/docks | Top chain footprint, chain identity, dominant stablecoin cargo | Chain supply, health, top cargo |
| Active stablecoins | Ships | Stablecoin identity, class, scale, home docks, risk route | Exact supply, chain presence, risk placement, route facts |
| Peg and DEWS stress | Risk water bands | Distance from harbor, water severity, fog/storm context | DEWS band, peg status, source fields |
| Long-tail active assets | Ship clusters | Budgeted grouping by water zone and total supply | Cluster members and totals |
| Mint/burn pressure | Royal Mint And Burn Foundry | Issuance-chain activity and stale/unavailable states | Gauge, volumes, scope, sync caveat |
| Exit liquidity and redemption routes | Exit Route Gatehouse | Exit depth, concentration, route freshness | DEX/backstop facts and non-guarantee caveat |
| Yield intelligence | Yield Orchard And Moonwell | Source breadth, source switches, benchmark context | Rankings, source context, safety caveat |
| Dependency risk | Dependency Loom / Chainworks | Direct report-card dependency links and hubs | Direct edges, hubs, no transitive VaR claim |
| Freeze/blacklist monitoring | North Froze Pole area | Observed freeze activity as frozen northern water | Active totals, recent events, chains, methodology |
| Dead/frozen lifecycle | Cemetery | Memorialized dead/frozen assets with cause-aware treatment | Cause/date/cemetery detail |

North Froze Pole is a northern frozen-water area, not a building sprite. It should stay visually separate from the main-island data buildings.

## Actors

| Entity | Identity cues | Movement behavior |
| --- | --- | --- |
| Active stablecoin | Hull by governance class, sail logo or symbol, compressed market-cap scale | Slow deterministic water-only route through home docks and risk anchor |
| Long-tail group | Count, total market cap, risk placement | Static water-zone cluster |
| Chain dock cargo | Chain logo flag, harbored stablecoins in DOM | Static landmark; selection can highlight associated ships |
| Cemetery entry | Local cemetery logo, cause-aware marker treatment | Static memorial precinct |

## Events And Effects

| Event/state | Visual cue | Reduced-motion fallback |
| --- | --- | --- |
| PSI band/current score | Lighthouse fire, beam, fog/unlit state | Static flame/beam color |
| DEWS breadth/severity | Named risk water bands, storm/fog treatment | Static water tint/zone labels |
| Peg/DEWS stress on coin | Ship risk anchor and route detour | Static representative mooring or risk patrol tile |
| Recent supply move | Capped wake/effect on selected/top/recent ships | Static wake mark or detail fact only |
| Mint-heavy/burn-heavy flow | Press/furnace sparks/smoke | Static press/furnace glow |
| Freeze activity | Ice seams, cold mist, frosted sign | Static frost/mist |
| Exit depth/concentration | Gate opening, water level, wheel/lantern | Static gate/water level |
| Yield source breadth/warning | Orchard glints, well/windmill state | Static glints/well tint |
| Dependency concentration | Loom threads/gears | Static thread arcs |
| Stale or missing source | Data fog/dimmed landmark | Static fog and explicit DOM stale fact |

## DOM-Only Until Clearer

The canvas must not become the only source of analytical truth. Exact values, caveats, source fields, freshness, member lists, links, keyboard instructions, and screen-reader copy stay in DOM surfaces.

Concepts that should remain DOM-only until their visual mapping is clearer:

- full tables of events, holdings, pools, yields, or dependencies
- transitive dependency exposure and value-at-risk interpretations
- executable redemption guarantees or route promises
- filtering, sorting, and dense inspection controls
- methodology text beyond short source/caveat labels

No new Worker endpoint, D1 migration, data provider, supply override, methodology change, or mobile canvas support is implied by this scenery brief.
