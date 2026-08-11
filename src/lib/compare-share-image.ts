/** Radar section data for one coin. */
interface ShareRadarCoinData {
  symbol: string;
  overallGrade: string;
  color: string;
  scores: number[]; // one per dimension, same order as dimensionLabels
}

/** Data for the radar section appended below the stat cards. */
export interface ShareRadarData {
  dimensionLabels: string[];
  coins: ShareRadarCoinData[];
}

/** Data for one coin in the share image. All values are pre-formatted strings. */
export interface ShareCoinData {
  symbol: string;
  name: string;
  price: string;
  marketCap: string;
  pegScore: string;
  weeklyChange: string;
  liquidityScore: string;
  governance: string;
  backing: string;
  pegCurrency: string;
  safetyRating: string | null;
  logoImg: HTMLImageElement | null;
}

// --- Layout constants ---
const W = 1200;
const BG = "#0d1628";
const CARD_BG = "#1a2744";
const CREAM = "#E8DCC4";
const WHITE = "#ffffff";
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

// Card header height: padding (16) + logo (48) + gap (24) + symbol (22) + name (28) + divider (16)
const CARD_HEADER_H = 154;
const ROW_H = 24;
const CARD_BOTTOM_PAD = 12;
const CARDS_Y = 90;
const FOOTER_H = 50;

/** Compute the number of stat rows for a coin (8 base + 1 if has rating). */
function statRowCount(coin: ShareCoinData): number {
  return coin.safetyRating ? 9 : 8;
}

/** Draw a single coin card at (x, y) with the given width and height. */
function drawCoinCard(
  ctx: CanvasRenderingContext2D,
  coin: ShareCoinData,
  x: number,
  y: number,
  cardW: number,
  cardH: number,
) {
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
  curY += logoSize + 24;

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

  // Stats rows: [label, value, color]
  const stats: [string, string, string][] = [
    ["Price", coin.price, WHITE],
    ["Market Cap", coin.marketCap, WHITE],
    ["Peg Score", coin.pegScore, CREAM],
    ["7d Change", coin.weeklyChange, WHITE],
    ["Liquidity", coin.liquidityScore, CREAM],
    ["Governance", coin.governance, WHITE],
    ["Backing", coin.backing, WHITE],
    ["Peg", coin.pegCurrency, WHITE],
  ];
  if (coin.safetyRating) {
    stats.push(["Safety", coin.safetyRating, CREAM]);
  }

  const labelX = x + CARD_PAD;
  const valueX = x + cardW - CARD_PAD;

  for (const [label, value, color] of stats) {
    // Label
    ctx.fillStyle = MUTED;
    ctx.font = "12px -apple-system, 'Segoe UI', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(label, labelX, curY);

    // Value
    ctx.fillStyle = color;
    ctx.font = "bold 12px 'SF Mono', 'Cascadia Code', 'Consolas', monospace";
    ctx.textAlign = "right";
    ctx.fillText(value, valueX, curY);

    curY += ROW_H;
  }
}

// --- Radar constants ---
const RADAR_R = 85;
const RADAR_LABEL_OFFSET = 22;
// Total section height: 24 top-gap + 16 title + 32 post-divider + radar circle + bottom label offset + 16 gap + 24 legend + 16 bottom
const RADAR_SECTION_H = 24 + 16 + 32 + 2 * (RADAR_R + RADAR_LABEL_OFFSET) + 16 + 24 + 16;

