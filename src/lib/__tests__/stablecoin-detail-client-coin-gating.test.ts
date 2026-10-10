// src/lib/__tests__/stablecoin-detail-client-coin-gating.test.ts
import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
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
  it("shows oracle but hides custody for a cdp archetype with no explicit custodyModel", () => {
    const clientCoin = buildStablecoinDetailClientCoin(coinWith({ mechanismArchetype: "cdp" }));
    expect(clientCoin.oracleRiskSummary).toBeDefined();
    expect("custodyProfileSummary" in clientCoin).toBe(false);
  });

  it("shows custody and available oracle data for a fiat-cash archetype with no explicit custodyModel", () => {
    const clientCoin = buildStablecoinDetailClientCoin(coinWith({ mechanismArchetype: "fiat-cash" }));
    expect(clientCoin.custodyProfileSummary).toBeDefined();
    expect(clientCoin.oracleRiskSummary).toBeDefined();
  });

  it("shows custody for a cdp archetype when an explicit centralized custodyModel is set", () => {
    const clientCoin = buildStablecoinDetailClientCoin(
      coinWith({ mechanismArchetype: "cdp", custodyModel: "institutional-regulated" }),
    );
    expect(clientCoin.custodyProfileSummary).toBeDefined();
  });

  it("attaches the reserve quality summary while stripping the server-only reserve review", () => {
    const clientCoin = buildStablecoinDetailClientCoin(
      coinWith({ reserves: RESERVES_WITH_QUALITY, reserveReview: RESERVE_REVIEW }),
    );
    expect(clientCoin.reserveQualitySummary).toBeDefined();
    expect(clientCoin.reserveQualitySummary!.chipLabel).toBe("Highly liquid");
    expect("reserveReview" in clientCoin).toBe(false);
  });

  it("hides reserve quality for reserve slices with no quality attributes", () => {
    const clientCoin = buildStablecoinDetailClientCoin(
      coinWith({ reserves: [{ name: "Cash", pct: 100, risk: "very-low" }], reserveReview: RESERVE_REVIEW }),
    );
    expect("reserveQualitySummary" in clientCoin).toBe(false);
    expect("reserveReview" in clientCoin).toBe(false);
  });

  it("de-duplicates mint-authority review and incident sources by URL", () => {
    const clientCoin = buildStablecoinDetailClientCoin(coinWith({
      mintAuthority: {
        mintPath: "issuer-direct-mint",
        authorityPosture: "concentrated-admin",
        confidence: "verified",
        summary: "Issuer backend can mint through reviewed operator controls.",
        review: {
          sources: [
            { label: "Review", url: "https://example.com/review" },
            { label: "Review mirror", url: "https://example.com/review" },
          ],
        },
        mintIncidents: [{
          date: "2025-02-01",
          status: "active",
          summary: "Privileged mint incident.",
          sources: [
            { label: "Thread", url: "https://example.com/thread" },
            { label: "Thread mirror", url: "https://example.com/thread" },
          ],
        }],
      },
    }));

    expect(clientCoin.mintAuthoritySummary?.sources).toEqual([
      { label: "Review", url: "https://example.com/review" },
      { label: "Thread", url: "https://example.com/thread" },
    ]);
    expect(clientCoin.mintAuthoritySummary?.mintIncidents?.[0]?.sources).toEqual([
      { label: "Thread", url: "https://example.com/thread" },
    ]);
  });

  it("omits empty-label mint-authority links before deduplication across summary, incident and custody sources", () => {
    const base = TRACKED_META_BY_ID.get("usdt-tether")!;
    const sources = [
      { label: "", url: "https://example.com/evidence" },
      { label: "Evidence", url: "https://example.com/evidence" },
      { label: "", url: "https://example.com/empty-label" },
    ];
    const coin: StablecoinMeta = {
      ...base,
      mintAuthority: {
        mintPath: "issuer-direct-mint", authorityPosture: "concentrated-admin", confidence: "verified",
        summary: "Issuer backend can mint through reviewed operator controls.",
        review: {
          evidence: "Reviewed backend signer custody documentation.", reviewer: "test", reviewedAt: "2026-10-01", sources,
        },
        mintIncidents: [{
          date: "2025-02-01", status: "active", summary: "Privileged mint incident.", sources,
        }],
        controls: [{
          label: "Backend signer", role: "backend-signer", authorityType: "issuer-backend", directMintAbility: "direct",
          keyCustodyAttestation: { kind: "hsm", sources },
        }],
      },
    };
    const summary = buildStablecoinDetailClientCoin(coin).mintAuthoritySummary!;
    const expected = [{ label: "Evidence", url: "https://example.com/evidence" }];

    expect(summary.sources).toEqual(expected);
    expect(summary.mintIncidents?.[0]?.sources).toEqual(expected);
    expect(summary.controls?.[0]?.keyCustodyAttestation?.sources).toEqual(expected);
  });

  it("projects only allowed mint-authority fields across the validated registry and inherited parents", () => {
    const summaryKeys = ["mintPath", "authorityPosture", "confidence", "summary", "headline", "inheritedFrom",
      "mintIncidents", "controls", "totalControlCount", "controlCensusUrl", "sources", "reviewedAt",
      "sourceFreeRationale", "unresolvedQuestions"];
    const controlKeys = ["label", "role", "authorityType", "directMintAbility", "chain", "address", "threshold",
      "signerCount", "timelockDelaySec", "capDescription", "canRaiseCap", "modulesOrGuardsStatus", "keyCustodyAttestation"];
    const priority = ["direct", "can-authorize", "unknown", "cap-limited", "upgrade-only", "parameter-only", "none"];
    let checked = 0;
    for (const coin of TRACKED_META_BY_ID.values()) {
      const client = buildStablecoinDetailClientCoin(coin, { parentById: TRACKED_META_BY_ID });
      const profile = coin.mintAuthority;
      if (!profile) {
        expect(client).not.toHaveProperty("mintAuthoritySummary");
        continue;
      }
      const summary = client.mintAuthoritySummary!;
      expect(Object.keys(summary).every((key) => summaryKeys.includes(key)), coin.id).toBe(true);
      expect(summary).toMatchObject({
        mintPath: profile.mintPath, authorityPosture: profile.authorityPosture,
        confidence: profile.confidence, summary: profile.summary,
      });
      const authored = profile.controls ?? [];
      const selected = authored.length > MAX_MINT_AUTHORITY_DETAIL_CONTROLS
        ? [...authored].sort((a, b) => priority.indexOf(a.directMintAbility) - priority.indexOf(b.directMintAbility))
            .slice(0, MAX_MINT_AUTHORITY_DETAIL_CONTROLS)
        : authored;
      expect(summary.controls?.map((control) => control.label) ?? []).toEqual(selected.map((control) => control.label));
      for (const control of summary.controls ?? []) {
        expect(Object.keys(control).every((key) => controlKeys.includes(key)), coin.id).toBe(true);
        if (control.keyCustodyAttestation) expect(Object.keys(control.keyCustodyAttestation)).toEqual(["kind", "sources"]);
      }
      expect(new Set(summary.sources?.map((source) => source.url)).size).toBe(summary.sources?.length ?? 0);
      if (profile.inheritedFrom && TRACKED_META_BY_ID.get(profile.inheritedFrom)?.mintAuthority) {
        expect(client.mintAuthorityParentSummaries?.[profile.inheritedFrom]).toEqual(
          buildStablecoinDetailClientCoin(TRACKED_META_BY_ID.get(profile.inheritedFrom)!).mintAuthoritySummary,
        );
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });
});
