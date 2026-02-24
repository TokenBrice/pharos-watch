# Compare Share Feature — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add social sharing buttons (Twitter/X, Web Share API, download) to the compare page, generating a branded PNG image of the comparison table using the Canvas API.

**Architecture:** All changes are frontend-only. A new pure module (`src/lib/compare-share-image.ts`) handles canvas rendering. The compare client (`src/app/compare/client.tsx`) wires up the share button group, logo preloading, and share/download handlers. No new dependencies.

**Tech Stack:** React 19, Next.js 16, TypeScript strict, Canvas 2D API, Web Share API

**Design doc:** `docs/plans/2026-02-24-compare-share-design.md`

---

### Task 1: Create the canvas image renderer

**Files:**
- Create: `src/lib/compare-share-image.ts`

**Step 1: Create the share image module**

Create `src/lib/compare-share-image.ts` with the full canvas rendering logic. This is a pure function — no React, no DOM dependencies beyond `HTMLCanvasElement` and `HTMLImageElement`.

```typescript
/** Data for one coin in the share image. All values are pre-formatted strings. */
export interface ShareCoinData {
  symbol: string;
  name: string;
  price: string;
  marketCap: string;
  pegScore: string;
  weeklyChange: string;
  weeklyChangePositive: boolean;
  logoImg: HTMLImageElement | null;
}

// --- Layout constants ---
const W = 1200;
const H = 630;
const BG = "#0d1628";
const CARD_BG = "#1a2744";
const CREAM = "#E8DCC4";
const WHITE = "#ffffff";
const GREEN = "#4ade80";
const RED = "#f87171";
const MUTED = "#94a3b8";
const CARD_RADIUS = 16;
const CARD_PAD = 16;

/** Round-rect helper for Canvas 2D. */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** Draw a single coin card at (x, y) with the given width. */
function drawCoinCard(
  ctx: CanvasRenderingContext2D,
  coin: ShareCoinData,
  x: number,
  y: number,
  cardW: number,
) {
  const cardH = 320;
  const cx = x + cardW / 2; // center x of card

  // Card background
  roundRect(ctx, x, y, cardW, cardH, CARD_RADIUS);
  ctx.fillStyle = CARD_BG;
  ctx.fill();

  // Subtle border
  roundRect(ctx, x, y, cardW, cardH, CARD_RADIUS);
  ctx.strokeStyle = "rgba(232, 220, 196, 0.12)";
  ctx.lineWidth = 1;
  ctx.stroke();

  let curY = y + CARD_PAD;

  // Coin logo (centered, 48x48)
  const logoSize = 48;
  if (coin.logoImg) {
    // Draw circular clip for logo
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, curY + logoSize / 2, logoSize / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(coin.logoImg, cx - logoSize / 2, curY, logoSize, logoSize);
    ctx.restore();
  } else {
    // Placeholder circle
    ctx.beginPath();
    ctx.arc(cx, curY + logoSize / 2, logoSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(232, 220, 196, 0.15)";
    ctx.fill();
  }
  curY += logoSize + 12;

  // Symbol (bold, large)
  ctx.fillStyle = WHITE;
  ctx.font = "bold 22px -apple-system, 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(coin.symbol, cx, curY);
  curY += 22;

  // Name (smaller, muted)
  ctx.fillStyle = MUTED;
  ctx.font = "14px -apple-system, 'Segoe UI', sans-serif";
  ctx.fillText(coin.name, cx, curY, cardW - CARD_PAD * 2);
  curY += 28;

  // Divider line
  ctx.strokeStyle = "rgba(232, 220, 196, 0.1)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + CARD_PAD, curY);
  ctx.lineTo(x + cardW - CARD_PAD, curY);
  ctx.stroke();
  curY += 16;

  // Stats rows: label (left-aligned) + value (right-aligned)
  const stats: [string, string, string][] = [
    ["Price", coin.price, WHITE],
    ["Market Cap", coin.marketCap, WHITE],
    ["Peg Score", coin.pegScore, CREAM],
    ["7d Change", coin.weeklyChange, coin.weeklyChangePositive ? GREEN : RED],
  ];

  const labelX = x + CARD_PAD;
  const valueX = x + cardW - CARD_PAD;

  for (const [label, value, color] of stats) {
    // Label
    ctx.fillStyle = MUTED;
    ctx.font = "13px -apple-system, 'Segoe UI', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(label, labelX, curY);

    // Value
    ctx.fillStyle = color;
    ctx.font = "bold 14px 'SF Mono', 'Cascadia Code', 'Consolas', monospace";
    ctx.textAlign = "right";
    ctx.fillText(value, valueX, curY);

    curY += 28;
  }
}

/**
 * Render the branded compare share image to a canvas.
 * Returns the canvas element — caller converts to blob for sharing/download.
 */
export function renderCompareShareImage(
  coins: ShareCoinData[],
  pharosLogo: HTMLImageElement,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  // --- Background ---
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // Subtle gradient overlay at top
  const grad = ctx.createLinearGradient(0, 0, 0, 200);
  grad.addColorStop(0, "rgba(232, 220, 196, 0.04)");
  grad.addColorStop(1, "rgba(232, 220, 196, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 200);

  // --- Header: Pharos logo + text (left) and URL (right) ---
  const logoH = 36;
  const logoW = (pharosLogo.naturalWidth / pharosLogo.naturalHeight) * logoH;
  ctx.drawImage(pharosLogo, 40, 28, logoW, logoH);

  ctx.fillStyle = CREAM;
  ctx.font = "bold 22px -apple-system, 'Segoe UI', sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("Pharos", 40 + logoW + 12, 52);

  ctx.fillStyle = MUTED;
  ctx.font = "15px -apple-system, 'Segoe UI', sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("pharos.watch", W - 40, 52);

  // --- Coin cards ---
  const n = coins.length;
  const totalPad = 80; // 40px each side
  const gap = 20;
  const availableW = W - totalPad - gap * (n - 1);
  const cardW = Math.min(availableW / n, 200);
  const totalCardsW = cardW * n + gap * (n - 1);
  const startX = (W - totalCardsW) / 2;
  const cardsY = 90;

  for (let i = 0; i < n; i++) {
    drawCoinCard(ctx, coins[i], startX + i * (cardW + gap), cardsY, cardW);
  }

  // --- Footer branding ---
  ctx.fillStyle = MUTED;
  ctx.font = "13px -apple-system, 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("pharos.watch/compare", W / 2, H - 24);

  return canvas;
}

/** Convert canvas to a PNG Blob. */
export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Canvas toBlob failed"))),
      "image/png",
    );
  });
}

/** Preload an image from a URL. Returns null on failure. */
export function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Clean build, no type errors.

**Step 3: Commit**

```bash
git add src/lib/compare-share-image.ts
git commit -m "feat(compare): add canvas-based share image renderer"
```

---

### Task 2: Wire up share buttons in the compare client

**Files:**
- Modify: `src/app/compare/client.tsx`

This task replaces the existing "Copy link" button with a share button group containing three actions: Twitter/X, Share (Web Share API), and Download image.

**Step 1: Add share image generation and handlers**

In `src/app/compare/client.tsx`, add imports and the share logic. The key changes:

1. Import the new share image module
2. Add a `generateShareImage` function that preloads logos and renders the canvas
3. Add `handleTwitterShare`, `handleWebShare`, and `handleDownload` handlers
4. Replace the "Copy link" button group with the new share button group

```typescript
// Add these imports at the top:
import { Share2, Twitter, Download } from "lucide-react";
import {
  renderCompareShareImage,
  canvasToBlob,
  loadImage,
} from "@/lib/compare-share-image";
import type { ShareCoinData } from "@/lib/compare-share-image";
```

Remove the existing `Link2`, `Check` imports (they're replaced by the new buttons). Remove the `copied` state and `handleCopyLink` callback.

Add a helper to build `ShareCoinData[]` from the existing `comparisonCoins` + `rowData`:

```typescript
const buildShareData = useCallback(async (): Promise<{
  coins: ShareCoinData[];
  pharosLogo: HTMLImageElement;
} | null> => {
  if (comparisonCoins.length < 2) return null;

  // Preload Pharos logo
  const pharosLogo = await loadImage("/pharos-icon.png");
  if (!pharosLogo) return null;

  // Preload coin logos in parallel
  const logoImgs = await Promise.all(
    comparisonCoins.map((c) => {
      const src = logos?.[c.id];
      return src ? loadImage(src) : Promise.resolve(null);
    }),
  );

  // Build formatted stats — reuse the same computation as ComparisonTable
  const shareCoins: ShareCoinData[] = comparisonCoins.map((coin, i) => {
    const cap = getCirculatingRaw(coin.data);
    const prev = getPrevWeekRaw(coin.data);
    const weeklyPct = prev > 0 ? ((cap - prev) / prev) * 100 : null;
    const pegRef = getPegReference(coin.data.pegType, pegRates, coin.meta.commodityOunces);

    return {
      symbol: coin.symbol,
      name: coin.name,
      price: formatNativePrice(coin.data.price, coin.meta.flags.pegCurrency, pegRef),
      marketCap: formatCurrency(cap),
      pegScore: coin.pegScore != null ? `${coin.pegScore.toFixed(1)}/10` : "N/A",
      weeklyChange:
        weeklyPct != null
          ? `${weeklyPct >= 0 ? "+" : ""}${weeklyPct.toFixed(2)}%`
          : "N/A",
      weeklyChangePositive: weeklyPct != null ? weeklyPct >= 0 : true,
      logoImg: logoImgs[i],
    };
  });

  return { coins: shareCoins, pharosLogo };
}, [comparisonCoins, logos, pegRates]);
```

Add these imports from existing modules (already available in the file's dependency graph):

```typescript
import { getCirculatingRaw, getPrevWeekRaw } from "@/lib/supply";
import { formatNativePrice } from "@/lib/format";
import { getPegReference } from "@/lib/peg-rates";
```

Note: `formatCurrency` is already imported.

Add the three share handlers:

```typescript
const [shareLoading, setShareLoading] = useState(false);

