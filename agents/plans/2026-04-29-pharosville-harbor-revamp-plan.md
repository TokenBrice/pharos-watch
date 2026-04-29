# PharosVille Harbor Revamp Plan

Date: 2026-04-29

## Assumptions

- The active target is `/pharosville/`, not the legacy `harbor-scene-*` prototype path.
- "Chain harbors" means rendered top-chain docks from `/api/chains`, with ship visits derived from positive `stablecoins.chainCirculating` chain presence.
- Ships should read as belonging to harbors first. Peg/DEWS risk water remains part of the route, but should not make the initial/static frame look like every ship starts from the top or open edge of the map.
- PixelLab work should remain local static PNGs under `public/pharosville/assets/`; runtime must not depend on remote PixelLab URLs.
- Follow-up bay cleanup should avoid broad overlay sprites that cover authored dock slots. Each harbor should read as an individual building/dock sprite with its own sign.

## Success Criteria

- Reduced-motion representative ship positions use rendered chain harbor moorings when a ship has rendered positive chain presence.
- Normal-motion cycles start from harbor context, visit rendered chain harbors frequently, and still route through risk water according to peg/DEWS status.
- Ships with multiple rendered chain presences rotate across those docks over cycles.
- Dockless ships continue to sail deterministic water patrols rather than parking on a single tile.
- Ethereum uses a dedicated epic PixelLab grand-quay asset in the center of the EVM bay, with Base, Arbitrum, and Polygon assigned to surrounding EVM-bay side slots.
- Top-ten chain harbors use PixelLab assets without falling back to repeated generic wooden piers.
- The cemetery sits on the main island between the EVM bay and lighthouse, leaving no detached southwest cemetery island behind.
- Unit tests cover harbor-first anchors, dock rotation, and water-only samples.
- Documentation reflects the revised PharosVille harbor behavior.

## Plan

1. Preserve existing dirty worktree changes and build on the current PharosVille motion/dock pass.
2. Add harbor-first representative placement after dock-visit assignment.
3. Update motion routes so docked ships start from a primary harbor stop, travel through risk water, then visit scheduled harbor stops.
4. Generate and integrate individual PixelLab dock sprites without a broad harbor-district overlay.
5. Update focused tests/docs and run targeted validation.