/** Draw the radar section and return the Y coordinate of its bottom edge. */
function drawRadarSection(
  ctx: CanvasRenderingContext2D,
  radarData: ShareRadarData,
  sectionY: number,
): void {
  const N = radarData.dimensionLabels.length;
  if (N === 0) return;
  const cx = W / 2;
  const angleStep = (2 * Math.PI) / N;
  const startAngle = -Math.PI / 2;

  // Section title
  let curY = sectionY + 24;
  ctx.fillStyle = MUTED;
  ctx.font = "13px -apple-system, 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Safety Score Comparison", cx, curY);
  curY += 16;

  // Subtle divider
  ctx.strokeStyle = "rgba(232, 220, 196, 0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, curY);
  ctx.lineTo(W - 40, curY);
  ctx.stroke();
  curY += 32;

  const radarCY = curY + RADAR_R + RADAR_LABEL_OFFSET;

  // Grid rings (20 / 40 / 60 / 80 / 100 %)
  for (let ring = 1; ring <= 5; ring++) {
    const r = (ring / 5) * RADAR_R;
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const angle = startAngle + i * angleStep;
      const px = cx + r * Math.cos(angle);
      const py = radarCY + r * Math.sin(angle);
      if (i === 0) { ctx.moveTo(px, py); } else { ctx.lineTo(px, py); }
    }
    ctx.closePath();
    ctx.strokeStyle = ring === 5 ? "rgba(148, 163, 184, 0.25)" : "rgba(148, 163, 184, 0.1)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Spokes
  for (let i = 0; i < N; i++) {
    const angle = startAngle + i * angleStep;
    ctx.beginPath();
    ctx.moveTo(cx, radarCY);
    ctx.lineTo(cx + RADAR_R * Math.cos(angle), radarCY + RADAR_R * Math.sin(angle));
    ctx.strokeStyle = "rgba(148, 163, 184, 0.15)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Axis labels
  ctx.fillStyle = MUTED;
  ctx.font = "11px -apple-system, 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  for (let i = 0; i < N; i++) {
    const angle = startAngle + i * angleStep;
    const lr = RADAR_R + RADAR_LABEL_OFFSET;
    const lx = cx + lr * Math.cos(angle);
    const ly = radarCY + lr * Math.sin(angle) + 4;
    ctx.fillText(radarData.dimensionLabels[i], lx, ly);
  }

  // Coin polygons
  for (const coin of radarData.coins) {
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const angle = startAngle + i * angleStep;
      const r = ((coin.scores[i] ?? 0) / 100) * RADAR_R;
      const px = cx + r * Math.cos(angle);
      const py = radarCY + r * Math.sin(angle);
      if (i === 0) { ctx.moveTo(px, py); } else { ctx.lineTo(px, py); }
    }
    ctx.closePath();
    ctx.fillStyle = coin.color + "33"; // ~20 % opacity
    ctx.fill();
    ctx.strokeStyle = coin.color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Legend
  const legendY = radarCY + RADAR_R + RADAR_LABEL_OFFSET + 16;
  const LEGEND_ITEM_W = 110;
  const totalLegendW = radarData.coins.length * LEGEND_ITEM_W;
  let legendX = (W - totalLegendW) / 2 + 8;

  for (const coin of radarData.coins) {
    ctx.beginPath();
    ctx.arc(legendX, legendY - 4, 5, 0, Math.PI * 2);
    ctx.fillStyle = coin.color;
    ctx.fill();

    ctx.fillStyle = WHITE;
    ctx.font = "bold 12px -apple-system, 'Segoe UI', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`${coin.symbol}: ${coin.overallGrade}`, legendX + 10, legendY);
    legendX += LEGEND_ITEM_W;
  }
}

/**
 * Render the branded compare share image to a canvas.
 * Returns the canvas element — caller converts to blob for sharing/download.
 */
export function renderCompareShareImage(
  coins: ShareCoinData[],
  pharosLogo: HTMLImageElement,
  radarData?: ShareRadarData,
): HTMLCanvasElement | null {
  // Compute card and canvas height from content
  const maxRows = coins.reduce((m, c) => Math.max(m, statRowCount(c)), -Infinity);
  const cardH = CARD_HEADER_H + maxRows * ROW_H + CARD_BOTTOM_PAD;
  const H = CARDS_Y + cardH + (radarData ? RADAR_SECTION_H : 0) + FOOTER_H;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

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

  for (let i = 0; i < n; i++) {
    drawCoinCard(ctx, coins[i], startX + i * (cardW + gap), CARDS_Y, cardW, cardH);
  }

  // --- Radar section (optional) ---
  if (radarData) {
    drawRadarSection(ctx, radarData, CARDS_Y + cardH);
  }

  // --- Footer branding ---
  ctx.fillStyle = MUTED;
  ctx.font = "13px -apple-system, 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("pharos.watch/compare", W / 2, H - 20);

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
