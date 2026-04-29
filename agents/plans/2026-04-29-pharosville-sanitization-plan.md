# PharosVille Sanitization Plan

Date: 2026-04-29

## Assumptions

- The active surface is `/pharosville/` and the legacy lighthouse/harbor prototype remains out of scope.
- Existing Pixellab dock and district assets are sufficient for this pass; the requested cleanup can be handled in the world model and Canvas renderer without generating new assets.
- The current dirty PharosVille worktree is treated as baseline work in progress and must not be reverted.

## Success Criteria

- Alert Channel, Warning Shoals, and Danger Strait are successive DEWS water areas with visibly escalating water treatment.
- Ships whose peg/DEWS evidence maps to ALERT, WARNING, or DANGER route through the corresponding water area.
- Ethereum, Base, Arbitrum, and Polygon stay in the EVM bay, with Ethereum on the prominent slot.
- BSC, Tron, Solana, Aptos, and other non-core-EVM top harbors are placed on separate island coastlines instead of the EVM bay.
- Water-area labels render as nautical posts, while harbor labels render as separate hanging building signs.
- Unit tests and route docs reflect the new placement contract.

## Plan

1. Add terrain-level DEWS water bands and align risk anchors/sign tiles to those bands.
2. Replace rank-only dock coordinates with chain-aware EVM bay and distributed outer-harbor placement.
3. Split generic sign rendering into water posts and harbor signs.
4. Update PharosVille docs and focused tests.
5. Run targeted PharosVille validation, then broader lint/build checks as time allows.
