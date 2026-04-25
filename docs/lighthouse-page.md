# Lighthouse Page

Contract for the public concept route:

- `/lighthouse/` lighthouse visualization over the chain fleet

---

## Route Shape

- **Page shell:** `src/app/lighthouse/page.tsx`
- **Route client:** `src/app/lighthouse/client.tsx`
- **Scene model:** `src/app/lighthouse/view-model.ts`
- **Story model:** `src/app/lighthouse/story-model.ts`
- **Scene renderer:** `src/app/lighthouse/lighthouse-scene.tsx`
- **Story shell:** `src/app/lighthouse/lighthouse-story-shell.tsx`
- **Story panels:** `src/app/lighthouse/lens-room-panel.tsx`, `src/app/lighthouse/storm-watch-panel.tsx`, `src/app/lighthouse/harbor-ledger.tsx`, `src/app/lighthouse/dawn-orders.tsx`
- **Fleet manifest:** `src/app/lighthouse/lighthouse-fleet-list.tsx`
- **Primary data hooks:** `useChains()`, `useStabilityIndexDetail()`, and `useStressSignals()`
- **Primary API:** `GET /api/chains`, the PSI detail endpoint, and aggregate `GET /api/stress-signals`

The route is intentionally visual-first: the scene renders the view from inside the lighthouse lens room, projects the chain fleet onto the horizon, and keeps the selected illuminated harbor tied to exact Pharos data through the in-scene readout and signal reel.

---

## `/lighthouse/` Contract

`src/app/lighthouse/page.tsx` renders a `FeaturePageShell` with:

- breadcrumb + canonical path `/lighthouse/`
- status badge `experimental`
- lead copy framing the beam as an inspection signal, not a new score

`src/app/lighthouse/client.tsx`:

- loads the chain snapshot and PSI detail in parallel
- resolves the default selection from the largest visible harbor
- auto-cycles the inspection target until the user selects a harbor
- respects reduced-motion preferences

`src/app/lighthouse/view-model.ts`:

- derives the visible ship set from `GET /api/chains`
- caps the scene at the largest six harbors
- computes the trailing fleet aggregate
- resolves the selected harbor and the lighthouse target geometry
- formats the scene caption and selected-manifest copy from existing chain fields only

`src/app/lighthouse/story-model.ts`:

- orders the route chapters: Harbor, Lens, Storm, Ledger, and Orders
- marks chapters unavailable when PSI or stress-signal data is missing
- derives PSI lens slats from published PSI components only
- derives DEWS storm-watch counts from aggregate `WARNING`, `ALERT`, and `DANGER` bands only
- prepares ledger facts and onward route links without inventing a new score

The main scene is an SVG-only visualization. It stays legible without horizontal scrolling and keeps the data mapping explicit:

- horizon target order follows the largest visible chain harbors
- signal height follows tracked supply share
- dock width and pennant width reflect dominant stablecoin concentration
- cargo marks scale with visible hull size and are not an independent risk signal
- wake direction and length reflect 7-day change
- the lens beam points at the current selection
- PSI contributes a watch label in the baseline route; the Lens Room story chapter may use PSI color and component shutters explicitly
- DEWS appears only as aggregate storm-watch context in the story chapter, never as chain-specific causality

The story controls and signal reel are local UI state. Hover/focus can preview a harbor and move the beam; click, Enter, or Space pins the selection. Route navigation stays on explicit links.

---

## Update Rules

Update this file when any of the following change:

- `/lighthouse/` route shell, layout, or metadata
- selection behavior or auto-cycle rules
- visible ship limit or tail-fleet aggregation
- data sourcing for the scene, manifest, or caption
- scene semantics for beam, wake, or harbor mapping

Related docs to update in the same change:

- [architecture.md](./architecture.md)
- [README.md](./README.md)
