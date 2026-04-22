import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findCanonicalOrderIssues,
  findDuplicateStablecoinIds,
  loadGeneratedPerCoinCoins,
  syncGeneratedPerCoinAsset,
  type StablecoinSourceEntry,
} from "../lib/stablecoin-catalog-sources";

const tempDirs: string[] = [];

function makeTempRoot(): string {
  const rootDir = mkdtempSync(join(tmpdir(), "stablecoin-catalog-"));
  tempDirs.push(rootDir);
  return rootDir;
}

function writeJson(rootDir: string, relativePath: string, value: unknown): void {
  const absolutePath = join(rootDir, relativePath);
  // Test helper writes only into per-test temp directories.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  mkdirSync(dirname(absolutePath), { recursive: true });
  // Test helper writes only into per-test temp directories.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeCoin(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `${id} Coin`,
    symbol: id.split("-")[0]!.slice(0, 8).toUpperCase(),
    flags: {
      backing: "rwa-backed",
      pegCurrency: "USD",
      governance: "centralized",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    },
    ...overrides,
  };
}

function makeEntry(
  id: string,
  file: string,
  sourceKind: StablecoinSourceEntry["sourceKind"],
  legacyShard?: StablecoinSourceEntry["legacyShard"],
): StablecoinSourceEntry {
  return {
    coin: makeCoin(id) as StablecoinSourceEntry["coin"],
    file,
    id,
    legacyShard,
    sourceKind,
  };
}

function writeLegacyShards(rootDir: string, usdMajorCoins: unknown[] = []): void {
  writeJson(rootDir, "shared/data/stablecoins/usd-major.json", usdMajorCoins);
  writeJson(rootDir, "shared/data/stablecoins/usd-minor.json", []);
  writeJson(rootDir, "shared/data/stablecoins/non-usd.json", []);
  writeJson(rootDir, "shared/data/stablecoins/commodity.json", []);
  writeJson(rootDir, "shared/data/stablecoins/pre-launch.json", []);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("stablecoin catalog source helpers", () => {
  it("detects duplicate IDs across legacy and per-coin sources", () => {
    const issues = findDuplicateStablecoinIds([
      makeEntry(
        "usdc-circle",
        "shared/data/stablecoins/usd-major.json",
        "legacy",
        "usd-major.json",
      ),
      makeEntry(
        "usdc-circle",
        "shared/data/stablecoins/coins/usdc-circle.json",
        "per-coin",
      ),
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.id).toBe("usdc-circle");
    expect(issues[0]?.entries.map((entry) => entry.file)).toEqual([
      "shared/data/stablecoins/usd-major.json",
      "shared/data/stablecoins/coins/usdc-circle.json",
    ]);
  });

  it("reports canonical-order duplicates, unknown IDs, and missing tracked IDs", () => {
    const issues = findCanonicalOrderIssues(
      ["alpha-usd", "alpha-usd", "missing-usd"],
      [
        makeEntry(
          "alpha-usd",
          "shared/data/stablecoins/usd-major.json",
          "legacy",
          "usd-major.json",
        ),
        makeEntry(
          "beta-usd",
          "shared/data/stablecoins/coins/beta-usd.json",
          "per-coin",
        ),
      ],
    );

    expect(issues).toEqual({
      duplicateIds: ["alpha-usd"],
      missingIds: ["beta-usd"],
      unknownIds: ["missing-usd"],
    });
  });

  it("fails check mode when the generated per-coin aggregate is stale", () => {
    const rootDir = makeTempRoot();
    writeLegacyShards(rootDir);
    writeJson(
      rootDir,
      "shared/data/stablecoins/coins/per-coin-usd.json",
      makeCoin("per-coin-usd"),
    );
    writeJson(rootDir, "shared/data/stablecoins/coins.generated.json", []);

    expect(() => syncGeneratedPerCoinAsset({ check: true, rootDir })).toThrow(/stale/);
  });

  it("writes the generated per-coin aggregate and then passes check mode", () => {
    const rootDir = makeTempRoot();
    const legacyCoin = makeCoin("legacy-usd");
    const perCoin = makeCoin("per-coin-usd");

    writeLegacyShards(rootDir, [legacyCoin]);
    writeJson(rootDir, "shared/data/stablecoins/coins/per-coin-usd.json", perCoin);
    writeJson(rootDir, "shared/data/stablecoins/coins.generated.json", []);

    const result = syncGeneratedPerCoinAsset({ rootDir });
    expect(result.changed).toBe(true);
    expect(loadGeneratedPerCoinCoins(rootDir)).toEqual([perCoin]);
    expect(() => syncGeneratedPerCoinAsset({ check: true, rootDir })).not.toThrow();
  });

  it("rejects duplicate IDs before generating the per-coin aggregate", () => {
    const rootDir = makeTempRoot();
    const duplicateCoin = makeCoin("legacy-usd");

    writeLegacyShards(rootDir, [duplicateCoin]);
    writeJson(rootDir, "shared/data/stablecoins/coins/legacy-usd.json", duplicateCoin);
    writeJson(rootDir, "shared/data/stablecoins/coins.generated.json", []);

    expect(() => syncGeneratedPerCoinAsset({ rootDir })).toThrow(/Duplicate stablecoin IDs detected/);
  });
});