const handleTwitterShare = useCallback(() => {
  const symbols = comparisonCoins.map((c) => c.symbol).join(" vs ");
  const text = `Comparing ${symbols} on Pharos`;
  const url = window.location.href;
  window.open(
    `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
    "_blank",
    "noopener,noreferrer",
  );
}, [comparisonCoins]);

const handleWebShare = useCallback(async () => {
  setShareLoading(true);
  try {
    const data = await buildShareData();
    if (!data) return;
    const canvas = renderCompareShareImage(data.coins, data.pharosLogo);
    const blob = await canvasToBlob(canvas);
    const file = new File([blob], "pharos-compare.png", { type: "image/png" });
    const symbols = comparisonCoins.map((c) => c.symbol).join(" vs ");

    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({
        title: `${symbols} — Pharos Compare`,
        text: `Comparing ${symbols} on Pharos`,
        url: window.location.href,
        files: [file],
      });
    } else {
      // Fallback: copy URL to clipboard
      await navigator.clipboard.writeText(window.location.href);
    }
  } catch (e) {
    if (e instanceof Error && e.name !== "AbortError") {
      // User cancelled share — not an error
      console.warn("Share failed:", e);
    }
  } finally {
    setShareLoading(false);
  }
}, [buildShareData, comparisonCoins]);

const handleDownload = useCallback(async () => {
  setShareLoading(true);
  try {
    const data = await buildShareData();
    if (!data) return;
    const canvas = renderCompareShareImage(data.coins, data.pharosLogo);
    const blob = await canvasToBlob(canvas);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pharos-compare.png";
    a.click();
    URL.revokeObjectURL(url);
  } finally {
    setShareLoading(false);
  }
}, [buildShareData]);
```

**Step 2: Replace the button group JSX**

Replace the existing "Copy link" button area (the `{selectedIds.length >= 2 && ( <div className="flex justify-end">...` block) with:

```tsx
{selectedIds.length >= 2 && (
  <div className="flex justify-end gap-2">
    <button
      onClick={handleTwitterShare}
      className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      title="Share on Twitter/X"
    >
      <Twitter className="h-3.5 w-3.5" />
      Tweet
    </button>
    <button
      onClick={handleWebShare}
      disabled={shareLoading}
      className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
      title="Share comparison"
    >
      <Share2 className="h-3.5 w-3.5" />
      Share
    </button>
    <button
      onClick={handleDownload}
      disabled={shareLoading}
      className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
      title="Download comparison image"
    >
      <Download className="h-3.5 w-3.5" />
      Image
    </button>
  </div>
)}
```

**Step 3: Clean up removed imports**

Remove `Link2` and `Check` from the lucide-react import line. Remove the `copied` state and `handleCopyLink` callback (they're replaced by the new handlers).

**Step 4: Verify build**

Run: `npm run build`
Expected: Clean build, no type errors.

**Step 5: Commit**

```bash
git add src/app/compare/client.tsx
git commit -m "feat(compare): add share button group with Twitter, Web Share, and download"
```

---

### Task 3: Visual testing and polish

**Files:**
- Possibly modify: `src/lib/compare-share-image.ts` (minor tweaks)
- Possibly modify: `src/app/compare/client.tsx` (minor tweaks)

**Step 1: Test the generated image**

Run: `npm run dev`

1. Navigate to `/compare`, select 2 coins (e.g. USDT and USDC)
2. Click "Image" (download button)
3. Open the downloaded `pharos-compare.png`
4. Verify:
   - Dark navy background renders correctly
   - Pharos lighthouse logo appears top-left
   - Coin logos appear in their cards (circular clip)
   - Symbol, name, and 4 stat rows are readable
   - Card layout is centered and evenly spaced
   - Footer "pharos.watch/compare" appears at bottom

**Step 2: Test with different coin counts**

1. Test with 2 coins — cards should be wider, nicely spaced
2. Test with 3 coins — standard layout
3. Test with 5 coins — cards narrower but still readable

Adjust `cardW` max or font sizes in `compare-share-image.ts` if needed.

**Step 3: Test share buttons**

1. Click "Tweet" — verify Twitter intent opens with correct text and URL
2. Click "Share" — on mobile, verify native share sheet appears with image attached. On desktop, verify URL is copied to clipboard as fallback.
3. Click "Image" — verify PNG downloads

**Step 4: Commit any fixes**

```bash
git add src/lib/compare-share-image.ts src/app/compare/client.tsx
git commit -m "fix(compare): polish share image layout and button behavior"
```

---

### Task 4: Final verification and push

**Step 1: Full build**

Run: `npm run build`
Expected: Clean build with no warnings or errors.

**Step 2: Push**

```bash
git push
```
