import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LIVE_RESERVE_ADAPTER_KEYS } from "@shared/types/live-reserves";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(TEST_DIR, "fixtures");
const CAPTURED_AT_RE = /<!--\s*captured-at:\s*(\d{4}-\d{2}-\d{2}T[\d:]+Z)\s*-->/;
// Archived fixtures are intentionally frozen regression inputs; their reason
// replaces capture metadata.
const ARCHIVED_RE = /<!--\s*archived:\s*(\S[^>]*?)\s*-->/;
const SOURCE_TRIMMED_RE = /<!--\s*source-trimmed:\s*(\S[^>]*?)\s*-->/;
const SOURCE_RE = /<!--\s*source:\s*(https:\/\/\S+?)\s*-->/;
// Capture age (90-day bound, future-dated rejection) and refresh-list
// membership are owned by `scripts/ci/check-html-fixture-age.ts`
// (`npm run check:html-fixture-age`, scheduled in
// .github/workflows/weekly-validation.yml) and covered by
// `scripts/__tests__/check-html-fixture-age.test.ts`, which reads the script's
// exported refresh targets instead of its source text. This file only asserts
// that the metadata a parser run needs is present and parsable, so its verdict
// does not move with the calendar.

// Adapters that intentionally don't carry an HTML fixture file. Each entry
// must come with a reason — gated PDFs cannot be checked in, and small
// adapters with stable upstream layouts inline their HTML directly in tests.
// Adding a new entry is an architectural decision: prefer adding a fixture
// when the upstream HTML is large enough to justify out-of-test storage.
const FIXTURE_EXEMPT_ADAPTERS: Record<string, string> = {
  "attestation-pdf-index": "Upstream is a gated PDF index; HTML page is not the parsed surface.",
  "audx-independent-assurance": "Compact index HTML for newer-report detection is covered inline; evidence is the exact official PDF bytes bound to a reviewed manifest SHA-256.",
  "brla-independent-assurance": "The Notion index HTML is only a host/reachability gate; the parsed surface is the inline loadPageChunk/getSignedFileUrls record maps in brla-independent-assurance.test.ts, and evidence is the exact official PDF bytes bound to a reviewed manifest SHA-256.",
  "paxos-independent-assurance": "Inline tests cover the sole parsed HTML surface (main-module script reference); exact reviewed main/product-module hashes bind report selection, and the manifest binds PDF bytes.",
  "agora-independent-assurance": "Compact Fern docs index HTML for reviewed-link rewriting is covered inline; evidence is the exact official PDF bytes bound to a reviewed manifest SHA-256.",
  "fidd-independent-assurance": "Compact official index and Widen viewer HTML for newer-report detection are covered inline; evidence is the exact official PDF bytes bound to a reviewed manifest SHA-256.",
  "issuer-attested-report": "Shared sibling descriptor for BRLV/AUDM: each product profile parses its own compact issuer index inline and evidence is the exact reviewed PDF bytes bound to a manifest SHA-256.",
  "sbc-independent-assurance": "Compact Brale index HTML for newer-report detection is covered inline; evidence is the exact official PDF bytes bound to a reviewed manifest SHA-256.",
  "quantoz-transparency": "Adapter test uses inline HTML; upstream layout is stable and compact.",
  "ripple-transparency": "Adapter test uses inline HTML; upstream layout is stable and compact.",
  "onre-holdings-csv": "Adapter parses the published Schedule of Assets CSV (RFC-4180 quoted), not an HTML page; the compact CSV payload is covered inline in tests.",
  "usdy-holdings-report": "Parses no HTML surface: evidence is the exact Ankura PDF report bytes pinned to a manifest SHA-256, and the live feed is suspended with the reviewed manifest retained as static evidence.",
};

function fixturePrefixCandidates(key: string): string[] {
  const candidates = [key];
  // Some fixtures shorten the adapter key by dropping the "-transparency" suffix
  // for compact fixture names. Accept both forms.
  if (key.endsWith("-transparency")) {
    candidates.push(key.slice(0, -"-transparency".length));
  }
  return candidates;
}

