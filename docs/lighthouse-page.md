# Lighthouse Page

Contract for the public concept route:

- `/lighthouse/` lighthouse visualization over the chain fleet

---

## Route Shape

- **Page shell:** `src/app/lighthouse/page.tsx`
- **Route client:** `src/app/lighthouse/client.tsx`
- **Scene model:** `src/app/lighthouse/view-model.ts`
- **Scene renderer:** `src/app/lighthouse/lighthouse-scene.tsx`
- **Fleet manifest:** `src/app/lighthouse/lighthouse-fleet-list.tsx`
- **Primary data hooks:** `useChains()` and `useStabilityIndexDetail()`
- **Primary API:** `GET /api/chains` plus the PSI detail endpoint

The route is intentionally visual-first: the scene renders the fleet as a harbor at night, the lighthouse beam marks the currently inspected chain harbor, and the manifest below mirrors the same selection state in text form.

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

The scene is an SVG-only visualization. It stays legible without horizontal scrolling and keeps the data mapping explicit:

- ship width follows chain supply
- ship cargo marks reflect dominant stablecoin concentration
- wake direction and length reflect 7-day change
- lighthouse beam points at the current selection
- PSI contributes a watch label and atmospheric banding only

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
