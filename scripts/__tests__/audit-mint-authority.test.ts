import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMintAuthorityCandidate,
  buildProviderCapabilities,
  parseArgs,
  runCli,
} from "../maintenance/audit-mint-authority";

describe("audit-mint-authority", () => {
  it("builds an unknown candidate without treating scanner output as curated metadata", () => {
    const candidate = buildMintAuthorityCandidate(
      {
        id: "fixture-usd",
        symbol: "FUSD",
        contracts: [
          {
            chain: "ethereum",
            address: "0x0000000000000000000000000000000000000001",
            decimals: 18,
          },
          {
            chain: "solana",
            address: "So11111111111111111111111111111111111111112",
            decimals: 9,
          },
        ],
      },
      {
        generatedAt: "2026-05-24T00:00:00.000Z",
        providerCapabilities: buildProviderCapabilities({ ETHERSCAN_API_KEY: "set" }),
      },
    );

    expect(candidate).toMatchObject({
      coinId: "fixture-usd",
      eventScanComplete: false,
      candidateMintAuthority: {
        mintPath: "unknown",
        authorityPosture: "unknown",
        confidence: "unknown",
      },
      providerCapabilities: {
        etherscanV2: {
          available: true,
          env: ["ETHERSCAN_API_KEY"],
        },
      },
    });
    expect(candidate.contractsScanned.map((contract) => contract.scannerStatus)).toEqual([
      "queued-not-scanned",
      "unsupported-address",
    ]);
    expect(candidate.manualReviewRequired.join(" ")).toContain("curate sources before adding mintAuthority metadata");
  });

  it("parses focused CLI options", () => {
    expect(
      parseArgs([
        "--coin",
        "usdc-circle",
        "--coin",
        "usdt-tether",
        "--out-dir",
        "agents/mint-authority-candidates",
        "--generated-at",
        "2026-05-24T00:00:00.000Z",
        "--json",
      ]),
    ).toMatchObject({
      coinIds: ["usdc-circle", "usdt-tether"],
      outputDir: "agents/mint-authority-candidates",
      generatedAt: "2026-05-24T00:00:00.000Z",
      json: true,
    });
    expect(() => parseArgs(["--limit", "0"])).toThrow("--limit must be a positive integer");
    expect(() => parseArgs(["--all", "--coin", "usdc-circle"])).toThrow("Choose either --all");
  });

  it("writes candidate files to the requested candidates directory", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "pharos-mint-authority-"));
    const stdout = { write: (_chunk: string) => true } as Pick<NodeJS.WriteStream, "write">;

    try {
      await expect(
        runCli(
          ["--coin", "usdc-circle", "--out-dir", outputDir, "--generated-at", "2026-05-24T00:00:00.000Z"],
          process.cwd(),
          {},
          stdout,
        ),
      ).resolves.toBe(0);

      const written = JSON.parse(readFileSync(join(outputDir, "usdc-circle.json"), "utf8")) as {
        coinId: string;
        candidateMintAuthority: { confidence: string };
      };
      expect(written.coinId).toBe("usdc-circle");
      expect(written.candidateMintAuthority.confidence).toBe("unknown");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("refuses to write into stablecoin metadata paths", async () => {
    await expect(
      runCli(["--coin", "usdc-circle", "--out-dir", "shared/data/stablecoins"], process.cwd()),
    ).rejects.toThrow("writes candidate artifacts only");
  });

  it("refuses stablecoin metadata paths even when invoked outside the repo root", async () => {
    await expect(
      runCli(
        ["--coin", "usdc-circle", "--out-dir", "../shared/data/stablecoins/coins"],
        join(process.cwd(), "scripts"),
      ),
    ).rejects.toThrow("writes candidate artifacts only");
  });
});
