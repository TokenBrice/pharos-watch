import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseArgs,
  renderL2BeatBridgeRouteReviewAuditMarkdown,
  runCli,
} from "../maintenance/build-l2beat-bridge-route-candidates";

describe("build-l2beat-bridge-route-candidates", () => {
  it("parses CLI options", () => {
    expect(parseArgs([
      "--coin",
      "usdc-circle",
      "--limit",
      "10",
      "--json",
      "--stdout",
      "--generated-at",
      "2026-06-12T00:00:00.000Z",
    ])).toMatchObject({
      coinIds: ["usdc-circle"],
      limit: 10,
      format: "json",
      stdout: true,
    });
    expect(() => parseArgs(["--all", "--limit", "5"])).toThrow("Choose either --all or --limit");
  });

  it("renders bridge-route candidate rows with score-impacting notes", () => {
    const markdown = renderL2BeatBridgeRouteReviewAuditMarkdown({
      generatedAt: "2026-06-12T00:00:00.000Z",
      summary: {
        stablecoinCount: 1,
        l2beatInteropProtocolCount: 37,
        protocolReferenceCount: 1,
        stablecoinsWithProtocolReferences: 1,
        stablecoinsWithBridgeRouteRisk: 0,
        reviewRowCount: 1,
      },
      reviewRows: [{
        coinId: "fixture",
        symbol: "FX",
        currentBridgeRouteTier: null,
        suggestedBridgeRouteTier: "external-lock-mint",
        protocols: [{
          id: "ccip",
          slug: "ccip",
          name: "Chainlink CCIP",
          type: "multichain",
          bridgeTypes: ["lockAndMint", "burnAndMint"],
          suggestedTier: "external-lock-mint",
          url: "https://l2beat.com/interop/protocols/ccip",
        }],
        reasons: ["bridge-route-risk-missing", "l2beat-protocol-reference"],
        notes: ["Reviewed bridgeRouteRisk can affect Safety Score v8.12."],
      }],
    });

    expect(markdown).toContain("# L2BEAT Bridge Route Candidates");
    expect(markdown).toContain("FX (fixture)");
    expect(markdown).toContain("Chainlink CCIP");
    expect(markdown).toContain("Safety Score v8.12");
    expect(markdown).toContain("never mutates stablecoin metadata");
  });

  it("writes advisory output under the requested report path", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-l2beat-bridge-candidates-"));
    const stdout = { write: vi.fn(() => true) };

    await expect(runCli([
      "--coin",
      "usdc-circle",
      "--report",
      "agents/l2beat-bridge.md",
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
      "shared/data/stablecoins/l2beat-bridge.md",
    ], process.cwd(), stdout)).rejects.toThrow("advisory");
  });
});
