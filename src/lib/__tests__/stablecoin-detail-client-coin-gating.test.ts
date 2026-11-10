// src/lib/__tests__/stablecoin-detail-client-coin-gating.test.ts
import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import { MAX_MINT_AUTHORITY_DETAIL_CONTROLS } from "../stablecoin-detail-mint-authority-client";
import { buildStablecoinDetailClientCoin } from "../stablecoin-detail-client-coin";

const CUSTODY_PROFILE = {
  providers: [{ name: "Example Custodian", role: "custodian", sharePct: 100 }],
  segregation: "segregated",
  bankruptcyRemoteness: "contractual-only",
  rehypothecation: "prohibited",
  reviewedAt: "2026-07-17",
  reviewer: "Kimi FIAT-CTRL shard-11",
  confidence: "verified",
  sources: [],
  uncertainty: "",
};

const ORACLE_RISK = {
  tier: "redundant-with-failover",
  summary: "External feeds with response validation.",
};

const RESERVES_WITH_QUALITY = [
  { name: "U.S. Treasury bills", pct: 80, risk: "very-low", assetClass: "treasury-bill", liquidityHorizon: "one-day" },
  { name: "Bank deposits", pct: 20, risk: "low", assetClass: "bank-deposit", liquidityHorizon: "immediate" },
];

const RESERVE_REVIEW = {
  reviewedAt: "2026-07-18",
  reviewer: "Kimi RESERVE shard-3",
  confidence: "verified",
  sources: [],
  rationale: "Server-only rationale.",
  compositionBasis: "Monthly attestation composition table.",
  scope: "full-composition",
  knownUnknownExposure: "No undisclosed obligors.",
  knownUnknownExposurePct: 0,
};

const MINT_AUTHORITY_SUMMARY_KEYS = ["mintPath", "authorityPosture", "confidence", "summary", "headline", "inheritedFrom",
  "mintIncidents", "controls", "totalControlCount", "controlCensusUrl", "sources", "reviewedAt",
  "sourceFreeRationale", "unresolvedQuestions"];

const MINT_AUTHORITY_CONTROL_KEYS = ["label", "role", "authorityType", "directMintAbility", "chain", "address", "threshold",
  "signerCount", "timelockDelaySec", "capDescription", "canRaiseCap", "modulesOrGuardsStatus", "keyCustodyAttestation"];

function coinWith(overrides: Record<string, unknown>): StablecoinMeta {
  return {
    id: "test-coin",
    flags: {
      backing: "crypto-backed",
      governance: "decentralized",
      pegCurrency: "USD",
      rwa: false,
      navToken: false,
      yieldBearing: false,
    },
    custodyProfile: CUSTODY_PROFILE,
    oracleRisk: ORACLE_RISK,
    ...overrides,
  } as unknown as StablecoinMeta;
}

describe("buildStablecoinDetailClientCoin display gating", () => {
  it("attaches the reserve quality summary while stripping the server-only reserve review", () => {
    const clientCoin = buildStablecoinDetailClientCoin(
      coinWith({ reserves: RESERVES_WITH_QUALITY, reserveReview: RESERVE_REVIEW }),
    );
    expect(clientCoin.reserveQualitySummary).toBeDefined();
    expect(clientCoin.reserveQualitySummary!.chipLabel).toBe("Highly liquid");
    expect("reserveReview" in clientCoin).toBe(false);
  });

  it("projects reserve provenance only when slices miss a quality attribute", () => {
    const clientCoin = buildStablecoinDetailClientCoin(
      coinWith({ reserves: [{ name: "Cash", pct: 100, risk: "very-low" }], reserveReview: RESERVE_REVIEW }),
    );
    expect(clientCoin.reserveQualitySummary?.provenanceOnly).toBe(true);
    expect(clientCoin.reserveQualitySummary?.chipLabel).toBeNull();
    expect(clientCoin.reserveQualitySummary?.reviewedAt).toBe("2026-07-18");
    expect("reserveReview" in clientCoin).toBe(false);
  });

  it("projects only allowlisted mint-authority fields and keeps an overflowing census in display priority", () => {
    const abilities = ["none", "parameter-only", "upgrade-only", "cap-limited", "unknown", "can-authorize", "direct"] as const;
    const controls = [...abilities, ...abilities].map((directMintAbility, index) => ({
      label: `control-${index}`,
      role: "minter",
      authorityType: "contract",
      directMintAbility,
      chain: "ethereum",
      address: `0x${String(index).padStart(40, "0")}`,
      threshold: 2,
      signerCount: 3,
      timelockDelaySec: 0,
      capDescription: "Bounded by the reviewed minter allowance.",
      canRaiseCap: true,
      modulesOrGuardsStatus: "verified",
      keyCustodyAttestation: {
        kind: "multisig",
        sources: [{ label: "Custody attestation", url: "https://example.com/custody" }],
      },
    }));
    const client = buildStablecoinDetailClientCoin(coinWith({
      mintAuthority: {
        mintPath: "issuer-direct-mint",
        authorityPosture: "unbounded-reconciled",
        confidence: "verified",
        summary: "Fixture mint authority summary.",
        headline: "Fixture headline",
        controls,
        review: { reviewedAt: "2026-07-18", sourceFreeRationale: "Server-only rationale." },
      },
    }));
    const summary = client.mintAuthoritySummary!;
    expect(Object.keys(summary).every((key) => MINT_AUTHORITY_SUMMARY_KEYS.includes(key))).toBe(true);
    expect(summary.controls).toHaveLength(MAX_MINT_AUTHORITY_DETAIL_CONTROLS);
    // Display priority is direct first; the two lowest-priority controls drop out.
    expect(summary.controls?.map((control) => control.label)).toEqual([
      "control-6", "control-13", "control-5", "control-12", "control-4", "control-11",
      "control-3", "control-10", "control-2", "control-9", "control-1", "control-8",
    ]);
    expect(summary.totalControlCount).toBe(controls.length);
    expect(summary.controlCensusUrl).toContain("/mint-authority/test-coin.json");
    for (const control of summary.controls ?? []) {
      expect(Object.keys(control).every((key) => MINT_AUTHORITY_CONTROL_KEYS.includes(key)), control.label).toBe(true);
      expect(Object.keys(control.keyCustodyAttestation!)).toEqual(["kind", "sources"]);
    }
    expect(new Set(summary.sources?.map((source) => source.url)).size).toBe(summary.sources?.length ?? 0);
    expect(client).not.toHaveProperty("mintAuthority");
    expect(client).not.toHaveProperty("mintAuthorityParentSummaries");
    expect(buildStablecoinDetailClientCoin(coinWith({}))).not.toHaveProperty("mintAuthoritySummary");
  });
});
