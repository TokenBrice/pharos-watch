import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import { REMOVED_STABLECOINS } from "@/lib/removed-stablecoins";

const rules = readFileSync("public/_redirects", "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((line) => {
    const [source, destination, status] = line.split(/\s+/);
    return { source, destination, status };
  });

describe("removed stablecoins", () => {
  it("lists only IDs that are no longer in the registry", () => {
    for (const coin of REMOVED_STABLECOINS) expect(TRACKED_META_BY_ID.has(coin.id), coin.id).toBe(false);
    expect(new Set(REMOVED_STABLECOINS.map((coin) => coin.id)).size).toBe(REMOVED_STABLECOINS.length);
  });

  it("names only cemetery records that exist", () => {
    const cemeteryIds = new Set(DEAD_STABLECOINS.map((entry) => entry.id));
    const withRecord = REMOVED_STABLECOINS.filter((coin) => coin.cemeteryId != null);
    expect(withRecord.length).toBeGreaterThan(0);
    for (const coin of withRecord) expect(cemeteryIds.has(coin.cemeteryId!), coin.id).toBe(true);
  });

  it("redirects every retired profile and subpath to its cemetery record, built peg hub, or /coverage/", () => {
    for (const coin of REMOVED_STABLECOINS) {
      const destination = coin.cemeteryId
        ? `/cemetery/#${coin.cemeteryId}`
        : buildPegLandingUrl(coin.pegCurrency) ?? "/coverage/";
      for (const source of [`/stablecoin/${coin.id}`, `/stablecoin/${coin.id}/*`]) {
        expect(rules.find((rule) => rule.source === source), source).toEqual({ source, destination, status: "301" });
      }
    }
  });

  it("covers every retired coin ID that redirects to /coverage/, a cemetery record or a peg hub", () => {
    const listed = new Set(REMOVED_STABLECOINS.map((coin) => coin.id));
    const retiredIds = rules
      .filter((rule) => /^\/stablecoins\/[a-z]+\/$|^\/coverage\/$|^\/cemetery\/#/.test(rule.destination))
      .map((rule) => /^\/stablecoin\/([a-z][^/*]*)\/?$/.exec(rule.source)?.[1])
      .filter((id): id is string => id != null);
    expect(retiredIds.filter((id) => !listed.has(id))).toEqual([]);
  });
});
