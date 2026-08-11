import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources";
import { migrateStablecoinSidecar } from "../lib/stablecoin-sidecar-workflow";
import { parseStablecoinSidecarMigrationArgs } from "../maintenance/migrate-stablecoin-sidecar";

const tempDirs: string[] = [];

function makeTempRoot(): string {
  const rootDir = mkdtempSync(join(tmpdir(), "stablecoin-sidecar-workflow-"));
  tempDirs.push(rootDir);
  return rootDir;
}

function writeJson(rootDir: string, relativePath: string, value: unknown): void {
  const absolutePath = join(rootDir, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(rootDir: string, relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(rootDir, relativePath), "utf8")) as Record<string, unknown>;
}

function makeCoin(id: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    name: `${id} Coin`,
    symbol: "SIDE",
    flags: {
      backing: "rwa-backed",
      pegCurrency: "USD",
      governance: "centralized",
      yieldBearing: false,
      rwa: true,
      navToken: false,
    },
    ...overrides,
  };
}

const mintAuthority = {
  mintPath: "unknown",
  authorityPosture: "unknown",
  confidence: "unknown",
  summary: "The fixture mint authority remains unresolved.",
  review: {
    sourceFreeRationale: "Workflow fixture without external research.",
    evidence: "The fixture records enough evidence text for strict schema validation.",
    reviewer: "test",
    reviewedAt: "2026-07-09",
  },
};

const genius = {
  applicability: "unclear",
  authorizationStatus: "unknown",
  issuerPathway: "unknown",
  reviewer: "test",
  reviewedAt: "2026-07-09",
};

const blacklistabilityReview = {
  reviewedStatus: true,
  sourceFreeRationale: "Workflow fixture without external research.",
  evidence: "The fixture models a direct blacklistability control surface.",
  reviewer: "test",
  reviewedAt: "2026-07-09",
};

const reserveReview = {
  reviewedAt: "2026-07-12",
  reviewer: "test",
  confidence: "verified",
  sources: [{ label: "Reserve report", url: "https://example.com/reserves" }],
  rationale: "The fixture reserve composition was reviewed.",
  compositionBasis: "issuer disclosure",
  scope: "full-composition",
  knownUnknownExposure: "None identified in the fixture.",
  knownUnknownExposurePct: 0,
};

const custodyProfile = {
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

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
      fields: {
        blacklistabilityReview,
        oracleRisk: {
          tier: "opaque-or-unknown",
          summary: "The fixture oracle design remains unknown.",
        },
        bridgeRouteRisk: {
          tier: "opaque-or-unknown",
          summary: "The fixture bridge route remains unknown.",
          reviewedAt: "2026-07-09",
          reviewer: "test",
          confidence: "unknown",
          sourceFreeRationale: "Workflow fixture without external research.",
        },
      },
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
