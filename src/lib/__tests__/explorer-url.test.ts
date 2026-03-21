import { describe, expect, it } from "vitest";
import { buildExplorerUrl } from "@shared/lib/explorer";

describe("buildExplorerUrl", () => {
  it("builds tron transaction and address URLs with the shared helper", () => {
    expect(buildExplorerUrl({
      chainKey: "tron",
      entityType: "tx",
      value: "abcd",
    })).toBe("https://tronscan.org/#/transaction/abcd");

    expect(buildExplorerUrl({
      chainKey: "tron",
      entityType: "address",
      value: "0x1234",
    })).toBe("https://tronscan.org/#/address/411234");
  });

  it("builds chain-specific contract URLs for non-EVM chains", () => {
    expect(buildExplorerUrl({
      chainKey: "solana",
      entityType: "contract",
      value: "So11111111111111111111111111111111111111112",
    })).toBe("https://solscan.io/account/So11111111111111111111111111111111111111112");

    expect(buildExplorerUrl({
      chainKey: "starknet",
      entityType: "contract",
      value: "0xabc",
    })).toBe("https://starkscan.co/contract/0xabc");
  });
});
