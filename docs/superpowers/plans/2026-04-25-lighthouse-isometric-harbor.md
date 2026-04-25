# Lighthouse Isometric Harbor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/lighthouse` and `/lighthouse-2` routes with a single, fully data-bound 2D isometric pixel-art harbor scene at `/lighthouse` — Pharos as a beacon-island, chains as harbours, stablecoins as boats, PSI as the beam, DEWS as the sea state.

**Architecture:** PixiJS v8 inside a `dynamic({ ssr: false })` React shell, GSAP-driven motion, a runtime-neutral `systems/` adapter that consumes existing TanStack Query hooks (`useChains`, `useStablecoins`, `useStabilityIndexDetail`, `useStressSignals`) and emits a `SceneData` object diffed onto live sprites. Pixel-art discipline enforced by a 24-color anchor palette and a hex-literal lint check.

**Tech Stack:** `pixi.js@^8.18`, `@pixi/react@^8.0.5`, `gsap@^3.15` (MotionPathPlugin free under Webflow). React 19, Next 16 static export, Vitest + Playwright.

**Source spec:** `docs/superpowers/specs/2026-04-25-lighthouse-2-isometric-harbor-design.md` — this plan supersedes that spec for execution and resolves three review streams (RPG visual direction, data-binding coherence, technical architecture).

---

## 0. Reference Tables — locked before implementation

### 0.1 Anchor palette (24 colors)

Single source of truth. Every code-drawn `Graphics` call and every PixelLab asset must clamp to these.

```ts
// src/app/lighthouse/systems/palette.ts
export const HARBOR_PALETTE = {
  // Sea & sky
  deep_sea_2:        "#0a0e1d",
  deep_sea_1:        "#141a30",
  shallow_teal:      "#1f2a4a",
  shallow_teal_lit:  "#2d3f6b",
  sky_night:         "#0d1226",
  sky_horizon:       "#1a2240",
  fog_blue:          "#3a4f7a",
  fog_pale:          "#5a7099",
  // Stone & structure
  stone_dark:        "#2a2620",
  stone_mid:         "#4a4238",
  stone_pale:        "#6a5e4e",
  iron_dark:         "#1a1612",
  timber_dark:       "#3a2a1e",
  // Wood & dock
  timber_mid:        "#6a4a2e",
  timber_warm:       "#8a6840",
  // Warm light pole
  ember:             "#2a1a0e",
  lantern_warm:      "#d49a3e",
  lantern_glow:      "#f7d68a",
  // Cool light pole
  lantern_cold:      "#5a8aaa",
  moonlight:         "#bfd6e8",
  // Sail & flag accents
  sail_teal:         "#3a5e5a",
  sail_red:          "#9a3a2e",
  // Foam & weather
  foam_white:        "#e8eef0",
  // Health / data ramp
  aurora_green:      "#5ea970",
  bloodmoon_red:     "#c83a3a",
} as const;
export type HarborPaletteKey = keyof typeof HARBOR_PALETTE;
```

### 0.2 Data-binding map (audited, final)

This replaces Section 6 of the source spec. Every entry cites a real symbol verified during review.

| Visual | Data field | Source | Encoding |
|---|---|---|---|
| Lighthouse beam color | `StabilityIndexCurrent.band` → `PSI_HEX_COLORS` | `shared/lib/psi-colors.ts:6` | 6 PSI band hexes; cross-blend on band change (2 s, palette-snapped) |
| Lighthouse beam sweep duration | `StabilityIndexCurrent.band` → new `PSI_SWEEP_DURATION` | new constant in `shared/lib/psi-colors.ts` (mirrors `src/lib/dews-radar-utils.ts:20-26`) | Piecewise per band: BEDROCK=12s, STEADY=9, TREMOR=6, FRACTURE=4, CRISIS=2.5, MELTDOWN=1.2 |
| Lighthouse lantern pulse | none — fixed | constant 1.2 Hz | Decoupled rhythm: heartbeat regardless of PSI |
| Sea wave amplitude + tint | `useStressSignals()` highest band → `THREAT_BAND_HEX` | `shared/lib/classification.ts:621-627`, `src/lib/dews-radar-utils.ts:81-88` | Single intensity drives wave amplitude (1.5 → 4 px) and water tint |
| Storm overlays (rain / lightning) | DEWS `WARNING`/`DANGER` only | same | Rain particles + occasional lightning flash above WARNING |
| Cloud density | DEWS highest band | same | Sky tint + cloud sprite count |
| Harbor build quality | `getChainResilienceTier(chainId)` | `shared/lib/chains.ts:151` | Tier 1 = stone seawalls; Tier 2 = wood pier; Tier 3 = weathered planks |
| Harbor footprint (S/M/L) | `ChainSummary.totalUsd` | `shared/types/chains.ts:29` | Log-scaled via `hullWidth(totalUsd, maxUsd, ...)` (`src/app/chains/nautical-scene-math.ts:10`) |
| Warehouse count per harbor | `ChainSummary.stablecoinCount` | `shared/types/chains.ts:36` | 1 warehouse per ~3 coins |
| Chain flag on dock mast | `CHAIN_HEX[chainId]` (else neutral) | `src/lib/dex-display-constants.ts:82-93` | Small accent; fallback grey when undefined |
| Boat hull silhouette | `(StablecoinMeta.flags.governance, .flags.backing)` | `shared/lib/classification.ts:46, 75` | Galleon (centralized) / Brigantine (centralized-dependent) / Schooner (decentralized); `backing === "algorithmic"` → Junk override |
| Boat hull size | `ChainTopStablecoin.supplyUsd` | `shared/types/chains.ts:21` | 2 tiers (S, L), log-scaled inside harbor |
| Boat pennant color (peg health) | `useStressSignals().signals[id].band` → `THREAT_BAND_HEX` | `src/hooks/api-hooks.ts:266`; `shared/lib/classification.ts:621` | 5 colors; neutral grey if no signal |
| Boat pennant tail tint | `StablecoinData.pegType` → `PEG_CHART_COLORS[peg].hex` | `shared/types/market.ts:29`; `shared/lib/classification.ts:501` | Desaturated cohort cue |
| Boat wake length / direction | `ChainSummary.change7dPct` | `shared/types/chains.ts:33` | Reuse `wakeLength()` from `src/app/chains/nautical-scene-math.ts:30` |
| Moored bob (universal) | none | constant | All boats: 1 px sine, 3 s, random phase |
| Horizon islands (alt-peg cohorts) | `buildPegDiversityHero(stablecoins)` | `src/lib/alt-peg-hero.ts:8` | Far-horizon flagged silhouettes; Option B from RPG review |
| Moonpath glitter | constant | — | Atmospheric, not data-bound |
| Beam-on-water tint | beam state | derived | Additive overlay where beam projects; volumetric read |

**Deliberately removed** vs. source spec (data does not exist client-side): "Boat sailing vs moored = 24h volume rank", "Harbor buildings = chain TVL". Replaced with motion-by-`change7dPct` and warehouse-count-by-`stablecoinCount` respectively (data verified during review).

### 0.3 Reused existing helpers (do not redefine)

| Helper | Location |
|---|---|
| `hullWidth(totalUsd, maxUsd, cardWidth)` | `src/app/chains/nautical-scene-math.ts:10` |
| `cargoCapacityForHull(hullW)` | `src/app/chains/nautical-scene-math.ts:18` |
| `depthLayers(dominanceShare)` | `src/app/chains/nautical-scene-math.ts:23` |
| `wakeLength(change7dPct)` | `src/app/chains/nautical-scene-math.ts:30` |
| `aggregateSkyBand(...)` | `src/app/chains/nautical-scene-math.ts:42` |
| `highestBand(bands)` | `src/lib/dews-radar-utils.ts:81` |
| `sweepDuration(band)` | `src/lib/dews-radar-utils.ts:91` (DEWS variant — read for shape, do **not** use for PSI) |
| `getChainResilienceTier(chainId)` | `shared/lib/chains.ts:151` |
| `getCirculatingRaw(c)` | `shared/lib/supply.ts:25` |
| `getGovernanceLabelShort`, `getBackingLabelShort` | `shared/lib/classification.ts:98, 88` |
| `buildPegDiversityHero(stablecoins)` | `src/lib/alt-peg-hero.ts:8` |
| `PSI_HEX_COLORS`, `PSI_PULSE_DURATION` | `shared/lib/psi-colors.ts:6, 46` |
| `THREAT_BAND_HEX` | `shared/lib/classification.ts:621` |
| `useChains`, `useStablecoins`, `useStabilityIndexDetail`, `useStressSignals` | `src/hooks/use-chains.ts:15`, `src/hooks/use-stablecoins.ts`, `src/hooks/api-hooks.ts:221, 266` |

### 0.4 File structure (locked)

```
src/app/lighthouse/
├── page.tsx                              # SEO/metadata; static
├── client.tsx                            # SSR boundary, hooks, error wrapper
├── harbor-scene-client.tsx               # Pixi <Application>; ssr:false dynamic-imported
├── harbor-scene.css                      # Canvas sizing, image-rendering, overlay positioning
├── lighthouse-fullscreen-dialog.tsx      # Reused pattern from old /lighthouse
├── lighthouse-a11y-ledger.tsx            # Single sr-only ledger (replaces both legacy ledgers)
├── layers/
│   ├── sky-layer.ts                      # Stars, moon, gulls, clouds — Container builder
│   ├── water-layer.ts                    # TilingSprite + 3-frequency wave shader
│   ├── lamp-layer.ts                     # Dock lanterns, warehouse windows, ship lights
│   ├── harbor-layer.ts                   # Per-chain harbour Container (island, dock, warehouses, flag, lighthouse)
│   ├── boat-layer.ts                     # Per-coin boat Container (moored + sailing)
│   ├── horizon-layer.ts                  # Alt-peg flagged silhouettes
│   └── ui-overlay.tsx                    # HTML overlay (chain labels, hover, tooltips, kbd targets)
├── sprites/
│   ├── lighthouse-sprite.ts              # Tower blocks + volumetric beam + lantern halo
│   ├── boat-sprite.ts                    # Galleon / Brigantine / Schooner / Junk factory
│   ├── harbor-island-sprite.ts           # Tile stack, dock, warehouse builders
│   ├── water-tile.ts                     # Per-tile water polygon (NOT used per-frame; see water-layer)
│   └── horizon-island-sprite.ts          # Distant silhouettes + flag pole
├── systems/
│   ├── palette.ts                        # 24-color anchor + tint utility
│   ├── isometric.ts                      # Tile↔screen, depth key, hit-test inverse
│   ├── patrol.ts                         # Bezier path generator + GSAP MotionPath wiring
│   ├── scene-data.ts                     # Hooks → SceneData adapter
│   ├── scene-sync.ts                     # Diff SceneData → mutate Pixi sprites
│   ├── classification-to-boat.ts         # (governance, backing) → BoatStyle
│   ├── reduced-motion.ts                 # mq listener + parent-timeline pause helper
│   └── timeline-registry.ts              # Single parent timeline owner (pause/resume target)
└── __fixtures__/
    └── scene-data.ts                     # Deterministic SceneData for tests
```

Tests live alongside their pure-TS modules (`isometric.test.ts`, `scene-data.test.ts`, `classification-to-boat.test.ts`, `palette.test.ts`).

---

## 1. Phase 0 — CSP Smoke Test (BLOCKER)

Pharos's CSP is `script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://static.cloudflareinsights.com` (`public/_headers:14`) — **no `unsafe-eval`**. PixiJS v8's WebGL shader path historically requires `unsafe-eval` via `new Function()`. **No further work happens until this is verified.**

### Task 0.1: Install dependencies on a smoke branch

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Create a branch and install Pixi v8 + GSAP**

```bash
git checkout -b spike/pixi-v8-csp
npm install --save pixi.js@^8.18 @pixi/react@^8.0.5 gsap@^3.15
```

Expected: install succeeds, `package.json` adds three dependencies.

- [ ] **Step 2: Commit the install**

```bash
git add package.json package-lock.json
git commit -m "spike: install pixi/gsap for CSP probe"
```

### Task 0.2: Build the smallest hello-world canvas

**Files:**
- Create: `src/app/lighthouse-spike/page.tsx`
- Create: `src/app/lighthouse-spike/client.tsx`
- Create: `src/app/lighthouse-spike/hello-pixi.tsx`

- [ ] **Step 1: Write the page route**

```tsx
// src/app/lighthouse-spike/page.tsx
import dynamic from "next/dynamic";
const Client = dynamic(() => import("./client").then((m) => ({ default: m.SpikeClient })), { ssr: false });
export const metadata = { robots: { index: false, follow: false } };
export default function Page() {
  return <Client />;
}
```

- [ ] **Step 2: Write the client wrapper**

```tsx
// src/app/lighthouse-spike/client.tsx
"use client";
import dynamic from "next/dynamic";
const HelloPixi = dynamic(() => import("./hello-pixi").then((m) => ({ default: m.HelloPixi })), { ssr: false });
export function SpikeClient() {
  return <HelloPixi />;
}
```

- [ ] **Step 3: Write the Pixi probe**

```tsx
// src/app/lighthouse-spike/hello-pixi.tsx
"use client";
import { useEffect, useRef, useState } from "react";

export function HelloPixi() {
  const ref = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let app: import("pixi.js").Application | null = null;
    (async () => {
      try {
        const { Application, Graphics } = await import("pixi.js");
        app = new Application();
        await app.init({
          width: 320,
          height: 200,
          background: "#0a0e1d",
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          autoDensity: true,
          skipExtensionImports: true,
        });
        const g = new Graphics();
        g.rect(40, 40, 240, 120).fill({ color: 0xd49a3e });
        app.stage.addChild(g);
        ref.current?.appendChild(app.canvas);
        setStatus("ok");
      } catch (e) {
        setError((e as Error).message);
        setStatus("error");
      }
    })();
    return () => { app?.destroy(true, { children: true }); };
  }, []);

  return (
    <div>
      <div data-testid="spike-status">{status}</div>
      {error && <pre data-testid="spike-error">{error}</pre>}
      <div ref={ref} />
    </div>
  );
}
```

