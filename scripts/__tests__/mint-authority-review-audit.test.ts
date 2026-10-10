import { describe, expect, it } from "vitest";
import {
  buildMintAuthorityReviewAudit,
  renderMintAuthorityReviewAuditMarkdown,
} from "../lib/mint-authority-review-audit";
import { parseArgs, uniqueMintAuthoritySourceUrls } from "../maintenance/generate-mint-authority-review-audit";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types";
import { projectMintAuthorityClientSummary } from "../../src/lib/stablecoin-detail-mint-authority-client";

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
  it("uses exception and upgradeability evidence in counts, detail links and live probe selection", () => {
    const fixture = coin({
      id: "exception", symbol: "EXC",
      mintAuthority: {
        mintPath: "unknown", authorityPosture: "unknown", confidence: "manual-review",
        summary: "Native issuance is under review.",
        review: {
          reviewer: "Pharos", reviewedAt: "2026-10-09", evidence: "Reviewed native issuance exception.",
          sources: [
            { label: "Review", url: "https://example.com/common" },
            { label: "Duplicate review", url: "https://example.com/common" },
          ],
          noLocalIssuance: {
            kind: "external-only-representation", rationale: "Reviewed external representation.",
            reviewedAt: "2026-10-09", reviewer: "Pharos",
            sources: [{ label: "Exception only", url: "https://example.com/exception" }],
          },
        },
        upgradeability: {
          model: "unknown", canChangeMintLogic: "unknown",
          sources: [{ label: "Upgrade only", url: "https://example.com/upgrade" }],
        },
      },
    });
    expect(buildMintAuthorityReviewAudit({ coins: [fixture] }).summary.sourceUrls)
      .toEqual({ totalLinks: 4, uniqueUrls: 3, duplicateUrls: 1 });
    expect(uniqueMintAuthoritySourceUrls([fixture]))
      .toEqual(["https://example.com/common", "https://example.com/exception", "https://example.com/upgrade"]);
    expect(projectMintAuthorityClientSummary(fixture)?.sources?.map((source) => source.url))
      .toEqual(["https://example.com/common", "https://example.com/exception", "https://example.com/upgrade"]);
  });

  it("renders actionable rows for all four previously summary-only queues", () => {
    const fixture = coin({
      id: "actionable", symbol: "ACT",
      mintAuthority: {
        mintPath: "unknown", authorityPosture: "unknown", confidence: "manual-review",
        summary: "Private native issuance remains unresolved.",
        review: {
          reviewer: "Pharos", reviewedAt: "2026-10-09", evidence: "Private controls cannot be inspected.",
          sourceFreeRationale: "Private chain has no public explorer.",
          unresolvedQuestions: ["Who can authorize native issuance?"],
        },
        controls: [{ label: "Shared signer", role: "minter-admin", authorityType: "eoa",
          directMintAbility: "can-authorize", chain: "ethereum", address: `0x${"1".repeat(40)}` }],
        upgradeability: { model: "unknown", canChangeMintLogic: "unknown", controlRef: "Shared signer",
          sources: [{ label: "Review", url: "https://example.com/review" }] },
      },
    });
    const audit = buildMintAuthorityReviewAudit({ coins: [fixture] });
    expect(audit.summary).toMatchObject({ unresolvedQuestionProfiles: 1, sourceFreeProfiles: 1,
      unknownUpgradeabilityProfiles: 1, commonCriticalControls: 1 });
    const markdown = renderMintAuthorityReviewAuditMarkdown(audit);
    expect(markdown).toContain("`actionable` (ACT, manual-review): Who can authorize native issuance?");
    expect(markdown).toContain("`actionable` (ACT): Private chain has no public explorer.");
    expect(markdown).toContain("## Unknown Upgradeability\n\n- `actionable` (ACT, active)");
    expect(markdown).toContain(`\`address:ethereum:0x${"1".repeat(40)}\`: Shared signer (mint, upgrade)`);
  });

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
        coin({
          id: "reserve-custody",
          symbol: "RC",
          mintAuthority: {
            mintPath: "issuer-direct-mint",
            authorityPosture: "concentrated-admin",
            confidence: "manual-review",
            summary:
              "Reserve assets are held with an institutional custodian; privileged signer controls are not described.",
            controls: [
              {
                label: "Issuer EOA",
                role: "direct-minter",
                authorityType: "eoa",
                directMintAbility: "direct",
              },
            ],
            review: {
              evidence: "Issuer-operated minting; reserve custody is disclosed separately from key controls.",
              reviewer: "Pharos",
              reviewedAt: "2026-06-18",
            },
          },
        }),
      ],
    });

    expect(audit.summary).toMatchObject({
      trackedCoins: 4,
      activeCoins: 4,
      reviewedProfiles: 3,
      activeMissingReviews: 1,
      routeCheckQueue: 1,
      capDescriptionQueue: 1,
      unresolvedQuestionProfiles: 1,
      verifiedWithUnresolvedQuestions: 1,
      sourceFreeProfiles: 1,
      custodyAttestationQueue: 0,
      sourceUrls: {
        totalLinks: 1,
        uniqueUrls: 1,
        duplicateUrls: 0,
      },
    });
    expect(audit.activeMissingReviews.map((row) => row.coinId)).toEqual(["missing"]);
    expect(audit.routeCheckQueue[0]).toMatchObject({
      coinId: "bridge",
      controlLabel: "Bridge admin key",
      reason: "missing routeChecks",
    });
    expect(audit.custodyAttestationQueue).toEqual([]);
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

  it("does not leave an explicit upgrade authority without a profile-level record", () => {
    const missing = TRACKED_STABLECOINS.filter(
      (meta) =>
        meta.mintAuthority?.upgradeability == null &&
        meta.mintAuthority?.controls?.some((control) => control.directMintAbility === "upgrade-only"),
    ).map((meta) => meta.id);

    expect(missing).toEqual([]);
  });
});
