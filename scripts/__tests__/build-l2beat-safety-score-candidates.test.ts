import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseArgs,
  renderL2BeatStablecoinSafetyAuditMarkdown,
  runCli,
} from "../maintenance/build-l2beat-safety-score-candidates";

describe("build-l2beat-safety-score-candidates", () => {
  it("parses CLI options", () => {
    expect(parseArgs([
      "--coin",
      "usdc-circle",
      "--chain",
      "base",
      "--limit",
      "10",
      "--json",
      "--stdout",
      "--generated-at",
      "2026-06-12T00:00:00.000Z",
    ])).toMatchObject({
      coinIds: ["usdc-circle"],
      chainIds: ["base"],
      limit: 10,
      format: "json",
      stdout: true,
    });
    expect(() => parseArgs(["--all", "--limit", "5"])).toThrow("Choose either --all or --limit");
  });

  it("renders advisory rows without automatic deployment-model suggestions", () => {
    const markdown = renderL2BeatStablecoinSafetyAuditMarkdown({
      generatedAt: "2026-06-12T00:00:00.000Z",
      summary: {
        stablecoinCount: 1,
        stablecoinsWithContracts: 1,
        stablecoinsWithL2BeatDeployments: 1,
        matchedDeploymentCount: 1,
        reviewRowCount: 1,
      },
      reviewRows: [{
        coinId: "fixture",
        symbol: "FX",
        chainId: "base",
        chainTier: null,
        deploymentModel: null,
        contractChainCount: 1,
        projectId: "base",
        l2beatName: "Base Chain",
        slug: "base",
        stage: "Stage 1",
        layer: "layer2",
        category: "Optimistic Rollup",
        hostChain: "Ethereum",
        hostChainId: "ethereum",
        chainEnvironmentScore: 82,
        suggestedChainTier: "stage1-l2",
        reasons: ["chain-tier-stage1-candidate"],
        notes: ["deploymentModel remains an asset-level manual review."],
      }],
    });

    expect(markdown).toContain("# L2BEAT Safety Score Candidates");
    expect(markdown).toContain("FX (fixture)");
    expect(markdown).toContain("chain-tier-stage1-candidate");
    expect(markdown).toContain("token-route review");
  });

  it("writes advisory output under the requested report path", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-l2beat-candidates-"));
    const stdout = { write: vi.fn(() => true) };

    await expect(runCli([
      "--coin",
      "usdc-circle",
      "--chain",
      "base",
      "--report",
      "agents/l2beat.md",
      "--generated-at",
      "2026-06-12T00:00:00.000Z",
    ], cwd, stdout)).resolves.toBe(0);
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("wrote"));
  });

  it("refuses report writes into stablecoin source data", async () => {
    const stdout = { write: vi.fn(() => true) };

    await expect(runCli([
      "--coin",
      "usdc-circle",
      "--report",
      "shared/data/stablecoins/l2beat.md",
    ], process.cwd(), stdout)).rejects.toThrow("advisory");
  });
});
