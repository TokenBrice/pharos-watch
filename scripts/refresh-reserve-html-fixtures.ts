#!/usr/bin/env tsx
/**
 * Refreshes the canonical HTML fixtures used by adapter tests in
 * worker/src/cron/reserve-adapters/__tests__/fixtures/. Each fixture is
 * fetched from its upstream source, prepended with a `<!-- captured-at: ISO -->`
 * header so reviewers can see provenance, and written back to disk.
 *
 * Usage:
 *   npm run refresh:html-fixtures
 *
 * Network failures for a given source leave the existing fixture untouched
 * and print a warning; the script exits 0 as long as at least one fetch
 * succeeds, so partial refreshes are possible. Run locally only.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface HtmlFixtureSpec {
  readonly name: string;
  readonly url: string;
  readonly fixture: string;
  readonly headers?: Record<string, string>;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = join(
  ROOT,
  "worker/src/cron/reserve-adapters/__tests__/fixtures",
);

// Canonical upstream URLs per HTML source. Keep in sync with
// shared/data/stablecoins/*.json and the adapter modules.
const FIXTURES: readonly HtmlFixtureSpec[] = [
  {
    name: "Circle transparency (USDC/EURC)",
    url: "https://www.circle.com/transparency",
    fixture: "circle-usdc.html",
  },
  {
    name: "Circle transparency (EURC alias)",
    url: "https://www.circle.com/transparency",
    fixture: "circle-eurc.html",
  },
  {
    name: "First Digital FDUSD transparency",
    url: "https://www.firstdigitallabs.com/transparency",
    fixture: "fdusd-transparency.html",
  },
  {
    name: "Mento reserve dashboard",
    url: "https://reserve.mento.org/",
    fixture: "mento-reserve-composition.html",
  },
  {
    name: "Reserve (RE) metrics dashboard",
    url: "https://app.re.xyz/metrics",
    fixture: "re-metrics-initial-tvl.html",
  },
  {
    name: "SG Forge EUR CoinVertible",
    url: "https://www.sgforge.com/product/coinvertible/",
    fixture: "sgforge-coinvertible-eur.html",
  },
  {
    name: "Buck (buck-buck-assets) transparency",
    url: "https://buck.io/transparency",
    fixture: "buck-io.html",
  },
  {
    name: "USDH (usdh-native-markets) reserves",
    url: "https://usdh.com/reserves",
    fixture: "usdh-native-markets.html",
  },
];

const USER_AGENT = "Mozilla/5.0 (compatible; pharos-fixture-refresh/1.0)";

async function fetchFixture(spec: HtmlFixtureSpec): Promise<string | null> {
  try {
    const res = await fetch(spec.url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,*/*",
        ...(spec.headers ?? {}),
      },
      redirect: "follow",
    });
    if (!res.ok) {
      console.warn(`[refresh] ${spec.name}: HTTP ${res.status} for ${spec.url}`);
      return null;
    }
    return await res.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[refresh] ${spec.name}: fetch failed — ${message}`);
    return null;
  }
}

function writeFixture(spec: HtmlFixtureSpec, body: string): void {
  const header = `<!-- captured-at: ${new Date().toISOString()} from ${spec.url} -->\n`;
  const path = join(FIXTURES_DIR, spec.fixture);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from adapter-owned constants (FIXTURES_DIR + spec.fixture), not user input.
  writeFileSync(path, header + body, "utf8");
}

async function main(): Promise<void> {
  let ok = 0;
  let failed = 0;
  for (const spec of FIXTURES) {
    const body = await fetchFixture(spec);
    if (body == null) {
      failed++;
      continue;
    }
    // Keep the previous fixture untouched when the upstream body is suspiciously
    // empty, to avoid a silent breakage committed via a dry refresh.
    if (body.trim().length < 200) {
      console.warn(
        `[refresh] ${spec.name}: upstream returned <200 bytes of content; skipping write`,
      );
      failed++;
      continue;
    }
    writeFixture(spec, body);
    console.log(`[refresh] ${spec.name}: wrote ${spec.fixture}`);
    ok++;
  }
  console.log(`[refresh] done: ${ok} succeeded, ${failed} failed`);
  if (ok === 0) {
    console.error("[refresh] no fixtures refreshed; exit non-zero so CI notices");
    process.exit(1);
  }
}

// Read-only access to existing fixture paths so the script fails fast if the
// fixtures directory has been relocated.
for (const spec of FIXTURES) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same reason as writeFixture above: path is adapter-owned, not user input.
  readFileSync(join(FIXTURES_DIR, spec.fixture), "utf8");
}

void main();
