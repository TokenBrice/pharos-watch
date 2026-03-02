/**
 * Screenshot each page on pharos.watch at 1200×630 for OG images.
 * Usage: node scripts/screenshot-og.mjs
 */
import { chromium } from '/usr/lib/node_modules/playwright/index.mjs';
import { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '../public');
const BASE = 'https://pharos.watch';

const PAGES = [
  { path: '/',                file: 'og-card.png'           },
  { path: '/cemetery',        file: 'og-cemetery.png'       },
  { path: '/compare',         file: 'og-compare.png'        },
  { path: '/depeg',           file: 'og-depeg.png'          },
  { path: '/flows',           file: 'og-flows.png'          },
  { path: '/liquidity',       file: 'og-liquidity.png'      },
  { path: '/safety-scores',   file: 'og-safety-scores.png'  },
  { path: '/yield',           file: 'og-yield.png'          },
  { path: '/blacklist',       file: 'og-blacklist.png'      },
  { path: '/stability-index', file: 'og-stability-index.png'},
  { path: '/dependency-map',  file: 'og-dependency-map.png' },
  { path: '/digest',          file: 'og-digest.png',         scrollY: 200 },
  // Portfolio pre-loaded with typical holdings so it shows data, not empty state
  { path: '/portfolio?p=USDT:10000,USDC:5000,DAI:2000,USDE:1000', file: 'og-portfolio.png' },
  { path: '/methodology',     file: 'og-methodology.png'    },
];

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1200, height: 630 },
  colorScheme: 'dark',
  // Prevent cookie banners / consent overlays from appearing
  locale: 'en-US',
});

// Suppress non-critical console noise
context.on('console', () => {});

for (const { path: pagePath, file, scrollY } of PAGES) {
  const url = BASE + pagePath;
  const outFile = path.join(OUT, file);

  process.stdout.write(`  ${pagePath.padEnd(55)} → ${file} ... `);

  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    // Extra settle time for React hydration + data fetch
    await page.waitForTimeout(3000);
    // Scroll if needed to show the best content
    if (scrollY) await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    // Hide the feedback button and any overlays
    await page.evaluate(() => {
      document.querySelectorAll('[data-radix-popper-content-wrapper], [role="dialog"]')
        .forEach(el => el.remove());
      // Hide feedback button (find by aria-label or button text)
      document.querySelectorAll('button').forEach(btn => {
        if (btn.textContent?.includes('Feedback')) btn.style.display = 'none';
      });
    });
    await page.screenshot({ path: outFile, clip: { x: 0, y: scrollY ?? 0, width: 1200, height: 630 } });
    console.log('done');
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
  } finally {
    await page.close();
  }
}

await browser.close();
console.log('\nAll screenshots saved to public/');
