# Chain Harbor Docks Plan

Created: 2026-04-28

## Goal

Replace the repeated PharosVille bridge/dock sprite with six distinct chain harbor sprites, one for each of the top six chains by stablecoin supply, and remove the isolated far-west dock.

## Success Criteria

- `buildChainDocks()` emits at most six docks ordered by `totalUsd`.
- The `15,42` far-west dock tile is no longer part of the dock placement list.
- Each dock carries a rank-based Pixellab asset id.
- Dock details and the screen-reader ledger expose the highest-supply stablecoins for that chain.
- Stablecoin ships with a rendered dominant-chain dock stay moored around that dock.
- Stablecoin boats show local stablecoin logos on their sails, falling back to a symbol mark while logo assets load or when a logo is absent.
- The asset manifest references all generated PNGs and passes `npm run check:pharosville-assets`.
