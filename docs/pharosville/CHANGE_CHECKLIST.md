# PharosVille Change Checklist

Last updated: 2026-04-29

Use this checklist for future `/pharosville/` work. Keep it agent-facing and update it when the route workflow changes.

## Before Editing

- Read `docs/pharosville-page.md`, `docs/pharosville/CURRENT.md`, and `docs/pharosville/TESTING.md`.
- For asset work, also read `docs/pharosville/ASSET_PIPELINE.md`.
- Run `git status --short` and identify dirty files before touching anything.
- Inspect the exact files you plan to edit. Work with existing dirty changes; do not revert or overwrite unrelated work.
- State whether the change affects route behavior, visual encoding, asset inventory, data/API contracts, or agent docs only.

## Scope Guardrails

- Keep changes under `src/app/pharosville/`, `public/pharosville/assets/`, route docs, and this agent pack unless the user explicitly widens scope.
- Do not change Worker/API contracts for a visual-only route change without explicit approval.
- Do not change methodology, scoring thresholds, or classification semantics from a PharosVille task.
- Do not move analytical meaning into canvas only; keep DOM parity for detail and accessibility.
- Do not weaken the desktop viewport gate or reduced-motion contract.

## Implementation Checks

- World-model changes should be pure and covered by focused system tests.
- Renderer changes must keep hit testing, selected rings, follow-selected behavior, and debug samples aligned.
- Motion changes must keep sampled routes deterministic, water-only where expected, and static under reduced motion.
- Asset changes must update `public/pharosville/assets/manifest.json`, bump `style.cacheVersion` when bytes/geometry/animation frames change, keep provenance aligned with `style.styleAnchorVersion`, and pass asset validation.
- Copy or route behavior changes may require `docs/pharosville-page.md`; route-maintenance process changes belong in `docs/pharosville/`.

## Pre-Claim Validation

Choose the narrowest relevant checks from `TESTING.md`, then broaden when the change touches shared route behavior.

Minimum for docs-only agent changes:

```bash
npm run check:verified-doc-links
npm run check:doc-source-paths
```

Minimum for PharosVille implementation changes:

```bash
npm test -- src/app/pharosville
npm run check:pharosville-assets
npm run check:harbor-palette
```

Add visual and build validation when UI, canvas, metadata, screenshots, or static export behavior changes:

```bash
npm run build
npm run seo:check
npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"
```

Before pushing deploy-impacting work:

```bash
npm run test:merge-gate
```

## Handoff Notes

Record exact commands and outcomes in the relevant plan/handoff file when work spans multiple sessions. If a command is skipped, state why. If validation is blocked by pre-existing dirty work, identify the file and failure without changing unrelated files.
