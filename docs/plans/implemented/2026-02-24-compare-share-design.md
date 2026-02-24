# Compare Share Feature — Design Document

**Date**: 2026-02-24
**Goal**: Add social sharing to the compare page with a branded, visually compelling image generated client-side.

---

## Overview

Users can share their stablecoin comparisons via Twitter/X, the Web Share API (mobile), or by downloading a branded PNG. The image is generated client-side using the Canvas API — no server-side rendering or external dependencies.

## Share Button Group

Replaces the standalone "Copy link" button. Three actions:

1. **Twitter/X** — Opens `twitter.com/intent/tweet` with pre-filled text (`Comparing USDT vs USDC vs DAI on @PharosWatch`) and the compare URL. Relies on OG meta for Twitter card visual.
2. **Share** — Web Share API with the generated image attached as a file. Falls back to clipboard copy on unsupported browsers.
3. **Download image** — Saves the branded PNG locally so users can attach it to any platform manually.

## Branded Image Spec

**Dimensions**: 1200x630px (Twitter/OG card standard)

**Layout**:
```
┌─────────────────────────────────────────────────┐
│  [lighthouse]  Pharos           pharos.watch     │
│                                                  │
│    ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│    │  [logo]  │  │  [logo]  │  │  [logo]  │     │
│    │   USDT   │  │   USDC   │  │   DAI    │     │
│    │  Tether  │  │ USD Coin │  │   Dai    │     │
│    ├──────────┤  ├──────────┤  ├──────────┤     │
│    │ $1.0001  │  │ $0.9999  │  │ $1.0003  │     │
│    │ $144.2B  │  │ $52.1B   │  │ $5.3B    │     │
│    │ Peg 9.8  │  │ Peg 9.6  │  │ Peg 9.2  │     │
│    │ +0.12%   │  │ -0.05%   │  │ +0.32%   │     │
│    └──────────┘  └──────────┘  └──────────┘     │
│                                                  │
│                  pharos.watch/compare            │
└─────────────────────────────────────────────────┘
```

**Stats per coin card** (4 rows):
- Price (USD formatted)
- Market Cap (abbreviated: $144.2B)
- Peg Score (X.X/10)
- 7d Change (green +X.XX% / red -X.XX%)

**Color palette** (matches site dark theme):
- Background: `#0d1628`
- Card background: `#1a2744`
- Header/label text: `#E8DCC4` (Pharos cream)
- Value text: `#ffffff`
- 7d change: green `#4ade80` / red `#f87171`

**Typography**: System sans-serif (canvas fillText). Bold for symbols, normal for labels/values.

**Logos**: Pharos icon (`/pharos-icon.png`) top-left. Coin logos from the logos API, preloaded as `Image` objects.

## Technical Approach

**Canvas API** — Pure `CanvasRenderingContext2D` drawing. No external dependencies.

### New file: `src/lib/compare-share-image.ts`

Pure function: takes comparison coin data + preloaded images, returns a `canvas` element. Caller converts to blob for sharing/download.

```typescript
interface ShareCoinData {
  id: string;
  symbol: string;
  name: string;
  price: string;
  marketCap: string;
  pegScore: string;
  weeklyChange: string;
  weeklyChangePositive: boolean;
  logoImg: HTMLImageElement | null;
}

export function renderCompareShareImage(
  coins: ShareCoinData[],
  pharosLogo: HTMLImageElement,
): HTMLCanvasElement;
```

### Modifications: `src/app/compare/client.tsx`

- Replace "Copy link" button with a share button group
- Add image generation logic (preload logos, call `renderCompareShareImage`)
- Add Twitter intent, Web Share API, and download handlers

## Constraints

- Static export site — all rendering client-side
- Canvas cannot load cross-origin images without CORS — coin logos served from same origin (`/api/logos`)
- Twitter intent links cannot attach images — URL + text only, OG card handles visual
- Web Share API file sharing requires HTTPS and secure context
- Up to 5 coins — layout must adapt from 2 to 5 columns
