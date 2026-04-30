# PharosVille Renderer

The renderer turns a pure `PharosVilleWorld` model into a Canvas 2D scene plus aligned hit targets. It should stay route-local and should not fetch data or mutate the world model.

## Files

- `world-canvas.ts` sequences sky, terrain, entity drawables, decorative overlays,
  and render metrics for the route debug frame.
- `layers/selection.ts` draws hover/selection rings and selected ship/dock
  relationship overlays.
- `geometry.ts` owns shared render geometry for sprite draw points, manifest
  hitboxes, dock harbor offsets, printed area label targets, and follow-selected
  anchors used by drawing, hit testing, and the route shell.
- `drawable-pass.ts` owns stable isometric depth ordering and pass helpers for
  overlap-prone entity groups.
- `hit-testing.ts` builds selectable rectangles for lighthouse, docks, ships, clusters, graves, and named areas.
- `asset-manager.ts` loads the local manifest-backed PNG assets and logo images.
- `hit-testing.test.ts` protects target ordering, manifest hitboxes, moving ship target rectangles, and building selectability.

## Data Flow

1. `pharosville-world.tsx` owns canvas state, camera state, asset loading, reduced-motion state, and selected/hovered detail IDs.
2. `systems/motion.ts` samples ship positions for the current frame.
3. `collectHitTargets()` receives the same camera and ship motion samples used for drawing.
4. `drawPharosVille()` draws from the immutable world model, loaded assets, camera, selected/hovered targets, and motion state, then returns frame-level render metrics.
5. Pointer and keyboard handlers resolve selected details through the hit targets and `world.detailIndex`.

## Contracts

- Drawing, hit testing, debug frame state, selected rings, and follow-selected behavior must use the same sampled ship positions.
- Drawing and hit testing must use `geometry.ts` for overlap-prone entity
  anchors instead of duplicating dock, sprite, or printed-label math.
- Overlap-prone entity groups should resolve a `WorldDrawable` with a pass,
  screen bounds, and depth from `geometry.ts`, then use `drawable-pass.ts`
  sorting.
- Layer modules should depend on renderer input types, shared geometry, and the
  route-local system modules they visualize, such as selected motion routes; keep
  new overlay-specific drawing out of `world-canvas.ts`.
- The renderer must remain a consumer of world data. Add new semantics in `systems/` first, then draw them.
- Reduced motion draws a deterministic static frame and must not require a running RAF loop.
- Asset IDs must resolve through `public/pharosville/assets/manifest.json`; runtime code must not use prototype paths or remote image URLs.
- Manifest geometry changes must keep anchors, hitboxes, scale, and selection rings aligned.
- Canvas backing size must go through `resolveCanvasBudget()`.

## Validation

```bash
npm test -- src/app/pharosville/renderer/hit-testing.test.ts
npm run check:pharosville-assets
npm run check:pharosville-colors
npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"
```

Add `npm run build` and `npm run seo:check` when the route shell or static export behavior changes.
