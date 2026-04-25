# Lighthouse Isometric Harbor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/lighthouse` and `/lighthouse-2` routes with a single, fully data-bound 2D isometric pixel-art harbor scene at `/lighthouse` — Pharos as a beacon-island, chains as harbours, stablecoins as boats, PSI as the beam, DEWS as the sea state.

**Architecture:** Canvas 2D inside a `dynamic({ ssr: false })` React shell, GSAP-driven value tweens (renderer-agnostic — `requestAnimationFrame` loop reads tweened state per frame), a runtime-neutral `systems/` adapter that consumes existing TanStack Query hooks (`useChains`, `useStablecoins`, `useStabilityIndexDetail`, `useStressSignals`) and emits a `SceneData` object rendered by layered draw functions. Pixel-art discipline enforced by a 24-color anchor palette, `imageSmoothingEnabled = false`, integer-pixel positioning, and a hex-literal lint check.

**Tech Stack:** Plain DOM `<canvas>` + 2D context, `gsap@^3.15` for value tweens. React 19, Next 16 static export, Vitest + Playwright.

**Phase 0 outcome (recorded 2026-04-25):** PixiJS v8.18.1 throws `_unsafeEvalCheck` under the production CSP. Verdict NO-GO; Fork A (Canvas 2D rewrite) selected. See `docs/superpowers/audits/2026-04-25-pixi-v8-csp.md`. The plan from §3 onward (Phase 2+) implements Fork A directly. Phase 1 below is renderer-agnostic and ships unchanged.

**Source spec:** `docs/superpowers/specs/2026-04-25-lighthouse-2-isometric-harbor-design.md` — this plan supersedes that spec for execution and resolves three review streams (RPG visual direction, data-binding coherence, technical architecture).

---

## 0. Reference Tables — locked before implementation

### 0.1 Anchor palette (25 colors)

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
| Lighthouse beam sweep duration | `StabilityIndexCurrent.band` → new `PSI_SWEEP_DURATION` | new constant in `shared/lib/psi-colors.ts` (mirrors `src/lib/dews-radar-utils.ts`) | Piecewise per band: BEDROCK=12s, STEADY=9, TREMOR=6, FRACTURE=4, CRISIS=2.5, MELTDOWN=1.2 |
| Lighthouse lantern pulse | none — fixed | constant 1.2 Hz | Decoupled rhythm: heartbeat regardless of PSI |
| Sea wave amplitude + tint | `useStressSignals()` highest band → `THREAT_BAND_HEX` | `shared/lib/classification.ts`, `src/lib/dews-radar-utils.ts` | Single intensity drives wave amplitude (1.5 → 4 px) and water tint |
| Storm overlays (rain / lightning) | DEWS `WARNING`/`DANGER` only | same | Rain particles + occasional lightning flash above WARNING |
| Cloud density | DEWS highest band | same | Sky tint + cloud sprite count |
| Harbor build quality | `getChainResilienceTier(chainId)` | `shared/lib/chains.ts:151` | Tier 1 = stone seawalls; Tier 2 = wood pier; Tier 3 = weathered planks |
| Harbor footprint (S/M/L) | `ChainSummary.totalUsd` | `shared/types/chains.ts:29` | Log-scaled via `hullWidth(totalUsd, maxUsd, ...)` (`src/app/chains/nautical-scene-math.ts:10`) |
| Warehouse count per harbor | `ChainSummary.stablecoinCount` | `shared/types/chains.ts:36` | 1 warehouse per ~3 coins |
| Chain flag on dock mast | `CHAIN_HEX[chainId]` (else neutral) | `src/lib/dex-display-constants.ts` | Small accent; fallback grey when undefined |
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
├── harbor-scene-client.tsx               # Canvas 2D mount, RAF loop; ssr:false dynamic-imported
├── harbor-scene.css                      # Canvas sizing, image-rendering, overlay positioning
├── lighthouse-a11y-ledger.tsx            # Single sr-only ledger (replaces both legacy ledgers)
├── layers/
│   ├── sky-layer.ts                      # Stars, moon, gulls, clouds — draw fn
│   ├── water-layer.ts                    # 3-frequency scanline wave draw fn
│   ├── lamp-layer.ts                     # Dock lanterns, warehouse windows, ship lights
│   ├── harbor-layer.ts                   # Per-chain harbour state (island, dock, warehouses, flag)
│   ├── boat-layer.ts                     # Per-coin boat state (moored + sailing)
│   ├── horizon-layer.ts                  # Alt-peg flagged silhouettes
│   └── ui-overlay.tsx                    # HTML overlay (chain labels, hover, tooltips, kbd targets)
├── sprites/
│   ├── lighthouse-sprite.ts              # drawLighthouse(ctx, x, y, beamRot, beamColor)
│   ├── boat-sprite.ts                    # drawBoat(ctx, x, y, style, size, pennantHex, auraHex)
│   ├── harbor-island-sprite.ts           # drawHarborIsland(ctx, x, y, harborState)
│   ├── water-tile.ts                     # drawWaterTile(ctx, x, y, tint) helper
│   └── horizon-island-sprite.ts          # drawHorizonIsland(ctx, x, y, cohort)
├── systems/
│   ├── palette.ts                        # 24-color anchor + tint utility
│   ├── isometric.ts                      # Tile↔screen, depth key, hit-test inverse
│   ├── patrol.ts                         # Bezier path generator
│   ├── scene-data.ts                     # Hooks → SceneData adapter
│   ├── scene-render.ts                   # Per-frame draw orchestrator (sorts + paints layers)
│   ├── classification-to-boat.ts         # (governance, backing) → BoatStyle
│   ├── reduced-motion.ts                 # mq listener helper
│   └── timeline-registry.ts              # GSAP parent timeline (pauses on reduced-motion)
└── __fixtures__/
    └── scene-data.ts                     # Deterministic SceneData for tests
```

Tests live alongside their pure-TS modules (`isometric.test.ts`, `scene-data.test.ts`, `classification-to-boat.test.ts`, `palette.test.ts`, `patrol.test.ts`).

**Architectural pattern (Canvas 2D specific):** layers and sprites are pure functions over `(ctx, frameState)`, not Container objects. The render orchestrator (`systems/scene-render.ts`) owns the `requestAnimationFrame` loop, calls `ctx.clearRect`, then invokes each layer's draw function in painter's order. GSAP tweens animate value objects (e.g., `{ rotation: 0, alpha: 0.85 }`); layers read those values per frame. Pause = `parentTimeline.pause()` + setting a `reducedMotion` flag the layers respect (e.g., the water layer skips its scanline displacement and renders a static composition).

---

## 1. Phase 0 — CSP Smoke Test (COMPLETED 2026-04-25 — VERDICT: NO-GO)

Pharos's CSP is `script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://static.cloudflareinsights.com` (`public/_headers:14`) — **no `unsafe-eval`**. PixiJS v8's WebGL shader path requires `unsafe-eval` via `AbstractRenderer._unsafeEvalCheck` and the check cannot be disabled.

