# Lighthouse Fullscreen Visualization Plan

## Assumptions

- The requested feature is the same interaction pattern used by the `/alt-pegs/` atlas: a viewport-sized Radix Dialog with progressive browser fullscreen when the browser allows it.
- The `/lighthouse/` stage should keep using the current `LighthouseCinematicModel`, mode state, harbor selection, hover preview, and screen-reader ledger.
- The normal route layout should remain visual-first; fullscreen is an inspection affordance, not a new route or new data model.

## Success Criteria

- `/lighthouse/` exposes an icon-only Expand Lighthouse control on the stage.
- Opening the control renders a labeled fullscreen inspection dialog and requests browser fullscreen when available.
- The fullscreen view reuses `LighthouseStage` with the same model and callbacks, without showing a nested expand trigger.
- Closing the dialog or pressing Escape returns to the inline page stage and exits browser fullscreen if this page owns it.
- Focused tests cover the new dialog/control and the shared fullscreen hook import.
- `docs/lighthouse-page.md` documents the fullscreen inspection contract.

## Steps

1. Move the alt-peg browser fullscreen hook to a shared frontend hook and update the atlas import/test.
2. Add a lighthouse fullscreen dialog component that renders a fullscreen `LighthouseStage` variant.
3. Add optional expand props to `LighthouseStage` and `StageControlsLayer`.
4. Add fullscreen-specific CSS so the dialog body owns the available viewport.
5. Update route docs and run focused Vitest coverage for the touched surfaces.