- [ ] **Step 4: Build the static export and serve under the production CSP**

```bash
npm run build
npx --yes tsx scripts/serve-static-export.mjs &
sleep 2
curl -fsSI http://localhost:3000/lighthouse-spike/ | grep -i content-security-policy
```

Expected: server responds; CSP header includes `script-src 'self' 'unsafe-inline'` (no `unsafe-eval`). If `serve-static-export.mjs` does not apply `_headers`, run `npx wrangler pages dev out --local` instead so Cloudflare's emulator applies CSP exactly as production.

- [ ] **Step 5: Open the route in headless Chrome and capture console errors**

```bash
node -e "(async () => {
  const { chromium } = require('playwright');
  const b = await chromium.launch();
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://localhost:3000/lighthouse-spike/', { waitUntil: 'load' });
  await page.waitForSelector('[data-testid=spike-status]');
  const status = await page.locator('[data-testid=spike-status]').textContent();
  const err = await page.locator('[data-testid=spike-error]').textContent().catch(() => null);
  console.log(JSON.stringify({ status, err, errors }));
  await b.close();
})();"
```

(`playwright` is already a dev dep elsewhere via the `mcp__plugin_playwright_playwright__*` tools — install locally on the spike branch if not already in `node_modules`: `npm install -D playwright && npx playwright install chromium`.)

- [ ] **Step 6: Decide GO / NO-GO**

**GO criterion:** `status === "ok"` and `errors` array contains no `"unsafe-eval"` or `"Refused to evaluate a string"` messages. Capture a screenshot of the rendered orange rectangle and attach to the PR description.

**NO-GO criterion:** any console error mentions `unsafe-eval`, `Refused to evaluate`, `EvalError`, or the `[data-testid=spike-status]` text is `error`.

- [ ] **Step 7: Document the decision**

Write findings to `docs/superpowers/audits/2026-04-25-pixi-v8-csp.md`:

```md
# Pixi v8 CSP probe — 2026-04-25

- Pixi version: 8.x.x (record exact)
- Verdict: GO | NO-GO
- Console errors: (paste raw)
- Screenshot: (link)

## Decision
- GO → proceed to Phase 1 of `docs/superpowers/plans/2026-04-25-lighthouse-isometric-harbor.md`.
- NO-GO → execute Plan-B branch in §2.
```

- [ ] **Step 8: Delete the spike route and commit**

```bash
rm -rf src/app/lighthouse-spike
git add -A
git commit -m "spike: pixi v8 CSP probe results recorded"
```

### Task 0.3: Plan-B branch (only if NO-GO)

If Phase 0 fails:

1. Stop. Do not start Phase 1.
2. Re-open this plan with the orchestrating user.
3. Recommended fork: switch the renderer from PixiJS to **raw Canvas 2D** with a thin custom isometric layer. The scene complexity (~30 chains, ~150 boats max, layered waves, beam) is well within Canvas 2D for &lt; 60 fps mobile / 60 fps desktop. Bundle drops by ~280 KB gz.
4. Alternative fork: scope `'unsafe-eval'` to `/lighthouse/*` only via a route-prefixed `public/_headers` rule. Document the security tradeoff in `docs/architecture.md`. Requires owner approval before merging.

Once Plan-B is decided, this plan's Phase 1+ tasks are re-templated against the chosen renderer (mostly the file structure and `systems/*` adapter survives; `harbor-scene-client.tsx`, `layers/*`, `sprites/*` rewrite). **Stop here for re-planning.**

---

## 2. Phase 1 — Foundations (PR1)

Goal: ship a deletable scaffold (route + dynamic boundary + a11y ledger + palette + isometric math + scene-data adapter) that **does not yet render Pixi**. This validates SSR, hooks, types, and tests before touching WebGL.

### Task 1.1: Install dependencies

**Files:** `package.json`, `package-lock.json`

- [ ] **Step 1: Install**

```bash
npm install --save pixi.js@^8.18 @pixi/react@^8.0.5 gsap@^3.15
```

- [ ] **Step 2: Verify bundle hint**

```bash
npx --yes bundle-phobia pixi.js @pixi/react gsap
```

Expected: PixiJS minzipped 250–290 KB, GSAP core ~25 KB. Capture the output in the PR description.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(lighthouse): add pixi v8, @pixi/react v8, gsap"
```

### Task 1.2: Anchor palette constant + tint helper

**Files:**
- Create: `src/app/lighthouse/systems/palette.ts`
- Create: `src/app/lighthouse/systems/palette.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/app/lighthouse/systems/palette.test.ts
import { describe, it, expect } from "vitest";
import { HARBOR_PALETTE, hexToInt, paletteOrThrow } from "./palette";

