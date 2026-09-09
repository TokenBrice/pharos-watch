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
 *
 * Importing this module runs no network or filesystem work: it exposes the
 * refresh inventory (`HTML_FIXTURE_REFRESH_TARGETS`) and each repository
 * fixture's capture metadata (`readHtmlFixtureCaptures()`) so the scheduled
 * age gate in `scripts/ci/check-html-fixture-age.ts` reads the same list this
 * script writes instead of re-deriving it from the source text.
 */

import { closeSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

/** An upstream source this script fetches, and the fixture it overwrites. */
export interface HtmlFixtureRefreshTarget {
  readonly name: string;
  readonly url: string;
  readonly fixture: string;
  /** Absolute path of the fixture file this target writes. */
  readonly path: string;
  readonly headers?: Record<string, string>;
}

type HtmlFixtureSource = Omit<HtmlFixtureRefreshTarget, "path">;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Directory holding every repository reserve HTML fixture. */
const HTML_FIXTURES_DIR = join(ROOT, "worker/src/cron/reserve-adapters/__tests__/fixtures");

// Canonical upstream URLs per HTML source. Keep in sync with
// shared/data/stablecoins/coins/*.json and the adapter modules.
const FIXTURE_SOURCES: readonly HtmlFixtureSource[] = [
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

/** Every fixture `npm run refresh:html-fixtures` owns, with its absolute path. */
export const HTML_FIXTURE_REFRESH_TARGETS: readonly HtmlFixtureRefreshTarget[] = FIXTURE_SOURCES.map((source) => ({
  ...source,
  path: join(HTML_FIXTURES_DIR, source.fixture),
}));

/** Provenance metadata of one repository fixture, read from its header block. */
export interface HtmlFixtureCapture {
  readonly fixture: string;
  readonly path: string;
  /** Raw `captured-at` header value, or `null` when the fixture carries none. */
  readonly capturedAt: string | null;
  /** Why the fixture is frozen instead of refreshed, or `null` when it is live. */
  readonly archivedReason: string | null;
  /** Why the fixture is trimmed by hand instead of refreshed, or `null` when the refresh owns it. */
  readonly trimmedReason: string | null;
  /** True when `HTML_FIXTURE_REFRESH_TARGETS` owns this file. */
  readonly refreshed: boolean;
}

const CAPTURED_AT_RE = /<!--\s*captured-at:\s*([^>]*?)\s*-->/;
const ARCHIVED_RE = /<!--\s*archived:\s*(\S[^>]*?)\s*-->/;
const SOURCE_TRIMMED_RE = /<!--\s*source-trimmed:\s*(\S[^>]*?)\s*-->/;
// The provenance block is written at byte 0 and the largest fixture is ~600 KB,
// so metadata reads take a bounded prefix instead of the whole corpus. A header
// pushed past this prefix reads as absent and fails the age gate loudly.
const HEADER_PREFIX_BYTES = 4096;

const USER_AGENT = "Mozilla/5.0 (compatible; pharos-fixture-refresh/1.0)";

function readHeaderPrefix(path: string): string {
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(HEADER_PREFIX_BYTES);
    const bytesRead = readSync(handle, buffer, 0, HEADER_PREFIX_BYTES, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    closeSync(handle);
  }
}

/** Reads capture metadata for every `.html` fixture in `dir`, sorted by name. */
export function readHtmlFixtureCaptures(dir: string = HTML_FIXTURES_DIR): HtmlFixtureCapture[] {
  const refreshedNames = new Set(HTML_FIXTURE_REFRESH_TARGETS.map((target) => target.fixture));
  return readdirSync(dir)
    .filter((name) => name.endsWith(".html"))
    .sort()
    .map((fixture) => {
      const path = join(dir, fixture);
      const header = readHeaderPrefix(path);
      return {
        fixture,
        path,
        capturedAt: header.match(CAPTURED_AT_RE)?.[1] ?? null,
        archivedReason: header.match(ARCHIVED_RE)?.[1] ?? null,
        trimmedReason: header.match(SOURCE_TRIMMED_RE)?.[1] ?? null,
        refreshed: refreshedNames.has(fixture),
      };
    });
}

async function fetchFixture(target: HtmlFixtureRefreshTarget): Promise<string | null> {
  try {
    const res = await fetch(target.url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,*/*",
        ...(target.headers ?? {}),
      },
      redirect: "follow",
    });
    if (!res.ok) {
      console.warn(`[refresh] ${target.name}: HTTP ${res.status} for ${target.url}`);
      return null;
    }
    return await res.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[refresh] ${target.name}: fetch failed — ${message}`);
    return null;
  }
}

function writeFixture(target: HtmlFixtureRefreshTarget, body: string): void {
  const capturedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const header = `<!-- captured-at: ${capturedAt} -->\n<!-- source: ${target.url} -->\n`;
  const normalizedBody = body.replace(/^[ \t]+/gm, (indent) => indent.replace(/\t/g, "  ")).replace(/[ \t]+$/gm, "");
  writeFileSync(target.path, header + normalizedBody, "utf8");
}

async function main(): Promise<void> {
  // Read-only access to existing fixture paths so the script fails fast if the
  // fixtures directory has been relocated.
  for (const target of HTML_FIXTURE_REFRESH_TARGETS) {
    readFileSync(target.path, "utf8");
  }

  let ok = 0;
  let failed = 0;

  // Group fixtures by URL so identical sources are fetched only once.
  const byUrl = new Map<string, HtmlFixtureRefreshTarget[]>();
  for (const target of HTML_FIXTURE_REFRESH_TARGETS) {
    const group = byUrl.get(target.url) ?? [];
    group.push(target);
    byUrl.set(target.url, group);
  }

  for (const [, targets] of byUrl) {
    // Fetch once for all fixtures that share the same URL.
    const representative = targets[0]!;
    const body = await fetchFixture(representative);
    if (body == null) {
      failed += targets.length;
      continue;
    }
    // Keep the previous fixture untouched when the upstream body is suspiciously
    // empty, to avoid a silent breakage committed via a dry refresh.
    if (body.trim().length < 200) {
      console.warn(`[refresh] ${representative.name}: upstream returned <200 bytes of content; skipping write`);
      failed += targets.length;
      continue;
    }
    for (const target of targets) {
      writeFixture(target, body);
      console.log(`[refresh] ${target.name}: wrote ${target.fixture}`);
      ok++;
    }
  }

  console.log(`[refresh] done: ${ok} succeeded, ${failed} failed`);
  if (ok === 0) {
    console.error("[refresh] no fixtures refreshed; exit non-zero so CI notices");
    process.exit(1);
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void main();
}
