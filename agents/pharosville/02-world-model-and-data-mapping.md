# World Model And Data Mapping

## North Star

PharosVille is a small island city in a large sea. The sea is the stablecoin market. The island is Pharos's interpretive layer: docks, lighthouse, watch posts, markets, cemetery, and civic districts that make market state spatially readable.

The map should answer:

- Which stablecoins dominate the market?
- Which assets are calm, strained, or in danger?
- Which chains carry the most stablecoin liquidity?
- Where are risk and stress concentrated?
- Which coins are dead or frozen?
- What changed recently?

## Map Shape

Recommended base grid:

- `64 x 64` isometric tiles for production.
- At least `70%` water tiles by count.
- One central island cluster occupying roughly `24-30%` of tiles.
- Deep water ring around the map edge.
- Shallow harbor water around the city.
- Central lighthouse on its own fortified rock or civic island inside the city.
- Docks radiating outward from island edges.

Water ratio should be enforced by a map fixture test. Example invariant:

```ts
const waterRatio = waterTiles.length / (MAP_WIDTH * MAP_HEIGHT);
expect(waterRatio).toBeGreaterThanOrEqual(0.68);
expect(waterRatio).toBeLessThanOrEqual(0.74);
```

## Districts

| District | Visual Form | Data Role |
| --- | --- | --- |
| Beacon Keep | central lighthouse, flame, beam, signal lenses | PSI and global market condition |
| Main Harbor Ring | large docks around island perimeter | chains by stablecoin TVL |
| Merchant Roads | streets from docks to market | chain-to-market connection and top stablecoin routes |
| Open Sea | deep water beyond harbor | peg-risk / DEWS stress space |
| Breakwater | near-shore safe waters | healthy pegged assets |
| Storm Shelf | outer water with waves, rocks, dark color | distressed/depegging assets |
| Cemetery Quarter | walled graveyard on quiet island edge | dead/frozen stablecoins |
| Market Exchange | central bazaar, cranes, cargo | DEX liquidity and market depth |
| Mint House | foundry/treasury with cargo flows | mint/burn pressure |
| Yield Garden | terraces, mills, or treasury orchards | yield-bearing opportunities |
| Watch Posts | towers, warning fires, signal flags | DEWS and report-card risk outliers |
| Archive / Hall Of Ledgers | library/city hall | methodology, data freshness, exact ledger |

## Core Encodings

### PSI: Lighthouse

Source:

- `useStabilityIndexDetail()`
- `StabilityIndexResponse.current.score`
- `StabilityIndexResponse.current.band`
- `StabilityIndexResponse.current.components`
- `StabilityIndexResponse.current.contributors`

Visual:

- Lighthouse is prominent and central.
- Flame color maps to PSI band.
- Beam sweep speed maps to PSI band or score.
- Beam width maps to confidence/freshness.
- Beam direction can settle toward the largest current PSI contributor under reduced motion.
- Lighthouse masonry damage or flags can reflect input degradation.

Interaction:

- Click lighthouse to open PSI detail panel: score, band, components, top contributors, methodology version, computed timestamp.

### Stablecoin Market Cap: Boats And Ships

Source:

- `useStablecoins().data.peggedAssets`
- `StablecoinData.circulating`
- `StablecoinData.chainCirculating`
- `StablecoinData.pegType`
- metadata from `ACTIVE_META_BY_ID` / `TRACKED_META_BY_ID`
- `StablecoinMeta.flags`

Visual:

- Every active stablecoin is represented in the world model.
- Top N by market cap are individual ships at normal zoom.
- Long-tail coins are clustered into fleet groups by chain, peg, or risk band until zoomed/filtered.
- Boat size is log-scaled by market cap.
- Boat class maps to stablecoin type:
  - Centralized RWA-backed: large merchant galleon / treasury ship.
  - Centralized-dependent: chartered transport / bridge barge.
  - Decentralized crypto-backed: nimble cutter / spell-sloop.
  - Algorithmic: alchemist skiff / experimental vessel.
  - Commodity-backed: armored bullion barge.
  - Yield-bearing: cargo sails or harvest pennant.
  - NAV token: ledger raft / sealed vault boat.
- Peg currency is sail/pennant motif, not dominant hull color.
- Stablecoin identity is shown only on hover/selection or for top assets at high zoom.

