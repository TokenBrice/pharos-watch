import { afterEach, describe, expect, it } from "vitest";
import {
  buildGeneratedPerCoinAsset,
  findCanonicalOrderIssues,
  findDuplicateStablecoinIds,
  findRecreatedRetiredStablecoinAssetFiles,
  formatRecreatedRetiredAssetFileIssue,
  loadGeneratedPerCoinCoins,
  loadPerCoinStablecoinEntries,
  loadStablecoinDomainSidecarEntries,
  syncGeneratedPerCoinAsset,
  type StablecoinSourceEntry,
} from "../lib/stablecoin-catalog-sources";
import { createTempRepoTracker } from "./helpers/test-state";

const { cleanup, makeRoot: makeTempRoot, writeJson } = createTempRepoTracker("stablecoin-catalog");

function makeCoin(id: string, overrides: Record<string, unknown> = {}): StablecoinSourceEntry["coin"] {
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
  } as StablecoinSourceEntry["coin"];
}

function makeEntry(id: string, file: string): StablecoinSourceEntry {
  return {
    coin: makeCoin(id),
    file,
    id,
  };
}

function makeReserves(): Array<Record<string, unknown>> {
  return [
    {
      name: "Cash",
      pct: 100,
      risk: "very-low",
    },
  ];
}

function makeReserveReview(): Record<string, unknown> {
  return {
    reviewedAt: "2026-07-12",
    reviewer: "test",
    confidence: "verified",
    sources: [{ label: "Reserve report", url: "https://example.com/reserves" }],
    rationale: "The fixture reserve composition was reviewed.",
    compositionBasis: "issuer disclosure",
    compositionAsOf: "2026-07-01",
    scope: "full-composition",
    knownUnknownExposure: "None identified in the fixture.",
    knownUnknownExposurePct: 0,
  };
}

function makeCustodyProfile(): Record<string, unknown> {
  return {
    providers: [{ name: "Fixture Bank", role: "bank", sharePct: 100, jurisdiction: "US" }],
    segregation: "segregated",
    bankruptcyRemoteness: "contractual-only",
    rehypothecation: "prohibited",
    reviewedAt: "2026-07-12",
    reviewer: "test",
    confidence: "verified",
    sources: [{ label: "Custody report", url: "https://example.com/custody" }],
    uncertainty: "No material custody allocation is unresolved in the fixture.",
    knownUnknownExposurePct: 0,
  };
}

function makeMintAuthority(): Record<string, unknown> {
  return {
    mintPath: "unknown",
    authorityPosture: "unknown",
    confidence: "unknown",
    summary: "The fixture mint authority remains unresolved.",
    review: {
      sourceFreeRationale: "Catalog loader fixture without external research.",
      evidence: "The fixture records enough evidence text for strict schema validation.",
      reviewer: "test",
      reviewedAt: "2026-07-09",
    },
  };
}

function makeGeniusProfile(): Record<string, unknown> {
  return {
    applicability: "unclear",
    authorizationStatus: "unknown",
    issuerPathway: "unknown",
    reviewer: "test",
    reviewedAt: "2026-07-09",
  };
}

function makeBlacklistabilityReview(): Record<string, unknown> {
  return {
    reviewedStatus: true,
    sourceFreeRationale: "Catalog loader fixture without external research.",
    evidence: "The fixture models a direct blacklistability control surface.",
    reviewer: "test",
    reviewedAt: "2026-07-09",
  };
}

afterEach(cleanup);

