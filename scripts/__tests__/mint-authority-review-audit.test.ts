import { describe, expect, it } from "vitest";
import {
  buildMintAuthorityReviewAudit,
  renderMintAuthorityReviewAuditMarkdown,
} from "../lib/mint-authority-review-audit";
import { parseArgs } from "../maintenance/generate-mint-authority-review-audit";
import type { StablecoinMeta } from "../../shared/types";

function coin(overrides: Partial<StablecoinMeta> & Pick<StablecoinMeta, "id" | "symbol">): StablecoinMeta {
  return {
    name: overrides.symbol,
    flags: {
      pegCurrency: "USD",
      governance: "centralized",
      backing: "fiat-backed",
    },
    status: "active",
    ...overrides,
  } as StablecoinMeta;
}

describe("mint-authority-review-audit", () => {
  it("builds static advisory queues from mint authority metadata", () => {
    const audit = buildMintAuthorityReviewAudit({
      generatedAt: "2026-06-18T00:00:00.000Z",
      coins: [
        coin({ id: "missing", symbol: "MIS" }),
        coin({
          id: "bridge",
          symbol: "BRG",
          mintAuthority: {
            mintPath: "bridge-or-oft-synthetic",
            authorityPosture: "concentrated-admin",
            confidence: "verified",
            summary: "Fireblocks MPC custody is described for the bridge admin key.",
            controls: [
              {
                label: "Bridge admin key",
                role: "bridge-admin",
                authorityType: "eoa",
                directMintAbility: "cap-limited",
              },
            ],
            review: {
              evidence: "Fireblocks MPC custody is referenced in issuer materials.",
              reviewer: "Pharos",
              reviewedAt: "2026-06-18",
              sources: [{ label: "Issuer docs", url: "https://example.com/issuer" }],
              unresolvedQuestions: ["Confirm whether caps can be raised without delay."],
            },
          },
        }),
        coin({
          id: "unknown",
          symbol: "UNK",
          mintAuthority: {
            mintPath: "unknown",
            authorityPosture: "unknown",
            confidence: "unknown",
            summary: "Private chain mint authority is not externally auditable.",
            review: {
              evidence: "No public mint authority source was available.",
              reviewer: "Pharos",
              reviewedAt: "2026-06-18",
              sourceFreeRationale: "Private-chain controls are not externally inspectable.",
            },
          },
        }),
      ],
    });

    expect(audit.summary).toMatchObject({
      trackedCoins: 3,
      activeCoins: 3,
      reviewedProfiles: 2,
      activeMissingReviews: 1,
      reviewedButUnscoreable: 1,
      routeCheckQueue: 1,
      capDescriptionQueue: 1,
      unresolvedQuestionProfiles: 1,
      verifiedWithUnresolvedQuestions: 1,
      sourceFreeProfiles: 1,
      custodyAttestationQueue: 1,
      sourceUrls: {
        totalLinks: 1,
        uniqueUrls: 1,
        duplicateUrls: 0,
      },
    });
    expect(audit.activeMissingReviews.map((row) => row.coinId)).toEqual(["missing"]);
    expect(audit.reviewedButUnscoreable).toMatchObject([{ coinId: "unknown", unresolvedReason: "unknown-mint-path" }]);
    expect(audit.routeCheckQueue[0]).toMatchObject({
      coinId: "bridge",
      controlLabel: "Bridge admin key",
      reason: "missing routeChecks",
    });
    expect(audit.custodyAttestationQueue[0]?.reason).toContain("lacks attestation");
  });

  it("renders markdown summaries and queues", () => {
    const audit = buildMintAuthorityReviewAudit({
      generatedAt: "2026-06-18T00:00:00.000Z",
      coins: [coin({ id: "missing", symbol: "MIS" })],
    });
    const markdown = renderMintAuthorityReviewAuditMarkdown(audit);

    expect(markdown).toContain("# Mint Authority Review Audit");
    expect(markdown).toContain("- Active missing reviews: 1");
    expect(markdown).toContain("`missing` (MIS, active)");
  });

  it("parses CLI options", () => {
    expect(
      parseArgs([
        "--format",
        "json",
        "--out",
        "agents/mint-authority-review-audit.json",
        "--generated-at",
        "2026-06-18T00:00:00.000Z",
        "--live",
        "--live-limit",
        "5",
      ]),
    ).toMatchObject({
      format: "json",
      outputPath: "agents/mint-authority-review-audit.json",
      generatedAt: "2026-06-18T00:00:00.000Z",
      live: true,
      liveLimit: 5,
    });
    expect(() => parseArgs(["--format", "xml"])).toThrow("--format must be markdown or json");
    expect(() => parseArgs(["--live-limit", "0"])).toThrow("--live-limit must be a positive integer");
  });
});
