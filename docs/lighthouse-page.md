# Lighthouse Page

Contract for the public concept route:

- `/lighthouse/` cinematic Pharos watch over chain harbors, PSI, DEWS, and non-USD peg structure

---

## Route Shape

- **Page shell:** `src/app/lighthouse/page.tsx`
- **Route client:** `src/app/lighthouse/client.tsx`
- **Cinematic model:** `src/app/lighthouse/cinematic-model.ts`
- **Stage renderer:** `src/app/lighthouse/lighthouse-stage.tsx`
- **Stage styles:** `src/app/lighthouse/lighthouse-stage.css`
- **SVG layers:** `src/app/lighthouse/layers/*`
- **Accessible ledger:** `src/app/lighthouse/lighthouse-a11y-ledger.tsx`
- **Primary data hooks:** `useChains()`, `useStabilityIndexDetail()`, `useStressSignals()`, and `useStablecoins()`
- **Primary API:** `GET /api/chains`, the PSI detail endpoint, aggregate `GET /api/stress-signals`, and `GET /api/stablecoins`

The route is intentionally visual-first. The lighthouse, islands, chain harbors, radar marks, and alt-peg sky projection are the visible interface. Text is kept out of the primary stage; exact data remains available through the accessible ledger and SVG labels.

---

## `/lighthouse/` Contract

`src/app/lighthouse/page.tsx` renders a minimal route shell with:

- canonical path `/lighthouse/`
- breadcrumb JSON-LD
- a screen-reader heading
- a dynamic client boundary around the cinematic stage

`src/app/lighthouse/client.tsx`:

- loads chains, PSI detail, stress signals, and stablecoins in parallel
- builds one pure `LighthouseCinematicModel`
- auto-cycles the inspected harbor only in `watch` mode, only until the user pins a harbor, and only when reduced motion is not requested
- lets hover/focus preview a harbor without pinning it
- keeps display mode and ledger visibility as local UI state

`src/app/lighthouse/cinematic-model.ts`:

- derives the visible harbor fleet from existing chain helper semantics
- caps the stage at the largest six harbors and aggregates the remaining chains into tail lights
- uses PSI only for beam reach, lens brightness, color, and scene state
- uses DEWS only as aggregate radar weather, never as per-chain causality
- reuses alt-peg market-cap sizing and peg colors for the sky projection
- sanitizes hostile numeric inputs before turning data into geometry
- returns exact fallback ledger rows so the visual metaphor remains auditable

The stage is an SVG-first visualization. It stays inside the route viewport without horizontal scrolling and keeps the data mapping explicit:

- harbor order and hull scale follow tracked chain supply
- cargo marks follow visible hull capacity and are not a separate score
- wake direction and length reflect 7-day chain supply movement
- harbor signal color follows Chain Health band color semantics
- the lighthouse beam targets the current selected or previewed harbor
- PSI controls lens and beam behavior, not a new `/lighthouse/` score
- DEWS radar rings and blips summarize aggregate stress-signal severity
- alt-peg marks remain a secondary projection of non-USD peg structure
- the accessible ledger repeats selected harbor, PSI, DEWS, alt-peg, and visible harbor facts in text form

Mode controls are icon-only buttons:

- `watch` emphasizes harbor inspection and beam movement
- `radar` emphasizes DEWS aggregate weather
- `atlas` emphasizes non-USD peg projection
- ledger toggle exposes exact text facts on larger screens; small screens expose the ledger automatically

---

## Update Rules

Update this file when any of the following change:

- `/lighthouse/` route shell, layout, or metadata
- selection, preview, pinning, or auto-cycle behavior
- visible harbor limit or tail-fleet aggregation
- data sourcing for chain harbors, PSI, DEWS, or alt-peg marks
- stage semantics for beam, wake, radar, atlas projection, or accessible ledger

Related docs to check in the same change:

- [architecture.md](./architecture.md)
- [README.md](./README.md)
