import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { analyzeAttestorTierCoverage } from "../lib/attestor-tier-coverage";
import type { StablecoinMeta } from "../../shared/types";

const baseFlags = {
  backing: "rwa-backed",
  pegCurrency: "USD",
  governance: "centralized",
  yieldBearing: false,
  rwa: false,
  navToken: false,
} as const;

function makeCoin(id: string, overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return {
    id,
    name: id,
    symbol: id.toUpperCase(),
    flags: baseFlags,
    ...overrides,
  };
}

function audit(id: string, withTier: boolean): StablecoinMeta {
  return makeCoin(id, {
    proofOfReserves: {
      type: "independent-audit",
      url: "https://example.com/audit",
      ...(withTier ? { attestorTier: "big4" } : {}),
    },
  });
}

describe("analyzeAttestorTierCoverage", () => {
  it("passes when 0% of independent-audit coins are missing attestorTier", () => {
    const coins = [audit("a", true), audit("b", true), audit("c", true)];

    const result = analyzeAttestorTierCoverage(coins);

    expect(result.total).toBe(3);
    expect(result.withTier).toBe(3);
    expect(result.withoutTier).toBe(0);
    expect(result.missingIds).toEqual([]);
    expect(result.missingRatio).toBe(0);
  });

  it("reports under-threshold coverage without failing", () => {
    const withTier = Array.from({ length: 9 }, (_value, index) => audit(`with-${index}`, true));
    const withoutTier = [audit("missing-1", false)];

    const result = analyzeAttestorTierCoverage([...withTier, ...withoutTier]);

    expect(result.total).toBe(10);
    expect(result.withoutTier).toBe(1);
    expect(result.missingIds).toEqual(["missing-1"]);
    expect(result.missingRatio).toBeCloseTo(0.1);
  });

  it("flags over-threshold coverage with the missing ids listed alphabetically", () => {
    const coins = [
      audit("delta", true),
      audit("charlie", false),
      audit("alpha", false),
      audit("bravo", false),
    ];

    const result = analyzeAttestorTierCoverage(coins);

    expect(result.total).toBe(4);
    expect(result.withoutTier).toBe(3);
    expect(result.missingRatio).toBe(0.75);
    expect(result.missingIds).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("ignores coins without an independent-audit proofOfReserves entry", () => {
    const coins = [
      makeCoin("no-por"),
      makeCoin("self-reported", {
        proofOfReserves: { type: "self-reported", url: "https://example.com" },
      }),
      audit("audited", true),
    ];

    const result = analyzeAttestorTierCoverage(coins);

    expect(result.total).toBe(1);
    expect(result.withTier).toBe(1);
    expect(result.missingIds).toEqual([]);
  });
});

describe("check-attestor-tier-coverage CLI", () => {
  it("exits 0 on the current repo data", () => {
    const stdout = execFileSync("npx", ["tsx", "scripts/ci/check-attestor-tier-coverage.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(stdout).toMatch(/attestorTier coverage OK/);
  });
});
