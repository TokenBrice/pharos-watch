/* eslint-disable security/detect-non-literal-fs-filename -- test-only fixture walker rooted in this checked-in test directory. */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LIVE_RESERVE_ADAPTER_KEYS } from "@shared/types/live-reserves";
import { LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS } from "@shared/lib/live-reserve-adapters";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(TEST_DIR, "../../../../..");
const FIXTURES_DIR = resolve(TEST_DIR, "fixtures");
const REFRESH_SCRIPT = resolve(ROOT_DIR, "scripts/maintenance/refresh-reserve-html-fixtures.ts");
const CAPTURED_AT_RE = /<!--\s*captured-at:\s*(\d{4}-\d{2}-\d{2}T[\d:]+Z)\s*-->/;
// Fixtures whose upstream source no longer exists carry an `archived:` header
// explaining why. They are frozen on purpose: the refresh script must not list
// them, and they are exempt from the 90-day staleness bound.
const ARCHIVED_RE = /<!--\s*archived:\s*(\S[^>]*?)\s*-->/;
const MAX_FIXTURE_AGE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function inspectFixtureFreshness(file: string, content: string, now = new Date()) {
  const match = content.match(CAPTURED_AT_RE);
  if (!match) return { file, error: `${file}: missing captured-at header` };
  const capturedAt = new Date(match[1]);
  if (Number.isNaN(capturedAt.getTime())) return { file, error: `${file}: invalid captured-at timestamp ${match[1]}` };
  const ageDays = Math.floor((now.getTime() - capturedAt.getTime()) / DAY_MS);
  if (ageDays > MAX_FIXTURE_AGE_DAYS) {
    return { file, ageDays, error: `${file}: captured-at ${match[1]} is ${ageDays} days old` };
  }
  return { file, ageDays };
}

// Adapters that intentionally don't carry an HTML fixture file. Each entry
// must come with a reason — gated PDFs cannot be checked in, and small
// adapters with stable upstream layouts inline their HTML directly in tests.
// Adding a new entry is an architectural decision: prefer adding a fixture
// when the upstream HTML is large enough to justify out-of-test storage.
const FIXTURE_EXEMPT_ADAPTERS: Record<string, string> = {
  "attestation-pdf-index": "Upstream is a gated PDF index; HTML page is not the parsed surface.",
  "quantoz-transparency": "Adapter test uses inline HTML; upstream layout is stable and compact.",
  "ripple-transparency": "Adapter test uses inline HTML; upstream layout is stable and compact.",
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
  const httpHtmlAdapters = LIVE_RESERVE_ADAPTER_KEYS.filter((key) => {
    const inputKinds = LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS[key] as readonly string[];
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
    ARCHIVED_RE.test(readFileSync(resolve(FIXTURES_DIR, name), "utf8")));
  const refreshableFixtureNames = htmlFixtureNames.filter((name) => !archivedFixtureNames.includes(name));

  it.each(refreshableFixtureNames)("%s carries a valid captured-at header no older than 90 whole days", (fixtureName) => {
    const content = readFileSync(resolve(FIXTURES_DIR, fixtureName), "utf8");
    const result = inspectFixtureFreshness(fixtureName, content);
    expect(result.error, result.error).toBeUndefined();
  });

  it.each(archivedFixtureNames)("%s documents why it is archived instead of refreshed", (fixtureName) => {
    const content = readFileSync(resolve(FIXTURES_DIR, fixtureName), "utf8");
    const reason = content.match(ARCHIVED_RE)?.[1] ?? "";
    expect(reason.trim().length, `Archived fixture ${fixtureName} must state why it is frozen`).toBeGreaterThan(20);
  });

  it("keeps the 90-day boundary, invalid/missing headers, and future timestamps explicit", () => {
    const now = new Date("2026-04-01T12:00:00Z");
    expect(inspectFixtureFreshness("exact.html", "<!-- captured-at: 2026-01-01T00:00:00Z -->", now)).toEqual({
      file: "exact.html",
      ageDays: 90,
    });
    expect(inspectFixtureFreshness("stale.html", "<!-- captured-at: 2025-12-31T12:00:00Z -->", now)).toMatchObject({
      file: "stale.html",
      ageDays: 91,
      error: expect.stringContaining("stale.html"),
    });
    expect(inspectFixtureFreshness("invalid.html", "<!-- captured-at: 2026-99-99T99:99:99Z -->", now)).toEqual({
      file: "invalid.html",
      error: "invalid.html: invalid captured-at timestamp 2026-99-99T99:99:99Z",
    });
    expect(inspectFixtureFreshness("missing.html", "<html />", now)).toEqual({
      file: "missing.html",
      error: "missing.html: missing captured-at header",
    });
    expect(inspectFixtureFreshness("future.html", "<!-- captured-at: 2026-04-02T12:00:00Z -->", now)).toEqual({
      file: "future.html",
      ageDays: -1,
    });
  });

  it("refresh script lists every refreshable fixture and no archived or deleted one", () => {
    const script = readFileSync(REFRESH_SCRIPT, "utf8");
    const refreshFixtures = new Set(Array.from(script.matchAll(/fixture:\s*"([^"]+\.html)"/g), (match) => match[1]));
    const missing = refreshableFixtureNames.filter((fixtureName) => !refreshFixtures.has(fixtureName));
    const orphaned = [...refreshFixtures].filter((fixtureName) => !refreshableFixtureNames.includes(fixtureName)).sort();

    expect(missing).toEqual([]);
    expect(orphaned).toEqual([]);
  });
});
