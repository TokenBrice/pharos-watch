import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources";
import { migrateStablecoinSidecar } from "../lib/stablecoin-sidecar-workflow";
import { parseStablecoinSidecarMigrationArgs } from "../maintenance/migrate-stablecoin-sidecar";
import { createTempRepoTracker } from "./helpers/test-state";
import {
  makeCoin as makeCatalogCoin, makeReserveReview, makeCustodyProfile,
  makeMintAuthority, makeGeniusProfile, makeRiskReview,
} from "./stablecoin-catalog.test-support";

const { cleanup, makeRoot: makeTempRoot, writeJson } = createTempRepoTracker("stablecoin-sidecar-workflow");

function readJson(rootDir: string, relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(rootDir, relativePath), "utf8")) as Record<string, unknown>;
}

function makeCoin(id: string, overrides: Record<string, unknown>): Record<string, unknown> {
  const coin = makeCatalogCoin(id);
  return { ...coin, symbol: "SIDE", flags: { ...coin.flags, rwa: true }, ...overrides };
}

const mintAuthority = makeMintAuthority();
const genius = makeGeniusProfile();
const reserveReview = makeReserveReview(null);
const custodyProfile = makeCustodyProfile();

afterEach(cleanup);

describe("stablecoin sidecar migration workflow", () => {
  const cases = [
    {
      domain: "reserves" as const,
      fields: {
        reserves: [{ name: "Cash", pct: 100, risk: "very-low" }],
        reserveReview,
        custodyProfile,
      },
      expectedFields: ["reserves", "reserveReview", "custodyProfile"],
    },
    {
      domain: "mint-authority" as const,
      fields: { mintAuthority },
      expectedFields: ["mintAuthority"],
    },
    {
      domain: "compliance" as const,
      fields: { mica: { status: "out-of-scope" }, genius },
      expectedFields: ["mica", "genius"],
    },
    {
      domain: "risk-review" as const,
      fields: makeRiskReview(),
      expectedFields: ["blacklistabilityReview", "oracleRisk", "bridgeRouteRisk"],
    },
  ];

  for (const migrationCase of cases) {
    it(`moves ${migrationCase.domain} without changing the merged projection`, () => {
      const rootDir = makeTempRoot();
      const id = `${migrationCase.domain}-usd`;
      const original = makeCoin(id, migrationCase.fields);
      const baseFile = `shared/data/stablecoins/coins/${id}.json`;
      const sidecarFile = `shared/data/stablecoins/domains/${migrationCase.domain}/${id}.json`;
      writeJson(rootDir, baseFile, original);

      const result = migrateStablecoinSidecar({ domain: migrationCase.domain, id, rootDir });

      expect(result).toMatchObject({ changed: true, movedFields: migrationCase.expectedFields });
      const base = readJson(rootDir, baseFile);
      for (const field of migrationCase.expectedFields) {
        expect(base).not.toHaveProperty(field);
      }
      expect(readJson(rootDir, sidecarFile)).toMatchObject({ id, ...migrationCase.fields });
      expect(readFileSync(join(rootDir, sidecarFile), "utf8")).toBe(
        `${JSON.stringify({ id, ...migrationCase.fields }, null, 2)}\n`,
      );
      expect(loadPerCoinStablecoinEntries(rootDir)[0]?.coin).toEqual(original);
      expect(() => migrateStablecoinSidecar({ check: true, domain: migrationCase.domain, id, rootDir })).not.toThrow();
    });
  }

  it("migrates another domain over existing reserves without changing either projection or sidecar bytes", () => {
    const rootDir = makeTempRoot();
    const id = "layered-usd";
    const baseFile = `shared/data/stablecoins/coins/${id}.json`;
    const reservesFile = `shared/data/stablecoins/domains/reserves/${id}.json`;
    const original = makeCoin(id, {
      mintAuthority,
      liveReservesConfig: {
        adapter: "curated-validated", version: 1, semantics: "attestation-mix",
        breakerScope: id,
        display: { url: "https://example.com/reserves", label: "Reserves" },
        inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
      },
    });
    const reserves = [{ name: "Cash", pct: 100, risk: "very-low" }];
    writeJson(rootDir, baseFile, original);
    writeJson(rootDir, reservesFile, { id, reserves });
    const bytes = readFileSync(join(rootDir, reservesFile), "utf8");
    const before = loadPerCoinStablecoinEntries(rootDir)[0]?.coin;

    migrateStablecoinSidecar({ domain: "mint-authority", id, rootDir });

    expect(loadPerCoinStablecoinEntries(rootDir)[0]?.coin).toEqual(before);
    expect(readFileSync(join(rootDir, reservesFile), "utf8")).toBe(bytes);
    expect(readJson(rootDir, baseFile)).not.toHaveProperty("mintAuthority");
    expect(readJson(rootDir, `shared/data/stablecoins/domains/mint-authority/${id}.json`))
      .toEqual({ id, mintAuthority });
  });

  it("leaves base bytes and destination untouched when the merged projection is invalid", () => {
    const rootDir = makeTempRoot();
    const id = "invalid-merged-usd";
    const baseFile = `shared/data/stablecoins/coins/${id}.json`;
    const destination = join(rootDir, `shared/data/stablecoins/domains/mint-authority/${id}.json`);
    writeJson(rootDir, baseFile, makeCoin(id, { mintAuthority }));
    writeJson(rootDir, `shared/data/stablecoins/domains/reserves/${id}.json`, { id, reserveReview });
    const bytes = readFileSync(join(rootDir, baseFile), "utf8");

    expect(() => migrateStablecoinSidecar({ domain: "mint-authority", id, rootDir }))
      .toThrow(/reserveReview requires a reserve composition/);
    expect(readFileSync(join(rootDir, baseFile), "utf8")).toBe(bytes);
    expect(existsSync(destination)).toBe(false);
  });

  it("keeps dry runs read-only", () => {
    const rootDir = makeTempRoot();
    const id = "dry-run-usd";
    const baseFile = `shared/data/stablecoins/coins/${id}.json`;
    writeJson(rootDir, baseFile, makeCoin(id, { mintAuthority }));
    const before = readFileSync(join(rootDir, baseFile), "utf8");

    const result = migrateStablecoinSidecar({
      domain: "mint-authority",
      dryRun: true,
      id,
      rootDir,
    });

    expect(result.changed).toBe(true);
    expect(readFileSync(join(rootDir, baseFile), "utf8")).toBe(before);
    expect(() =>
      readFileSync(join(rootDir, `shared/data/stablecoins/domains/mint-authority/${id}.json`), "utf8"),
    ).toThrow();
  });

  it("rejects partial migrations and check-mode base fields", () => {
    const rootDir = makeTempRoot();
    const id = "partial-usd";
    writeJson(
      rootDir,
      `shared/data/stablecoins/coins/${id}.json`,
      makeCoin(id, { mica: { status: "out-of-scope" }, genius }),
    );
    writeJson(rootDir, `shared/data/stablecoins/domains/compliance/${id}.json`, { id, genius });

    expect(() => migrateStablecoinSidecar({ check: true, domain: "compliance", id, rootDir })).toThrow(
      /still contains compliance fields/,
    );
    expect(() => migrateStablecoinSidecar({ domain: "compliance", id, rootDir })).toThrow(/partial migration/);
  });

  it("checks an existing sidecar ID against the requested filename ID", () => {
    const rootDir = makeTempRoot();
    const id = "expected-usd";
    writeJson(rootDir, `shared/data/stablecoins/coins/${id}.json`, makeCoin(id, {}));
    writeJson(rootDir, `shared/data/stablecoins/domains/compliance/${id}.json`, {
      id: "different-usd",
      genius,
    });

    expect(() => migrateStablecoinSidecar({ check: true, domain: "compliance", id, rootDir })).toThrow(
      /contains id "different-usd", expected "expected-usd"/,
    );
  });
});

describe("stablecoin sidecar migration CLI", () => {
  it("parses repeated IDs and safe modes", () => {
    expect(
      parseStablecoinSidecarMigrationArgs([
        "--domain",
        "compliance",
        "--id",
        "usdc-circle",
        "--id",
        "pyusd-paypal",
        "--dry-run",
      ]),
    ).toEqual({
      check: false,
      domain: "compliance",
      dryRun: true,
      help: false,
      ids: ["usdc-circle", "pyusd-paypal"],
    });
  });

  it("rejects unknown domains, missing IDs, and conflicting modes", () => {
    expect(() => parseStablecoinSidecarMigrationArgs(["--domain", "ratings", "--id", "usdc-circle"])).toThrow(
      /--domain must be one of/,
    );
    expect(() => parseStablecoinSidecarMigrationArgs(["--domain", "compliance"])).toThrow(/at least one --id/);
    expect(() =>
      parseStablecoinSidecarMigrationArgs(["--domain", "compliance", "--id", "usdc-circle", "--check", "--dry-run"]),
    ).toThrow(/cannot be used together/);
  });
});
