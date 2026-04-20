/**
 * Screenshot public page content at 1200×628 for OG images.
 * Usage: node scripts/screenshot-og.mjs
 *
 * Set OG_BASE_URL to capture another environment:
 *   OG_BASE_URL=http://127.0.0.1:4173 node scripts/screenshot-og.mjs
 */
import { chromium } from '/usr/lib/node_modules/playwright/index.mjs';
import { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '../public');
const BASE = process.env.OG_BASE_URL?.replace(/\/+$/, '') || 'https://pharos.watch';
const OG_WIDTH = 1200;
const OG_HEIGHT = 628;

const PAGES = [
  { path: '/',                file: 'og-card.png'           },
  { path: '/about',           file: 'og-about.png'          },
  { path: '/cemetery',        file: 'og-cemetery.png'       },
  { path: '/chains',          file: 'og-chains.png'         },
  { path: '/compare',         file: 'og-compare.png'        },
  { path: '/coverage',        file: 'og-coverage.png'       },
  { path: '/depeg',           file: 'og-depeg.png'          },
  { path: '/flows',           file: 'og-flows.png'          },
  { path: '/liquidity',       file: 'og-liquidity.png'      },
  { path: '/safety-scores',   file: 'og-safety-scores.png'  },
  { path: '/yield',           file: 'og-yield.png'          },
  { path: '/blacklist',       file: 'og-blacklist.png'      },
  { path: '/stability-index', file: 'og-stability-index.png'},
  { path: '/dependency-map',  file: 'og-dependency-map.png' },
  { path: '/digest',          file: 'og-digest.png'          },
  // Portfolio pre-loaded with typical holdings so it shows data, not empty state
  { path: '/portfolio?p=usdt-tether:10000,usdc-circle:5000,dai-makerdao:2000,usde-ethena:1000', file: 'og-portfolio.png' },
  { path: '/methodology',     file: 'og-methodology.png'    },
  { path: '/start',           file: 'og-start.png'          },
  { path: '/telegram',        file: 'og-telegram.png'       },
];

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: OG_WIDTH, height: OG_HEIGHT },
  colorScheme: 'dark',
  // Prevent cookie banners / consent overlays from appearing
  locale: 'en-US',
});

// Suppress non-critical console noise
context.on('console', () => {});

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

for (const { path: pagePath, file } of PAGES) {
  const url = BASE + pagePath;
  const outFile = path.join(OUT, file);

  process.stdout.write(`  ${pagePath.padEnd(55)} → ${file} ... `);

  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    // Extra settle time for React hydration + data fetch
    await page.waitForTimeout(3000);
    await page.addStyleTag({ content: SOCIAL_CAPTURE_CSS });
    // Hide the feedback button and any overlays
    await page.evaluate(() => {
      document.querySelectorAll('[data-radix-popper-content-wrapper], [role="dialog"]')
        .forEach(el => el.remove());
      // Hide feedback button (find by aria-label or button text)
      document.querySelectorAll('button').forEach(btn => {
        if (btn.textContent?.includes('Feedback')) btn.style.display = 'none';
      });
    });
    await page.screenshot({ path: outFile, clip: { x: 0, y: 0, width: OG_WIDTH, height: OG_HEIGHT } });
    console.log('done');
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
  } finally {
    await page.close();
  }
}

await browser.close();
console.log('\nAll screenshots saved to public/');
