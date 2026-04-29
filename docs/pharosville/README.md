# PharosVille Maintenance Pack

Created: 2026-04-28

Goal: maintain durable maintenance, asset, and validation notes for `/pharosville/`. This directory complements the public route contract in `docs/pharosville-page.md`; use `docs/pharosville/CURRENT.md` for the current implementation map.

## Start Here

- `CURRENT.md` — current source of truth for PharosVille maintenance work, live route entrypoints, invariants, and known boundaries.
- `CHANGE_CHECKLIST.md` — pre-edit and pre-claim checklist for future PharosVille changes.
- `CHANGE_PLAYBOOK.md` — task-type decision tree from request to files, docs, and focused checks.
- `VISUAL_INVARIANTS.md` — non-negotiable visual/data contracts for the world representation.
- `SCENARIO_CATALOG.md` — canonical fixture and test scenarios for semantic and visual validation.
- `VISUAL_REVIEW_ATLAS.md` — screenshot baselines, browser review entries, and manual pixel checklist.
- `KNOWN_PITFALLS.md` — repeat-risk issues maintainers should check before editing or claiming completion.
- `ASSET_PIPELINE.md` — Pixellab/prototype-to-manifest workflow and asset guardrails.
- `TESTING.md` — route-specific focused checks, visual checks, and broader validation guidance.

Historical plans were intentionally not migrated here. Current code, `CURRENT.md`, and `docs/pharosville-page.md` win over old planning artifacts.

## Primary Inputs Inspected

Pharos:

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-and-api-limits.md`
- `docs/design-context.md`
- `docs/design-language.md`
- `docs/design-tokens.md`
- `src/hooks/api-hooks.ts`
- `src/hooks/use-stablecoins.ts`
- `src/hooks/use-chains.ts`
- `shared/types/chains.ts`
- `shared/types/market.ts`
- `shared/types/stability.ts`
- `shared/types/report-cards.ts`
- `shared/types/mint-burn.ts`
- `shared/types/core.ts`
- `shared/lib/dead-stablecoins.ts`
- `shared/data/dead-stablecoins.json`

ClaudeVille:

- `/home/ahirice/Documents/git/claude-ville/docs/visual-experience-crafting.md`
- `/home/ahirice/Documents/git/claude-ville/claudeville/src/presentation/character-mode/README.md`
- `/home/ahirice/Documents/git/claude-ville/scripts/sprites/generate.md`
- `/home/ahirice/Documents/git/claude-ville/docs/pixellab-reference.md`
- `/home/ahirice/Documents/git/claude-ville/claudeville/src/presentation/character-mode/IsometricRenderer.js`
- `/home/ahirice/Documents/git/claude-ville/claudeville/src/presentation/character-mode/Camera.js`
- `/home/ahirice/Documents/git/claude-ville/claudeville/src/presentation/character-mode/AssetManager.js`
- `/home/ahirice/Documents/git/claude-ville/claudeville/src/presentation/character-mode/SceneryEngine.js`
- `/home/ahirice/Documents/git/claude-ville/claudeville/src/presentation/character-mode/HarborTraffic.js`
- `/home/ahirice/Documents/git/claude-ville/claudeville/assets/sprites/manifest.yaml`
- `/home/ahirice/Documents/git/claude-ville/docs/superpowers/specs/2026-04-25-pixel-art-baseline/overview-fresh.png`

## Current Working Summary

PharosVille is now an implemented desktop-only route at `/pharosville/`. The current route uses a viewport gate before mounting world data, a pure world model under `src/app/pharosville/systems/`, a Canvas 2D renderer under `src/app/pharosville/renderer/`, local static PNG assets under `public/pharosville/assets/`, and DOM parity through the detail panel and accessibility ledger.

Current source of truth for future maintainers:

1. `docs/pharosville-page.md` for verified user-facing route behavior.
2. `docs/pharosville/CURRENT.md` for implementation orientation and maintenance guardrails.
3. `docs/pharosville/CHANGE_CHECKLIST.md`, `ASSET_PIPELINE.md`, and `TESTING.md` for repeatable work.

## Original Verdict

Feasible, but it should be treated as a product surface, not a decorative map. The current implementation target is a full visual replacement of `/pharosville/` using a new world model and renderer under `src/app/pharosville/`, inspired by ClaudeVille's Canvas 2D architecture and sprite workflow. Screens below `1280px` are a desktop-only fallback for v0.1, not a mobile/tablet canvas. Existing Pharos endpoints are sufficient without Worker changes. Pixellab is suitable for the asset pipeline after the renderer and data contract are stable.

Independent review originally returned "conditional go" and identified data-contract, accessibility, and performance gaps. Those fixes have been folded into the current route contract and maintenance docs.
