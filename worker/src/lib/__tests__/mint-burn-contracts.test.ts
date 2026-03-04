import { describe, it, expect } from "vitest";
import { decodeUint256AtSlot } from "../evm-logs";
import { MINT_BURN_CONFIGS } from "../mint-burn-contracts";

const REUSD_DEPOSITED_TOPIC = "0x8752a472e571a816aea92eec8dae9baf628e840f4929fbcc2d155e6233ff68a7";

describe("mint-burn-contracts reUSD config", () => {
  it("uses 18 decimals for reUSD Deposited mint events", () => {
    const reusdDepositConfigs = MINT_BURN_CONFIGS.filter(
      (c) =>
        c.stablecoinId === "339" &&
        c.events.some((e) => e.topicHash === REUSD_DEPOSITED_TOPIC && e.direction === "mint"),
    );

    expect(reusdDepositConfigs.length).toBeGreaterThan(0);
    for (const cfg of reusdDepositConfigs) {
      expect(cfg.decimals).toBe(18);

      const depositEvent = cfg.events.find((e) => e.topicHash === REUSD_DEPOSITED_TOPIC);
      expect(depositEvent?.amountEncoding).toBe("nth-data-uint256");
      expect(depositEvent?.dataSlot).toBe(2);
    }
  });

  it("decodes known reUSD Deposited payload to 10 tokens (not 10T)", () => {
    const cfg = MINT_BURN_CONFIGS.find(
      (c) =>
        c.stablecoinId === "339" &&
        c.chain.chainId === "ethereum" &&
        c.events.some((e) => e.topicHash === REUSD_DEPOSITED_TOPIC && e.direction === "mint"),
    );
    expect(cfg).toBeDefined();

    // ETH tx 0xca639a80db00f29bedb9c36fd40f913cae7bbd1f66c1731848610c365e1040cc
    // Deposited(user, token, amount) with amount slot = 10e18.
    const data =
      "0x000000000000000000000000b6dcd6e755cc55b8d230be8290742b78fadc4a17" +
      "00000000000000000000000057f5e098cad7a3d1eed53991d4d66c45c9af7812" +
      "0000000000000000000000000000000000000000000000008ac7230489e80000";

    expect(decodeUint256AtSlot(data, 2, cfg!.decimals)).toBe(10);
  });
});
