# PharosVille Testing Guide

Last updated: 2026-04-29

Use this guide to choose focused checks for `/pharosville/`. The global testing reference remains `docs/testing.md`.

## Fast Focused Checks

World model, route facts, ship visual classes, risk placement, map layout, and motion:

```bash
npm test -- src/app/pharosville
```

Asset manifest and local PNG contract:

```bash
npm run check:pharosville-assets
```

Route palette guardrail:

```bash
npm run check:harbor-palette
```

Focused renderer/hit-testing changes:

```bash
npm test -- src/app/pharosville/renderer/hit-testing.test.ts
```

Focused motion changes:

```bash
npm test -- src/app/pharosville/systems/motion.test.ts
```

## Visual And Browser Checks

Run Playwright when the change affects canvas drawing, interaction, viewport gating, reduced motion, screenshots, detail positioning, or route shell behavior:

```bash
npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"
```

Useful narrower lanes:

```bash
npx playwright test tests/visual/pharosville.spec.ts --grep "normal motion"
npx playwright test tests/visual/pharosville.spec.ts --grep "reduced motion"
npx playwright test tests/visual/pharosville.spec.ts --grep "narrow fallback"
```

The visual suite covers desktop shell rendering, narrow/short fallback behavior, canvas interaction, reduced-motion behavior, normal-motion movement, and backing-store budget checks.

## Build And Release Checks

Use these when route metadata, static export behavior, CSS, assets, screenshots, or page shell behavior changes:

```bash
npm run lint
npm run typecheck
npm run build
npm run seo:check
```

Before pushing deploy-impacting work:

```bash
npm run test:merge-gate
```

## Docs-Only Maintenance Changes

For changes limited to `docs/pharosville/`, `docs/agent-task-router.md`, `docs/doc-ownership.json`, or `docs/testing.md`, run:

```bash
npm run check:verified-doc-links
npm run check:doc-source-paths
```

These checks are still useful for docs-only route-maintenance changes because `docs/pharosville/` is part of the verified documentation corpus.

## What To Verify Manually

- The desktop gate still prevents world data, manifest, canvas, and sprite loading below `1280px` by `760px`.
- Normal motion visibly moves ships without turning route semantics into game mechanics.
- Reduced motion stays deterministic and does not run a RAF loop.
- Detail panel and accessibility ledger describe any new visual encoding.
- Hit targets align with sprites after scale, anchor, or motion changes.
- Docking cadence reads as chain presence, not transfers or activity.
