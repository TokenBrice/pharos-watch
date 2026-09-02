import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAudit, loadSupportedChains, renderMarkdown } from "../maintenance/audit-eurostablecoins-coverage";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("audit-eurostablecoins-coverage", () => {
  it("uses the real registry and preserves fixed-fixture report bytes", () => {
    const supportedChains = loadSupportedChains();
    const audit = buildAudit({
      externalCoins: [
        {
          coin_id: "eurx",
          ticker: "EURX",
          name: "Euro X",
          issuer: "Issuer",
          market_status: "market_traded",
          total_supply: 1_234.5,
          circulating_supply: 1_200,
          treasury_held: 34.5,
          recorded_at: "2026-09-01",
          chains: ["polygon-zkevm", "future-chain"],
        },
      ],
      localCoins: [
        {
          id: "eurx-local",
          symbol: "EURX",
          status: "active",
          marketAvailability: "limited-trading",
          contracts: [{ chain: "ethereum" }],
        },
      ],
      deadCoins: [],
      supportedChains,
      generatedAt: "2026-09-01T00:00:00.000Z",
      apiUrl: "https://fixture.invalid/coins",
    });
    expect(["ethereum", "polygon-zkevm", "immutable-zkevm"].every((id) => supportedChains.has(id))).toBe(true);
    expect([`${JSON.stringify(audit, null, 2)}\n`, renderMarkdown(audit)].map((text) => [Buffer.byteLength(text), sha256(text)]))
      .toEqual([
        [1_261, "b0d6d9994d7f631fca04cb2521230a558cfcb11ac0d128874ec862b76fea12b0"],
        [1_107, "1afd5850dad044d6119ad79b714c8c75aacef9bb546810dcfb2a846baa024a6d"],
      ]);
  });
});
