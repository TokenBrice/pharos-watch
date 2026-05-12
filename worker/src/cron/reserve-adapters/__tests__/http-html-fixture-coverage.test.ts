import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LIVE_RESERVE_ADAPTER_KEYS } from "@shared/types/live-reserves";
import { LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS } from "@shared/lib/live-reserve-adapters";

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

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
  // (e.g. buck-io-transparency → buck-io.html). Accept both forms.
  if (key.endsWith("-transparency")) {
    candidates.push(key.slice(0, -"-transparency".length));
  }
  return candidates;
}

function findFixturesFor(key: string, fixtureNames: readonly string[]): string[] {
  const prefixes = fixturePrefixCandidates(key);
  return fixtureNames.filter((name) =>
    name.endsWith(".html") && prefixes.some((prefix) => name === `${prefix}.html` || name.startsWith(`${prefix}-`)),
  );
}

describe("http-html adapter fixture coverage", () => {
  const fixtureNames = readdirSync(FIXTURES_DIR);
  const httpHtmlAdapters = LIVE_RESERVE_ADAPTER_KEYS.filter((key) => {
    const inputKinds = LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS[key] as readonly string[];
    return inputKinds.includes("http-html");
  });

  it.each(httpHtmlAdapters)(
    "%s has an HTML fixture file or an explicit FIXTURE_EXEMPT_ADAPTERS reason",
    (key) => {
      const fixtures = findFixturesFor(key, fixtureNames);
      const exemptReason = FIXTURE_EXEMPT_ADAPTERS[key];
      if (exemptReason) {
        expect(exemptReason.trim().length, `Exemption reason for ${key} must be non-empty`).toBeGreaterThan(0);
        return;
      }
      expect(
        fixtures.length,
        `http-html adapter "${key}" has no fixture in __tests__/fixtures/ — add one matching ` +
          `${fixturePrefixCandidates(key).map((p) => `${p}.html`).join(" or ")}, or list it in FIXTURE_EXEMPT_ADAPTERS with a reason.`,
      ).toBeGreaterThan(0);
    },
  );

  it("FIXTURE_EXEMPT_ADAPTERS keys all map to real http-html adapter keys", () => {
    const httpHtmlSet = new Set(httpHtmlAdapters);
    for (const key of Object.keys(FIXTURE_EXEMPT_ADAPTERS)) {
      expect(
        httpHtmlSet.has(key as (typeof LIVE_RESERVE_ADAPTER_KEYS)[number]),
        `FIXTURE_EXEMPT_ADAPTERS lists "${key}" but it is not an http-html adapter; remove the stale entry.`,
      ).toBe(true);
    }
  });
});
