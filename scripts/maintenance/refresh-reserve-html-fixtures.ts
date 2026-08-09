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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES_DIR = join(ROOT, "worker/src/cron/reserve-adapters/__tests__/fixtures");

// Canonical upstream URLs per HTML source. Keep in sync with
// shared/data/stablecoins/coins/*.json and the adapter modules.
const FIXTURES: readonly HtmlFixtureSpec[] = [
  {
    name: "Circle transparency (USDC/EURC)",
    url: "https://www.circle.com/transparency",
    fixture: "circle-usdc.html",
  },
  {
    // The canonical `www.firstdigitallabs.com/transparency` host answers automation
    // with a Cloudflare 403 challenge, so refreshes target the issuer's own Webflow
    // origin — the same-provider fallback the live-reserves config already uses.
    name: "First Digital FDUSD transparency (Webflow origin)",
    url: "https://firstdigitallabs.webflow.io/transparency",
    fixture: "fdusd-transparency.html",
  },
  {
    name: "Mento reserve dashboard",
    url: "https://reserve.mento.org/",
    fixture: "mento-reserve-composition.html",
  },
  {
    name: "Reserve (RE) metrics dashboard series payload",
    url: "https://app.re.xyz/metrics",
    fixture: "re-metrics-series.html",
  },
  {
    name: "SG Forge EUR CoinVertible",
    url: "https://www.sgforge.com/product/coinvertible/",
    fixture: "sgforge-coinvertible-eur.html",
  },
];

// Sources deliberately not refreshed:
// - `buck-io.html`: fixture deleted with the adapter in "Remove orphaned live reserve adapters".
// - `usdh-native-markets.html`: usdh.com sunset on 2026-07-17 and /reserves now 301s to a sunset
//   notice, so a refresh would overwrite the archived capture the retired adapter's tests parse.

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
  const capturedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const header = `<!-- captured-at: ${capturedAt} -->\n<!-- source: ${spec.url} -->\n`;
  const path = join(FIXTURES_DIR, spec.fixture);
  const normalizedBody = body.replace(/^[ \t]+/gm, (indent) => indent.replace(/\t/g, "  ")).replace(/[ \t]+$/gm, "");
  writeFileSync(path, header + normalizedBody, "utf8");
}

async function main(): Promise<void> {
  let ok = 0;
  let failed = 0;

  // Group fixtures by URL so identical sources are fetched only once.
  const byUrl = new Map<string, HtmlFixtureSpec[]>();
  for (const spec of FIXTURES) {
    const group = byUrl.get(spec.url) ?? [];
    group.push(spec);
    byUrl.set(spec.url, group);
  }

  for (const [, specs] of byUrl) {
    // Fetch once for all fixtures that share the same URL.
    const representative = specs[0]!;
    const body = await fetchFixture(representative);
    if (body == null) {
      failed += specs.length;
      continue;
    }
    // Keep the previous fixture untouched when the upstream body is suspiciously
    // empty, to avoid a silent breakage committed via a dry refresh.
    if (body.trim().length < 200) {
      console.warn(`[refresh] ${representative.name}: upstream returned <200 bytes of content; skipping write`);
      failed += specs.length;
      continue;
    }
    for (const spec of specs) {
      writeFixture(spec, body);
      console.log(`[refresh] ${spec.name}: wrote ${spec.fixture}`);
      ok++;
    }
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
  readFileSync(join(FIXTURES_DIR, spec.fixture), "utf8");
}

void main();