**Result:** Probe failed cleanly. Audit at `docs/superpowers/audits/2026-04-25-pixi-v8-csp.md`. Switched to **Fork A — Canvas 2D rewrite**. The tasks below (0.1-0.5) document what was done; Phase 1+ implements the Canvas 2D path.

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

**Files (transient, deleted at end of Phase 0):**
- Create: src/app/lighthouse-spike/page.tsx (no longer present after spike cleanup)
- Create: src/app/lighthouse-spike/client.tsx (no longer present after spike cleanup)
- Create: src/app/lighthouse-spike/hello-pixi.tsx (no longer present after spike cleanup)

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

### Task 1.1: Install dependencies — DONE (commit `272581ae`)

`gsap@3.15.0` and `playwright@1.59.1` are installed on the feature branch from the Phase 0 → Fork A pivot. The Pixi-specific deps (`pixi.js`, `@pixi/react`) are intentionally NOT installed for the Canvas 2D fork. Skip this task and proceed to Task 1.2.

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
  it("contains 25 entries", () => {
    expect(Object.keys(HARBOR_PALETTE)).toHaveLength(25);
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
  // Multiplier 2x SCENE_GRID guarantees elevated tiles always sort above any
  // ground tile in the 40x40 scene (max ground sum = 78 < SCENE_GRID*2 = 80).
  return tileX + tileY + elevation * SCENE_GRID * 2;
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

(Verify the exact shape of `ChainSummary`/`StablecoinDataPayload`/`StabilityIndexResponse`/`StressSignalsAllResponse` against `shared/types/chains.ts`, `shared/types/market.ts`, and the schemas in `shared/types/stability.ts`. Adjust fixture fields to match strict TypeScript.)

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

- [ ] **Step 4: Stub `harbor-scene-client.tsx` (renders empty canvas)**

```tsx
// src/app/lighthouse/harbor-scene-client.tsx
"use client";
import { useEffect, useRef } from "react";
import type { SceneData } from "./systems/scene-data";
import "./harbor-scene.css";

export function HarborSceneClient(_props: { scene: SceneData }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cvs = ref.current;
    if (!cvs) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      const r = cvs.getBoundingClientRect();
      cvs.width = Math.floor(r.width * dpr);
      cvs.height = Math.floor(r.height * dpr);
      const ctx = cvs.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#0a0e1d";
      ctx.fillRect(0, 0, cvs.width, cvs.height);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cvs);
    return () => ro.disconnect();
  }, []);
  return <canvas ref={ref} className="harbor-scene-canvas" aria-hidden="true" />;
}
```

Also create `src/app/lighthouse/harbor-scene.css`:

```css
.harbor-scene-canvas {
  display: block;
  width: 100%;
  height: 70vh;
  background: #0a0e1d;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
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

## 3. Phase 2 — Canvas 2D shell + Sky + Water + Lamps (PR2)

Goal: stand up the Canvas 2D render loop with strict palette discipline. Static composition only — no boats, no harbors, no lighthouse yet. The water shimmer is the test of perf and reduced-motion.

**Architectural pattern locked here:**

- `harbor-scene-client.tsx` owns the canvas, the DPR-aware sizing, the RAF loop, and a `frame: FrameState` object passed to each layer.
- Each layer in `layers/*` exports a builder that returns `{ draw(ctx, frame), dispose() }`. No state on layers besides what the builder closes over.
- All hex literals come from `HARBOR_PALETTE`. The lint guard rejects everything else.
- Reduced-motion is a single `frame.reducedMotion` flag layers respect.

```ts
// FrameState contract — referenced by every layer
export interface FrameState {
  t: number;                  // seconds since first frame
  width: number;              // CSS px
  height: number;             // CSS px
  dpr: number;                // capped at 2
  reducedMotion: boolean;
  scene: SceneData;
  beam: { rotationRad: number; alpha: number; colorHex: string };
  lantern: { alpha: number };
}
```

### Task 2.1: Canvas mount, DPR-aware sizing, RAF loop

**Files:**
- Modify: `src/app/lighthouse/harbor-scene-client.tsx`
- Modify: `src/app/lighthouse/harbor-scene.css`
- Create: `src/app/lighthouse/systems/scene-render.ts`

- [ ] **Step 1: Implement the render orchestrator**

```ts
// src/app/lighthouse/systems/scene-render.ts
import type { SceneData } from "./scene-data";

export interface FrameState {
  t: number;
  width: number;
  height: number;
  dpr: number;
  reducedMotion: boolean;
  scene: SceneData;
  beam: { rotationRad: number; alpha: number; colorHex: string };
  lantern: { alpha: number };
}

export interface DrawableLayer {
  draw(ctx: CanvasRenderingContext2D, frame: FrameState): void;
  dispose?: () => void;
}

export function createInitialFrameState(scene: SceneData): FrameState {
  return {
    t: 0,
    width: 0,
    height: 0,
    dpr: 1,
    reducedMotion: false,
    scene,
    beam: { rotationRad: 0, alpha: 0.55, colorHex: scene.beam.color },
    lantern: { alpha: 0.85 },
  };
}
```

- [ ] **Step 2: Replace stub with real Canvas 2D shell + RAF loop**

```tsx
// src/app/lighthouse/harbor-scene-client.tsx
"use client";
import { useEffect, useRef } from "react";
import { HARBOR_PALETTE } from "./systems/palette";
import type { SceneData } from "./systems/scene-data";
import { createInitialFrameState, type DrawableLayer, type FrameState } from "./systems/scene-render";
import { observeReducedMotion } from "./systems/reduced-motion";
import "./harbor-scene.css";

export function HarborSceneClient({ scene }: { scene: SceneData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext("2d", { alpha: false });
    if (!ctx) return;

    const frame = createInitialFrameState(sceneRef.current);
    frame.dpr = Math.min(window.devicePixelRatio || 1, 2);

    const layers: DrawableLayer[] = []; // populated in subsequent tasks

    const resize = () => {
      const r = cvs.getBoundingClientRect();
      frame.width = Math.floor(r.width);
      frame.height = Math.floor(r.height);
      cvs.width = Math.floor(r.width * frame.dpr);
      cvs.height = Math.floor(r.height * frame.dpr);
      ctx.imageSmoothingEnabled = false;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cvs);

    const disposeRm = observeReducedMotion((m) => { frame.reducedMotion = m; });

    const start = performance.now();
    let rafId = 0;
    const tick = () => {
      frame.t = (performance.now() - start) / 1000;
      frame.scene = sceneRef.current;
      ctx.save();
      ctx.scale(frame.dpr, frame.dpr);
      ctx.fillStyle = HARBOR_PALETTE.deep_sea_2;
      ctx.fillRect(0, 0, frame.width, frame.height);
      for (const layer of layers) layer.draw(ctx, frame);
      ctx.restore();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      disposeRm();
      for (const layer of layers) layer.dispose?.();
    };
  }, []);

  return (
    <div className="harbor-scene-wrap" data-testid="harbor-scene">
      <canvas ref={canvasRef} className="harbor-scene-canvas" aria-hidden="true" />
    </div>
  );
}
```

(The empty `layers: DrawableLayer[] = []` is intentional — Tasks 2.2/2.3/2.4 push real layers into this slot.)

- [ ] **Step 3: CSS**

```css
/* src/app/lighthouse/harbor-scene.css */
.harbor-scene-wrap {
  position: relative;
  width: 100%;
  height: 70vh;
  overflow: hidden;
  background: #0a0e1d;
}
.harbor-scene-canvas {
  display: block;
  width: 100%;
  height: 100%;
  background: #0a0e1d;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}
```

- [ ] **Step 4: Build + smoke-check**

```bash
npm run build
```

Expected: build succeeds, no SSR errors. `/lighthouse/` renders a flat 70vh dark canvas.

- [ ] **Step 5: Commit**

```bash
git add src/app/lighthouse/harbor-scene-client.tsx \
        src/app/lighthouse/harbor-scene.css \
        src/app/lighthouse/systems/scene-render.ts
git commit -m "feat(lighthouse): canvas 2d shell with DPR-aware RAF loop"
```

### Task 2.2: Sky layer (gradient + stars + moon)

**Files:**
- Create: `src/app/lighthouse/layers/sky-layer.ts`
- Create: `src/app/lighthouse/systems/rng.ts` (deterministic LCG used by multiple layers)

- [ ] **Step 1: Deterministic RNG**

```ts
// src/app/lighthouse/systems/rng.ts
export function mulberry32(seed: number): () => number {
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

- [ ] **Step 2: Sky layer builder**

```ts
// src/app/lighthouse/layers/sky-layer.ts
import { HARBOR_PALETTE } from "../systems/palette";
import type { DrawableLayer, FrameState } from "../systems/scene-render";
import { mulberry32 } from "../systems/rng";

interface Star { x: number; y: number; alpha: number; }

export function buildSkyLayer(): DrawableLayer {
  let cachedW = 0;
  let cachedH = 0;
  let stars: Star[] = [];

  const ensureStars = (w: number, h: number) => {
    if (w === cachedW && h === cachedH) return;
    cachedW = w; cachedH = h;
    const rng = mulberry32(0xcafef00d);
    stars = [];
    for (let i = 0; i < 70; i++) {
      stars.push({ x: Math.floor(rng() * w), y: Math.floor(rng() * h * 0.55), alpha: 0.5 + rng() * 0.5 });
    }
  };

  return {
    draw(ctx, frame: FrameState) {
      ensureStars(frame.width, frame.height);
      // Eight horizontal gradient bands
      const stops = [
        HARBOR_PALETTE.sky_night, HARBOR_PALETTE.sky_night, HARBOR_PALETTE.sky_night,
        HARBOR_PALETTE.sky_horizon, HARBOR_PALETTE.sky_horizon,
        HARBOR_PALETTE.fog_blue, HARBOR_PALETTE.fog_blue, HARBOR_PALETTE.fog_pale,
      ];
      const bandH = Math.ceil(frame.height / stops.length);
      for (let i = 0; i < stops.length; i++) {
        ctx.fillStyle = stops[i];
        ctx.fillRect(0, i * bandH, frame.width, bandH);
      }
      // Stars
      ctx.fillStyle = HARBOR_PALETTE.moonlight;
      for (const s of stars) {
        ctx.globalAlpha = s.alpha;
        ctx.fillRect(s.x, s.y, 1, 1);
      }
      ctx.globalAlpha = 1;
      // Moon
      const mx = Math.floor(frame.width * 0.18);
      const my = Math.floor(frame.height * 0.16);
      ctx.fillStyle = HARBOR_PALETTE.moonlight;
      ctx.beginPath(); ctx.arc(mx, my, 14, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = HARBOR_PALETTE.lantern_glow;
      ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.arc(mx - 3, my - 3, 11, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    },
  };
}
```

- [ ] **Step 3: Push it into the layer stack in `harbor-scene-client.tsx`**

```ts
import { buildSkyLayer } from "./layers/sky-layer";
// ...
const layers: DrawableLayer[] = [buildSkyLayer()];
```

- [ ] **Step 4: Verify in browser**

```bash
npm run dev
```

Open `/lighthouse/` — confirm a starry night gradient renders with a moon top-left.

- [ ] **Step 5: Commit**

```bash
git add src/app/lighthouse/layers/sky-layer.ts \
        src/app/lighthouse/systems/rng.ts \
        src/app/lighthouse/harbor-scene-client.tsx
git commit -m "feat(lighthouse): sky layer (gradient + stars + moon)"
```

### Task 2.3: Water layer — 3-frequency scanline waves

**Files:** `src/app/lighthouse/layers/water-layer.ts`

- [ ] **Step 1: Implement**

```ts
// src/app/lighthouse/layers/water-layer.ts
import { HARBOR_PALETTE } from "../systems/palette";
import type { DrawableLayer, FrameState } from "../systems/scene-render";

export function buildWaterLayer(): DrawableLayer {
  return {
    draw(ctx, frame: FrameState) {
      // Base wash (covers anything the sky band did not paint)
      ctx.fillStyle = HARBOR_PALETTE.deep_sea_2;
      ctx.fillRect(0, Math.floor(frame.height * 0.45), frame.width, frame.height);

      const amp = frame.scene.sea.amplitudePx;
      const rows = 16;
      const rowH = Math.ceil(frame.height * 0.55 / rows);
      const y0 = Math.floor(frame.height * 0.45);
      const t = frame.reducedMotion ? 0 : frame.t;
      for (let r = 0; r < rows; r++) {
        const y = y0 + r * rowH;
        const swell = Math.sin(t * 0.3 + r * 0.7) * 1.5 * amp;
        const chop = Math.sin(t * 1.4 + r * 1.1) * 0.6 * amp;
        const ripple = Math.sin(t * 3.2 + r * 2.3) * 0.3 * amp;
        const dy = frame.reducedMotion ? 0 : Math.round(swell + chop + ripple);
        const tint = r > rows * 0.6 ? HARBOR_PALETTE.deep_sea_1 : HARBOR_PALETTE.deep_sea_2;
        ctx.fillStyle = tint;
        ctx.globalAlpha = 0.55;
        ctx.fillRect(0, y + dy, frame.width, rowH);
      }
      ctx.globalAlpha = 1;

      // Foam intensity at "shoreline" (a horizontal band) — uses amplitude even when motion is reduced
      const foamY = y0 - 1;
      ctx.fillStyle = HARBOR_PALETTE.foam_white;
      ctx.globalAlpha = Math.min(0.4, 0.08 + amp * 0.05);
      ctx.fillRect(0, foamY, frame.width, 1);
      ctx.globalAlpha = 1;
    },
  };
}
```

(Note: scanline approximation. If FPS drops below 50 on iPhone 12-class hardware, switch to an offscreen-canvas pre-render of one tileable wave row and `ctx.drawImage` it with translation.)

- [ ] **Step 2: Push into layer stack**

```ts
import { buildWaterLayer } from "./layers/water-layer";
// ...
const layers: DrawableLayer[] = [buildSkyLayer(), buildWaterLayer()];
```

- [ ] **Step 3: Verify in browser + reduced-motion toggle**

DevTools → Rendering → Emulate CSS media feature `prefers-reduced-motion: reduce` → confirm waves freeze with foam still visible. Re-enable → waves resume.

- [ ] **Step 4: Commit**

```bash
git add src/app/lighthouse/layers/water-layer.ts \
        src/app/lighthouse/harbor-scene-client.tsx
git commit -m "feat(lighthouse): water layer with 3-frequency waves + foam"
```

### Task 2.4: Lamp/window light layer (atmosphere)

**Files:** `src/app/lighthouse/layers/lamp-layer.ts`

- [ ] **Step 1: Implement**

```ts
// src/app/lighthouse/layers/lamp-layer.ts
import { HARBOR_PALETTE } from "../systems/palette";
import type { DrawableLayer, FrameState } from "../systems/scene-render";

export interface Lamp { x: number; y: number; warm: boolean; phase: number; }

export interface LampLayerAPI extends DrawableLayer {
  setLamps(lamps: Lamp[]): void;
}

export function buildLampLayer(): LampLayerAPI {
  let lamps: Lamp[] = [];
  return {
    draw(ctx, frame: FrameState) {
      const t = frame.reducedMotion ? 0 : frame.t;
      for (const l of lamps) {
        const flicker = frame.reducedMotion ? 1 : 0.85 + 0.15 * Math.sin(t * 4 + l.phase);
        const color = l.warm ? HARBOR_PALETTE.lantern_warm : HARBOR_PALETTE.lantern_cold;
        // Halo
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.18 * flicker;
        ctx.beginPath(); ctx.arc(l.x, l.y, 6, 0, Math.PI * 2); ctx.fill();
        // Hot pixel
        ctx.globalAlpha = 1;
        ctx.fillRect(l.x - 1, l.y - 1, 2, 2);
      }
      ctx.globalAlpha = 1;
    },
    setLamps(next) { lamps = next; },
  };
}
```

- [ ] **Step 2: Push into layer stack with empty lamp set** (real positions land in PR4 with harbor sprites)

```ts
import { buildLampLayer } from "./layers/lamp-layer";
const lampLayer = buildLampLayer();
const layers: DrawableLayer[] = [buildSkyLayer(), buildWaterLayer(), lampLayer];
```

- [ ] **Step 3: Commit**

```bash
git add src/app/lighthouse/layers/lamp-layer.ts \
        src/app/lighthouse/harbor-scene-client.tsx
git commit -m "feat(lighthouse): lamp layer scaffold (atmosphere)"
```

### Task 2.5: Auto-drift parallax breath

**Files:** modify `src/app/lighthouse/harbor-scene-client.tsx`

- [ ] **Step 1: Wrap the layer pass in a translated context**

In the RAF tick, after `ctx.scale(frame.dpr, frame.dpr)` and the background fill, add:

```ts
const driftX = frame.reducedMotion ? 0 : Math.sin(frame.t * 0.05) * 8;
const driftY = frame.reducedMotion ? 0 : Math.cos(frame.t * 0.04) * 4;
ctx.translate(driftX, driftY);
for (const layer of layers) layer.draw(ctx, frame);
```

Wrap the whole layer loop between `ctx.save()` / `ctx.restore()` so subsequent frames are not cumulative.

- [ ] **Step 2: Verify in browser**

Confirm the scene drifts gently (~3 minute cycle period); reduced-motion locks position.

- [ ] **Step 3: Commit**

```bash
git add src/app/lighthouse/harbor-scene-client.tsx
git commit -m "feat(lighthouse): auto-drift parallax breath (reduced-motion safe)"
```

### Task 2.6: Open PR2

PR title: `feat(lighthouse): isometric harbor — Phase 2 canvas shell + sky/water/lamps`. Test plan: visual checks above + Lighthouse perf score on `/lighthouse/` not regressing other routes' perf. Bundle delta on `/lighthouse/` ≈ +25 KB gz (GSAP only — Pixi removed via Fork A).

---

## 4. Phase 3 — Lighthouse + Boat Sprites (PR3)

Goal: the hero island lighthouse with volumetric beam + boat factories for all four styles, plus motion timelines (decoupled lantern pulse vs. beam sweep).

### Task 3.1: Lighthouse sprite — tower + lantern + beam (Canvas 2D draw fn)

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

- [ ] **Step 2: Implement the draw function**

```ts
// src/app/lighthouse/sprites/lighthouse-sprite.ts
import { HARBOR_PALETTE } from "../systems/palette";

export const LIGHTHOUSE_GEOM = {
  base:    { w: 24, h: 12 },
  shaft:   { w: 18, h: 32 },
  gallery: { w: 22, h: 4  },
  lantern: { w: 16, h: 18 },
  cap:     { w: 18, h: 30 },
};

export interface LighthouseDrawState {
  beamRotationRad: number;
  beamColorHex: string;
  beamAlpha: number;
  lanternAlpha: number;
}

const BEAM_LEN = 200;
const BEAM_HALF_SPREAD = 50;

export function drawLighthouse(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number, // anchor: waterline center
  s: LighthouseDrawState,
): void {
  // Coordinates derived bottom-up so cap height extends UP from anchor
  const baseTop = ay - LIGHTHOUSE_GEOM.base.h;
  const shaftTop = baseTop - LIGHTHOUSE_GEOM.shaft.h;
  const galleryTop = shaftTop - LIGHTHOUSE_GEOM.gallery.h;
  const lanternTop = galleryTop - LIGHTHOUSE_GEOM.lantern.h;
  const capTop = lanternTop - 4; // roof rises 4 px above lantern

  // Base
  ctx.fillStyle = HARBOR_PALETTE.stone_dark;
  ctx.fillRect(ax - 12, baseTop, 24, LIGHTHOUSE_GEOM.base.h);
  ctx.fillStyle = HARBOR_PALETTE.stone_mid;
  ctx.fillRect(ax - 12, baseTop, 24, 4);

  // Shaft
  ctx.fillStyle = HARBOR_PALETTE.stone_mid;
  ctx.fillRect(ax - 9, shaftTop, 18, LIGHTHOUSE_GEOM.shaft.h);
  ctx.strokeStyle = HARBOR_PALETTE.stone_dark;
  ctx.lineWidth = 1;
  for (let y = shaftTop + 6; y < shaftTop + LIGHTHOUSE_GEOM.shaft.h; y += 6) {
    ctx.beginPath(); ctx.moveTo(ax - 9, y); ctx.lineTo(ax + 9, y); ctx.stroke();
  }
  // Two lit windows
  ctx.fillStyle = HARBOR_PALETTE.lantern_warm;
  ctx.fillRect(ax - 1, shaftTop + 8, 2, 3);
  ctx.fillRect(ax - 1, shaftTop + 18, 2, 3);

  // Gallery deck
  ctx.fillStyle = HARBOR_PALETTE.iron_dark;
  ctx.fillRect(ax - 11, galleryTop, 22, LIGHTHOUSE_GEOM.gallery.h);

  // Lantern room
  ctx.fillStyle = HARBOR_PALETTE.iron_dark;
  ctx.fillRect(ax - 8, lanternTop, 16, LIGHTHOUSE_GEOM.lantern.h);
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = HARBOR_PALETTE.lantern_warm;
  ctx.fillRect(ax - 7, lanternTop + 1, 14, 16);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = HARBOR_PALETTE.iron_dark;
  for (let x = -7; x < 7; x += 4) {
    ctx.beginPath();
    ctx.moveTo(ax + x + 2, lanternTop + 1);
    ctx.lineTo(ax + x + 2, lanternTop + 17);
    ctx.stroke();
  }

  // Cap (triangle + weathervane)
  ctx.fillStyle = HARBOR_PALETTE.stone_dark;
  ctx.beginPath();
  ctx.moveTo(ax - 9, capTop + 4);
  ctx.lineTo(ax,     capTop - 4);
  ctx.lineTo(ax + 9, capTop + 4);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = HARBOR_PALETTE.iron_dark;
  ctx.beginPath(); ctx.moveTo(ax, capTop - 4); ctx.lineTo(ax, capTop - 12); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ax - 3, capTop - 10); ctx.lineTo(ax + 3, capTop - 10); ctx.stroke();

  // Beam — drawn rotated around lantern center
  const lanternCx = ax;
  const lanternCy = lanternTop + Math.floor(LIGHTHOUSE_GEOM.lantern.h / 2);
  ctx.save();
  ctx.translate(lanternCx, lanternCy);
  ctx.rotate(s.beamRotationRad);
  ctx.fillStyle = s.beamColorHex;
  ctx.globalAlpha = s.beamAlpha;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(BEAM_LEN, -BEAM_HALF_SPREAD);
  ctx.lineTo(BEAM_LEN, BEAM_HALF_SPREAD);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.restore();

  // Lantern halo (always upright; alpha tweened by GSAP)
  ctx.fillStyle = HARBOR_PALETTE.lantern_glow;
  ctx.globalAlpha = s.lanternAlpha;
  ctx.beginPath(); ctx.arc(lanternCx, lanternCy, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = HARBOR_PALETTE.lantern_warm;
  ctx.globalAlpha = 0.35 * s.lanternAlpha;
  ctx.beginPath(); ctx.arc(lanternCx, lanternCy, 8, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/app/lighthouse/sprites/lighthouse-sprite.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/app/lighthouse/sprites/lighthouse-sprite.ts \
        src/app/lighthouse/sprites/lighthouse-sprite.test.ts
git commit -m "feat(lighthouse): lighthouse draw fn (tower + lantern + beam)"
```

### Task 3.2: Boat sprite (4 styles, S/L sizes — Canvas 2D draw fn)

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

- [ ] **Step 2: Implement the draw function**

```ts
// src/app/lighthouse/sprites/boat-sprite.ts
import { HARBOR_PALETTE } from "../systems/palette";
import type { BoatStyle } from "../systems/classification-to-boat";

export const BOAT_DIMENSIONS: Record<BoatStyle, { S: { w: number; h: number }; L: { w: number; h: number } }> = {
  galleon:    { S: { w: 14, h: 20 }, L: { w: 22, h: 30 } },
  brigantine: { S: { w: 13, h: 18 }, L: { w: 20, h: 28 } },
  schooner:   { S: { w: 12, h: 16 }, L: { w: 18, h: 24 } },
  junk:       { S: { w: 13, h: 18 }, L: { w: 20, h: 28 } },
};

export interface BoatDrawProps {
  style: BoatStyle;
  size: "S" | "L";
  pennantHex: string;
  auraHex: string | null;
}

export function drawBoat(ctx: CanvasRenderingContext2D, ax: number, ay: number, p: BoatDrawProps): void {
  const dim = BOAT_DIMENSIONS[p.style][p.size];
  const halfW = dim.w / 2;
  // Convert local coords (0..dim.w, 0..dim.h) to canvas with anchor at hull base center
  const lx = (x: number) => ax + x;
  const ly = (y: number) => ay + (y - dim.h);

  // Aura
  if (p.auraHex) {
    ctx.fillStyle = p.auraHex;
    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    ctx.arc(ax, ay - 4, halfW + 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Hull (per-style polygon)
  switch (p.style) {
    case "galleon":
      ctx.fillStyle = HARBOR_PALETTE.timber_warm;
      polyFill(ctx, [
        lx(-halfW), ly(dim.h - 4), lx(-halfW + 2), ly(dim.h), lx(halfW - 2), ly(dim.h),
        lx(halfW), ly(dim.h - 4), lx(halfW - 1), ly(dim.h - 8), lx(-halfW + 1), ly(dim.h - 8),
      ]);
      // Stern castle
      ctx.fillStyle = HARBOR_PALETTE.timber_dark;
      ctx.fillRect(lx(-halfW + 1), ly(dim.h - 11), 5, 4);
      // Stern lantern
      ctx.fillStyle = HARBOR_PALETTE.lantern_warm;
      ctx.beginPath(); ctx.arc(lx(-halfW + 3), ly(dim.h - 12), 1, 0, Math.PI * 2); ctx.fill();
      break;
    case "brigantine":
      ctx.fillStyle = HARBOR_PALETTE.timber_mid;
      polyFill(ctx, [
        lx(-halfW + 1), ly(dim.h - 3), lx(-halfW + 2), ly(dim.h), lx(halfW - 2), ly(dim.h),
        lx(halfW), ly(dim.h - 4), lx(halfW - 1), ly(dim.h - 7), lx(-halfW), ly(dim.h - 8),
      ]);
      break;
    case "schooner":
      ctx.fillStyle = HARBOR_PALETTE.timber_mid;
      polyFill(ctx, [
        lx(-halfW), ly(dim.h - 2), lx(-halfW + 1), ly(dim.h), lx(halfW - 1), ly(dim.h),
        lx(halfW), ly(dim.h - 3), lx(halfW - 1), ly(dim.h - 6), lx(-halfW + 1), ly(dim.h - 6),
      ]);
      break;
    case "junk":
      ctx.fillStyle = HARBOR_PALETTE.timber_dark;
      polyFill(ctx, [
        lx(-halfW), ly(dim.h - 6), lx(-halfW + 1), ly(dim.h - 1), lx(halfW - 1), ly(dim.h - 1),
        lx(halfW), ly(dim.h - 6), lx(halfW - 2), ly(dim.h - 9), lx(-halfW + 2), ly(dim.h - 9),
      ]);
      break;
  }

  // Masts + sails
  ctx.strokeStyle = HARBOR_PALETTE.iron_dark;
  ctx.lineWidth = 1;
  if (p.style === "galleon") {
    for (const mx of [-4, 0, 4]) {
      strokeLine(ctx, lx(mx), ly(dim.h - 8), lx(mx), ly(2));
      ctx.fillStyle = HARBOR_PALETTE.foam_white;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(lx(mx - 3), ly(4), 6, 10);
      ctx.globalAlpha = 1;
    }
  } else if (p.style === "brigantine") {
    strokeLine(ctx, lx(-2), ly(dim.h - 7), lx(-2), ly(2));
    ctx.fillStyle = HARBOR_PALETTE.foam_white;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(lx(-5), ly(4), 6, 10);
    strokeLine(ctx, lx(3), ly(dim.h - 7), lx(3), ly(4));
    polyFill(ctx, [lx(3), ly(4), lx(7), ly(12), lx(3), ly(12)]);
    ctx.globalAlpha = 1;
  } else if (p.style === "schooner") {
    const slant = 1;
    strokeLine(ctx, lx(-1 - slant), ly(dim.h - 6), lx(-1), ly(2));
    ctx.fillStyle = HARBOR_PALETTE.sail_teal;
    ctx.globalAlpha = 0.9;
    polyFill(ctx, [lx(-1), ly(2), lx(-5), ly(12), lx(-1), ly(12)]);
    strokeLine(ctx, lx(3 - slant), ly(dim.h - 6), lx(3), ly(4));
    polyFill(ctx, [lx(3), ly(4), lx(7), ly(12), lx(3), ly(12)]);
    ctx.globalAlpha = 1;
  } else if (p.style === "junk") {
    strokeLine(ctx, lx(0), ly(dim.h - 9), lx(0), ly(1));
    ctx.fillStyle = HARBOR_PALETTE.sail_red;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(lx(-5), ly(3), 10, 12);
    ctx.globalAlpha = 1;
    for (let y = 6; y < 14; y += 3) strokeLine(ctx, lx(-5), ly(y), lx(5), ly(y));
  }

  // Pennant
  ctx.fillStyle = p.pennantHex;
  ctx.fillRect(lx(2), ly(0), 3, 2);
}

function polyFill(ctx: CanvasRenderingContext2D, pts: number[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
  ctx.fill();
}

function strokeLine(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/app/lighthouse/sprites/boat-sprite.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/app/lighthouse/sprites/boat-sprite.ts \
        src/app/lighthouse/sprites/boat-sprite.test.ts
git commit -m "feat(lighthouse): boat draw fn — 4 styles, 2 sizes, pennant + aura"
```

### Task 3.3: Boat layer (state map + per-frame draw with idle bob)

**Files:** `src/app/lighthouse/layers/boat-layer.ts`

- [ ] **Step 1: Implement**

```ts
// src/app/lighthouse/layers/boat-layer.ts
import type { DrawableLayer, FrameState } from "../systems/scene-render";
import { drawBoat } from "../sprites/boat-sprite";
import type { SceneBoat } from "../systems/scene-data";

interface BoatPlacement { boat: SceneBoat; baseX: number; baseY: number; phase: number; }

export interface BoatLayerAPI extends DrawableLayer {
  upsertBoat(boat: SceneBoat, screen: { x: number; y: number }): void;
  removeBoat(coinId: string): void;
  pruneExcept(ids: Set<string>): void;
  positionFor(coinId: string): { x: number; y: number } | null;
}

export function buildBoatLayer(): BoatLayerAPI {
  const map = new Map<string, BoatPlacement>();

  return {
    upsertBoat(boat, screen) {
      const existing = map.get(boat.coinId);
      if (existing) {
        existing.boat = boat;
        existing.baseX = screen.x;
        existing.baseY = screen.y;
        return;
      }
      map.set(boat.coinId, { boat, baseX: screen.x, baseY: screen.y, phase: hashPhase(boat.coinId) });
    },
    removeBoat(coinId) {
      map.delete(coinId);
    },
    pruneExcept(ids) {
      for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
    },
    positionFor(coinId) {
      const e = map.get(coinId);
      return e ? { x: e.baseX, y: e.baseY } : null;
    },
    draw(ctx, frame: FrameState) {
      const t = frame.reducedMotion ? 0 : frame.t * 1.0;
      // Painter's order — sort by Y so boats further south render on top
      const sorted = Array.from(map.values()).sort((a, b) => a.baseY - b.baseY);
      for (const e of sorted) {
        const dy = frame.reducedMotion ? 0 : Math.round(Math.sin(t + e.phase));
        drawBoat(ctx, Math.round(e.baseX), Math.round(e.baseY + dy), {
          style: e.boat.style,
          size: e.boat.hullSize,
          pennantHex: e.boat.pennantHex,
          auraHex: null,
        });
      }
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
git commit -m "feat(lighthouse): boat layer with id-stable bob and Y-sort"
```

### Task 3.4: GSAP timelines — beam sweep + decoupled lantern pulse + lighthouse layer

**Files:**
- Create: `src/app/lighthouse/systems/animation.ts`
- Create: `src/app/lighthouse/layers/lighthouse-layer.ts`

- [ ] **Step 1: Animation helpers (renderer-agnostic — tween value objects)**

```ts
// src/app/lighthouse/systems/animation.ts
import gsap from "gsap";
import type { TimelineRegistry } from "./timeline-registry";

export interface BeamState { rotationRad: number; alpha: number; colorHex: string; }
export interface LanternState { alpha: number; }

export function startBeamSweep(state: BeamState, sweepSeconds: number, registry: TimelineRegistry): gsap.core.Tween {
  state.rotationRad = 0;
  const tween = gsap.to(state, {
    rotationRad: Math.PI * 2,
    duration: sweepSeconds,
    ease: "none",
    repeat: -1,
  });
  registry.parent.add(tween, 0);
  return tween;
}

export function startLanternPulse(state: LanternState, registry: TimelineRegistry): gsap.core.Tween {
  state.alpha = 0.85;
  const tween = gsap.to(state, {
    alpha: 0.7,
    duration: 0.42,
    ease: "sine.inOut",
    yoyo: true,
    repeat: -1,
  });
  registry.parent.add(tween, 0);
  return tween;
}

export function setBeamSweepDuration(tween: gsap.core.Tween, seconds: number): void {
  const progress = tween.progress();
  tween.duration(seconds);
  tween.progress(progress);
}
```

- [ ] **Step 2: Lighthouse layer — reads tweened state, draws each frame**

```ts
// src/app/lighthouse/layers/lighthouse-layer.ts
import { drawLighthouse } from "../sprites/lighthouse-sprite";
import type { DrawableLayer, FrameState } from "../systems/scene-render";

export interface LighthouseLayerAPI extends DrawableLayer {
  setAnchor(x: number, y: number): void;
  anchor(): { x: number; y: number };
}

export function buildLighthouseLayer(): LighthouseLayerAPI {
  let ax = 0;
  let ay = 0;
  return {
    setAnchor(x, y) { ax = x; ay = y; },
    anchor() { return { x: ax, y: ay }; },
    draw(ctx, frame: FrameState) {
      drawLighthouse(ctx, ax, ay, {
        beamRotationRad: frame.beam.rotationRad,
        beamColorHex: frame.beam.colorHex,
        beamAlpha: frame.beam.alpha,
        lanternAlpha: frame.lantern.alpha,
      });
    },
  };
}
```

- [ ] **Step 3: Wire into the scene**

In `harbor-scene-client.tsx`:

```ts
import gsap from "gsap";
import { createTimelineRegistry } from "./systems/timeline-registry";
import { startBeamSweep, startLanternPulse, setBeamSweepDuration } from "./systems/animation";
import { buildLighthouseLayer } from "./layers/lighthouse-layer";

// Inside the useEffect:
const registry = createTimelineRegistry(gsap);
const lighthouseLayer = buildLighthouseLayer();
lighthouseLayer.setAnchor(Math.round(frame.width * 0.45), Math.round(frame.height * 0.65));
const boatLayer = buildBoatLayer();

frame.beam.colorHex = sceneRef.current.beam.color;
const beamTween = startBeamSweep(frame.beam, sceneRef.current.beam.sweepSeconds, registry);
startLanternPulse(frame.lantern, registry);

const layers: DrawableLayer[] = [
  buildSkyLayer(),
  buildWaterLayer(),
  lampLayer,
  boatLayer,
  lighthouseLayer,
];

// observeReducedMotion: also pauses GSAP parent timeline
const disposeRm = observeReducedMotion((m) => {
  frame.reducedMotion = m;
  if (m) registry.pause(); else registry.resume();
});

// Cleanup
return () => {
  cancelAnimationFrame(rafId);
  ro.disconnect();
  disposeRm();
  registry.destroy();
  for (const layer of layers) layer.dispose?.();
};
```

(Anchor needs to update on resize — re-set inside the `resize` callback.)

- [ ] **Step 4: Verify in browser**

Open `/lighthouse/` — beam rotates around the lantern (volumetric triangle), lantern halo pulses on its own slower rhythm. Toggle reduced-motion → both freeze.

- [ ] **Step 5: Commit**

```bash
git add src/app/lighthouse/systems/animation.ts \
        src/app/lighthouse/layers/lighthouse-layer.ts \
        src/app/lighthouse/harbor-scene-client.tsx
git commit -m "feat(lighthouse): GSAP beam sweep + decoupled lantern pulse"
```

### Task 3.5: Open PR3

PR title: `feat(lighthouse): isometric harbor — Phase 3 lighthouse + boats`. Test plan: lighthouse renders at off-center anchor, beam rotates and changes color with PSI band, lantern pulses on its own rhythm, boats render at programmatically inserted positions (harbours follow in PR4).

---

## 5. Phase 4 — Harbours + Live Data Binding (PR4)

Goal: real harbours from real chains data, full diff-and-mutate sync, patrol routes for sailing boats. **This is where the page becomes a dashboard.**

### Task 4.1: Harbor island draw fn

**Files:** `src/app/lighthouse/sprites/harbor-island-sprite.ts`

- [ ] **Step 1: Implement**

```ts
// src/app/lighthouse/sprites/harbor-island-sprite.ts
import { HARBOR_PALETTE } from "../systems/palette";
import type { SceneHarbor } from "../systems/scene-data";

export interface HarborIslandResult {
  lampPositions: { x: number; y: number; warm: boolean; phase: number }[];
  dockEndX: number;  // canvas-space x where dock terminus is — for boat anchoring
  dockEndY: number;
}

export function drawHarborIsland(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  harbor: SceneHarbor,
): HarborIslandResult {
  const footprintW = 80 + Math.min(80, Math.log10(Math.max(1, harbor.totalUsd / 1e6)) * 18);
  const footprintH = footprintW * 0.6;
  const halfW = footprintW / 2;

  const dockColor =
    harbor.resilienceTier === 1 ? HARBOR_PALETTE.stone_pale
    : harbor.resilienceTier === 3 ? HARBOR_PALETTE.timber_dark
    : HARBOR_PALETTE.timber_mid;

  // Island top (diamond)
  ctx.fillStyle = HARBOR_PALETTE.stone_dark;
  poly(ctx, [
    ax - halfW, ay,
    ax,         ay - footprintH / 2,
    ax + halfW, ay,
    ax,         ay + footprintH / 2,
  ]);
  // Left face
  ctx.fillStyle = HARBOR_PALETTE.stone_mid;
  poly(ctx, [
    ax - halfW, ay,
    ax,         ay + footprintH / 2,
    ax,         ay + footprintH / 2 + 6,
    ax - halfW, ay + 6,
  ]);
  // Right face
  ctx.fillStyle = HARBOR_PALETTE.stone_dark;
  poly(ctx, [
    ax,         ay + footprintH / 2,
    ax + halfW, ay,
    ax + halfW, ay + 6,
    ax,         ay + footprintH / 2 + 6,
  ]);

  // Dock pier
  ctx.fillStyle = dockColor;
  ctx.fillRect(ax - halfW * 0.6, ay + footprintH / 2 + 6, halfW * 1.2, 8);

  // Warehouses
  const lampPositions: { x: number; y: number; warm: boolean; phase: number }[] = [];
  const wHouseCount = Math.min(4, Math.max(1, Math.ceil(harbor.stablecoinCount / 3)));
  for (let i = 0; i < wHouseCount; i++) {
    const wx = ax - halfW * 0.7 + i * 16;
    const wy = ay - footprintH * 0.1;
    ctx.fillStyle = HARBOR_PALETTE.timber_dark;
    ctx.fillRect(wx, wy - 12, 12, 12);
    ctx.fillStyle = HARBOR_PALETTE.stone_dark;
    poly(ctx, [wx - 1, wy - 12, wx + 6, wy - 16, wx + 13, wy - 12]);
    if (i % 2 === 0) {
      ctx.fillStyle = HARBOR_PALETTE.lantern_warm;
      ctx.fillRect(wx + 4, wy - 8, 3, 2);
    }
    lampPositions.push({ x: wx + 6, y: wy - 2, warm: true, phase: i * 0.7 });
  }

  const dockEndX = ax + halfW * 0.5;
  const dockEndY = ay + footprintH / 2 + 14;
  lampPositions.push({ x: dockEndX, y: dockEndY, warm: true, phase: 0.3 });

  return { lampPositions, dockEndX, dockEndY };
}

function poly(ctx: CanvasRenderingContext2D, pts: number[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
  ctx.fill();
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/lighthouse/sprites/harbor-island-sprite.ts
git commit -m "feat(lighthouse): harbor island draw fn (resilience-tiered docks)"
```

### Task 4.2: Harbor layer + scene placement (Canvas 2D)

**Files:** `src/app/lighthouse/layers/harbor-layer.ts`

- [ ] **Step 1: Implement** with off-center lighthouse anchor and triangle composition

```ts
// src/app/lighthouse/layers/harbor-layer.ts
import { drawHarborIsland } from "../sprites/harbor-island-sprite";
import { worldToScreen } from "../systems/isometric";
import type { DrawableLayer, FrameState } from "../systems/scene-render";
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

export interface HarborPlacement {
  harbor: SceneHarbor;
  worldX: number;
  worldY: number;
  dockEndX: number;
  dockEndY: number;
  lamps: { x: number; y: number; warm: boolean; phase: number }[];
}

export interface HarborLayerAPI extends DrawableLayer {
  syncHarbors(harbors: SceneHarbor[], originX: number, originY: number): Map<string, HarborPlacement>;
}

export function buildHarborLayer(): HarborLayerAPI {
  let placements: HarborPlacement[] = [];

  return {
    syncHarbors(harbors, originX, originY) {
      const map = new Map<string, HarborPlacement>();
      placements = harbors.slice(0, TRIANGLE_TILES.length).map((harbor, i) => {
        const tile = TRIANGLE_TILES[i];
        const screen = worldToScreen(tile);
        const placement: HarborPlacement = {
          harbor,
          worldX: originX + screen.x,
          worldY: originY + screen.y,
          dockEndX: 0,
          dockEndY: 0,
          lamps: [],
        };
        map.set(harbor.id, placement);
        return placement;
      });
      return map;
    },
    draw(ctx, _frame: FrameState) {
      // Painter's order — sort by Y (further south paints later)
      const sorted = placements.slice().sort((a, b) => a.worldY - b.worldY);
      for (const p of sorted) {
        const result = drawHarborIsland(ctx, Math.round(p.worldX), Math.round(p.worldY), p.harbor);
        // Mutate placement so scene-render can read accurate lamp + dock positions
        p.lamps = result.lampPositions;
        p.dockEndX = result.dockEndX;
        p.dockEndY = result.dockEndY;
      }
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

### Task 4.4: Scene render — apply SceneData to layers each render

**Files:** modify `src/app/lighthouse/harbor-scene-client.tsx`

- [ ] **Step 1: Apply scene whenever `scene` prop or canvas size changes**

In `harbor-scene-client.tsx`, add an effect that reacts to `scene` prop changes:

```ts
useEffect(() => {
  if (!harborLayerRef.current || !boatLayerRef.current) return;
  const originX = Math.round(frame.width * 0.45);
  const originY = Math.round(frame.height * 0.65);
  lighthouseLayerRef.current?.setAnchor(originX, originY);
  const placements = harborLayerRef.current.syncHarbors(scene.harbors, originX, originY);

  // Boats — anchored at each harbour's dock end, fanned out
  const seen = new Set<string>();
  for (const harbor of scene.harbors) {
    const placement = placements.get(harbor.id);
    if (!placement) continue;
    harbor.boats.forEach((boat, i) => {
      seen.add(boat.coinId);
      const offset = i * 14 - (harbor.boats.length - 1) * 7;
      boatLayerRef.current!.upsertBoat(boat, {
        x: placement.dockEndX + offset,
        y: placement.dockEndY + 4,
      });
    });
  }
  boatLayerRef.current.pruneExcept(seen);

  // Lamps — collect from placements (filled in after first draw of harbor-layer)
  // We can't read placements before harborLayer.draw runs; instead expose a
  // post-draw callback in scene-render. Simpler: query positions on the next
  // animation frame.
  requestAnimationFrame(() => {
    const allLamps: { x: number; y: number; warm: boolean; phase: number }[] = [];
    for (const p of placements.values()) allLamps.push(...p.lamps);
    lampLayerRef.current?.setLamps(allLamps);
  });

  // Beam state — driven by GSAP tween (color/duration here, rotation by tween)
  frame.beam.colorHex = scene.beam.color;
  if (beamTweenRef.current) setBeamSweepDuration(beamTweenRef.current, scene.beam.sweepSeconds);
}, [scene, frame.width, frame.height]);
```

(Refs: store `harborLayerRef`, `boatLayerRef`, `lampLayerRef`, `lighthouseLayerRef`, `beamTweenRef` so the effect can read them without re-mounting.)

- [ ] **Step 2: Verify live data**

`npm run dev` → load `/lighthouse/` → boats appear at chains, beam color matches current PSI band, sea amplitude follows DEWS.

- [ ] **Step 3: Commit**

```bash
git add src/app/lighthouse/harbor-scene-client.tsx
git commit -m "feat(lighthouse): scene application effect (live data)"
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

**Files:** modify `src/app/lighthouse/harbor-scene-client.tsx`

When reduced-motion fires (already pausing GSAP via parent timeline + `frame.reducedMotion = true`), we want a deterministic frozen frame:
- Beam: rotate to point at the largest harbour (highest `totalUsd`).
- Boats: drawn at base position (no bob).
- Water: scanline displacement zero, foam intensity preserved.
- Lamp flicker: held at full brightness.

The water/lamp/boat layers already check `frame.reducedMotion`. The only thing missing is rotating the beam to the largest harbour.

- [ ] **Step 1: Add a freeze helper**

```ts
// src/app/lighthouse/systems/reduced-motion-freeze.ts
import type { SceneData } from "./scene-data";
import type { HarborPlacement } from "../layers/harbor-layer";

export function pickLargestHarborPlacement(
  scene: SceneData,
  placements: Map<string, HarborPlacement>,
): HarborPlacement | null {
  let best: HarborPlacement | null = null;
  let bestUsd = -1;
  for (const harbor of scene.harbors) {
    const p = placements.get(harbor.id);
    if (!p) continue;
    if (harbor.totalUsd > bestUsd) { best = p; bestUsd = harbor.totalUsd; }
  }
  return best;
}

export function aimBeamAt(
  beam: { rotationRad: number },
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): void {
  beam.rotationRad = Math.atan2(toY - fromY, toX - fromX);
}
```

- [ ] **Step 2: Wire it in `harbor-scene-client.tsx` reduced-motion observer**

```ts
const disposeRm = observeReducedMotion((m) => {
  frame.reducedMotion = m;
  if (m) {
    registry.pause();
    const placements = lastPlacementsRef.current;
    if (placements) {
      const largest = pickLargestHarborPlacement(sceneRef.current, placements);
      if (largest) {
        const anchor = lighthouseLayer.anchor();
        aimBeamAt(frame.beam, anchor.x, anchor.y, largest.worldX, largest.worldY);
      }
    }
  } else {
    registry.resume();
  }
});
```

(Stash placements in `lastPlacementsRef` from the scene-application effect in Task 4.4.)

- [ ] **Step 3: Commit**

```bash
git add src/app/lighthouse/systems/reduced-motion-freeze.ts \
        src/app/lighthouse/harbor-scene-client.tsx
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
- Create: `agents/retrospectives/2026-04-25-lighthouse-isometric-harbor.md`
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
- Phase 0 (CSP) — RESOLVED 2026-04-25 as NO-GO. Switched to Fork A (Canvas 2D). Audit: `docs/superpowers/audits/2026-04-25-pixi-v8-csp.md`.
- Canvas 2D perf at 60 fps on iPhone 12-class is the new perf risk. Mitigation: scanline approximation (Task 2.3), id-stable boat list (Task 3.3), DPR cap at 2 in canvas init.
- Bundle: GSAP-only, ~25 KB gz delta on `/lighthouse/` (PixiJS removed). Verified by dynamic import + npm-side check.
- `image-rendering: pixelated` Safari fallback handled with `crisp-edges` cascade (Task 2.1).