function findFixturesFor(key: string, fixtureNames: readonly string[]): string[] {
  const prefixes = fixturePrefixCandidates(key);
  return fixtureNames.filter(
    (name) =>
      name.endsWith(".html") && prefixes.some((prefix) => name === `${prefix}.html` || name.startsWith(`${prefix}-`)),
  );
}

describe("http-html adapter fixture coverage", () => {
  const fixtureNames = readdirSync(FIXTURES_DIR);
  const htmlFixtureNames = fixtureNames.filter((name) => name.endsWith(".html")).sort();
  const fixtureContents = Object.fromEntries(htmlFixtureNames.map((name) =>
    [name, readFileSync(resolve(FIXTURES_DIR, name), "utf8")]));
  const httpHtmlAdapters = LIVE_RESERVE_ADAPTER_KEYS.filter((key) => {
    const inputKinds = LIVE_RESERVE_ADAPTER_DEFINITIONS[key].primaryInputKinds as readonly string[];
    return inputKinds.includes("http-html");
  });

  it.each(httpHtmlAdapters)("%s has an HTML fixture file or an explicit FIXTURE_EXEMPT_ADAPTERS reason", (key) => {
    const fixtures = findFixturesFor(key, fixtureNames);
    const exemptReason = FIXTURE_EXEMPT_ADAPTERS[key];
    if (exemptReason) {
      expect(exemptReason.trim().length, `Exemption reason for ${key} must be non-empty`).toBeGreaterThan(0);
      return;
    }
    expect(
      fixtures.length,
      `http-html adapter "${key}" has no fixture in __tests__/fixtures/ — add one matching ` +
        `${fixturePrefixCandidates(key)
          .map((p) => `${p}.html`)
          .join(" or ")}, or list it in FIXTURE_EXEMPT_ADAPTERS with a reason.`,
    ).toBeGreaterThan(0);
  });

  it("FIXTURE_EXEMPT_ADAPTERS keys all map to real http-html adapter keys", () => {
    const httpHtmlSet = new Set(httpHtmlAdapters);
    for (const key of Object.keys(FIXTURE_EXEMPT_ADAPTERS)) {
      expect(
        httpHtmlSet.has(key as (typeof LIVE_RESERVE_ADAPTER_KEYS)[number]),
        `FIXTURE_EXEMPT_ADAPTERS lists "${key}" but it is not an http-html adapter; remove the stale entry.`,
      ).toBe(true);
    }
  });

  const archivedFixtureNames = htmlFixtureNames.filter((name) =>
    ARCHIVED_RE.test(fixtureContents[name]));
  const manuallyTrimmedFixtureNames = htmlFixtureNames.filter((name) =>
    SOURCE_TRIMMED_RE.test(fixtureContents[name]));
  const currentFixtureNames = htmlFixtureNames.filter((name) => !archivedFixtureNames.includes(name));

  it.each(currentFixtureNames)("%s carries a valid captured-at header", (fixtureName) => {
    const capturedAt = fixtureContents[fixtureName].match(CAPTURED_AT_RE)?.[1];
    expect(capturedAt, `${fixtureName}: missing captured-at header`).toBeDefined();
    expect(Number.isFinite(Date.parse(capturedAt!))).toBe(true);
  });

  it.each(manuallyTrimmedFixtureNames)("%s identifies its live source and why it is manually trimmed", (fixtureName) => {
    const content = fixtureContents[fixtureName];
    expect(content.match(SOURCE_RE)?.[1], `${fixtureName}: missing HTTPS source header`).toMatch(/^https:\/\//);
    expect(
      content.match(SOURCE_TRIMMED_RE)?.[1]?.trim().length,
      `${fixtureName}: source-trimmed reason must be specific`,
    ).toBeGreaterThan(20);
  });

  it.each(archivedFixtureNames)("%s documents why it is archived instead of refreshed", (fixtureName) => {
    const content = fixtureContents[fixtureName];
    const reason = content.match(ARCHIVED_RE)?.[1] ?? "";
    expect(reason.trim().length, `Archived fixture ${fixtureName} must state why it is frozen`).toBeGreaterThan(20);
  });

});
