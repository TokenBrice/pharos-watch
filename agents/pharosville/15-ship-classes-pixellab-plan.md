# PharosVille Ship Classes + PixelLab Asset Plan

Date: 2026-04-28

## Assumptions

- This is a PharosVille planning pass only; no production code or assets are changed here.
- "Ship model" means the existing Canvas 2D PharosVille sprite model, not a 3D GLB/FBX model.
- Stablecoin class uses the existing `StablecoinMeta.flags.governance` taxonomy: `centralized`, `centralized-dependent`, and `decentralized`.
- Market cap uses `getCirculatingRaw(asset)`, which is already USD-denominated for the stablecoin list payload.

## Current Implementation

- The live route is `/pharosville/`; it is desktop-only and must not mount world queries, canvas, manifest fetches, or sprite decoding below `1280px` width or `760px` height.
- Data enters through `src/app/pharosville/pharosville-desktop-data.tsx`, then `buildPharosVilleWorld()` builds the pure world model in `src/app/pharosville/systems/pharosville-world.ts`.
- Current ship visual selection lives in `src/app/pharosville/systems/ship-visuals.ts`.
- Current ship assets are manifest-backed PNG sprites under `public/pharosville/assets/ships/`:
  - `ship.treasury-galleon`
  - `ship.crypto-caravel`
  - `ship.algo-junk`
- The renderer in `src/app/pharosville/renderer/world-canvas.ts` loads assets by `ship.${ship.visual.hull}` and falls back to a procedural ship when an asset is missing.
- Hit testing mirrors the rendered scale in `src/app/pharosville/renderer/hit-testing.ts`; any scale or anchor changes must be kept in sync.
- `scripts/pharosville/validate-assets.mjs` enforces local PNG assets, dimensions, no orphan PNGs, no remote URLs/tokens, duplicate ID rejection, and a 34-asset manifest cap. The manifest currently has enough room for a modest ship expansion.

## Product Model

Use separate visual channels so the map remains readable:

| Data | Visual channel | Rule |
| --- | --- | --- |
| Governance class | Ship class / silhouette | Primary ship family |
| Backing | Hull/cargo/trim treatment | Secondary cue; should not override governance |
| Market cap | Compressed size tier | Bounded, not linear |
| Peg currency | Pennant / sail mark | Keep current peg behavior |
| Peg and DEWS stress | Distance from shore, sea/weather, aura | Risk remains spatial and environmental |
| Yield or NAV wrapper | Small overlay/cargo marker | Do not make wrappers a separate base class |

Recommended governance-to-ship mapping:

| Governance | Label | Ship class | Intent |
| --- | --- | --- | --- |
| `centralized` | CeFi | Treasury Galleon | Broad issuer/custody/redemption vessel |
| `centralized-dependent` | CeFi-Dep | Chartered Brigantine | Hybrid/dependent vessel; visibly distinct without implying failure |
| `decentralized` | DeFi | DAO Schooner | Nimble on-chain vessel |

Keep `algo-junk` only as a defensive legacy/shadow fallback if algorithmic backing appears in the active path. It should not be the primary class model for active stablecoins.

## Size Model

Replace the current `0.75 / 1 / 1.25` scale bands with named compressed tiers:

| Tier | Market cap | Scale |
| --- | ---: | ---: |
| Flagship | `>= $10B` | `3.0` |
| Major | `$1B - $10B` | `1.8` |
| Regional | `$100M - $1B` | `1.25` |
| Local | `$10M - $100M` | `0.95` |
| Skiff | `$1M - $10M` | `0.78` |
| Micro / unknown | `< $1M`, invalid, missing | `0.7` |

This intentionally exaggerates larger ships so $1B+ assets are spottable and the top issuers can read as major map landmarks, while still capping scale instead of making area linear to market cap. Exact market cap remains available in the detail panel.

## PixelLab Asset Plan

Use `mcp__pixellab__.create_map_object` for standalone transparent PNG sprites.

Generation defaults should match the manifest style:

```json
{
  "width": 80,
  "height": 64,
  "view": "low top-down",
  "outline": "single color outline",
  "shading": "medium shading",
  "detail": "medium detail"
}
```

Generate candidates into `agents/pharosville/pixellab-prototypes/` first. Do not reference PixelLab URLs at runtime; selected PNGs must be local checked-in static assets under `public/pharosville/assets/ships/`.

Suggested production asset IDs:

| ID | Path | Purpose |
| --- | --- | --- |
| `ship.treasury-galleon` | `ships/treasury-galleon.png` | CeFi |
| `ship.chartered-brigantine` | `ships/chartered-brigantine.png` | CeFi-Dep |
| `ship.dao-schooner` | `ships/dao-schooner.png` | DeFi |
| `ship.algo-junk` | `ships/algo-junk.png` | legacy/shadow fallback |

Candidate prompts should prepend the manifest style anchor:

- `fiat-backed stablecoin treasury galleon, compact isometric merchant ship, cream sail, warm brown hull, gold reserve trim, readable at small size, transparent background, no text, no logo, no UI`
- `centralized-dependent stablecoin chartered brigantine, compact isometric hybrid merchant ship, balanced classic and modern rigging, muted amber dependency pennants, readable at small size, transparent background, no text, no logo, no UI`
- `decentralized stablecoin DAO schooner, compact isometric agile schooner, open rigging, teal and limestone sail accents, readable at small size, transparent background, no text, no logo, no UI`
- `legacy algorithmic stablecoin junk boat, compact isometric fantasy ship, patched red-brown sail, fragile asymmetric silhouette, readable at small size, transparent background, no text, no logo, no UI`

Manifest updates after asset selection:

- Bump `style.assetVersion`.
- Add or update ship entries with accurate `width`, `height`, `anchor`, `footprint`, `hitbox`, and `loadPriority`.
- Keep `tool: "mcp:create_map_object"` and record `promptProvenance.jobId`.
- Keep only the first-render ship family critical if possible; defer the rest unless first-render fallback becomes visually misleading.

## Implementation Steps

1. Generate PixelLab candidates and save them under `agents/pharosville/pixellab-prototypes/`.
2. Select and normalize final PNGs to local production paths. Verify actual PNG dimensions before manifesting.
3. Extend `ShipVisual` in `src/app/pharosville/systems/world-types.ts` with `shipClass`, `classLabel`, `sizeTier`, and `sizeLabel`.
4. Update `src/app/pharosville/systems/ship-visuals.ts`:
   - Add `resolveShipClass(meta)`.
   - Add `resolveShipSizeTier(marketCapUsd)`.
   - Map governance class to the new ship asset IDs.
   - Preserve peg pennants, yield/NAV/watch overlays, and backing metadata as secondary cues.
5. Update `src/app/pharosville/renderer/world-canvas.ts`:
   - Use the new ship asset IDs.
   - Recalibrate sail-logo offsets only if selected sprites differ materially from current geometry.
   - Keep procedural fallback colors for every ship class.
6. Update `src/app/pharosville/renderer/hit-testing.ts` if any asset scale/anchor math changes.
7. Update `src/app/pharosville/systems/detail-model.ts` so the DOM detail panel exposes ship class and size tier alongside exact market cap.
8. Update `src/app/pharosville/systems/visual-cue-registry.ts` so visual cue documentation names governance class and compressed market-cap size.
9. Consider clustering long-tail ships by `riskPlacement + shipClass + sizeTier` instead of only risk placement if clusters become semantically mixed.
10. Update docs:
    - `docs/pharosville-page.md`
    - `docs/architecture.md` only if the route contract summary changes
    - `docs/data-visualization.md` only if the compressed tiering is documented as a broader pattern

## Test Plan

Focused validation:

```bash
npm run check:pharosville-assets
npm run check:harbor-palette
npx vitest run src/app/pharosville/systems/ship-visuals.test.ts src/app/pharosville/systems/pharosville-world.test.ts src/app/pharosville/renderer/hit-testing.test.ts
npm run test:visual
```

Pre-claim validation for an implementation branch:

```bash
npm run lint
npm test
npm run build
npm run test:merge-gate
```

Add unit coverage for:

- CeFi, CeFi-Dep, and DeFi class mapping.
- Defensive fallback for missing/unknown governance.
- Monotonic size tiers with bounded max/min ratio.
- Invalid, zero, negative, or missing market cap using the smallest/unknown tier.
- Detail panel facts for ship class and size tier.
- Hit targets remaining selectable after scale changes.

## Risks

- Sprite geometry can break sail-logo placement; visual review is required after PixelLab selection.
- Draw and hitbox drift can make selection feel wrong if renderer and hit-testing scale math diverge.
- Too many asset variants can hit the manifest cap or slow deferred loading.
- If class meaning changes, PharosVille must keep DOM parity because canvas is not the only source of analytical truth.
- Replacement sprites can affect visual snapshots; update screenshots only after confirming the semantic behavior is correct.
