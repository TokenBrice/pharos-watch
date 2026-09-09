import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  STABLECOIN_SOURCE_DOMAIN_FIELDS,
  type StablecoinSourceDomain,
} from "@shared/lib/stablecoins/schema";
import {
  buildGeneratedPerCoinAsset,
  findCanonicalOrderIssues,
  findDuplicateStablecoinIds,
  findRecreatedRetiredStablecoinAssetFiles,
  loadGeneratedPerCoinCoins,
  loadPerCoinStablecoinEntries,
  loadStablecoinDomainSidecarEntries,
  syncGeneratedPerCoinAsset,
  type StablecoinSourceEntry,
} from "../lib/stablecoin-catalog-sources";
import { createTempRepoTracker } from "./helpers/test-state";
import {
  makeCoin, makeReserves, makeReserveReview, makeCustodyProfile,
  makeMintAuthority, makeGeniusProfile, makeRiskReview,
} from "./stablecoin-catalog.test-support";

const { cleanup, makeRoot: makeTempRoot, writeJson } = createTempRepoTracker("stablecoin-catalog");

function makeEntry(id: string, file: string): StablecoinSourceEntry {
  return {
    coin: makeCoin(id),
    file,
    id,
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
    const { blacklistabilityReview, oracleRisk, bridgeRouteRisk } = makeRiskReview();

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

// Real composed-record coverage. Since the domain split, a base coin file is only
// one projection of an asset, and the catalog schema's cross-domain refinements
// (PoR lockstep, reserveReview-needs-reserves, inherited mint authority) can only
// be satisfied by the merged record. The loader owns that merge, so these four
// assets are covered here rather than through a filesystem composer in the schema
// suite: usdt-tether carries an issuer attestation, asusdf-astherus and susds-sky
// are live-fed wrappers, stusd-stoneyield is a curated-only wrapper.
describe("real stablecoin catalog composed records", () => {
  const REPO_ROOT = resolve(import.meta.dirname, "../..");
  let composedEntries: StablecoinSourceEntry[] = [];

  beforeAll(() => {
    composedEntries = loadPerCoinStablecoinEntries(REPO_ROOT);
  });

  function composedEntry(id: string): StablecoinSourceEntry {
    const entry = composedEntries.find((candidate) => candidate.id === id);
    if (entry == null) {
      throw new Error(`${id} is not a tracked per-coin stablecoin source file`);
    }
    return entry;
  }

  function domainFields(coin: StablecoinSourceEntry["coin"], domain: StablecoinSourceDomain): string[] {
    const fields: readonly Exclude<keyof StablecoinSourceEntry["coin"], "id">[] =
      STABLECOIN_SOURCE_DOMAIN_FIELDS[domain];
    return fields.filter((field) => coin[field] != null);
  }

  it("keeps usdt-tether's proof-of-reserves and curated composition in lockstep across files", () => {
    const entry = composedEntry("usdt-tether");
    const { coin } = entry;

    expect(entry.sidecarFiles).toEqual([
      "shared/data/stablecoins/domains/compliance/usdt-tether.json",
      "shared/data/stablecoins/domains/mint-authority/usdt-tether.json",
      "shared/data/stablecoins/domains/reserves/usdt-tether.json",
      "shared/data/stablecoins/domains/risk-review/usdt-tether.json",
    ]);
    // proofOfReserves stays in the base file, compositionAsOf in the reserves
    // sidecar; only the merged record can satisfy the lockstep refinement.
    const periodEnd = coin.proofOfReserves?.latestReport?.periodEnd;
    expect(periodEnd).toBeDefined();
    expect(coin.reserveReview?.compositionAsOf).toBe(periodEnd);
    expect(coin.reserves?.length).toBeGreaterThan(1);
    expect(coin.reserves?.filter((reserve) => reserve.coinId != null)).toEqual([]);
    expect(coin.reserveReview?.knownUnknownExposurePct).toBeGreaterThan(0);
    expect(coin.liveReservesConfig?.semantics).toBe("attestation-mix");
    expect(coin.mintAuthority?.mintPath).toBe("issuer-direct-mint");
    expect(domainFields(coin, "compliance")).toEqual(["mica", "genius"]);
    expect(domainFields(coin, "risk-review")).toEqual(["blacklistabilityReview", "bridgeRouteRisk"]);
  });

  it("agrees on asusdf-astherus's wrapper parent across base, mint-authority, and reserves files", () => {
    const { coin } = composedEntry("asusdf-astherus");

    expect(coin.variantOf).toBe("usdf-astherus");
    expect(coin.pegReferenceId).toBe(coin.variantOf);
    expect(coin.flags.navToken).toBe(true);
    expect(coin.mintAuthority?.mintPath).toBe("wrapped-or-variant-inherited");
    expect(coin.mintAuthority?.inheritedFrom).toBe(coin.variantOf);
    expect(coin.reserves).toEqual([
      expect.objectContaining({ coinId: coin.variantOf, depType: "wrapper", pct: 100 }),
    ]);
    expect(coin.liveReservesConfig?.semantics).toBe("single-asset");
    expect(coin.custodyProfile).toBeDefined();
    expect(domainFields(coin, "risk-review")).toEqual(["blacklistabilityReview", "oracleRisk"]);
  });

  it("composes susds-sky's review-backed wrapper composition with no attestation or custody evidence", () => {
    const { coin } = composedEntry("susds-sky");

    expect(coin.variantOf).toBe("usds-sky");
    expect(coin.variantKind).toBe("savings-passthrough");
    expect(coin.mintAuthority?.inheritedFrom).toBe(coin.variantOf);
    expect(coin.reserves).toEqual([
      expect.objectContaining({ coinId: coin.variantOf, depType: "wrapper", pct: 100 }),
    ]);
    expect(coin.reserveReview?.scope).toBe("full-composition");
    // The lockstep pair stays silent here: the sidecar review has no base-file
    // attestation to agree with, and this reserves sidecar omits custody entirely.
    expect(coin.proofOfReserves).toBeUndefined();
    expect(coin.custodyProfile).toBeUndefined();
    expect(coin.liveReservesConfig?.semantics).toBe("single-asset");
    expect(domainFields(coin, "risk-review")).toEqual([
      "blacklistabilityReview",
      "oracleRisk",
      "bridgeRouteRisk",
    ]);
  });

  it("composes stusd-stoneyield as a curated-only wrapper with no live reserve feed", () => {
    const { coin } = composedEntry("stusd-stoneyield");

    expect(coin.variantOf).toBe("usdc-circle");
    expect(coin.variantKind).toBe("strategy-vault");
    expect(coin.mintAuthority?.inheritedFrom).toBe(coin.variantOf);
    expect(coin.liveReservesConfig).toBeUndefined();
    expect(coin.proofOfReserves).toBeUndefined();
    expect(coin.reserves).toEqual([
      expect.objectContaining({ coinId: coin.variantOf, depType: "wrapper", pct: 100 }),
    ]);
    expect(coin.custodyProfile?.segregation).toBe("unknown");
    expect(coin.notices?.map((notice) => notice.type)).toEqual(["warning"]);
    expect(domainFields(coin, "risk-review")).toEqual(["blacklistabilityReview"]);
  });
});
