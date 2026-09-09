import { test, expect, type Page, type Route } from "@playwright/test";

// The nautical-chart scene is authored in fixed dark oklch colors (the viewport
// background and the sky/water gradients), and its SVG annotations inherit
// `currentColor` from a fixed `text-slate-100` class. The deleted unit test
// pinned those class strings; the observable contract is that the annotation
// labels stay readable on that dark scene in BOTH color schemes. We measure the
// composited label contrast against the scene in each scheme.
const CHAINS = {
  chains: [
    {
      id: "ethereum", name: "Ethereum", logoPath: "/logos/chains/ethereum.svg", type: "evm",
      totalUsd: 100_000_000_000, change24h: 0, change24hPct: 0, change7d: 0, change7dPct: 0,
      change30d: 0, change30dPct: 0, stablecoinCount: 3,
      dominantStablecoin: { id: "usdc-circle", symbol: "USDC", share: 0.6 },
      topStablecoins: [
        { id: "usdc-circle", symbol: "USDC", share: 0.6, supplyUsd: 60_000_000_000 },
        { id: "usdt-tether", symbol: "USDT", share: 0.25, supplyUsd: 25_000_000_000 },
        { id: "dai-makerdao", symbol: "DAI", share: 0.15, supplyUsd: 15_000_000_000 },
      ],
      dominanceShare: 0.5, healthScore: 82, healthBand: "robust",
      healthFactors: { concentration: 80, quality: 85, pegStability: 90, backingDiversity: 70, chainEnvironment: 80 },
    },
    {
      id: "base", name: "Base", logoPath: "/logos/chains/base.svg", type: "evm",
      totalUsd: 60_000_000_000, change24h: 0, change24hPct: 0, change7d: 0, change7dPct: 0,
      change30d: 0, change30dPct: 0, stablecoinCount: 3,
      dominantStablecoin: { id: "usdc-circle", symbol: "USDC", share: 0.7 },
      topStablecoins: [
        { id: "usdc-circle", symbol: "USDC", share: 0.7, supplyUsd: 42_000_000_000 },
        { id: "usdt-tether", symbol: "USDT", share: 0.2, supplyUsd: 12_000_000_000 },
        { id: "eurc-circle", symbol: "EURC", share: 0.1, supplyUsd: 6_000_000_000 },
      ],
      dominanceShare: 0.3, healthScore: 70, healthBand: "healthy",
      healthFactors: { concentration: 70, quality: 75, pegStability: 80, backingDiversity: 60, chainEnvironment: 70 },
    },
    {
      id: "solana", name: "Solana", logoPath: "/logos/chains/solana.svg", type: "other",
      totalUsd: 40_000_000_000, change24h: 0, change24hPct: 0, change7d: 0, change7dPct: 0,
      change30d: 0, change30dPct: 0, stablecoinCount: 3,
      dominantStablecoin: { id: "usdc-circle", symbol: "USDC", share: 0.8 },
      topStablecoins: [
        { id: "usdc-circle", symbol: "USDC", share: 0.8, supplyUsd: 32_000_000_000 },
        { id: "usdt-tether", symbol: "USDT", share: 0.15, supplyUsd: 6_000_000_000 },
        { id: "pyth-pyth", symbol: "PYUSD", share: 0.05, supplyUsd: 2_000_000_000 },
      ],
      dominanceShare: 0.2, healthScore: 55, healthBand: "mixed",
      healthFactors: { concentration: 85, quality: 50, pegStability: 60, backingDiversity: 40, chainEnvironment: 55 },
    },
  ],
  globalTotalUsd: 200_000_000_000,
  chainAttributedTotalUsd: 200_000_000_000,
  unattributedTotalUsd: 0,
  globalChange24hPct: 0,
  globalChange7dPct: 0,
  globalChange30dPct: 0,
  updatedAt: Math.floor(Date.now() / 1000),
  healthMethodologyVersion: "1.5.0",
};

async function installChains(page: Page): Promise<void> {
  const handler = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "X-Data-Age": "0", "Cache-Control": "no-store" },
      body: JSON.stringify(CHAINS),
    });
  await page.route("**/api/chains**", handler);
  await page.route("**/_site-data/chains**", handler);
}

test.describe.configure({ timeout: 90_000 });

for (const colorScheme of ["light", "dark"] as const) {
  test(`nautical chart annotations stay readable on the dark scene (${colorScheme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.emulateMedia({ colorScheme });
    await installChains(page);
    await page.goto("/chains");
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator("svg.nc-chart-svg"), "chart never rendered").toBeVisible({ timeout: 45_000 });
    // Ship-name annotations render as direct <text> children; the decorative
    // "DOMINANCE DRAFT" watermark and the horizon-fleet count sit inside their
    // own groups, so direct children isolate the readable labels.
    await expect(page.locator("svg.nc-chart-svg > text").first()).toBeVisible({ timeout: 45_000 });

    const result = await page.evaluate(() => {
      const viewport = document.querySelector(".nc-chart-viewport")!;
      const labels = Array.from(document.querySelectorAll("svg.nc-chart-svg > text"));

      const resolve = (color: string): [number, number, number, number] => {
        const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3] / 255];
      };
      const luminance = ([r, g, b]: [number, number, number]): number => {
        const lin = (c: number) => {
          const s = c / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };

      const bg = resolve(getComputedStyle(viewport).backgroundColor);
      const bgRgb: [number, number, number] = [bg[0], bg[1], bg[2]];
      const sceneLuminance = luminance(bgRgb);

      let minRatio = Infinity;
      let minLabelLuminance = Infinity;
      for (const label of labels) {
        const cs = getComputedStyle(label);
        // SVG `fill="currentColor"` resolves through `color`; Chromium reports
        // `fill` as the unresolved `currentcolor` keyword, so use `color`.
        const fg = resolve(cs.color);
        const alpha = parseFloat(cs.opacity);
        const composite: [number, number, number] = [
          fg[0] * alpha + bgRgb[0] * (1 - alpha),
          fg[1] * alpha + bgRgb[1] * (1 - alpha),
          fg[2] * alpha + bgRgb[2] * (1 - alpha),
        ];
        const labelLuminance = luminance(composite);
        minLabelLuminance = Math.min(minLabelLuminance, labelLuminance);
        const l2 = luminance(bgRgb);
        const [hi, lo] = labelLuminance >= l2 ? [labelLuminance, l2] : [l2, labelLuminance];
        minRatio = Math.min(minRatio, (hi + 0.05) / (lo + 0.05));
      }

      return { sceneLuminance, minLabelLuminance, minRatio, labelCount: labels.length };
    });

    expect(result.labelCount, "expected annotation labels").toBeGreaterThan(0);
    // The scene must stay dark in both schemes (the readability regression is a
    // theme-aware scene that goes light and swallows the fixed light labels).
    expect(result.sceneLuminance, "scene background should stay dark").toBeLessThan(0.3);
    expect(result.minRatio, "annotation contrast (WCAG AA small text)").toBeGreaterThanOrEqual(4.5);
  });
}
