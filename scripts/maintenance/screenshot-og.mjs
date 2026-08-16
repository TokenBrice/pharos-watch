/**
 * Screenshot public page content at 1200×628 for OG images.
 * Usage: node scripts/maintenance/screenshot-og.mjs [path1 path2 ...]
 *
 * Set OG_BASE_URL to capture another environment:
 *   OG_BASE_URL=http://127.0.0.1:4173 node scripts/maintenance/screenshot-og.mjs
 *
 * Optional CLI args filter to specific page paths:
 *   node scripts/maintenance/screenshot-og.mjs /upcoming /funding
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { getOgCaptureValidationError } from "../lib/og-capture-validation.mts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "../../public");
const BASE = process.env.OG_BASE_URL?.replace(/\/+$/, "") || "https://pharos.watch";
const OG_WIDTH = 1200;
const OG_HEIGHT = 628;

const ALL_PAGES = [
  { path: "/", file: "og-card.png" },
  { path: "/about", file: "og-about.png" },
  { path: "/alt-pegs", file: "og-alt-pegs.png" },
  { path: "/cemetery", file: "og-cemetery.png" },
  { path: "/chains", file: "og-chains.png" },
  { path: "/changelog", file: "og-changelog.png" },
  { path: "/compare", file: "og-compare.png" },
  { path: "/coverage", file: "og-coverage.png" },
  { path: "/depeg", file: "og-depeg.png" },
  { path: "/flows", file: "og-flows.png" },
  { path: "/funding", file: "og-funding.png" },
  { path: "/liquidity", file: "og-liquidity.png" },
  { path: "/learn/mechanisms", file: "og-learn-mechanisms.png" },
  { path: "/safety-scores", file: "og-safety-scores.png" },
  { path: "/stablecoins", file: "og-stablecoins.png" },
  { path: "/timeline", file: "og-timeline.png" },
  { path: "/upcoming", file: "og-upcoming.png" },
  { path: "/yield", file: "og-yield.png" },
  { path: "/freezewatch", file: "og-blacklist.png" },
  { path: "/stability-index", file: "og-stability-index.png" },
  { path: "/dependency-map", file: "og-dependency-map.png" },
  { path: "/digest", file: "og-digest.png" },
  // Portfolio pre-loaded with typical holdings so it shows data, not empty state
  {
    path: "/portfolio?p=usdt-tether:10000,usdc-circle:5000,dai-makerdao:2000,usde-ethena:1000",
    file: "og-portfolio.png",
  },
  { path: "/methodology", file: "og-methodology.png" },
  { path: "/start", file: "og-start.png" },
  { path: "/pharoswatchbot/", file: "og-pharoswatchbot.png" },
  { path: "/screener", file: "og-default.png" },
];

const requestedPaths = process.argv.slice(2);
const PAGES = requestedPaths.length ? ALL_PAGES.filter((p) => requestedPaths.includes(p.path)) : ALL_PAGES;

if (requestedPaths.length && PAGES.length === 0) {
  console.error(`No matching pages for: ${requestedPaths.join(", ")}`);
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: OG_WIDTH, height: OG_HEIGHT },
  colorScheme: "dark",
  // Prevent cookie banners / consent overlays from appearing
  locale: "en-US",
});

// Suppress non-critical console noise
context.on("console", () => {});

const SOCIAL_CAPTURE_CSS = `
  html,
  body {
    width: ${OG_WIDTH}px !important;
    min-width: ${OG_WIDTH}px !important;
    min-height: ${OG_HEIGHT}px !important;
    overflow: hidden !important;
    background: var(--background, #05070a) !important;
  }

  header,
  aside,
  footer,
  nextjs-portal,
  [data-radix-popper-content-wrapper],
  [role="dialog"] {
    display: none !important;
  }

  body > div {
    min-height: ${OG_HEIGHT}px !important;
  }

  #main-content {
    box-sizing: border-box !important;
    position: fixed !important;
    inset: 0 auto auto 0 !important;
    z-index: 2147483647 !important;
    width: ${OG_WIDTH}px !important;
    max-width: none !important;
    height: ${OG_HEIGHT}px !important;
    min-height: ${OG_HEIGHT}px !important;
    margin: 0 !important;
    padding: 10px !important;
    overflow: hidden !important;
  }

  #main-content > * {
    max-width: none !important;
  }

  .pharos-mobile-utility-safe {
    padding-bottom: 0 !important;
  }
`;

const failures = [];

for (const { path: pagePath, file } of PAGES) {
  const url = BASE + pagePath;
  const outFile = path.join(OUT, file);

  process.stdout.write(`  ${pagePath.padEnd(55)} → ${file} ... `);

  const page = await context.newPage();
  try {
    let response;
    try {
      response = await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
    } catch {
      // Pages with periodic polling (e.g. /digest) may never reach networkidle.
      // Fall back to `load` and let the post-goto settle handle hydration.
      response = await page.goto(url, { waitUntil: "load", timeout: 20_000 });
    }
    // Extra settle time for React hydration + data fetch
    await page.waitForTimeout(3000);
    const bodyText = await page.locator("body").innerText();
    const validationError = getOgCaptureValidationError({
      status: response?.status(),
      hasMainContent: (await page.locator("#main-content").count()) > 0,
      bodyText,
    });
    if (validationError) {
      throw new Error(`${validationError} at ${page.url()}`);
    }
    await page.addStyleTag({ content: SOCIAL_CAPTURE_CSS });
    // Hide the feedback button and any overlays
    await page.evaluate(() => {
      document.querySelectorAll('[data-radix-popper-content-wrapper], [role="dialog"]').forEach((el) => el.remove());
      // Hide feedback button (find by aria-label or button text)
      document.querySelectorAll("button").forEach((btn) => {
        if (btn.textContent?.includes("Feedback")) btn.style.display = "none";
      });
    });
    await page.screenshot({ path: outFile, clip: { x: 0, y: 0, width: OG_WIDTH, height: OG_HEIGHT } });
    console.log("done");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push({ pagePath, message });
    console.log(`FAILED: ${message}`);
  } finally {
    await page.close();
  }

  if (failures.length > 0) break;
}

await browser.close();
if (failures.length > 0) {
  console.error(`\nOG capture stopped after ${failures[0].pagePath} failed: ${failures[0].message}`);
  process.exitCode = 1;
} else {
  console.log("\nAll screenshots saved to public/");
}
