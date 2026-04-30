# PharosVille Systems

The `systems/` directory owns the pure data-to-world layer for `/pharosville/`. Prefer adding semantics here before touching the renderer.

## Primary Flow

1. `pharosville-desktop-data.tsx` gathers existing Pharos API payloads after the desktop viewport gate.
2. `pharosville-world.ts` builds a deterministic `PharosVilleWorld` from those payloads.
3. `world-layout.ts` defines the authored isometric map, terrain kinds, dock slots, risk anchors, cemetery, civic core, and helper lookups.
4. Specialized modules derive route-local entities:
   - `chain-docks.ts` builds top-chain harbor docks.
   - `risk-placement.ts` resolves ship risk placement from peg/DEWS/report-card evidence.
   - `ship-visuals.ts` resolves hull, class, pennant, overlay, and market-cap size tier.
   - `motion.ts` builds deterministic ship routes and frame samples.
   - `detail-model.ts` creates DOM detail models for every selectable entity.
   - `visual-cue-registry.ts` records visual cues, source fields, and DOM equivalents.

## Boundaries

- Keep these modules pure and deterministic. Avoid DOM, canvas, timers, browser globals, and network calls.
- Use shared runtime-neutral helpers such as `getCirculatingRaw()` and `@shared/*` imports instead of route-local copies of shared logic.
- Keep source-field provenance with any visual cue that represents analytics.
- Keep route-specific visual semantics here; shared scoring/methodology logic belongs in `shared/lib/` only when it is a real cross-route contract.
- Use `stable-random.ts` for deterministic scatter and seeded placement, not `Math.random()`.

## Common Extension Points

| Goal | Start here | Notes |
| --- | --- | --- |
| Change map geography | `world-layout.ts`, `world-layout.test.ts` | Preserve sea-first ratio, lighthouse, EVM bay, cemetery, civic core, and risk-water anchors unless intentionally changing them. |
| Change dock semantics | `chain-docks.ts`, `pharosville-world.ts` | Docks mean top-chain stablecoin supply, not transfers. |
| Change ship class or size | `ship-visuals.ts`, `classification-to-boat.ts` | Size is compressed market-cap tiering. |
| Change risk placement | `risk-placement.ts`, `pharosville-world.ts` | Active depeg/fresh DEWS precedence matters; stale/missing evidence must not become storm risk. |
| Change movement | `motion.ts`, `pharosville-world.tsx` | Motion samples must stay water-safe and aligned with hit testing. |
| Add a visual cue | `visual-cue-registry.ts`, `detail-model.ts` | Include source fields and DOM equivalent text. |

## Focused Tests

```bash
npm test -- src/app/pharosville
npm test -- src/app/pharosville/systems/world-layout.test.ts
npm test -- src/app/pharosville/systems/motion.test.ts
npm test -- src/app/pharosville/systems/risk-placement.test.ts
npm test -- src/app/pharosville/systems/visual-cue-registry.test.ts
```

Use `docs/pharosville/SCENARIO_CATALOG.md` to choose scenario-specific checks.