Interaction:

- Click ship to show exact coin data: supply, price, peg type, backing/governance, chains, peg state, DEWS band, safety grade, links to detail page.

Implementation note:

- Use `/api/stablecoins` and each asset's `chainCirculating` for full boat coverage.
- Do not rely on `/api/chains.topStablecoins` for all boats. That field is appropriate for dock summaries and top docked ships, but it is intentionally incomplete for long-tail stablecoins.
- Filter the ship universe to active coins only with `ACTIVE_IDS`, `ACTIVE_META_BY_ID`, and `asset.frozen !== true`.
- Use `getCirculatingRaw(asset)` for boat market cap and `canonicalizeChainCirculating()` / `findCanonicalChainData()` for per-chain berths.

### Peg Status: Distance From Shore

Sources:

- `usePegSummary()`
- `useStressSignals()`
- optional depeg history from `useInfiniteDepegEvents()` after MVP
- `StablecoinData.price`

Visual:

- Healthy assets stay inside breakwater/near shore.
- Watch assets drift into mid-water.
- Alert/warning assets move toward rough water.
- Danger/depegging assets appear in outer storm shelf, near reefs or whirlpools.
- Assets with insufficient peg data sit in fog banks or at a customs checkpoint rather than being shown as healthy.

Distance policy:

| State | Placement |
| --- | --- |
| calm / no material deviation | docked or inside harbor |
| watch | harbor mouth / mid-water |
| alert | outside breakwater |
| warning | rough outer water |
| danger / active depeg | storm shelf or reef zone |
| missing data | fog mooring / unresolved berth |

Important rule: use distance, silhouette, and motion together. Do not rely on red/green alone.

Required pure function:

```ts
resolveShipRiskPlacement({
  asset,
  pegCoin,
  stressSignal,
  meta,
  freshness,
}: RiskPlacementInput): ShipRiskPlacement
```

Precedence:

1. `asset.frozen === true` or inactive registry id: exclude from active ships; cemetery only.
2. Stale required inputs: place in `data-fog` lane unless a stronger active depeg is present.
3. `pegCoin.activeDepeg === true`: place in `storm-shelf`, severity from `abs(currentDeviationBps ?? worstDeviationBps ?? 0)`.
4. Severe current deviation, even without active event:
   - `abs(currentDeviationBps) >= 500`: `storm-shelf`.
   - `>= 200`: `outer-rough-water`.
   - `>= 50`: `harbor-mouth-watch`.
5. DEWS band if stronger than peg deviation:
   - `DANGER`: `storm-shelf`.
   - `WARNING`: `outer-rough-water`.
   - `ALERT`: `harbor-mouth-watch`.
   - `WATCH`: `breakwater-edge`.
   - `CALM`: no escalation.
6. `pegCoin` missing, `asset.price == null`, or low/fallback price confidence: `data-fog`.
7. NAV tokens:
   - If metadata marks `navToken`, do not overstate peg safety from missing peg summary. Place in `ledger-mooring` unless an explicit active depeg/stress signal escalates it.
8. Default: `safe-harbor`.

Unknown bands must fall back to `data-fog` or neutral safe harbor only when exact freshness/peg inputs are good; never crash.

### Chains: Docks

Source:

- `useChains().data.chains`
- `ChainSummary.totalUsd`
- `ChainSummary.stablecoinCount`
- `ChainSummary.topStablecoins`
- `ChainSummary.healthBand`
- `ChainSummary.healthScore`
- `ChainSummary.dominanceShare`
- `ChainSummary.healthFactors`

Visual:

- Each major chain is a dock/harbor sector.
- Dock footprint and pier count map to `totalUsd` using log scale.
- Warehouse count maps to `stablecoinCount`.
- Dock condition maps to `healthBand`:
  - robust/healthy: stone quay, clear lamps.
  - mixed: patched wood, visible caution markers.
  - fragile/concentrated: narrow pier, worn supports, warning flags.
- Top chain stablecoins are docked at that chain's berth.
- Chain dominance is visible as one oversized ship or crowded berth when concentration is high.

Interaction:

- Click dock to show chain TVL, stablecoin count, top stablecoins, dominance share, health score/factors, and link to `/chains/<chain>/`.

### Dead And Frozen Stablecoins: Cemetery

Sources:

- `CEMETERY_ENTRIES` from `shared/lib/cemetery-merged.ts`
- curated `DEAD_STABLECOINS`
- frozen stablecoins from stablecoin registry, mapped into cemetery shape per `docs/cemetery-and-compare.md`
- `DeadStablecoin.peakMcap`
- `DeadStablecoin.causeOfDeath`
- `DeadStablecoin.deathDate`

Visual:

- Walled cemetery on the island edge, separated but visible.
- One grave marker per dead/frozen coin in world data.
- At far zoom: clustered graves by year/cause.
- At close zoom: individual tombstones.
- Tombstone size maps to peak market cap.
- Weathering maps to age.
- Cause maps to small symbol/stone tint, consistent with cemetery cause colors.

Interaction:

- Click grave or cemetery cluster to show epitaph, cause, date, peak market cap, and source link.
- Link to `/cemetery/` for full memorial view.

## Secondary Encodings

### DEWS: Weather And Sea State

Source:

- `useStressSignals()`
- aggregate highest band and breadth

Visual:

- Calm: clear water, low waves.
- Watch/alert: more chop, flags, cloud wisps.
- Warning/danger: storm clouds, foam, lightning hints, rough outer sea.
- Per-coin DEWS band can add ship aura/pennant.

### Report Cards: Civic Inspection Seals

Source:

- `useReportCards()`
- `ReportCard.overallGrade`
- dimension scores

Visual:

- Selected ship has an inspection seal.
- Risk dimensions can appear as tiny dockside plaques or detail-panel meters.
- Low-grade assets can show patched hulls or dim lanterns, but do not overload the base boat identity.

### DEX Liquidity: Market Depth

Source:

- `useDexLiquidity()`

Visual:

- Market Exchange and harbor channel depth.
- Liquid assets get clear shipping lanes and active cranes.
- Illiquid assets get shallow sandbars, narrow channels, or stalled cargo.

### Mint/Burn Flows: Cargo Movement

Source:

- `useMintBurnFlows()`

Visual:

- Mint House emits crates/cargo to ships for net issuance.
- Burn pressure pulls cargo back to vaults.
- Flight-to-quality can show guarded convoy movement toward safer docks.

### Recent Change: Wakes And Cargo Flags

Sources:

- `StablecoinData.circulatingPrevDay`
- `StablecoinData.circulatingPrevWeek`
- `StablecoinData.circulatingPrevMonth`
- `ChainSummary.change24hPct`
- `ChainSummary.change7dPct`
- `ChainSummary.change30dPct`
- optional `useMintBurnFlows()`

Visual:

- Ships with strong positive 24h/7d supply change get short wake/cargo glints.
- Ships with strong negative supply change get receding wake or unloaded-cargo markers.
- Chain docks with material growth get active crane lights.
- Chain docks with material contraction get lowered cargo nets.
- Exact values stay in detail panel.

Implementation:

- Use shared supply helpers for deltas.
- Cap recent-change markers to top movers plus selected entity.
- This satisfies the "what changed recently" promise without loading per-coin history.

### Yield: Treasury Gardens

Source:

- `useYieldRankings()`

Visual:

- Yield-bearing stablecoins can carry orchard/harvest pennants.
- Top risk-adjusted opportunities can appear near treasury terraces.
- This should be optional in v1 because yield data is not part of the user's first mapping list.

### Dependency Graph: Rope Lines And Supply Houses

Source:

- `useReportCards().data.dependencyGraph`
- `StablecoinMeta.dependencies`

Visual:

- Dependency lines should be opt-in or selection-only.
- Selected coin can reveal rope lines to reserve/custody/protocol landmarks.
- Never draw all dependency edges at once.

### Data Freshness: Fog And Ledger Bells

Source:

- query metadata from `useApiQueryWithMeta`
- endpoint `_meta`
- `X-Data-Age` interpreted by existing hooks

Visual:

- Fresh data: normal.
- Degraded data: light fog around affected district.
- Stale data: ledger bell / muted district / detail-panel warning.

## Avoided Encodings

- Do not show all labels at once.
- Do not assign unique colors to every chain and every stablecoin; the palette will collapse.
- Do not animate every ship continuously.
- Do not show a coin as safe just because data is missing.
- Do not encode exact values only in canvas pixels; DOM must carry exact numbers.
