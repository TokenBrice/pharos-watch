# PharosVille Visual Review Atlas

Last updated: 2026-04-30

This atlas defines what to look at when reviewing PharosVille pixels. It complements tests; it does not replace the verified route contract in `docs/pharosville-page.md`.

## Committed Screenshot Baselines

| Baseline | Source test | Path | Review focus |
| --- | --- | --- | --- |
| Desktop shell | `pharosville renders desktop canvas shell` | `tests/visual/pharosville.spec.ts-snapshots/pharosville-desktop-shell-linux.png` | Nonblank sea-first map, water/land balance, separated DEWS sea labels, lighthouse headland, EVM bay, cemetery separation, civic scenery, toolbar/detail surfaces, absence of retired building targets, and no asset load errors. |
| Dense lighthouse crop | `pharosville dense visual fixture preserves districts, flotillas, and render budget` | `tests/visual/pharosville.spec.ts-snapshots/pharosville-dense-lighthouse-linux.png` | Lighthouse style anchor, beacon massing, headland clearance, surrounding water/shore texture, and nearby sprite scale. |
| Dense EVM bay crop | `pharosville dense visual fixture preserves districts, flotillas, and render budget` | `tests/visual/pharosville.spec.ts-snapshots/pharosville-dense-evm-bay-linux.png` | Four EVM docks as a district, quay pads, harbor clutter, visible ships, and ledger basin separation. |
| Dense ship flotillas crop | `pharosville dense visual fixture preserves districts, flotillas, and render budget` | `tests/visual/pharosville.spec.ts-snapshots/pharosville-dense-ship-flotillas-linux.png` | 100+ ship stress, coherent citizen-boat sprites, long-tail flotilla clusters, count pennants, and risk-water readability. |
| Dense cemetery crop | `pharosville dense visual fixture preserves districts, flotillas, and render budget` | `tests/visual/pharosville.spec.ts-snapshots/pharosville-dense-cemetery-linux.png` | Maritime memorial terrace, dedicated marker sprite set, cause plaques, selected/major stone-mounted logos, and separation from docks/harbors. |
| Dense civic core crop | `pharosville dense visual fixture preserves districts, flotillas, and render budget` | `tests/visual/pharosville.spec.ts-snapshots/pharosville-dense-civic-core-linux.png` | Civic spine scenery, cemetery adjacency, lighthouse scale relationship, harbor support scenery, and no retired building selection targets. |
| Dense risk-water crop | `pharosville dense visual fixture preserves districts, flotillas, and render budget` | `tests/visual/pharosville.spec.ts-snapshots/pharosville-dense-risk-water-linux.png` | Alert/Warning/Danger organic water masks, plaques, buoys/reefs, storm chop, and label selectability. |
| Narrow fallback | `pharosville narrow fallback avoids world runtime requests` | `tests/visual/pharosville.spec.ts-snapshots/pharosville-narrow-fallback-linux.png` | DOM fallback copy and links, no canvas, and no world data/asset requests below the desktop gate. |

## Browser Review Entries

Run the whole visual atlas when canvas drawing, layout, interaction, motion, or assets change:

```bash
npx playwright test tests/visual/pharosville.spec.ts
```

Use focused entries while developing:

| Entry | Command | What to inspect |
| --- | --- | --- |
| Desktop canvas shell | `npx playwright test tests/visual/pharosville.spec.ts --grep "desktop canvas shell"` | World framing, absence of retired building targets, water/land pixel stats, hidden old auxiliary UI, asset load state. |
| Dense visual fixture | `npx playwright test tests/visual/pharosville.spec.ts --grep "dense visual fixture"` | Ten docks, 128 visible ships, flotilla clusters, crop atlas coverage, and p95 draw-duration budget under normal motion. |
| Named risk-water areas | `npx playwright test tests/visual/pharosville.spec.ts --grep "named risk water"` | Calm, Watch, Alert, Warning, Danger, and Ledger Mooring labels all remain visible, win label clicks, and select browser details with matching risk-water zones. |
| Stressed ship detail | `npx playwright test tests/visual/pharosville.spec.ts --grep "stressed ship"` | USDT active-depeg fixture selects a ship, shows Danger Strait/storm-shelf risk water, risk zone `danger`, and evidence fields. |
| Narrow fallback | `npx playwright test tests/visual/pharosville.spec.ts --grep "narrow fallback"` | No canvas/runtime requests under `1280px` width. |
| Short fallback | `npx playwright test tests/visual/pharosville.spec.ts --grep "short desktop"` | No clipped canvas under `760px` height. |
| Ultrawide canvas | `npx playwright test tests/visual/pharosville.spec.ts --grep "ultrawide"` | DPR/backing-store caps at `2560 x 1440` with device scale factor 3. |
| Interactions | `npx playwright test tests/visual/pharosville.spec.ts --grep "interactions"` | Click selection, detail anchors, blank-map clearing, pan/zoom, fullscreen, and camera bounds. |
| Reduced motion | `npx playwright test tests/visual/pharosville.spec.ts --grep "reduced motion"` | Static ship samples, no RAF loop, and live reduced-motion preference changes. |
| Normal motion | `npx playwright test tests/visual/pharosville.spec.ts --grep "normal motion"` | Bounded RAF startup, moving ship samples, moving target hitboxes, and route facts in detail/ledger. |

## Historical Review Images

Historical visual-review images and handoff notes from the old planning archive were context only, not current acceptance baselines. Use this file, current tests, and fresh screenshots to approve new pixels.

## Manual Pixel Checklist

Use this checklist when approving screenshot changes:

- The world reads as a maritime analytical map, not a generic game backdrop.
- The lighthouse, EVM bay, cemetery, civic spine, DEWS water areas, and Ledger Mooring are all visually distinguishable.
- The DEWS sea reads as a clear escalation route matching the current compound masks: Calm Anchorage fills the large west/lower-left basin, Watch Breakwater sits above the island in northwest/top water, Alert Channel occupies the top-center current, Warning Shoals wraps the lighthouse-side northeast reef shelf without label collision, Danger Strait attaches to the far east storm basin, and Ledger Mooring reads as quiet ledger water below the harbor away from Solana/top-chain harbor traffic.
- The default composition stays around 78-82% water while still showing enough coast, piers, islets, and districts to feel authored rather than empty.
- Terrain sprites add texture, but semantic overlay colors still make calm/watch/alert/warning/danger/ledger water distinguishable.
- Ships remain readable at default zoom; very large stablecoins are capped rather than overwhelming the map.
- Dock flags/logos identify chain harbors without becoming large label boards.
- Risk water escalation is visible but does not make stale/missing evidence or NAV ledger water look like active depeg.
- The selected target ring and detail panel refer to the same entity.
- Hit targets are plausible around the drawn sprite, especially after asset geometry or scale changes.
- Reduced-motion screenshots stay meaningful without animation.
- No asset fallback, missing image box, or debug color appears in normal screenshots.

## When To Update Baselines

Update snapshots only after confirming the visual behavior is intentionally changed. Pair snapshot changes with:

```bash
npm test -- src/app/pharosville
npm run check:pharosville-assets
npm run check:pharosville-colors
npx playwright test tests/visual/pharosville.spec.ts
```

If the screenshot change also changes route behavior or visual semantics, update `docs/pharosville-page.md` and `VISUAL_INVARIANTS.md`.
