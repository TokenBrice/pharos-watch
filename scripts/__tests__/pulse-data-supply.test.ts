import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { aggregatePulseSupply } from "../../.codex/skills/stablecoin-pulse-report/scripts/fetch-pulse-data.mjs";

const coin = (id: string, current: Record<string, number>, previous = current, group = id) => ({
  id, symbol: id, pegType: "peggedUSD", pegMechanism: group,
  circulating: current, circulatingPrevMonth: previous, price: 1,
});
const coins = [
  coin("empty", {}), coin("negative", { usd: 100, eur: -1 }),
  coin("overflow", { usd: Number.MAX_VALUE, eur: Number.MAX_VALUE }),
  coin("zero", { usd: 0 }), coin("complete", { usd: 120 }, { usd: 100 }),
  coin("paired", { usd: 30 }, { usd: 20 }, "partial"),
  coin("current-only", { usd: 70 }, {}, "partial"),
  coin("baseline-only", {}, { usd: 90 }, "partial"),
  coin("123", { usd: 999 }, { usd: 999 }, "partial"),
];

describe("Pulse canonical supply", () => {
  it("rejects absent, negative and overflowing buckets but observes explicit zero", () => {
    const groups = aggregatePulseSupply(coins, "pegMechanism");
    for (const key of ["empty", "negative", "overflow"]) {
      expect(groups[key]).toMatchObject({ currentUsd: null, previousUsd: null, comparableCurrentUsd: null,
        comparablePreviousUsd: null, currentCoins: 0, previousCoins: 0, comparableCoins: 0,
        currentCoverage: "none", previousCoverage: "none", comparableCoverage: "none", deltaUsd: null, deltaPct: null });
    }
    expect(groups.zero).toMatchObject({ currentUsd: 0, previousUsd: 0, currentCoins: 1,
      currentCoverage: "complete", comparableCoverage: "complete", deltaUsd: 0, deltaPct: null });
  });

  it("qualifies partial coverage while retaining paired delta denominators and excluding numeric ids", () => {
    const groups = aggregatePulseSupply(coins, "pegMechanism");
    expect(groups.partial).toMatchObject({ currentUsd: 100, previousUsd: 110, totalCoins: 3,
      currentCoins: 2, previousCoins: 2, comparableCoins: 1,
      currentCoverage: "partial", previousCoverage: "partial", comparableCoverage: "partial",
      comparableCurrentUsd: 30, comparablePreviousUsd: 20, deltaUsd: 10, deltaPct: 50 });
    expect(groups.complete).toMatchObject({ currentUsd: 120, previousUsd: 100, totalCoins: 1,
      currentCoverage: "complete", previousCoverage: "complete", comparableCoverage: "complete", deltaUsd: 20 });
    const disjoint = aggregatePulseSupply([coins[6], coins[7]], "pegMechanism").partial;
    expect(disjoint).toMatchObject({ currentUsd: 70, previousUsd: 90, comparableCurrentUsd: null,
      comparablePreviousUsd: null, comparableCoverage: "none", deltaUsd: null, deltaPct: null });
  });

  it("runs the documented Node/tsx entrypoint offline and writes qualified market and brief artifacts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pulse-supply-"));
    const script = ".codex/skills/stablecoin-pulse-report/scripts/fetch-pulse-data.mjs";
    const now = Math.floor(Date.now() / 1000);
    const fixture = {
      "/api/stablecoins": { peggedAssets: [...coins, coin("usdt-tether", { usd: -1 }), coin("usdc-circle", { usd: 0 })] },
      "/api/chains": { chains: [{ name: "Fixture", totalUsd: 0, change30d: 0, change30dPct: 0 }] },
      "/api/digest-archive": { digests: [now - 31 * 86400, now - 60].map((generatedAt) => ({ digestType: "daily", generatedAt, totalMcapUsd: 1e9 })) },
      "/api/stability-index?detail=true": { history: [{ date: now - 60, score: 90, band: "STABLE" }] },
      "/api/peg-summary": { coins: [], summary: { coinsAtPeg: 0, totalTracked: coins.length } },
      "/api/mint-burn-flows?hours=720": { coins: [{ id: "zero" }] },
      "/api/blacklist-summary": { stats: { count7d: 0 } },
      "/api/non-usd-share?days=60": [{ date: now - 60, commodityShare: 0, fiatNonUsdShare: 0 }],
      "/api/stablecoin-charts": [{ date: now - 60 }],
      "/api/depeg-events?limit=1000&includePending=true": { events: [] },
      "/api/depeg-events?limit=1000&includePending=true&active=true": { events: [] },
    };
    const preload = path.join(dir, "offline.mjs");
    try {
      writeFileSync(preload, `import timers from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
timers.setTimeout = async () => {};
syncBuiltinESMExports();
const fixture = ${JSON.stringify(fixture)};
globalThis.fetch = async (input) => {
  const url = new URL(input);
  if (url.origin !== 'https://api.pharos.watch') throw new Error('Unexpected origin: ' + url.origin);
  const key = url.pathname + url.search;
  if (Object.hasOwn(fixture, key)) return Response.json(fixture[key]);
  if (url.pathname === '/api/mint-burn-events') return Response.json({ events: [] });
  throw new Error('Unstubbed network request: ' + key);
};`);
      execFileSync(process.execPath, ["--import", "tsx", "--import", pathToFileURL(preload).href, script, "--out", dir], {
        cwd: process.cwd(), env: { ...process.env, PHAROS_API_KEY: "offline-fixture" }, stdio: "pipe", timeout: 20000,
      });
      const market = JSON.parse(readFileSync(path.join(dir, "data/market.json"), "utf8"));
      expect(market.current.totalMcapUsd).toBe(1e9);
      expect(market.byPegMechanism.empty.currentUsd).toBeNull();
      expect(market.byPegMechanism.zero.currentUsd).toBe(0);
      expect(market.byPegMechanism.partial).toMatchObject({ currentUsd: 100, currentCoverage: "partial", currentCoins: 2, totalCoins: 3, deltaUsd: 10 });
      expect(market.byPegType.peggedUSD).toMatchObject({ currentCoverage: "partial", previousCoverage: "partial" });
      expect(market.shares["usdt-tether"].supplyUsd).toBeNull();
      expect(market.shares["usdc-circle"].supplyUsd).toBe(0);
      const brief = readFileSync(path.join(dir, "data/brief.md"), "utf8");
      expect(brief).toContain("empty: unavailable now; current coverage 0/1 (none)");
      expect(brief).toContain("zero: $0.00M now; current coverage 1/1 (complete)");
      expect(brief).toContain("partial: $0.00M now; current coverage 2/3 (partial)");
      expect(brief).toContain("comparable coverage 1/3 (partial)");
      const excluded = readFileSync(path.join(dir, "data/movers-excluded.csv"), "utf8");
      expect(excluded).toContain("negative,negative,peggedUSD,negative,,,,,absent-current;absent-baseline");
      expect(excluded).toContain("zero,zero,peggedUSD,zero,0,0,0,,zero-baseline");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