describe("stablecoin catalog source helpers", () => {
  it("detects duplicate IDs across per-coin source files", () => {
    const issues = findDuplicateStablecoinIds([
      makeEntry("usdc-circle", "shared/data/stablecoins/coins/usdc-circle.json"),
      makeEntry("usdc-circle", "shared/data/stablecoins/coins/usdc-circle-copy.json"),
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.id).toBe("usdc-circle");
    expect(issues[0]?.entries.map((entry) => entry.file)).toEqual([
      "shared/data/stablecoins/coins/usdc-circle.json",
      "shared/data/stablecoins/coins/usdc-circle-copy.json",
    ]);
  });

  it("reports canonical-order duplicates, unknown IDs, and missing tracked IDs", () => {
    const issues = findCanonicalOrderIssues(
      ["alpha-usd", "alpha-usd", "missing-usd"],
      [
        makeEntry("alpha-usd", "shared/data/stablecoins/coins/alpha-usd.json"),
        makeEntry("beta-usd", "shared/data/stablecoins/coins/beta-usd.json"),
      ],
    );

    expect(issues).toEqual({
      duplicateIds: ["alpha-usd"],
      missingIds: ["beta-usd"],
      unknownIds: ["missing-usd"],
    });
  });

  it("rejects a recreated retired category shard", () => {
    const rootDir = makeTempRoot();
    expect(findRecreatedRetiredStablecoinAssetFiles(rootDir)).toEqual([]);

    writeJson(rootDir, "shared/data/stablecoins/usd-major.json", [makeCoin("legacy-usd")]);

    expect(findRecreatedRetiredStablecoinAssetFiles(rootDir)).toEqual([
      "shared/data/stablecoins/usd-major.json",
    ]);
    expect(formatRecreatedRetiredAssetFileIssue("shared/data/stablecoins/usd-major.json")).toContain(
      "retired legacy category shard must not exist. " +
        "Edit shared/data/stablecoins/coins/<id>.json " +
        "and regenerate shared/data/stablecoins/coins.generated.json instead.",
    );
  });

  it("merges reserves sidecars into per-coin source entries", () => {
    const rootDir = makeTempRoot();
    const reserves = makeReserves();
    const reserveReview = makeReserveReview();
    const custodyProfile = makeCustodyProfile();

    writeJson(rootDir, "shared/data/stablecoins/coins/sidecar-usd.json", makeCoin("sidecar-usd"));
    writeJson(rootDir, "shared/data/stablecoins/domains/reserves/sidecar-usd.json", {
      id: "sidecar-usd",
      reserves,
      reserveReview,
      custodyProfile,
    });

    const entries = loadPerCoinStablecoinEntries(rootDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.coin.reserves).toEqual(reserves);
    expect(entries[0]?.coin.reserveReview).toEqual(reserveReview);
    expect(entries[0]?.coin.custodyProfile).toEqual(custodyProfile);
    expect(entries[0]?.sidecarFiles).toEqual(["shared/data/stablecoins/domains/reserves/sidecar-usd.json"]);
  });

  it("loads a review-only reserve sidecar before merged-record validation", () => {
    const rootDir = makeTempRoot();
    const reserveReview = makeReserveReview();

    writeJson(rootDir, "shared/data/stablecoins/domains/reserves/review-only-usd.json", {
      id: "review-only-usd",
      reserveReview,
    });

    expect(loadStablecoinDomainSidecarEntries(rootDir)).toEqual([
      expect.objectContaining({
        domain: "reserves",
        fields: ["reserveReview"],
        id: "review-only-usd",
        patch: { reserveReview },
      }),
    ]);
  });

  it("rejects a review-only reserve sidecar when the merged record has no reserves", () => {
    const rootDir = makeTempRoot();

    writeJson(rootDir, "shared/data/stablecoins/coins/review-only-usd.json", makeCoin("review-only-usd"));
    writeJson(rootDir, "shared/data/stablecoins/domains/reserves/review-only-usd.json", {
      id: "review-only-usd",
      reserveReview: makeReserveReview(),
    });

    expect(() => loadPerCoinStablecoinEntries(rootDir)).toThrow(/reserveReview requires a reserve composition/);
  });

  it("merges all research sidecar domains into one stablecoin projection", () => {
    const rootDir = makeTempRoot();
    const mintAuthority = makeMintAuthority();
    const genius = makeGeniusProfile();
    const blacklistabilityReview = makeBlacklistabilityReview();
    const oracleRisk = {
      tier: "opaque-or-unknown",
      summary: "The fixture oracle design remains unknown.",
    };
    const bridgeRouteRisk = {
      tier: "opaque-or-unknown",
      summary: "The fixture bridge route remains unknown.",
      reviewedAt: "2026-07-09",
      reviewer: "test",
      confidence: "unknown",
      sourceFreeRationale: "Catalog loader fixture without external research.",
    };

    writeJson(rootDir, "shared/data/stablecoins/coins/sidecar-usd.json", makeCoin("sidecar-usd"));
    writeJson(rootDir, "shared/data/stablecoins/domains/mint-authority/sidecar-usd.json", {
      id: "sidecar-usd",
      mintAuthority,
    });
    writeJson(rootDir, "shared/data/stablecoins/domains/compliance/sidecar-usd.json", {
      id: "sidecar-usd",
      mica: { status: "out-of-scope" },
      genius,
    });
    writeJson(rootDir, "shared/data/stablecoins/domains/risk-review/sidecar-usd.json", {
      id: "sidecar-usd",
      blacklistabilityReview,
      oracleRisk,
      bridgeRouteRisk,
    });

    const [entry] = loadPerCoinStablecoinEntries(rootDir);
    expect(entry?.coin).toMatchObject({
      mintAuthority,
      mica: { status: "out-of-scope" },
      genius,
      blacklistabilityReview,
      oracleRisk,
      bridgeRouteRisk,
    });
    expect(entry?.sidecarFiles).toEqual([
      "shared/data/stablecoins/domains/compliance/sidecar-usd.json",
      "shared/data/stablecoins/domains/mint-authority/sidecar-usd.json",
      "shared/data/stablecoins/domains/risk-review/sidecar-usd.json",
    ]);
  });

  it("rejects sidecars whose id does not match the sidecar file id", () => {
    const rootDir = makeTempRoot();

    writeJson(rootDir, "shared/data/stablecoins/coins/sidecar-usd.json", makeCoin("sidecar-usd"));
    writeJson(rootDir, "shared/data/stablecoins/domains/reserves/sidecar-usd.json", {
      id: "other-usd",
      reserves: makeReserves(),
    });

    expect(() => loadPerCoinStablecoinEntries(rootDir)).toThrow(
      /sidecar id "other-usd" must match file id "sidecar-usd"/,
    );
  });

  it("rejects base coin files whose id does not match the file id", () => {
    const rootDir = makeTempRoot();

    writeJson(rootDir, "shared/data/stablecoins/coins/base-usd.json", makeCoin("other-usd"));

    expect(() => loadPerCoinStablecoinEntries(rootDir)).toThrow(/coin id "other-usd" must match file id "base-usd"/);
  });

  it("rejects the retired blacklistability override in base files", () => {
    const rootDir = makeTempRoot();

    writeJson(rootDir, "shared/data/stablecoins/coins/base-usd.json", makeCoin("base-usd", { canBeBlacklisted: true }));

    expect(() => loadPerCoinStablecoinEntries(rootDir)).toThrow(/Unrecognized key: "canBeBlacklisted"/);
  });

  it("rejects sidecars that duplicate a field still present in the base coin", () => {
    const rootDir = makeTempRoot();

    writeJson(
      rootDir,
      "shared/data/stablecoins/coins/sidecar-usd.json",
      makeCoin("sidecar-usd", { reserves: makeReserves() }),
    );
    writeJson(rootDir, "shared/data/stablecoins/domains/reserves/sidecar-usd.json", {
      id: "sidecar-usd",
      reserves: makeReserves(),
    });

    expect(() => loadPerCoinStablecoinEntries(rootDir)).toThrow(
      /field "reserves" already exists in shared\/data\/stablecoins\/coins\/sidecar-usd\.json/,
    );
  });

  it("rejects research sidecars while any field from that domain remains in the base", () => {
    const rootDir = makeTempRoot();

    writeJson(
      rootDir,
      "shared/data/stablecoins/coins/sidecar-usd.json",
      makeCoin("sidecar-usd", { mica: { status: "out-of-scope" } }),
    );
    writeJson(rootDir, "shared/data/stablecoins/domains/compliance/sidecar-usd.json", {
      id: "sidecar-usd",
      genius: makeGeniusProfile(),
    });

    expect(() => loadPerCoinStablecoinEntries(rootDir)).toThrow(
      /field "mica" already exists in shared\/data\/stablecoins\/coins\/sidecar-usd\.json/,
    );
  });

  it("rejects unknown fields in strict sidecar schemas", () => {
    const rootDir = makeTempRoot();

    writeJson(rootDir, "shared/data/stablecoins/coins/sidecar-usd.json", makeCoin("sidecar-usd"));
    writeJson(rootDir, "shared/data/stablecoins/domains/reserves/sidecar-usd.json", {
      id: "sidecar-usd",
      reserves: makeReserves(),
      notes: "not part of the reserves sidecar schema",
    });

    expect(() => loadPerCoinStablecoinEntries(rootDir)).toThrow(/Unrecognized key/);
  });

  it("rejects unknown fields in research sidecar schemas through the loader", () => {
    const rootDir = makeTempRoot();

    writeJson(rootDir, "shared/data/stablecoins/coins/sidecar-usd.json", makeCoin("sidecar-usd"));
    writeJson(rootDir, "shared/data/stablecoins/domains/compliance/sidecar-usd.json", {
      id: "sidecar-usd",
      genius: makeGeniusProfile(),
      jurisdiction: { country: "US" },
    });

    expect(() => loadPerCoinStablecoinEntries(rootDir)).toThrow(/Unrecognized key/);
  });

  it("rejects unsupported sidecar domain directories", () => {
    const rootDir = makeTempRoot();

    writeJson(rootDir, "shared/data/stablecoins/coins/sidecar-usd.json", makeCoin("sidecar-usd"));
    writeJson(rootDir, "shared/data/stablecoins/domains/ratings/sidecar-usd.json", {
      id: "sidecar-usd",
      riskRating: "low",
    });

    expect(() => loadPerCoinStablecoinEntries(rootDir)).toThrow(
      /Unsupported stablecoin sidecar domain directories: shared\/data\/stablecoins\/domains\/ratings/,
    );
  });

  it("rejects research sidecars without a matching base coin", () => {
    const rootDir = makeTempRoot();

    writeJson(rootDir, "shared/data/stablecoins/coins/other-usd.json", makeCoin("other-usd"));
    writeJson(rootDir, "shared/data/stablecoins/domains/mint-authority/orphan-usd.json", {
      id: "orphan-usd",
      mintAuthority: makeMintAuthority(),
    });

    expect(() => loadPerCoinStablecoinEntries(rootDir)).toThrow(/no matching base coin found.*"orphan-usd"/);
  });

  it("keeps generated aggregate shape equivalent after splitting a sidecar field", () => {
    const rootDir = makeTempRoot();
    const reserves = makeReserves();
    const expectedCoin = makeCoin("split-usd", { reserves });

    writeJson(rootDir, "shared/data/stablecoins/coins/split-usd.json", makeCoin("split-usd"));
    writeJson(rootDir, "shared/data/stablecoins/domains/reserves/split-usd.json", {
      id: "split-usd",
      reserves,
    });
    writeJson(rootDir, "shared/data/stablecoins/coins.generated.json", []);

    const result = syncGeneratedPerCoinAsset({ rootDir });
    expect(result.changed).toBe(true);
    expect(loadGeneratedPerCoinCoins(rootDir)).toEqual([expectedCoin]);
  });

  it("builds merged output in deterministic per-coin file order", () => {
    const rootDir = makeTempRoot();

    writeJson(rootDir, "shared/data/stablecoins/coins/zeta-usd.json", makeCoin("zeta-usd"));
    writeJson(rootDir, "shared/data/stablecoins/coins/alpha-usd.json", makeCoin("alpha-usd"));
    writeJson(rootDir, "shared/data/stablecoins/domains/reserves/zeta-usd.json", {
      id: "zeta-usd",
      reserves: makeReserves(),
    });
    writeJson(rootDir, "shared/data/stablecoins/domains/reserves/alpha-usd.json", {
      id: "alpha-usd",
      reserves: makeReserves(),
    });

    const entries = loadPerCoinStablecoinEntries(rootDir);
    expect(entries.map((entry) => entry.id)).toEqual(["alpha-usd", "zeta-usd"]);
    expect(entries.map((entry) => entry.sidecarFiles)).toEqual([
      ["shared/data/stablecoins/domains/reserves/alpha-usd.json"],
      ["shared/data/stablecoins/domains/reserves/zeta-usd.json"],
    ]);
    expect(Object.keys(entries[0]!.coin)).toEqual(["id", "name", "symbol", "flags", "reserves"]);
    expect(buildGeneratedPerCoinAsset(entries).map((coin) => coin.id)).toEqual(["alpha-usd", "zeta-usd"]);
  });

  it("fails check mode when the generated per-coin aggregate is stale", () => {
    const rootDir = makeTempRoot();
    writeJson(rootDir, "shared/data/stablecoins/coins/per-coin-usd.json", makeCoin("per-coin-usd"));
    writeJson(rootDir, "shared/data/stablecoins/coins.generated.json", []);

    expect(() => syncGeneratedPerCoinAsset({ check: true, rootDir })).toThrow(/stale/);
  });

  it("writes the generated per-coin aggregate and then passes check mode", () => {
    const rootDir = makeTempRoot();
    const perCoin = makeCoin("per-coin-usd");

    writeJson(rootDir, "shared/data/stablecoins/coins/per-coin-usd.json", perCoin);
    writeJson(rootDir, "shared/data/stablecoins/coins.generated.json", []);

    const result = syncGeneratedPerCoinAsset({ rootDir });
    expect(result.changed).toBe(true);
    expect(loadGeneratedPerCoinCoins(rootDir)).toEqual([perCoin]);
    expect(() => syncGeneratedPerCoinAsset({ check: true, rootDir })).not.toThrow();
  });

  it("can replace a stale aggregate that no longer satisfies catalog-level invariants", () => {
    const rootDir = makeTempRoot();
    const perCoin = makeCoin("per-coin-usd");

    writeJson(rootDir, "shared/data/stablecoins/coins/per-coin-usd.json", perCoin);
    writeJson(rootDir, "shared/data/stablecoins/coins.generated.json", [
      makeCoin("stale-variant-usd", {
        variantOf: "parent-usd",
        variantKind: "savings-passthrough",
      }),
    ]);

    const result = syncGeneratedPerCoinAsset({ rootDir });
    expect(result.changed).toBe(true);
    expect(loadGeneratedPerCoinCoins(rootDir)).toEqual([perCoin]);
  });

  it("validates the newly generated aggregate before writing it", () => {
    const rootDir = makeTempRoot();

    writeJson(rootDir, "shared/data/stablecoins/coins/parent-usd.json", makeCoin("parent-usd"));
    writeJson(
      rootDir,
      "shared/data/stablecoins/coins/variant-usd.json",
      makeCoin("variant-usd", {
        flags: {
          backing: "rwa-backed",
          pegCurrency: "USD",
          governance: "centralized",
          yieldBearing: false,
          rwa: false,
          navToken: true,
        },
        variantKind: "savings-passthrough",
        variantOf: "parent-usd",
      }),
    );
    writeJson(rootDir, "shared/data/stablecoins/coins.generated.json", []);

    expect(() => syncGeneratedPerCoinAsset({ rootDir })).toThrow(/active variants require mintAuthority review/);
  });

  it("rejects copied per-coin files before generating the aggregate", () => {
    const rootDir = makeTempRoot();
    const duplicateCoin = makeCoin("duplicate-usd");

    writeJson(rootDir, "shared/data/stablecoins/coins/duplicate-usd.json", duplicateCoin);
    writeJson(rootDir, "shared/data/stablecoins/coins/duplicate-usd-copy.json", duplicateCoin);
    writeJson(rootDir, "shared/data/stablecoins/coins.generated.json", []);

    expect(() => syncGeneratedPerCoinAsset({ rootDir })).toThrow(
      /coin id "duplicate-usd" must match file id "duplicate-usd-copy"/,
    );
  });
});