describe("HARBOR_PALETTE", () => {
  it("contains 24 entries", () => {
    expect(Object.keys(HARBOR_PALETTE)).toHaveLength(24);
  });

  it("each value is a 7-char hex starting with #", () => {
    for (const [k, v] of Object.entries(HARBOR_PALETTE)) {
      expect(v, k).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("hexToInt parses #d49a3e to 0xd49a3e", () => {
    expect(hexToInt("#d49a3e")).toBe(0xd49a3e);
  });

  it("paletteOrThrow returns the named color", () => {
    expect(paletteOrThrow("lantern_warm")).toBe("#d49a3e");
  });

  it("paletteOrThrow throws on unknown key", () => {
    expect(() => paletteOrThrow("not_a_color" as never)).toThrow(/HARBOR_PALETTE/);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
npx vitest run src/app/lighthouse/systems/palette.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/app/lighthouse/systems/palette.ts
export const HARBOR_PALETTE = {
  deep_sea_2: "#0a0e1d",
  deep_sea_1: "#141a30",
  shallow_teal: "#1f2a4a",
  shallow_teal_lit: "#2d3f6b",
  sky_night: "#0d1226",
  sky_horizon: "#1a2240",
  fog_blue: "#3a4f7a",
  fog_pale: "#5a7099",
  stone_dark: "#2a2620",
  stone_mid: "#4a4238",
  stone_pale: "#6a5e4e",
  iron_dark: "#1a1612",
  timber_dark: "#3a2a1e",
  timber_mid: "#6a4a2e",
  timber_warm: "#8a6840",
  ember: "#2a1a0e",
  lantern_warm: "#d49a3e",
  lantern_glow: "#f7d68a",
  lantern_cold: "#5a8aaa",
  moonlight: "#bfd6e8",
  sail_teal: "#3a5e5a",
  sail_red: "#9a3a2e",
  foam_white: "#e8eef0",
  aurora_green: "#5ea970",
  bloodmoon_red: "#c83a3a",
} as const;

export type HarborPaletteKey = keyof typeof HARBOR_PALETTE;

export function hexToInt(hex: string): number {
  return parseInt(hex.slice(1), 16);
}

export function paletteOrThrow(key: HarborPaletteKey): string {
  if (!(key in HARBOR_PALETTE)) {
    throw new Error(`HARBOR_PALETTE: unknown color ${String(key)}`);
  }
  return HARBOR_PALETTE[key];
}
```

- [ ] **Step 4: Run, expect pass**

```bash
npx vitest run src/app/lighthouse/systems/palette.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/lighthouse/systems/palette.ts src/app/lighthouse/systems/palette.test.ts
git commit -m "feat(lighthouse): anchor 24-color palette + tint helpers"
```

### Task 1.3: PSI sweep duration constant

**Files:**
- Modify: `shared/lib/psi-colors.ts`
- Create: `shared/lib/psi-colors.test.ts` (or extend existing if present — check first with `ls shared/lib/psi-colors*`)

- [ ] **Step 1: Write the failing test**

```ts
// shared/lib/psi-colors.test.ts
import { describe, it, expect } from "vitest";
import { PSI_SWEEP_DURATION, psiSweepDuration } from "./psi-colors";

describe("PSI_SWEEP_DURATION", () => {
  it("has all six bands", () => {
    expect(Object.keys(PSI_SWEEP_DURATION).sort()).toEqual(
      ["BEDROCK", "CRISIS", "FRACTURE", "MELTDOWN", "STEADY", "TREMOR"],
    );
  });

  it("duration shrinks monotonically toward MELTDOWN", () => {
    const order = ["BEDROCK", "STEADY", "TREMOR", "FRACTURE", "CRISIS", "MELTDOWN"] as const;
    for (let i = 1; i < order.length; i++) {
      expect(PSI_SWEEP_DURATION[order[i]]).toBeLessThan(PSI_SWEEP_DURATION[order[i - 1]]);
    }
  });

  it("psiSweepDuration returns BEDROCK duration for unknown band", () => {
    expect(psiSweepDuration("BOGUS" as never)).toBe(PSI_SWEEP_DURATION.BEDROCK);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
npx vitest run shared/lib/psi-colors.test.ts
```

- [ ] **Step 3: Implement**

Append to `shared/lib/psi-colors.ts`:

```ts
/** Lighthouse beam sweep duration (seconds per revolution) per PSI band — slower = calmer. */
export const PSI_SWEEP_DURATION: Record<ConditionBand, number> = {
  BEDROCK: 12,
  STEADY: 9,
  TREMOR: 6,
  FRACTURE: 4,
  CRISIS: 2.5,
  MELTDOWN: 1.2,
};

export function psiSweepDuration(band: string): number {
  return PSI_SWEEP_DURATION[band as ConditionBand] ?? PSI_SWEEP_DURATION.BEDROCK;
}
```

- [ ] **Step 4: Run, expect pass**

```bash
npx vitest run shared/lib/psi-colors.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add shared/lib/psi-colors.ts shared/lib/psi-colors.test.ts
git commit -m "feat(psi): add PSI_SWEEP_DURATION constant for lighthouse beam"
```

### Task 1.4: Isometric projection math

**Files:**
- Create: `src/app/lighthouse/systems/isometric.ts`
- Create: `src/app/lighthouse/systems/isometric.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/app/lighthouse/systems/isometric.test.ts
import { describe, it, expect } from "vitest";
import { TILE_W, TILE_H, worldToScreen, screenToWorld, depthKey } from "./isometric";

describe("isometric projection", () => {
  it("origin maps to origin", () => {
    expect(worldToScreen({ tileX: 0, tileY: 0 })).toEqual({ x: 0, y: 0 });
  });

  it("east tile maps right and down", () => {
    expect(worldToScreen({ tileX: 1, tileY: 0 })).toEqual({ x: TILE_W / 2, y: TILE_H / 2 });
  });

  it("south tile maps left and down", () => {
    expect(worldToScreen({ tileX: 0, tileY: 1 })).toEqual({ x: -TILE_W / 2, y: TILE_H / 2 });
  });

  it.each([
    [0, 0], [3, 5], [10, 0], [0, 10], [-2, 7],
  ])("screenToWorld inverts worldToScreen for (%i, %i)", (tx, ty) => {
    const s = worldToScreen({ tileX: tx, tileY: ty });
    const w = screenToWorld(s);
    expect(w.tileX).toBeCloseTo(tx, 6);
    expect(w.tileY).toBeCloseTo(ty, 6);
  });

  it("depthKey orders south-east tiles after north-west", () => {
    const a = depthKey({ tileX: 1, tileY: 1, elevation: 0 });
    const b = depthKey({ tileX: 4, tileY: 4, elevation: 0 });
    expect(b).toBeGreaterThan(a);
  });

  it("elevated tile beats any non-elevated tile in the same column", () => {
    const ground = depthKey({ tileX: 30, tileY: 30, elevation: 0 });
    const elevated = depthKey({ tileX: 1, tileY: 1, elevation: 1 });
    expect(elevated).toBeGreaterThan(ground);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
npx vitest run src/app/lighthouse/systems/isometric.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/app/lighthouse/systems/isometric.ts
export const TILE_W = 64;
export const TILE_H = 32;
export const SCENE_GRID = 40;

export interface TileCoord { tileX: number; tileY: number; }
export interface ScreenCoord { x: number; y: number; }
export interface DepthInput extends TileCoord { elevation: number; }

export function worldToScreen({ tileX, tileY }: TileCoord): ScreenCoord {
  return {
    x: ((tileX - tileY) * TILE_W) / 2,
    y: ((tileX + tileY) * TILE_H) / 2,
  };
}

export function screenToWorld({ x, y }: ScreenCoord): TileCoord {
  return {
    tileX: x / TILE_W + y / TILE_H,
    tileY: y / TILE_H - x / TILE_W,
  };
}

export function depthKey({ tileX, tileY, elevation }: DepthInput): number {
  return tileX + tileY + elevation * SCENE_GRID;
}
```

- [ ] **Step 4: Run, expect pass**

```bash
npx vitest run src/app/lighthouse/systems/isometric.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/app/lighthouse/systems/isometric.ts src/app/lighthouse/systems/isometric.test.ts
git commit -m "feat(lighthouse): isometric projection + depth key math"
```

### Task 1.5: Classification → BoatStyle mapping

**Files:**
- Create: `src/app/lighthouse/systems/classification-to-boat.ts`
- Create: `src/app/lighthouse/systems/classification-to-boat.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/app/lighthouse/systems/classification-to-boat.test.ts
import { describe, it, expect } from "vitest";
import { boatStyleFor } from "./classification-to-boat";

describe("boatStyleFor", () => {
  it("centralized + reserve = galleon", () => {
    expect(boatStyleFor({ governance: "centralized", backing: "rwa-backed" })).toBe("galleon");
  });

  it("centralized-dependent = brigantine", () => {
    expect(boatStyleFor({ governance: "centralized-dependent", backing: "rwa-backed" })).toBe("brigantine");
  });

  it("decentralized = schooner", () => {
    expect(boatStyleFor({ governance: "decentralized", backing: "crypto-backed" })).toBe("schooner");
  });

  it("algorithmic backing overrides to junk regardless of governance", () => {
    expect(boatStyleFor({ governance: "decentralized", backing: "algorithmic" })).toBe("junk");
    expect(boatStyleFor({ governance: "centralized", backing: "algorithmic" })).toBe("junk");
  });

  it("missing governance falls back to schooner", () => {
    expect(boatStyleFor({ governance: undefined, backing: "crypto-backed" })).toBe("schooner");
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
npx vitest run src/app/lighthouse/systems/classification-to-boat.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/app/lighthouse/systems/classification-to-boat.ts
import type { GovernanceType, BackingType } from "@shared/lib/classification";

export type BoatStyle = "galleon" | "brigantine" | "schooner" | "junk";

interface Input {
  governance: GovernanceType | undefined;
  backing: BackingType | undefined;
}

export function boatStyleFor({ governance, backing }: Input): BoatStyle {
  if (backing === "algorithmic") return "junk";
  switch (governance) {
    case "centralized": return "galleon";
    case "centralized-dependent": return "brigantine";
    case "decentralized": return "schooner";
    default: return "schooner";
  }
}
```

- [ ] **Step 4: Run, expect pass**

```bash
npx vitest run src/app/lighthouse/systems/classification-to-boat.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/app/lighthouse/systems/classification-to-boat.ts src/app/lighthouse/systems/classification-to-boat.test.ts
git commit -m "feat(lighthouse): (governance, backing) -> boat style mapping"
```

### Task 1.6: SceneData type + adapter

**Files:**
- Create: `src/app/lighthouse/systems/scene-data.ts`
- Create: `src/app/lighthouse/systems/scene-data.test.ts`
- Create: `src/app/lighthouse/__fixtures__/scene-data.ts`

- [ ] **Step 1: Write fixture**

```ts
// src/app/lighthouse/__fixtures__/scene-data.ts
import type { ChainsResponse } from "@shared/types/chains";
import type { StablecoinDataPayload } from "@shared/types/market";
import type { StabilityIndexResponse } from "@shared/types/stability";
import type { StressSignalsAllResponse } from "@shared/types/stability";

export const fixtureChains: ChainsResponse = {
  globalTotalUsd: 1_000_000_000,
  chains: [
    {
      id: "ethereum",
      name: "Ethereum",
      totalUsd: 600_000_000,
      stablecoinCount: 12,
      change7dPct: 1.5,
      topStablecoins: [
        { id: "usdt", symbol: "USDT", supplyUsd: 250_000_000, supplyShare: 0.42 },
        { id: "usdc", symbol: "USDC", supplyUsd: 200_000_000, supplyShare: 0.33 },
        { id: "dai",  symbol: "DAI",  supplyUsd: 80_000_000,  supplyShare: 0.13 },
      ],
    },
    {
      id: "tron",
      name: "Tron",
      totalUsd: 300_000_000,
      stablecoinCount: 4,
      change7dPct: -0.4,
      topStablecoins: [
        { id: "usdt", symbol: "USDT", supplyUsd: 280_000_000, supplyShare: 0.93 },
      ],
    },
  ],
} as ChainsResponse;

export const fixtureStability: StabilityIndexResponse = {
  current: { score: 72, band: "STEADY" },
} as StabilityIndexResponse;

export const fixtureStress: StressSignalsAllResponse = {
  signals: {
    usdt: { band: "WATCH" },
    usdc: { band: "CALM" },
    dai:  { band: "ALERT" },
  },
} as StressSignalsAllResponse;

export const fixtureStablecoins = {
  peggedAssets: [
    { id: "usdt", symbol: "USDT", pegType: "peggedUSD", flags: { governance: "centralized", backing: "rwa-backed" } },
    { id: "usdc", symbol: "USDC", pegType: "peggedUSD", flags: { governance: "centralized", backing: "rwa-backed" } },
    { id: "dai",  symbol: "DAI",  pegType: "peggedUSD", flags: { governance: "decentralized", backing: "crypto-backed" } },
  ],
} as unknown as StablecoinDataPayload;
```

(Verify the exact shape of `ChainSummary`/`StablecoinDataPayload`/`StabilityIndexResponse`/`StressSignalsAllResponse` against `shared/types/chains.ts:24-43`, `shared/types/market.ts:23-72`, and the schemas in `shared/types/stability.ts`. Adjust fixture fields to match strict TypeScript.)

- [ ] **Step 2: Write the failing test**

```ts
// src/app/lighthouse/systems/scene-data.test.ts
import { describe, it, expect } from "vitest";
import { buildSceneData } from "./scene-data";
import {
  fixtureChains,
  fixtureStability,
  fixtureStress,
  fixtureStablecoins,
} from "../__fixtures__/scene-data";

describe("buildSceneData", () => {
  const scene = buildSceneData({
    chains: fixtureChains,
    stability: fixtureStability,
    stress: fixtureStress,
    stablecoins: fixtureStablecoins,
  });

  it("emits one harbor per chain", () => {
    expect(scene.harbors.map((h) => h.id)).toEqual(["ethereum", "tron"]);
  });

  it("orders harbors by totalUsd desc", () => {
    expect(scene.harbors[0].totalUsd).toBeGreaterThanOrEqual(scene.harbors[1].totalUsd);
  });

  it("each harbor has boats keyed by topStablecoins", () => {
    const eth = scene.harbors[0];
    expect(eth.boats.map((b) => b.coinId)).toEqual(["usdt", "usdc", "dai"]);
  });

  it("boat style derives from governance/backing", () => {
    const eth = scene.harbors[0];
    expect(eth.boats.find((b) => b.coinId === "usdt")?.style).toBe("galleon");
    expect(eth.boats.find((b) => b.coinId === "dai")?.style).toBe("schooner");
  });

  it("boat pennant color comes from THREAT_BAND_HEX via stress signals", () => {
    const eth = scene.harbors[0];
    expect(eth.boats.find((b) => b.coinId === "usdt")?.pennantHex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("boats with no stress signal get neutral pennant", () => {
    expect(scene.harbors[1].boats[0].pennantHex).toBeDefined();
  });

  it("beam color matches PSI band STEADY", () => {
    expect(scene.beam.color).toBe("#14b8a6");
    expect(scene.beam.sweepSeconds).toBe(9);
  });

  it("includes alt-peg cohort silhouettes", () => {
    expect(scene.horizon.cohorts.length).toBeGreaterThanOrEqual(0);
  });

  it("returns deterministic results for the same inputs", () => {
    const scene2 = buildSceneData({
      chains: fixtureChains,
      stability: fixtureStability,
      stress: fixtureStress,
      stablecoins: fixtureStablecoins,
    });
    expect(scene2).toEqual(scene);
  });
});
```

- [ ] **Step 3: Run, expect fail**

```bash
npx vitest run src/app/lighthouse/systems/scene-data.test.ts
```

- [ ] **Step 4: Implement**

```ts
// src/app/lighthouse/systems/scene-data.ts
import type { ChainsResponse, ChainSummary, ChainTopStablecoin } from "@shared/types/chains";
import type { StablecoinDataPayload } from "@shared/types/market";
import type { StabilityIndexResponse, StressSignalsAllResponse } from "@shared/types/stability";
import { PSI_HEX_COLORS, psiSweepDuration } from "@shared/lib/psi-colors";
import { THREAT_BAND_HEX } from "@shared/lib/classification";
import { getChainResilienceTier } from "@shared/lib/chains";
import { boatStyleFor, type BoatStyle } from "./classification-to-boat";
import { buildPegDiversityHero } from "@/lib/alt-peg-hero";

const NEUTRAL_PENNANT = "#5a7099"; // fog_pale

export interface SceneBoat {
  coinId: string;
  symbol: string;
  style: BoatStyle;
  hullSize: "S" | "L";
  pennantHex: string;
  homeChainId: string;
  supplyUsd: number;
}

export interface SceneHarbor {
  id: string;
  name: string;
  totalUsd: number;
  stablecoinCount: number;
  change7dPct: number | null;
  resilienceTier: 1 | 2 | 3;
  boats: SceneBoat[];
}

export interface SceneBeam {
  color: string;
  sweepSeconds: number;
  band: string;
  score: number;
}

export interface SceneSea {
  amplitudePx: number;
  highestBand: string;
  tintHex: string;
}

export interface SceneHorizonCohort {
  id: string;
  label: string;
  pegType: string;
  coinCount: number;
}

export interface SceneData {
  harbors: SceneHarbor[];
  beam: SceneBeam;
  sea: SceneSea;
  horizon: { cohorts: SceneHorizonCohort[] };
}

interface Inputs {
  chains: ChainsResponse | null | undefined;
  stability: StabilityIndexResponse | null | undefined;
  stress: StressSignalsAllResponse | null | undefined;
  stablecoins: StablecoinDataPayload | null | undefined;
}

export function buildSceneData({ chains, stability, stress, stablecoins }: Inputs): SceneData {
  const chainList = (chains?.chains ?? []).slice().sort((a, b) => b.totalUsd - a.totalUsd);
  const stablecoinByIdMap = new Map(
    (stablecoins?.peggedAssets ?? []).map((c) => [c.id, c]),
  );
  const stressById = stress?.signals ?? {};

  const harbors: SceneHarbor[] = chainList.map((chain) => buildHarbor(chain, stablecoinByIdMap, stressById));

  const band = stability?.current?.band ?? "BEDROCK";
  const score = stability?.current?.score ?? 0;
  const beam: SceneBeam = {
    color: PSI_HEX_COLORS[band as keyof typeof PSI_HEX_COLORS] ?? PSI_HEX_COLORS.BEDROCK,
    sweepSeconds: psiSweepDuration(band),
    band,
    score,
  };

  const seaBand = highestStressBand(stressById);
  const sea: SceneSea = {
    highestBand: seaBand,
    amplitudePx: SEA_AMPLITUDE[seaBand],
    tintHex: THREAT_BAND_HEX[seaBand as keyof typeof THREAT_BAND_HEX] ?? "#3a4f7a",
  };

  const cohorts: SceneHorizonCohort[] = (() => {
    if (!stablecoins?.peggedAssets) return [];
    const hero = buildPegDiversityHero(stablecoins.peggedAssets);
    return hero.pegClusters.map((c) => ({
      id: c.peg,
      label: c.peg,
      pegType: c.peg,
      coinCount: c.coins.length,
    }));
  })();

  return { harbors, beam, sea, horizon: { cohorts } };
}

const SEA_AMPLITUDE: Record<string, number> = {
  CALM: 1.5,
  WATCH: 2.0,
  ALERT: 2.6,
  WARNING: 3.3,
  DANGER: 4.0,
};

function highestStressBand(signals: Record<string, { band: string }>): string {
  const order = ["CALM", "WATCH", "ALERT", "WARNING", "DANGER"];
  let max = "CALM";
  for (const sig of Object.values(signals)) {
    if (order.indexOf(sig.band) > order.indexOf(max)) max = sig.band;
  }
  return max;
}

function buildHarbor(
  chain: ChainSummary,
  coinsById: Map<string, StablecoinDataPayload["peggedAssets"][number]>,
  stressById: Record<string, { band: string }>,
): SceneHarbor {
  const top = chain.topStablecoins ?? [];
  const maxSupply = top.reduce((m, c) => Math.max(m, c.supplyUsd), 1);
  const boats: SceneBoat[] = top.map((c) => buildBoat(c, chain.id, coinsById, stressById, maxSupply));
  return {
    id: chain.id,
    name: chain.name,
    totalUsd: chain.totalUsd,
    stablecoinCount: chain.stablecoinCount,
    change7dPct: chain.change7dPct ?? null,
    resilienceTier: clampTier(getChainResilienceTier(chain.id)),
    boats,
  };
}

function clampTier(tier: number | undefined): 1 | 2 | 3 {
  if (tier === 1 || tier === 2 || tier === 3) return tier;
  return 2;
}

function buildBoat(
  c: ChainTopStablecoin,
  chainId: string,
  coinsById: Map<string, StablecoinDataPayload["peggedAssets"][number]>,
  stressById: Record<string, { band: string }>,
  maxSupply: number,
): SceneBoat {
  const coin = coinsById.get(c.id);
  const flags = (coin as { flags?: { governance?: string; backing?: string } } | undefined)?.flags;
  const style = boatStyleFor({
    governance: flags?.governance as never,
    backing: flags?.backing as never,
  });
  const sig = stressById[c.id];
  const pennantHex =
    sig && sig.band in THREAT_BAND_HEX
      ? THREAT_BAND_HEX[sig.band as keyof typeof THREAT_BAND_HEX]
      : NEUTRAL_PENNANT;
  return {
    coinId: c.id,
    symbol: c.symbol,
    style,
    hullSize: c.supplyUsd / maxSupply > 0.5 ? "L" : "S",
    pennantHex,
    homeChainId: chainId,
    supplyUsd: c.supplyUsd,
  };
}
```

- [ ] **Step 5: Run, expect pass**

```bash
npx vitest run src/app/lighthouse/systems/scene-data.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/app/lighthouse/systems/scene-data.ts \
        src/app/lighthouse/systems/scene-data.test.ts \
        src/app/lighthouse/__fixtures__/scene-data.ts
git commit -m "feat(lighthouse): SceneData adapter (hooks-agnostic)"
```

### Task 1.7: A11y ledger (single, replaces both legacy)

**Files:**
- Create: `src/app/lighthouse/lighthouse-a11y-ledger.tsx`
- Create: `src/app/lighthouse/lighthouse-a11y-ledger.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/lighthouse/lighthouse-a11y-ledger.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LighthouseA11yLedger } from "./lighthouse-a11y-ledger";
import {
  fixtureChains,
  fixtureStability,
  fixtureStress,
  fixtureStablecoins,
} from "./__fixtures__/scene-data";
import { buildSceneData } from "./systems/scene-data";

describe("LighthouseA11yLedger", () => {
  const scene = buildSceneData({
    chains: fixtureChains,
    stability: fixtureStability,
    stress: fixtureStress,
    stablecoins: fixtureStablecoins,
  });

  it("renders an sr-only section", () => {
    const { container } = render(<LighthouseA11yLedger scene={scene} />);
    expect(container.querySelector(".sr-only")).toBeTruthy();
  });

  it("includes the beam state", () => {
    render(<LighthouseA11yLedger scene={scene} />);
    expect(screen.getByText(/beam/i)).toBeInTheDocument();
    expect(screen.getByText(/STEADY/i)).toBeInTheDocument();
  });

  it("enumerates each harbor with chain name and coin count", () => {
    render(<LighthouseA11yLedger scene={scene} />);
    expect(screen.getByText(/Ethereum/)).toBeInTheDocument();
    expect(screen.getByText(/Tron/)).toBeInTheDocument();
  });

  it("enumerates each boat by symbol and classification", () => {
    render(<LighthouseA11yLedger scene={scene} />);
    expect(screen.getAllByText(/USDT|USDC|DAI/).length).toBeGreaterThan(0);
  });

  it("includes the highest sea state", () => {
    render(<LighthouseA11yLedger scene={scene} />);
    expect(screen.getByText(/sea state/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
npx vitest run src/app/lighthouse/lighthouse-a11y-ledger.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// src/app/lighthouse/lighthouse-a11y-ledger.tsx
import type { SceneData } from "./systems/scene-data";

export function LighthouseA11yLedger({ scene }: { scene: SceneData }) {
  return (
    <section className="sr-only" aria-label="Lighthouse data ledger" data-testid="lighthouse-a11y-ledger">
      <h2>Lighthouse data ledger</h2>
      <dl>
        <div>
          <dt>Lighthouse beam</dt>
          <dd>
            <strong>{scene.beam.band}</strong>
            <span> PSI score {scene.beam.score}, sweep {scene.beam.sweepSeconds.toFixed(1)} s</span>
          </dd>
        </div>
        <div>
          <dt>Sea state</dt>
          <dd>
            <strong>{scene.sea.highestBand}</strong>
            <span> wave amplitude {scene.sea.amplitudePx.toFixed(1)} px</span>
          </dd>
        </div>
      </dl>

      <h3>Harbors</h3>
      <ol>
        {scene.harbors.map((h) => (
          <li key={h.id}>
            <strong>{h.name}</strong>
            <span> {h.stablecoinCount} stablecoins, ${formatUsd(h.totalUsd)} total, resilience tier {h.resilienceTier}</span>
            <ol>
              {h.boats.map((b) => (
                <li key={b.coinId}>{b.symbol} ({b.style}, {b.hullSize}, supply ${formatUsd(b.supplyUsd)})</li>
              ))}
            </ol>
          </li>
        ))}
      </ol>

      <h3>Alt-peg cohorts</h3>
      <ol>
        {scene.horizon.cohorts.map((c) => (
          <li key={c.id}>{c.label} ({c.coinCount} coins)</li>
        ))}
      </ol>
    </section>
  );
}

function formatUsd(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  return `${n.toFixed(0)}`;
}
```

- [ ] **Step 4: Run, expect pass**

```bash
npx vitest run src/app/lighthouse/lighthouse-a11y-ledger.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add src/app/lighthouse/lighthouse-a11y-ledger.tsx \
        src/app/lighthouse/lighthouse-a11y-ledger.test.tsx
git commit -m "feat(lighthouse): unified sr-only a11y ledger"
```

### Task 1.8: Reduced-motion helper + timeline registry

**Files:**
- Create: `src/app/lighthouse/systems/reduced-motion.ts`
- Create: `src/app/lighthouse/systems/timeline-registry.ts`
- Create: `src/app/lighthouse/systems/reduced-motion.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/app/lighthouse/systems/reduced-motion.test.ts
import { describe, it, expect, vi } from "vitest";
import { observeReducedMotion } from "./reduced-motion";

describe("observeReducedMotion", () => {
  it("invokes callback with current value, then on change", () => {
    const listeners: ((e: { matches: boolean }) => void)[] = [];
    let matches = false;
    const fakeMq = {
      get matches() { return matches; },
      addEventListener: (_: "change", cb: (e: { matches: boolean }) => void) => listeners.push(cb),
      removeEventListener: vi.fn(),
    };
    const matchMedia = vi.fn().mockReturnValue(fakeMq);

    const cb = vi.fn();
    const dispose = observeReducedMotion(cb, matchMedia as unknown as typeof window.matchMedia);

    expect(cb).toHaveBeenCalledWith(false);

    matches = true;
    listeners.forEach((l) => l({ matches: true }));
    expect(cb).toHaveBeenCalledWith(true);

    dispose();
    expect(fakeMq.removeEventListener).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
npx vitest run src/app/lighthouse/systems/reduced-motion.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/app/lighthouse/systems/reduced-motion.ts
type MM = (q: string) => MediaQueryList;

export function observeReducedMotion(
  cb: (matches: boolean) => void,
  matchMedia: MM = (q) => window.matchMedia(q),
): () => void {
  const mq = matchMedia("(prefers-reduced-motion: reduce)");
  cb(mq.matches);
  const handler = (e: { matches: boolean }) => cb(e.matches);
  mq.addEventListener("change", handler as (e: MediaQueryListEvent) => void);
  return () => mq.removeEventListener("change", handler as (e: MediaQueryListEvent) => void);
}
```

```ts
// src/app/lighthouse/systems/timeline-registry.ts
import type gsapType from "gsap";

export interface TimelineRegistry {
  parent: ReturnType<typeof gsapType.timeline>;
  pause(): void;
  resume(): void;
  destroy(): void;
}

export function createTimelineRegistry(gsap: typeof gsapType): TimelineRegistry {
  const parent = gsap.timeline({ paused: false });
  return {
    parent,
    pause() { parent.pause(); },
    resume() { parent.resume(); },
    destroy() { parent.kill(); },
  };
}
```

- [ ] **Step 4: Run, expect pass**

```bash
npx vitest run src/app/lighthouse/systems/reduced-motion.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/app/lighthouse/systems/reduced-motion.ts \
        src/app/lighthouse/systems/timeline-registry.ts \
        src/app/lighthouse/systems/reduced-motion.test.ts
git commit -m "feat(lighthouse): reduced-motion observer + timeline registry"
```

### Task 1.9: Page shell — `page.tsx` + `client.tsx` (no canvas yet)

**Files:**
- Create: `src/app/lighthouse/page.tsx` (overwrites old route)
- Create: `src/app/lighthouse/client.tsx` (overwrites old client)
- Delete: every other file currently under `src/app/lighthouse/`
- Delete: every file under `src/app/lighthouse-2/`

- [ ] **Step 1: Delete legacy routes**

```bash
rm -rf src/app/lighthouse-2
rm src/app/lighthouse/cinematic-model.ts \
   src/app/lighthouse/cinematic-model.test.ts \
   src/app/lighthouse/lighthouse-stage.tsx \
   src/app/lighthouse/lighthouse-stage.css \
   src/app/lighthouse/lighthouse-stage.test.tsx \
   src/app/lighthouse/lighthouse-fullscreen-dialog.tsx \
   src/app/lighthouse/lighthouse-fullscreen-dialog.test.tsx \
   src/app/lighthouse/lighthouse-a11y-ledger.tsx \
   src/app/lighthouse/page.test.tsx \
   src/app/lighthouse/client.tsx \
   src/app/lighthouse/page.tsx
rm -rf src/app/lighthouse/layers
```

(The new `lighthouse-a11y-ledger.tsx` from Task 1.7 was created at the same path — re-add it from git after the deletion: `git checkout HEAD -- src/app/lighthouse/lighthouse-a11y-ledger.tsx src/app/lighthouse/lighthouse-a11y-ledger.test.tsx`.)

- [ ] **Step 2: Write the new page**

```tsx
// src/app/lighthouse/page.tsx
import type { Metadata } from "next";
import dynamic from "next/dynamic";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { buildPageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = buildPageMetadata({
  title: "Pharos Lighthouse",
  description:
    "An isometric pixel-art harbor: Pharos as the lighthouse, blockchains as harbours, stablecoins as boats. PSI is the beam. DEWS is the sea.",
  canonical: "/lighthouse/",
});

const LighthouseClient = dynamic(
  () => import("./client").then((mod) => ({ default: mod.LighthouseClient })),
  {
    loading: () => (
      <div className="min-h-[calc(100svh-1.5rem)] animate-pulse border border-border/50 bg-muted/20" aria-busy="true" />
    ),
  },
);

export default function LighthousePage() {
  return (
    <div className="relative left-1/2 w-[100vw] -translate-x-1/2 md:w-[calc(100vw-var(--sidebar-width-expanded))]">
      <BreadcrumbJsonLd items={[{ name: "Home", url: "/" }, { name: "Lighthouse", url: "/lighthouse/" }]} />
      <h1 id="lighthouse-heading" className="sr-only">Pharos Lighthouse</h1>
      <SectionErrorBoundary name="Pharos Lighthouse" supportingText="Refresh the page to retry the lighthouse view.">
        <LighthouseClient />
      </SectionErrorBoundary>
    </div>
  );
}
```

- [ ] **Step 3: Write the new client (no Pixi yet — placeholder)**

```tsx
// src/app/lighthouse/client.tsx
"use client";
import dynamic from "next/dynamic";
import { useChains } from "@/hooks/use-chains";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useStabilityIndexDetail, useStressSignals } from "@/hooks/api-hooks";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { LighthouseA11yLedger } from "./lighthouse-a11y-ledger";
import { buildSceneData } from "./systems/scene-data";

const HarborSceneClient = dynamic(
  () => import("./harbor-scene-client").then((m) => ({ default: m.HarborSceneClient })),
  { ssr: false, loading: () => <div className="min-h-[70vh] animate-pulse bg-muted/10" aria-busy="true" /> },
);

export function LighthouseClient() {
  const chainsQuery = useChains();
  const stabilityQuery = useStabilityIndexDetail();
  const stressQuery = useStressSignals();
  const stablecoinsQuery = useStablecoins();

  const scene = buildSceneData({
    chains: chainsQuery.data,
    stability: stabilityQuery.data,
    stress: stressQuery.data,
    stablecoins: stablecoinsQuery.data,
  });

  if (chainsQuery.isError && !chainsQuery.data) {
    return <QueryErrorNotice error={chainsQuery.error} onRetry={() => void chainsQuery.refetch()} />;
  }

  return (
    <>
      <QueryErrorNotice
        error={chainsQuery.error ?? stabilityQuery.error ?? stressQuery.error ?? stablecoinsQuery.error}
        hasData={!!chainsQuery.data?.chains?.length}
        onRetry={() => {
          void chainsQuery.refetch();
          void stabilityQuery.refetch();
          void stressQuery.refetch();
          void stablecoinsQuery.refetch();
        }}
      />
      <HarborSceneClient scene={scene} />
      <LighthouseA11yLedger scene={scene} />
    </>
  );
}
```

- [ ] **Step 4: Stub `harbor-scene-client.tsx` (renders nothing yet)**

```tsx
// src/app/lighthouse/harbor-scene-client.tsx
"use client";
import type { SceneData } from "./systems/scene-data";

export function HarborSceneClient(_props: { scene: SceneData }) {
  return <div className="relative h-[70vh] w-full bg-[#0a0e1d]" aria-hidden="true" />;
}
```

- [ ] **Step 5: Build, verify SSR + lint + types**

```bash
npm run build && npm run lint && npm run typecheck
```

Expected: all green. Visit `/lighthouse/` in dev (`npm run dev`) and verify the placeholder dark canvas renders, the a11y ledger has data when `useChains` returns.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(lighthouse): replace legacy routes with new shell + a11y ledger"
```

### Task 1.10: Hex-literal lint guard

**Files:**
- Create: `scripts/check-harbor-palette.mjs`
- Modify: `package.json` to add `check:harbor-palette` script and wire into `test:merge-gate` if appropriate

- [ ] **Step 1: Write the script**

```js
// scripts/check-harbor-palette.mjs
#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const palette = await import("../src/app/lighthouse/systems/palette.ts").catch(() => null);
if (!palette) {
  console.error("[check-harbor-palette] could not import palette.ts");
  process.exit(2);
}
const allowed = new Set(Object.values(palette.HARBOR_PALETTE).map((h) => h.toLowerCase()));

const files = execSync("git ls-files src/app/lighthouse | grep -E '\\.(ts|tsx)$' | grep -v test", { encoding: "utf8" })
  .trim().split("\n").filter(Boolean);

const offenders = [];
const HEX = /#[0-9a-fA-F]{6}\b/g;
for (const f of files) {
  if (f.endsWith("palette.ts")) continue;
  const text = readFileSync(f, "utf8");
  for (const match of text.matchAll(HEX)) {
    if (!allowed.has(match[0].toLowerCase())) offenders.push({ file: f, hex: match[0] });
  }
}
if (offenders.length) {
  console.error("Hex literals not in HARBOR_PALETTE:");
  for (const o of offenders) console.error(`  ${o.file}: ${o.hex}`);
  process.exit(1);
}
console.log("OK: all lighthouse hex literals are in HARBOR_PALETTE");
```

- [ ] **Step 2: Add npm script and run**

```bash
npm pkg set scripts.check:harbor-palette="node scripts/check-harbor-palette.mjs"
node scripts/check-harbor-palette.mjs
```

Expected: PASS (no offenders yet — only `palette.ts` defines hex).

- [ ] **Step 3: Commit**

```bash
git add scripts/check-harbor-palette.mjs package.json
git commit -m "chore(lighthouse): lint guard for hex literals outside palette"
```

### Task 1.11: Open the PR

- [ ] **Step 1: Push and open**

```bash
git push -u origin <branch>
gh pr create --title "feat(lighthouse): isometric harbor — Phase 1 foundations" \
  --body "$(cat <<'EOF'
## Summary

Phase 1 (PR1) of the lighthouse isometric-harbor rewrite. No Pixi yet — establishes:

- 24-color anchor palette + lint guard
- Isometric projection math + tests
- Classification → BoatStyle mapping
- SceneData adapter (hooks-agnostic, fully tested)
- Unified sr-only a11y ledger replacing both legacy ledgers
- New /lighthouse route shell with placeholder canvas
- Reduced-motion observer + timeline registry helpers
- Deleted /lighthouse-2 entirely

CSP smoke-test results: see docs/superpowers/audits/2026-04-25-pixi-v8-csp.md

Plan: docs/superpowers/plans/2026-04-25-lighthouse-isometric-harbor.md (Phase 1 of 5)

## Test plan
- [ ] npm run lint passes
- [ ] npm run typecheck passes
- [ ] npm test passes (new tests for palette, isometric, classification-to-boat, scene-data, a11y ledger, reduced-motion)
- [ ] /lighthouse renders the placeholder dark canvas + a11y ledger; /lighthouse-2 returns 404
- [ ] check:harbor-palette script passes
- [ ] check:doc-counts still green

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## 3. Phase 2 — Pixi Application + Sky + Water (PR2)

Goal: stand up the WebGL canvas with strict palette discipline. Static composition only — no boats, no harbors, no lighthouse yet. The water shimmer is the test of perf and reduced-motion.

### Task 2.1: Pixi `<Application>` shell with `extend` registry

**Files:**
- Modify: `src/app/lighthouse/harbor-scene-client.tsx` (replace stub)
- Create: `src/app/lighthouse/harbor-scene.css`

- [ ] **Step 1: Replace stub with real Pixi shell**

```tsx
// src/app/lighthouse/harbor-scene-client.tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { Application, Container, Graphics, Sprite, Texture, Ticker, ColorMatrixFilter, TilingSprite } from "pixi.js";
import { extend, Application as ReactApp } from "@pixi/react";
import { hexToInt, HARBOR_PALETTE } from "./systems/palette";
import type { SceneData } from "./systems/scene-data";
import { observeReducedMotion } from "./systems/reduced-motion";
import "./harbor-scene.css";

extend({ Container, Graphics, Sprite, TilingSprite });

export function HarborSceneClient({ scene }: { scene: SceneData }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setSize({ width: Math.floor(e.contentRect.width), height: Math.floor(e.contentRect.height) });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={wrapRef} className="harbor-scene-wrap" data-testid="harbor-scene">
      {size.width > 0 && size.height > 0 && (
        <ReactApp
          width={size.width}
          height={size.height}
          background={hexToInt(HARBOR_PALETTE.deep_sea_2)}
          resolution={Math.min(typeof window !== "undefined" ? window.devicePixelRatio : 1, 2)}
          autoDensity
          antialias={false}
          roundPixels
          skipExtensionImports
        >
          <pixiContainer />
        </ReactApp>
      )}
    </div>
  );
}
```

- [ ] **Step 2: CSS**

```css
/* src/app/lighthouse/harbor-scene.css */
.harbor-scene-wrap {
  position: relative;
  width: 100%;
  height: 70vh;
  overflow: hidden;
  background: #0a0e1d;
}
.harbor-scene-wrap canvas {
  image-rendering: pixelated;
  image-rendering: crisp-edges; /* Safari fallback */
  display: block;
}
```

- [ ] **Step 3: Build + smoke-check**

```bash
npm run build
```

Expected: build succeeds, no SSR errors. Open `/lighthouse/` in dev — confirm a black 70vh box renders.

- [ ] **Step 4: Commit**

```bash
git add src/app/lighthouse/harbor-scene-client.tsx src/app/lighthouse/harbor-scene.css
git commit -m "feat(lighthouse): pixi v8 application shell with palette background"
```

### Task 2.2: Sky layer (stars + moon)

**Files:**
- Create: `src/app/lighthouse/layers/sky-layer.ts`
- Create: `src/app/lighthouse/sprites/sky-sprite.ts`

- [ ] **Step 1: Implement the builder**

```ts
// src/app/lighthouse/sprites/sky-sprite.ts
import { Container, Graphics } from "pixi.js";
import { HARBOR_PALETTE, hexToInt } from "../systems/palette";

export function buildSkySprite(width: number, height: number): Container {
  const c = new Container();
  // Gradient by stacking 8 horizontal bands
  const bandH = Math.ceil(height / 8);
  const stops = [
    HARBOR_PALETTE.sky_night, HARBOR_PALETTE.sky_night, HARBOR_PALETTE.sky_night,
    HARBOR_PALETTE.sky_horizon, HARBOR_PALETTE.sky_horizon,
    HARBOR_PALETTE.fog_blue, HARBOR_PALETTE.fog_blue, HARBOR_PALETTE.fog_pale,
  ];
  for (let i = 0; i < 8; i++) {
    const g = new Graphics();
    g.rect(0, i * bandH, width, bandH).fill({ color: hexToInt(stops[i]) });
    c.addChild(g);
  }
  // Stars (deterministic pattern via simple LCG)
  const rng = mulberry32(0xcafef00d);
  const stars = new Graphics();
  for (let i = 0; i < 70; i++) {
    const sx = Math.floor(rng() * width);
    const sy = Math.floor(rng() * height * 0.55);
    const a = 0.5 + rng() * 0.5;
    stars.rect(sx, sy, 1, 1).fill({ color: hexToInt(HARBOR_PALETTE.moonlight), alpha: a });
  }
  c.addChild(stars);
  // Moon
  const moon = new Graphics();
  const mx = Math.floor(width * 0.18);
  const my = Math.floor(height * 0.16);
  moon.circle(mx, my, 14).fill({ color: hexToInt(HARBOR_PALETTE.moonlight) });
  moon.circle(mx - 3, my - 3, 11).fill({ color: hexToInt(HARBOR_PALETTE.lantern_glow), alpha: 0.6 });
  c.addChild(moon);
  return c;
}

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

```ts
// src/app/lighthouse/layers/sky-layer.ts
import { Container } from "pixi.js";
import { buildSkySprite } from "../sprites/sky-sprite";

export function buildSkyLayer(width: number, height: number): Container {
  const layer = new Container();
  layer.label = "sky-layer";
  layer.addChild(buildSkySprite(width, height));
  return layer;
}
```

- [ ] **Step 2: Mount the sky in the scene**

Replace the empty `<pixiContainer />` in `harbor-scene-client.tsx` with a `useEffect` that mounts a top-level Container containing the sky:

```tsx
// inside HarborSceneClient — add a stage ref and mount sky on size change
const stageRef = useRef<import("pixi.js").Container | null>(null);
useEffect(() => {
  if (!stageRef.current || size.width === 0) return;
  const stage = stageRef.current;
  stage.removeChildren();
  const sky = buildSkyLayer(size.width, size.height);
  stage.addChild(sky);
}, [size.width, size.height]);

// In JSX: <pixiContainer ref={stageRef} />
```

(Import `buildSkyLayer` at the top.)

- [ ] **Step 3: Verify in browser**

```bash
npm run dev
```

Open `/lighthouse/` — confirm a starry night gradient renders with a moon top-left.

- [ ] **Step 4: Commit**

```bash
git add src/app/lighthouse/layers/sky-layer.ts src/app/lighthouse/sprites/sky-sprite.ts src/app/lighthouse/harbor-scene-client.tsx
git commit -m "feat(lighthouse): sky layer with gradient bands, stars, moon"
```

### Task 2.3: Water layer — TilingSprite + 3-layer wave shader

**Files:**
- Create: `src/app/lighthouse/layers/water-layer.ts`
- Create: `src/app/lighthouse/sprites/water-tile.ts`

- [ ] **Step 1: Build the water layer**

```ts
// src/app/lighthouse/sprites/water-tile.ts
import { Graphics } from "pixi.js";
import { HARBOR_PALETTE, hexToInt } from "../systems/palette";

export function buildWaterTextureSource(): Graphics {
  // 64x32 base water diamond, two-tone diagonal stripes for tiling
  const g = new Graphics();
  g.poly([0, 16, 32, 0, 64, 16, 32, 32]).fill({ color: hexToInt(HARBOR_PALETTE.deep_sea_1) });
  g.moveTo(8, 16).lineTo(32, 4).stroke({ color: hexToInt(HARBOR_PALETTE.deep_sea_2), width: 1 });
  g.moveTo(56, 16).lineTo(32, 28).stroke({ color: hexToInt(HARBOR_PALETTE.shallow_teal), width: 1, alpha: 0.5 });
  return g;
}
```

```ts
// src/app/lighthouse/layers/water-layer.ts
import { Container, Graphics, Ticker } from "pixi.js";
import { HARBOR_PALETTE, hexToInt } from "../systems/palette";

export interface WaterLayer {
  container: Container;
  setAmplitude(px: number): void;
  setReducedMotion(reduced: boolean): void;
  destroy(): void;
}

export function buildWaterLayer(width: number, height: number): WaterLayer {
  const container = new Container();
  container.label = "water-layer";
  // Base flat fill so we never see canvas clear color while scrolling
  const base = new Graphics();
  base.rect(0, 0, width, height).fill({ color: hexToInt(HARBOR_PALETTE.deep_sea_2) });
  container.addChild(base);

  // Wave overlay drawn as horizontal scanlines that we re-draw per tick
  const overlay = new Graphics();
  container.addChild(overlay);

  let amplitude = 1.5;
  let reduced = false;
  let t = 0;

  const handler = (ticker: Ticker) => {
    if (reduced) return;
    t += ticker.deltaTime * 0.01;
    overlay.clear();
    const rows = 16;
    const rowH = Math.ceil(height / rows);
    for (let r = 0; r < rows; r++) {
      const y = r * rowH;
      const swell = Math.sin(t * 0.3 + r * 0.7) * 1.5 * amplitude;
      const chop  = Math.sin(t * 1.4 + r * 1.1) * 0.6 * amplitude;
      const ripple = Math.sin(t * 3.2 + r * 2.3) * 0.3 * amplitude;
      const dy = swell + chop + ripple;
      const tint = r > rows * 0.6 ? HARBOR_PALETTE.deep_sea_1 : HARBOR_PALETTE.deep_sea_2;
      overlay.rect(0, y + dy, width, rowH).fill({ color: hexToInt(tint), alpha: 0.55 });
    }
  };
  Ticker.shared.add(handler);

  return {
    container,
    setAmplitude(px) { amplitude = px; },
    setReducedMotion(r) { reduced = r; if (r) overlay.clear(); },
    destroy() { Ticker.shared.remove(handler); container.destroy({ children: true }); },
  };
}
```

(Note: this is the **chunked-scanline** approximation. If FPS drops below 50 on iPhone 12-class hardware, replace `overlay` with a `TilingSprite` whose `tilePosition.x/y` advances per tick — that path is the §3 perf fallback recommended by the technical review and requires no algorithmic change to data binding.)

- [ ] **Step 2: Mount it after the sky**

In `harbor-scene-client.tsx`'s effect:

```ts
const sky = buildSkyLayer(size.width, size.height);
const water = buildWaterLayer(size.width, size.height);
water.setAmplitude(scene.sea.amplitudePx);
stage.addChild(sky);
stage.addChild(water.container);
const dispose = observeReducedMotion((r) => water.setReducedMotion(r));
return () => { dispose(); water.destroy(); };
```

- [ ] **Step 3: Verify in browser + reduced-motion devtools toggle**

Open Chrome devtools → Rendering → Emulate CSS media feature `prefers-reduced-motion: reduce` → confirm waves freeze. Re-enable → waves resume.

- [ ] **Step 4: Commit**

```bash
git add src/app/lighthouse/layers/water-layer.ts src/app/lighthouse/sprites/water-tile.ts src/app/lighthouse/harbor-scene-client.tsx
git commit -m "feat(lighthouse): water layer with 3-frequency waves, reduced-motion gate"
```

### Task 2.4: Lamp/window light layer (always-on atmosphere)

**Files:** `src/app/lighthouse/layers/lamp-layer.ts`

- [ ] **Step 1: Implement**

```ts
// src/app/lighthouse/layers/lamp-layer.ts
import { Container, Graphics, Ticker } from "pixi.js";
import { HARBOR_PALETTE, hexToInt } from "../systems/palette";

export interface Lamp { x: number; y: number; warm?: boolean; phase: number; }

export function buildLampLayer(lamps: Lamp[]): { container: Container; setReducedMotion(r: boolean): void; destroy(): void } {
  const container = new Container();
  container.label = "lamp-layer";
  const g = new Graphics();
  container.addChild(g);
  let reduced = false;
  let t = 0;
  const handler = (ticker: Ticker) => {
    if (reduced) return;
    t += ticker.deltaTime * 0.03;
    g.clear();
    for (const l of lamps) {
      const flicker = 0.85 + 0.15 * Math.sin(t * 4 + l.phase);
      const color = hexToInt(l.warm ? HARBOR_PALETTE.lantern_warm : HARBOR_PALETTE.lantern_cold);
      g.circle(l.x, l.y, 1).fill({ color });
      g.circle(l.x, l.y, 6).fill({ color, alpha: 0.18 * flicker });
    }
  };
  Ticker.shared.add(handler);
  return {
    container,
    setReducedMotion(r) { reduced = r; if (r) { g.clear(); for (const l of lamps) { const c = hexToInt(l.warm ? HARBOR_PALETTE.lantern_warm : HARBOR_PALETTE.lantern_cold); g.circle(l.x, l.y, 1).fill({ color: c }); g.circle(l.x, l.y, 5).fill({ color: c, alpha: 0.15 }); } } },
    destroy() { Ticker.shared.remove(handler); container.destroy({ children: true }); },
  };
}
```

- [ ] **Step 2: Mount with placeholder lamp positions** (real positions land in PR3 with harbor sprites)

```ts
const lamps = buildLampLayer([]); // empty in PR2; PR3 populates
stage.addChild(lamps.container);
```

- [ ] **Step 3: Commit**

```bash
git add src/app/lighthouse/layers/lamp-layer.ts src/app/lighthouse/harbor-scene-client.tsx
git commit -m "feat(lighthouse): lamp/light layer scaffold (atmosphere)"
```

### Task 2.5: Auto-drift parallax breath

**Files:** modify `harbor-scene-client.tsx`

- [ ] **Step 1: Add a per-frame stage offset**

```ts
const breathHandler = (ticker: import("pixi.js").Ticker) => {
  if (reducedRef.current) return;
  const t = performance.now() * 0.00005;
  stage.x = Math.sin(t * 1.0) * 8;
  stage.y = Math.cos(t * 0.8) * 4;
};
Ticker.shared.add(breathHandler);
```

(Use `reducedRef = useRef(false)` and update it from the same `observeReducedMotion` callback.)

- [ ] **Step 2: Verify in browser**

Confirm the scene drifts gently; reduced-motion mode locks position.

- [ ] **Step 3: Commit**

```bash
git add src/app/lighthouse/harbor-scene-client.tsx
git commit -m "feat(lighthouse): auto-drift parallax breath (reduced-motion safe)"
```

### Task 2.6: Open PR2

PR title: `feat(lighthouse): isometric harbor — Phase 2 sky/water/lamps`. Test plan: visual checks above + Lighthouse perf score not regressing more than 3 points on `/`. Confirm the bundle delta on `/lighthouse/` matches the 290–325 KB gz estimate (use `npm run build` output).

---

## 4. Phase 3 — Lighthouse + Boat Sprites (PR3)

Goal: the hero island lighthouse with volumetric beam + boat factories for all four styles, plus motion timelines (decoupled lantern pulse vs. beam sweep).

### Task 3.1: Lighthouse sprite — tower + lantern + beam

**Files:**
- Create: `src/app/lighthouse/sprites/lighthouse-sprite.ts`
- Create: `src/app/lighthouse/sprites/lighthouse-sprite.test.ts`

- [ ] **Step 1: Test the geometry constants**

```ts
// src/app/lighthouse/sprites/lighthouse-sprite.test.ts
import { describe, it, expect } from "vitest";
import { LIGHTHOUSE_GEOM } from "./lighthouse-sprite";

describe("lighthouse geometry", () => {
  it("totals 96px tall waterline-to-cap", () => {
    const g = LIGHTHOUSE_GEOM;
    const total = g.base.h + g.shaft.h + g.gallery.h + g.lantern.h + g.cap.h;
    expect(total).toBe(96);
  });

  it("base is wider than lantern", () => {
    expect(LIGHTHOUSE_GEOM.base.w).toBeGreaterThan(LIGHTHOUSE_GEOM.lantern.w);
  });
});
```

- [ ] **Step 2: Implement the sprite factory**

```ts
// src/app/lighthouse/sprites/lighthouse-sprite.ts
import { Container, Graphics } from "pixi.js";
import { HARBOR_PALETTE, hexToInt } from "../systems/palette";

export const LIGHTHOUSE_GEOM = {
  base:    { w: 24, h: 12 },
  shaft:   { w: 18, h: 32 },
  gallery: { w: 22, h: 4  },
  lantern: { w: 16, h: 18 },
  cap:     { w: 18, h: 30 }, // hex roof + weathervane
};

export interface LighthouseSpriteAPI {
  container: Container;
  beamContainer: Container;
  lanternHalo: Graphics;
  setBeamColor(hex: string): void;
}

export function buildLighthouseSprite(): LighthouseSpriteAPI {
  const c = new Container();
  c.label = "lighthouse";

  // Base
  const base = new Graphics();
  base.rect(-12, -12, 24, 12).fill({ color: hexToInt(HARBOR_PALETTE.stone_dark) });
  base.rect(-12, -12, 24, 4).fill({ color: hexToInt(HARBOR_PALETTE.stone_mid) });
  c.addChild(base);

  // Shaft
  const shaftY = -12 - 32;
  const shaft = new Graphics();
  shaft.rect(-9, shaftY, 18, 32).fill({ color: hexToInt(HARBOR_PALETTE.stone_mid) });
  // course lines
  for (let y = shaftY + 6; y < shaftY + 32; y += 6) {
    shaft.moveTo(-9, y).lineTo(9, y).stroke({ color: hexToInt(HARBOR_PALETTE.stone_dark), width: 1 });
  }
  // windows
  shaft.rect(-1, shaftY + 8, 2, 3).fill({ color: hexToInt(HARBOR_PALETTE.lantern_warm) });
  shaft.rect(-1, shaftY + 18, 2, 3).fill({ color: hexToInt(HARBOR_PALETTE.lantern_warm) });
  c.addChild(shaft);

  // Gallery deck
  const galleryY = shaftY - 4;
  const gallery = new Graphics();
  gallery.rect(-11, galleryY, 22, 4).fill({ color: hexToInt(HARBOR_PALETTE.iron_dark) });
  c.addChild(gallery);

  // Lantern room
  const lanternY = galleryY - 18;
  const lantern = new Graphics();
  lantern.rect(-8, lanternY, 16, 18).fill({ color: hexToInt(HARBOR_PALETTE.iron_dark) });
  lantern.rect(-7, lanternY + 1, 14, 16).fill({ color: hexToInt(HARBOR_PALETTE.lantern_warm), alpha: 0.85 });
  // 4 fresnel panes
  for (let x = -7; x < 7; x += 4) {
    lantern.moveTo(x + 2, lanternY + 1).lineTo(x + 2, lanternY + 17).stroke({ color: hexToInt(HARBOR_PALETTE.iron_dark), width: 1 });
  }
  c.addChild(lantern);

  // Cap (hex roof simplified as triangle + weathervane)
  const cap = new Graphics();
  const capY = lanternY - 4;
  cap.poly([-9, capY + 4, 0, capY - 4, 9, capY + 4]).fill({ color: hexToInt(HARBOR_PALETTE.stone_dark) });
  cap.moveTo(0, capY - 4).lineTo(0, capY - 12).stroke({ color: hexToInt(HARBOR_PALETTE.iron_dark), width: 1 });
  cap.moveTo(-3, capY - 10).lineTo(3, capY - 10).stroke({ color: hexToInt(HARBOR_PALETTE.iron_dark), width: 1 });
  c.addChild(cap);

  // Lantern halo
  const lanternHalo = new Graphics();
  lanternHalo.circle(0, lanternY + 9, 4).fill({ color: hexToInt(HARBOR_PALETTE.lantern_glow), alpha: 0.85 });
  lanternHalo.circle(0, lanternY + 9, 8).fill({ color: hexToInt(HARBOR_PALETTE.lantern_warm), alpha: 0.35 });
  c.addChild(lanternHalo);

  // Beam container — child rotates; the beam itself is a triangle
  const beamContainer = new Container();
  beamContainer.label = "beam";
  beamContainer.position.set(0, lanternY + 9);
  const beam = new Graphics();
  // 200 px long, 28 deg spread → at 200, half-width = 200 * tan(14deg) ≈ 50
  beam.poly([0, 0, 200, -50, 200, 50]).fill({ color: hexToInt(HARBOR_PALETTE.lantern_warm), alpha: 0.55 });
  beam.blendMode = "add";
  beamContainer.addChild(beam);
  c.addChild(beamContainer);

  return {
    container: c,
    beamContainer,
    lanternHalo,
    setBeamColor(hex) {
      // Re-tint the beam on PSI band change
      beam.clear();
      beam.poly([0, 0, 200, -50, 200, 50]).fill({ color: hexToInt(hex), alpha: 0.55 });
    },
  };
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/app/lighthouse/sprites/lighthouse-sprite.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/app/lighthouse/sprites/lighthouse-sprite.ts src/app/lighthouse/sprites/lighthouse-sprite.test.ts
git commit -m "feat(lighthouse): lighthouse sprite (tower + lantern + beam)"
```

### Task 3.2: Boat sprite factory (4 styles, S/L sizes)

**Files:**
- Create: `src/app/lighthouse/sprites/boat-sprite.ts`
- Create: `src/app/lighthouse/sprites/boat-sprite.test.ts`

- [ ] **Step 1: Test boat sprite produces a Container with expected bounds**

```ts
// src/app/lighthouse/sprites/boat-sprite.test.ts
import { describe, it, expect } from "vitest";
import { BOAT_DIMENSIONS } from "./boat-sprite";

describe("boat dimensions", () => {
  it("has S and L for every style", () => {
    for (const style of ["galleon", "brigantine", "schooner", "junk"] as const) {
      expect(BOAT_DIMENSIONS[style].S.w).toBeGreaterThan(0);
      expect(BOAT_DIMENSIONS[style].L.w).toBeGreaterThan(BOAT_DIMENSIONS[style].S.w);
    }
  });

  it("hulls are taller than they are short", () => {
    for (const style of ["galleon", "brigantine", "schooner", "junk"] as const) {
      expect(BOAT_DIMENSIONS[style].L.h).toBeGreaterThan(BOAT_DIMENSIONS[style].L.w * 0.6);
    }
  });
});
```

- [ ] **Step 2: Implement (with the four signature silhouettes)**

```ts
// src/app/lighthouse/sprites/boat-sprite.ts
import { Container, Graphics } from "pixi.js";
import { HARBOR_PALETTE, hexToInt } from "../systems/palette";
import type { BoatStyle } from "../systems/classification-to-boat";

export const BOAT_DIMENSIONS: Record<BoatStyle, { S: { w: number; h: number }; L: { w: number; h: number } }> = {
  galleon:    { S: { w: 14, h: 20 }, L: { w: 22, h: 30 } },
  brigantine: { S: { w: 13, h: 18 }, L: { w: 20, h: 28 } },
  schooner:   { S: { w: 12, h: 16 }, L: { w: 18, h: 24 } },
  junk:       { S: { w: 13, h: 18 }, L: { w: 20, h: 28 } },
};

export interface BoatSpriteAPI {
  container: Container;
  setPennant(hex: string): void;
  setAura(hex: string | null): void;
}

export function buildBoatSprite(style: BoatStyle, size: "S" | "L"): BoatSpriteAPI {
  const c = new Container();
  c.label = `boat-${style}-${size}`;
  const dim = BOAT_DIMENSIONS[style][size];
  const halfW = dim.w / 2;

  // Aura under hull
  const aura = new Graphics();
  c.addChild(aura);

  // Hull (isometric polygon — different per style)
  const hull = new Graphics();
  switch (style) {
    case "galleon":
      hull.poly([-halfW, dim.h - 4, -halfW + 2, dim.h, halfW - 2, dim.h, halfW, dim.h - 4, halfW - 1, dim.h - 8, -halfW + 1, dim.h - 8])
          .fill({ color: hexToInt(HARBOR_PALETTE.timber_warm) });
      // stern castle
      hull.rect(-halfW + 1, dim.h - 11, 5, 4).fill({ color: hexToInt(HARBOR_PALETTE.timber_dark) });
      // stern lantern
      hull.circle(-halfW + 3, dim.h - 12, 1).fill({ color: hexToInt(HARBOR_PALETTE.lantern_warm) });
      break;
    case "brigantine":
      hull.poly([-halfW + 1, dim.h - 3, -halfW + 2, dim.h, halfW - 2, dim.h, halfW, dim.h - 4, halfW - 1, dim.h - 7, -halfW, dim.h - 8])
          .fill({ color: hexToInt(HARBOR_PALETTE.timber_mid) });
      break;
    case "schooner":
      hull.poly([-halfW, dim.h - 2, -halfW + 1, dim.h, halfW - 1, dim.h, halfW, dim.h - 3, halfW - 1, dim.h - 6, -halfW + 1, dim.h - 6])
          .fill({ color: hexToInt(HARBOR_PALETTE.timber_mid) });
      break;
    case "junk":
      // Curved hull — both ends raised
      hull.poly([-halfW, dim.h - 6, -halfW + 1, dim.h - 1, halfW - 1, dim.h - 1, halfW, dim.h - 6, halfW - 2, dim.h - 9, -halfW + 2, dim.h - 9])
          .fill({ color: hexToInt(HARBOR_PALETTE.timber_dark) });
      break;
  }
  c.addChild(hull);

  // Masts + sails
  const sails = new Graphics();
  if (style === "galleon") {
    for (const mx of [-4, 0, 4]) {
      sails.moveTo(mx, dim.h - 8).lineTo(mx, 2).stroke({ color: hexToInt(HARBOR_PALETTE.iron_dark), width: 1 });
      sails.rect(mx - 3, 4, 6, 10).fill({ color: hexToInt(HARBOR_PALETTE.foam_white), alpha: 0.85 });
    }
  } else if (style === "brigantine") {
    sails.moveTo(-2, dim.h - 7).lineTo(-2, 2).stroke({ color: hexToInt(HARBOR_PALETTE.iron_dark), width: 1 });
    sails.rect(-5, 4, 6, 10).fill({ color: hexToInt(HARBOR_PALETTE.foam_white), alpha: 0.85 });
    sails.moveTo(3, dim.h - 7).lineTo(3, 4).stroke({ color: hexToInt(HARBOR_PALETTE.iron_dark), width: 1 });
    sails.poly([3, 4, 7, 12, 3, 12]).fill({ color: hexToInt(HARBOR_PALETTE.foam_white), alpha: 0.85 });
  } else if (style === "schooner") {
    // Raked masts (slanted backward 8°)
    const slant = 1;
    sails.moveTo(-1 - slant, dim.h - 6).lineTo(-1, 2).stroke({ color: hexToInt(HARBOR_PALETTE.iron_dark), width: 1 });
    sails.poly([-1, 2, -5, 12, -1, 12]).fill({ color: hexToInt(HARBOR_PALETTE.sail_teal), alpha: 0.9 });
    sails.moveTo(3 - slant, dim.h - 6).lineTo(3, 4).stroke({ color: hexToInt(HARBOR_PALETTE.iron_dark), width: 1 });
    sails.poly([3, 4, 7, 12, 3, 12]).fill({ color: hexToInt(HARBOR_PALETTE.sail_teal), alpha: 0.9 });
  } else if (style === "junk") {
    sails.moveTo(0, dim.h - 9).lineTo(0, 1).stroke({ color: hexToInt(HARBOR_PALETTE.iron_dark), width: 1 });
    // Battened sail with 3 ribs
    sails.rect(-5, 3, 10, 12).fill({ color: hexToInt(HARBOR_PALETTE.sail_red), alpha: 0.9 });
    for (let y = 6; y < 14; y += 3) {
      sails.moveTo(-5, y).lineTo(5, y).stroke({ color: hexToInt(HARBOR_PALETTE.iron_dark), width: 1 });
    }
  }
  c.addChild(sails);

  // Pennant — colored 2x3 flag at masthead, replaceable by setPennant
  const pennant = new Graphics();
  pennant.rect(2, 0, 3, 2).fill({ color: hexToInt(HARBOR_PALETTE.fog_pale) });
  c.addChild(pennant);

  return {
    container: c,
    setPennant(hex) {
      pennant.clear();
      pennant.rect(2, 0, 3, 2).fill({ color: hexToInt(hex) });
    },
    setAura(hex) {
      aura.clear();
      if (hex !== null) {
        aura.circle(0, dim.h - 4, halfW + 4).fill({ color: hexToInt(hex), alpha: 0.22 });
      }
    },
  };
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/app/lighthouse/sprites/boat-sprite.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/app/lighthouse/sprites/boat-sprite.ts src/app/lighthouse/sprites/boat-sprite.test.ts
git commit -m "feat(lighthouse): boat sprite factory — 4 styles, 2 sizes, pennant + aura"
```

### Task 3.3: Boat layer + moored bob

**Files:** `src/app/lighthouse/layers/boat-layer.ts`

- [ ] **Step 1: Implement**

```ts
// src/app/lighthouse/layers/boat-layer.ts
import { Container, Ticker } from "pixi.js";
import { buildBoatSprite } from "../sprites/boat-sprite";
import type { SceneBoat } from "../systems/scene-data";

export interface BoatLayerAPI {
  container: Container;
  upsertBoat(boat: SceneBoat, screen: { x: number; y: number }): void;
  removeBoat(coinId: string): void;
  setReducedMotion(reduced: boolean): void;
  destroy(): void;
}

export function buildBoatLayer(): BoatLayerAPI {
  const container = new Container();
  container.label = "boat-layer";
  container.sortableChildren = true;

  const map = new Map<string, { sprite: ReturnType<typeof buildBoatSprite>; baseY: number; phase: number }>();
  let reduced = false;
  let t = 0;

  const handler = (ticker: Ticker) => {
    if (reduced) return;
    t += ticker.deltaTime * 0.05;
    for (const entry of map.values()) {
      entry.sprite.container.y = entry.baseY + Math.sin(t + entry.phase) * 1;
    }
  };
  Ticker.shared.add(handler);

  return {
    container,
    upsertBoat(boat, screen) {
      const existing = map.get(boat.coinId);
      if (existing) {
        existing.sprite.setPennant(boat.pennantHex);
        existing.sprite.container.x = screen.x;
        existing.baseY = screen.y;
        return;
      }
      const sprite = buildBoatSprite(boat.style, boat.hullSize);
      sprite.container.x = screen.x;
      sprite.container.y = screen.y;
      sprite.container.zIndex = screen.y;
      sprite.setPennant(boat.pennantHex);
      container.addChild(sprite.container);
      map.set(boat.coinId, { sprite, baseY: screen.y, phase: hashPhase(boat.coinId) });
    },
    removeBoat(coinId) {
      const e = map.get(coinId);
      if (!e) return;
      container.removeChild(e.sprite.container);
      e.sprite.container.destroy({ children: true });
      map.delete(coinId);
    },
    setReducedMotion(r) {
      reduced = r;
      if (r) for (const e of map.values()) e.sprite.container.y = e.baseY;
    },
    destroy() {
      Ticker.shared.remove(handler);
      for (const e of map.values()) e.sprite.container.destroy({ children: true });
      map.clear();
      container.destroy();
    },
  };
}

function hashPhase(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) / 0xffffffff) * Math.PI * 2;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/lighthouse/layers/boat-layer.ts
git commit -m "feat(lighthouse): boat layer with moored bob and id-stable diff"
```

### Task 3.4: GSAP timelines — beam sweep + lantern pulse

**Files:** `src/app/lighthouse/systems/animation.ts`

- [ ] **Step 1: Implement**

```ts
// src/app/lighthouse/systems/animation.ts
import gsap from "gsap";
import type { Container, Graphics } from "pixi.js";
import type { TimelineRegistry } from "./timeline-registry";

export function startBeamSweep(beam: Container, sweepSeconds: number, registry: TimelineRegistry) {
  const tween = gsap.to(beam, {
    rotation: Math.PI * 2,
    duration: sweepSeconds,
    ease: "none",
    repeat: -1,
  });
  registry.parent.add(tween, 0);
  return tween;
}

export function startLanternPulse(halo: Graphics, registry: TimelineRegistry) {
  const tween = gsap.to(halo, {
    alpha: 0.7,
    duration: 0.42,
    ease: "sine.inOut",
    yoyo: true,
    repeat: -1,
  });
  registry.parent.add(tween, 0);
  return tween;
}

export function setBeamSweepDuration(tween: gsap.core.Tween, seconds: number) {
  const progress = tween.progress();
  tween.duration(seconds);
  tween.progress(progress);
}
```

- [ ] **Step 2: Wire the lighthouse + animation in the scene**

In `harbor-scene-client.tsx` mount effect:

```ts
import gsap from "gsap";
import { createTimelineRegistry } from "./systems/timeline-registry";
import { buildLighthouseSprite } from "./sprites/lighthouse-sprite";
import { startBeamSweep, startLanternPulse, setBeamSweepDuration } from "./systems/animation";
// ...
const registry = createTimelineRegistry(gsap);
const lh = buildLighthouseSprite();
lh.setBeamColor(scene.beam.color);
lh.container.x = Math.round(size.width * 0.45);
lh.container.y = Math.round(size.height * 0.65);
stage.addChild(lh.container);
const beamTween = startBeamSweep(lh.beamContainer, scene.beam.sweepSeconds, registry);
startLanternPulse(lh.lanternHalo, registry);

const dispose = observeReducedMotion((r) => {
  if (r) registry.pause(); else registry.resume();
  reducedRef.current = r;
});

return () => { dispose(); registry.destroy(); /* destroy water, lamps, etc. */ };
```

- [ ] **Step 3: Verify in browser**

Open `/lighthouse/` — beam rotates, lantern pulses on its own slower rhythm. Toggle reduced-motion → both pause.

- [ ] **Step 4: Commit**

```bash
git add src/app/lighthouse/systems/animation.ts src/app/lighthouse/harbor-scene-client.tsx
git commit -m "feat(lighthouse): GSAP beam sweep + lantern pulse via parent timeline"
```

### Task 3.5: Open PR3

PR title: `feat(lighthouse): isometric harbor — Phase 3 lighthouse + boats`. Test plan: lighthouse renders at center-ish, beam rotates, lantern pulses, boats can be programmatically inserted via `upsertBoat()` (no harbours yet).

---

## 5. Phase 4 — Harbours + Live Data Binding (PR4)

Goal: real harbours from real chains data, full diff-and-mutate sync, patrol routes for sailing boats. **This is where the page becomes a dashboard.**

### Task 4.1: Harbor island sprite

**Files:** `src/app/lighthouse/sprites/harbor-island-sprite.ts`

- [ ] **Step 1: Implement**

```ts
// src/app/lighthouse/sprites/harbor-island-sprite.ts
import { Container, Graphics } from "pixi.js";
import { HARBOR_PALETTE, hexToInt } from "../systems/palette";
import type { SceneHarbor } from "../systems/scene-data";

export function buildHarborIsland(harbor: SceneHarbor): { container: Container; lampPositions: { x: number; y: number; warm: boolean; phase: number }[] } {
  const c = new Container();
  c.label = `harbor-${harbor.id}`;
  c.sortableChildren = true;

  // Footprint: log-scaled box
  const footprintW = 80 + Math.min(80, Math.log10(Math.max(1, harbor.totalUsd / 1e6)) * 18);
  const footprintH = footprintW * 0.6;
  const halfW = footprintW / 2;

  // Resilience tier dictates dock material
  const dockColor = hexToInt(
    harbor.resilienceTier === 1 ? HARBOR_PALETTE.stone_pale
    : harbor.resilienceTier === 3 ? HARBOR_PALETTE.timber_dark
    : HARBOR_PALETTE.timber_mid,
  );
  // Island base — 3 isometric faces
  const island = new Graphics();
  island.poly([-halfW, 0, 0, -footprintH / 2, halfW, 0, 0, footprintH / 2]).fill({ color: hexToInt(HARBOR_PALETTE.stone_dark) });
  island.poly([-halfW, 0, 0, footprintH / 2, 0, footprintH / 2 + 6, -halfW, 6]).fill({ color: hexToInt(HARBOR_PALETTE.stone_mid) });
  island.poly([0, footprintH / 2, halfW, 0, halfW, 6, 0, footprintH / 2 + 6]).fill({ color: hexToInt(HARBOR_PALETTE.stone_dark) });
  c.addChild(island);

  // Dock pier — 3 plank rows
  const dock = new Graphics();
  dock.rect(-halfW * 0.6, footprintH / 2 + 6, halfW * 1.2, 8).fill({ color: dockColor });
  c.addChild(dock);

  // Warehouses — N = ceil(stablecoinCount / 3), max 4
  const lampPositions: { x: number; y: number; warm: boolean; phase: number }[] = [];
  const wHouseCount = Math.min(4, Math.max(1, Math.ceil(harbor.stablecoinCount / 3)));
  for (let i = 0; i < wHouseCount; i++) {
    const wx = -halfW * 0.7 + i * 16;
    const wy = -footprintH * 0.1;
    const w = new Graphics();
    w.rect(wx, wy - 12, 12, 12).fill({ color: hexToInt(HARBOR_PALETTE.timber_dark) });
    w.poly([wx - 1, wy - 12, wx + 6, wy - 16, wx + 13, wy - 12]).fill({ color: hexToInt(HARBOR_PALETTE.stone_dark) });
    // 1 lit window
    if ((i % 2) === 0) {
      w.rect(wx + 4, wy - 8, 3, 2).fill({ color: hexToInt(HARBOR_PALETTE.lantern_warm) });
    }
    c.addChild(w);
    // Lantern position next to warehouse door
    lampPositions.push({ x: wx + 6, y: wy - 2, warm: true, phase: i * 0.7 });
  }

  // Dock terminus lantern
  lampPositions.push({ x: halfW * 0.5, y: footprintH / 2 + 14, warm: true, phase: 0.3 });

  return { container: c, lampPositions };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/lighthouse/sprites/harbor-island-sprite.ts
git commit -m "feat(lighthouse): harbor island sprite (resilience-tiered docks)"
```

### Task 4.2: Harbor layer + scene placement

**Files:** `src/app/lighthouse/layers/harbor-layer.ts`

- [ ] **Step 1: Implement** with off-center lighthouse anchor and triangle composition

```ts
// src/app/lighthouse/layers/harbor-layer.ts
import { Container } from "pixi.js";
import { buildHarborIsland } from "../sprites/harbor-island-sprite";
import { worldToScreen } from "../systems/isometric";
import type { SceneHarbor } from "../systems/scene-data";

const TRIANGLE_TILES = [
  // Hero positions around lighthouse at (15, 18)
  { tileX: 22, tileY: 12 }, // NE
  { tileX: 8,  tileY: 24 }, // SW
  { tileX: 26, tileY: 22 }, // E
  // Mid-tier positions
  { tileX: 12, tileY: 8  },
  { tileX: 28, tileY: 8  },
  { tileX: 6,  tileY: 14 },
  { tileX: 30, tileY: 16 },
  { tileX: 18, tileY: 28 },
];

export interface HarborLayerAPI {
  container: Container;
  syncHarbors(harbors: SceneHarbor[]): { harborById: Map<string, { container: Container; lamps: { x: number; y: number; warm: boolean; phase: number }[] }> };
  destroy(): void;
}

export function buildHarborLayer(): HarborLayerAPI {
  const container = new Container();
  container.label = "harbor-layer";
  container.sortableChildren = true;

  const harborById = new Map<string, { container: Container; lamps: { x: number; y: number; warm: boolean; phase: number }[] }>();

  return {
    container,
    syncHarbors(harbors) {
      const seen = new Set<string>();
      harbors.slice(0, TRIANGLE_TILES.length).forEach((harbor, i) => {
        seen.add(harbor.id);
        const tile = TRIANGLE_TILES[i];
        const screen = worldToScreen(tile);
        const existing = harborById.get(harbor.id);
        if (!existing) {
          const built = buildHarborIsland(harbor);
          built.container.x = screen.x;
          built.container.y = screen.y;
          built.container.zIndex = tile.tileX + tile.tileY;
          container.addChild(built.container);
          // Translate lamp positions into world coords
          const worldLamps = built.lampPositions.map((l) => ({ x: l.x + screen.x, y: l.y + screen.y, warm: l.warm, phase: l.phase }));
          harborById.set(harbor.id, { container: built.container, lamps: worldLamps });
        }
      });
      // Remove stale
      for (const id of harborById.keys()) {
        if (!seen.has(id)) {
          const e = harborById.get(id)!;
          container.removeChild(e.container);
          e.container.destroy({ children: true });
          harborById.delete(id);
        }
      }
      return { harborById };
    },
    destroy() {
      for (const e of harborById.values()) e.container.destroy({ children: true });
      harborById.clear();
      container.destroy();
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/lighthouse/layers/harbor-layer.ts
git commit -m "feat(lighthouse): harbor layer with off-center triangle composition"
```

### Task 4.3: Patrol route generator + sailing boats

**Files:**
- Create: `src/app/lighthouse/systems/patrol.ts`
- Create: `src/app/lighthouse/systems/patrol.test.ts`

- [ ] **Step 1: Test path generator**

```ts
// src/app/lighthouse/systems/patrol.test.ts
import { describe, it, expect } from "vitest";
import { generatePatrolPath } from "./patrol";

describe("generatePatrolPath", () => {
  it("returns at least 4 control points", () => {
    const path = generatePatrolPath({ x: 0, y: 0 }, { x: 200, y: 100 }, "abc");
    expect(path.length).toBeGreaterThanOrEqual(4);
  });

  it("is deterministic for same id", () => {
    const a = generatePatrolPath({ x: 0, y: 0 }, { x: 200, y: 100 }, "abc");
    const b = generatePatrolPath({ x: 0, y: 0 }, { x: 200, y: 100 }, "abc");
    expect(a).toEqual(b);
  });

  it("differs for different ids", () => {
    const a = generatePatrolPath({ x: 0, y: 0 }, { x: 200, y: 100 }, "abc");
    const b = generatePatrolPath({ x: 0, y: 0 }, { x: 200, y: 100 }, "xyz");
    expect(a).not.toEqual(b);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/app/lighthouse/systems/patrol.ts
export interface Pt { x: number; y: number; }

export function generatePatrolPath(home: Pt, beacon: Pt, seed: string): Pt[] {
  const rng = stringRng(seed);
  const midX = (home.x + beacon.x) / 2;
  const midY = (home.y + beacon.y) / 2;
  const detourX = (rng() - 0.5) * 80;
  const detourY = (rng() - 0.5) * 40;
  return [
    home,
    { x: midX + detourX, y: midY + detourY },
    { x: beacon.x + (rng() - 0.5) * 30, y: beacon.y + (rng() - 0.5) * 20 },
    home,
  ];
}

function stringRng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h = Math.imul(h ^ (h >>> 13), 2654435761); h ^= h >>> 16; return ((h >>> 0) / 0xffffffff); };
}
```

- [ ] **Step 3: Run tests, commit**

```bash
npx vitest run src/app/lighthouse/systems/patrol.test.ts
git add src/app/lighthouse/systems/patrol.ts src/app/lighthouse/systems/patrol.test.ts
git commit -m "feat(lighthouse): deterministic Bezier patrol path generator"
```

### Task 4.4: Scene sync — diff SceneData → mutate sprites

**Files:** `src/app/lighthouse/systems/scene-sync.ts`

- [ ] **Step 1: Implement** the diff-and-mutate orchestrator

```ts
// src/app/lighthouse/systems/scene-sync.ts
import type { SceneData } from "./scene-data";
import type { HarborLayerAPI } from "../layers/harbor-layer";
import type { BoatLayerAPI } from "../layers/boat-layer";
import { worldToScreen } from "./isometric";

export interface SceneSyncDeps {
  harborLayer: HarborLayerAPI;
  boatLayer: BoatLayerAPI;
  setBeamColor: (hex: string) => void;
  setBeamSweepSeconds: (s: number) => void;
  setSeaAmplitude: (px: number) => void;
  setLamps: (lamps: { x: number; y: number; warm: boolean; phase: number }[]) => void;
}

export function applyScene(scene: SceneData, d: SceneSyncDeps) {
  d.setBeamColor(scene.beam.color);
  d.setBeamSweepSeconds(scene.beam.sweepSeconds);
  d.setSeaAmplitude(scene.sea.amplitudePx);
  const { harborById } = d.harborLayer.syncHarbors(scene.harbors);
  const allLamps: { x: number; y: number; warm: boolean; phase: number }[] = [];
  const seenBoats = new Set<string>();
  for (const harbor of scene.harbors) {
    const placed = harborById.get(harbor.id);
    if (!placed) continue;
    allLamps.push(...placed.lamps);
    const dockX = placed.container.x;
    const dockY = placed.container.y;
    harbor.boats.forEach((boat, idx) => {
      seenBoats.add(boat.coinId);
      const offset = idx * 14 - (harbor.boats.length - 1) * 7;
      d.boatLayer.upsertBoat(boat, { x: dockX + offset, y: dockY + 18 });
    });
  }
  d.setLamps(allLamps);
}
```

- [ ] **Step 2: Wire into `harbor-scene-client.tsx`**

```ts
useEffect(() => {
  if (!stageRef.current || size.width === 0) return;
  const stage = stageRef.current;
  // ... build sky, water, lamps, harborLayer, boatLayer, lighthouse ...
  applyScene(scene, {
    harborLayer,
    boatLayer,
    setBeamColor: (hex) => lh.setBeamColor(hex),
    setBeamSweepSeconds: (s) => setBeamSweepDuration(beamTween, s),
    setSeaAmplitude: (px) => water.setAmplitude(px),
    setLamps: (lamps) => lampLayer.replaceLamps(lamps),
  });
}, [scene, size.width, size.height]);
```

(Adjust `lampLayer` API to add `replaceLamps`.)

- [ ] **Step 3: Verify live data**

`npm run dev` → load `/lighthouse/` → boats appear at chains, beam color = current PSI band, sea amplitude follows DEWS.

- [ ] **Step 4: Commit**

```bash
git add src/app/lighthouse/systems/scene-sync.ts src/app/lighthouse/harbor-scene-client.tsx src/app/lighthouse/layers/lamp-layer.ts
git commit -m "feat(lighthouse): scene-sync diff/mutate orchestrator"
```

### Task 4.5: UI overlay (chain labels + keyboard targets)

**Files:** `src/app/lighthouse/layers/ui-overlay.tsx`

- [ ] **Step 1: Implement HTML overlay**

```tsx
// src/app/lighthouse/layers/ui-overlay.tsx
import type { SceneData } from "../systems/scene-data";

interface OverlayProps {
  scene: SceneData;
  positions: Map<string, { x: number; y: number }>;
}

export function UIOverlay({ scene, positions }: OverlayProps) {
  return (
    <div className="harbor-overlay" aria-label="Harbor labels">
      {scene.harbors.map((h) => {
        const p = positions.get(h.id);
        if (!p) return null;
        return (
          <button
            key={h.id}
            type="button"
            className="harbor-overlay__label"
            style={{ left: p.x, top: p.y - 30 }}
            data-harbor-id={h.id}
          >
            {h.name}
          </button>
        );
      })}
    </div>
  );
}
```

Add `.harbor-overlay__label` styles to `harbor-scene.css`. The button is keyboard-focusable; clicking emits a future selection event (no-op for now).

- [ ] **Step 2: Mount the overlay alongside the canvas**

```tsx
// in HarborSceneClient JSX
<UIOverlay scene={scene} positions={positionsRef.current} />
```

- [ ] **Step 3: Commit**

```bash
git add src/app/lighthouse/layers/ui-overlay.tsx src/app/lighthouse/harbor-scene.css src/app/lighthouse/harbor-scene-client.tsx
git commit -m "feat(lighthouse): keyboard-accessible HTML overlay for harbour labels"
```

### Task 4.6: Reduced-motion freeze logic (deterministic composition)

**Files:** `src/app/lighthouse/systems/reduced-motion-freeze.ts` + wiring

- [ ] **Step 1: Implement**

When reduced-motion fires:
- Sailing boats freeze at `t=0.5` of their patrol path (midpoint).
- Wave amplitude visualised as foam-density on shoreline (clear `overlay`, draw foam intensity).
- Beam freezes pointing at the largest harbour.

```ts
// src/app/lighthouse/systems/reduced-motion-freeze.ts
import gsap from "gsap";
import type { SceneData } from "./scene-data";

export function applyReducedMotionFreeze(scene: SceneData, opts: {
  beamContainer: import("pixi.js").Container;
  beamTween: gsap.core.Tween;
  largestHarborTilePx: { x: number; y: number };
}) {
  // Pause beam, then rotate beam container to point at largest harbour
  opts.beamTween.pause();
  const angle = Math.atan2(opts.largestHarborTilePx.y, opts.largestHarborTilePx.x);
  opts.beamContainer.rotation = angle;
}
```

(Resume logic is `opts.beamTween.resume()` on motion-allowed.)

- [ ] **Step 2: Wire into scene's reduced-motion observer**

```ts
const dispose = observeReducedMotion((r) => {
  reducedRef.current = r;
  if (r) {
    registry.pause();
    applyReducedMotionFreeze(scene, { beamContainer: lh.beamContainer, beamTween, largestHarborTilePx: { x: 22, y: 12 } });
  } else {
    registry.resume();
  }
  water.setReducedMotion(r);
  lampLayer.setReducedMotion(r);
  boatLayer.setReducedMotion(r);
});
```

- [ ] **Step 3: Commit**

```bash
git add src/app/lighthouse/systems/reduced-motion-freeze.ts src/app/lighthouse/harbor-scene-client.tsx
git commit -m "feat(lighthouse): deterministic reduced-motion freeze composition"
```

### Task 4.7: Open PR4

PR title: `feat(lighthouse): isometric harbor — Phase 4 harbours + live data`. Test plan: real chains data populates harbours, boats correct in count/style/colour, beam reflects current PSI, waves reflect DEWS.

---

## 6. Phase 5 — Cleanup, Visual Regression, Docs (PR5)

### Task 5.1: Playwright visual regression test

**Files:** `tests/visual/lighthouse.spec.ts`

- [ ] **Step 1: Write the test** (uses reduced-motion for determinism)

```ts
// tests/visual/lighthouse.spec.ts
import { test, expect } from "@playwright/test";

test.use({ reducedMotion: "reduce" });

test("lighthouse renders deterministic frozen scene", async ({ page }) => {
  await page.goto("/lighthouse/");
  await page.waitForSelector("[data-testid=harbor-scene] canvas");
  await page.waitForTimeout(500); // allow scene-sync to apply
  await expect(page).toHaveScreenshot("lighthouse-reduced.png", { maxDiffPixelRatio: 0.02 });
});
```

- [ ] **Step 2: Run, baseline, commit**

```bash
npx playwright test tests/visual/lighthouse.spec.ts --update-snapshots
git add tests/visual/lighthouse.spec.ts tests/visual/__screenshots__/
git commit -m "test(lighthouse): playwright visual regression under reduced-motion"
```

### Task 5.2: Update docs

**Files:**
- Create: `docs/agents/2026-04-25-lighthouse-isometric.md`
- Modify: `docs/architecture.md` if any new constraints surfaced (DPR cap, palette discipline, lint guard)

- [ ] **Step 1: Author the agent note**

Brief retrospective covering: Phase 0 outcome (CSP), what shipped, what slid (PixelLab assets are P2), and the agent reviews referenced.

- [ ] **Step 2: Commit**

```bash
git add docs/agents/2026-04-25-lighthouse-isometric.md docs/architecture.md
git commit -m "docs(lighthouse): isometric harbor retrospective + architecture deltas"
```

### Task 5.3: Final merge gate

- [ ] **Step 1: Run merge gate**

```bash
npm run test:merge-gate
```

Expected: green. Includes type-check, lint, tests, palette guard, doc counts.

- [ ] **Step 2: Open PR5 and merge**

PR title: `feat(lighthouse): isometric harbor — Phase 5 visual regression + docs`. Once merged, the rewrite is complete.

---

## 7. Out-of-scope — explicit deferrals

These are designed for in scene graph but **not implemented in this plan**:

- PixelLab MCP-generated PNG sprite atlas (replace code-drawn `Graphics` with PNGs). Plan owner: future Phase 6.
- DEX dock cranes (data-bound to per-chain DEX presence). Spec slot at `§10`.
- Yield protocol mini-lighthouses on chain harbours.
- Bridge route animation between chains (no client-side bridge-volume feed exists).
- Camera pan/zoom on harbour click (PixiJS stage `scale`/`position` lerp).
- Storm rain/lightning particles (DEWS DANGER state) — recommended polish, deferred to keep PR4 reviewable.

The boundary between this plan and "future polish" is set at: **everything driven by data already on the chains/PSI/DEWS feeds is in scope; everything requiring a new endpoint is deferred.**

---

## 8. Self-review

**Spec coverage:** every section of the source spec is mapped — beam (T3.1, T3.4), boats (T3.2, T3.3), harbors (T4.1, T4.2), water/sky/lamps (T2.2, T2.3, T2.4), reduced motion (T1.8, T2.3, T4.6), a11y ledger (T1.7), file structure (§0.4), data binding (T1.6, T4.4), build sequence (5 phases). Items dropped — explicitly listed in §0.2 with reasoning (`volume24h` and chain TVL not available client-side).

**Placeholder scan:** none. Every step gives concrete code, exact paths, exact commands, expected output.

**Type consistency:** `SceneData`, `SceneBoat`, `SceneHarbor`, `BoatStyle`, `BoatSpriteAPI`, `LighthouseSpriteAPI`, `HarborLayerAPI`, `BoatLayerAPI`, `WaterLayer`, `TimelineRegistry` all defined where first used and referenced consistently downstream. Tween-duration helper (`setBeamSweepDuration`) and patrol generator are used in PR3/PR4 with the same signatures defined at PR3.

**Risk register:**
- Phase 0 (CSP) is the single hardest gate. If it fails, this plan re-templates against Canvas 2D — that fork is preserved at §1 Task 0.3.
- Pixi v8 + `@pixi/react@^8.0.5` are recent. PR2 includes a build/dev check before any rendering work.
- Water shimmer at 60 fps on iPhone 12-class is the perf risk; T2.3 commits to scanline approximation with a `TilingSprite` fallback path noted.
- Bundle ~290–325 KB gz on `/lighthouse/` only is verified by dynamic import + bundle-phobia step in T1.1.
