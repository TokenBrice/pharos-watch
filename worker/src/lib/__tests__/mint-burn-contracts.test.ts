import { describe, it, expect } from "vitest";
import { decodeUint256AtSlot } from "../evm-logs";
import { MINT_BURN_CONFIGS } from "../mint-burn-contracts";

const REUSD_DEPOSITED_TOPIC = "0x8752a472e571a816aea92eec8dae9baf628e840f4929fbcc2d155e6233ff68a7";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_ADDRESS_PADDED = "0x0000000000000000000000000000000000000000000000000000000000000000";

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

describe("mint-burn-contracts Ethereum expansion coverage", () => {
  const expectedConfigs = [
    { stablecoinId: "168", symbol: "fxUSD", address: "0x085780639cc2cacd35e474e71f4d000e2405d8f6", decimals: 18, startBlock: 19_287_523 },
    { stablecoinId: "110", symbol: "crvUSD", address: "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e", decimals: 18, startBlock: 17_257_952 },
    { stablecoinId: "205", symbol: "AUSD", address: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a", decimals: 6, startBlock: 20_257_620 },
    { stablecoinId: "226", symbol: "ZCHF", address: "0xb58e61c3098d85632df34eecfb899a1ed80921cb", decimals: 18, startBlock: 18_451_518 },
    { stablecoinId: "50", symbol: "EURC", address: "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c", decimals: 6, startBlock: 14_807_227 },
    { stablecoinId: "gold-paxg", symbol: "PAXG", address: "0x45804880de22913dafe09f4980848ece6ecbaf78", decimals: 18, startBlock: 8_426_430 },
    { stablecoinId: "gold-xaut", symbol: "XAUT", address: "0x68749665ff8d2d112fa859aa293f07a622782f38", decimals: 6, startBlock: 13_524_498 },
    { stablecoinId: "286", symbol: "USDG", address: "0xe343167631d89b6ffc58b88d6b7fb0228795491d", decimals: 6, startBlock: 20_915_336 },
    { stablecoinId: "262", symbol: "USD1", address: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", decimals: 18, startBlock: 21_720_503 },
  ];

  it("tracks all requested Ethereum-only coins via standard zero-address Transfer filters", () => {
    for (const expected of expectedConfigs) {
      const cfg = MINT_BURN_CONFIGS.find(
        (c) =>
          c.chain.chainId === "ethereum" &&
          c.stablecoinId === expected.stablecoinId &&
          c.contractAddress === expected.address,
      );

      expect(cfg, `Missing config for ${expected.symbol}`).toBeDefined();
      expect(cfg!.symbol).toBe(expected.symbol);
      expect(cfg!.decimals).toBe(expected.decimals);
      expect(cfg!.startBlock).toBe(expected.startBlock);
      expect(cfg!.tier).toBe("extended");
      expect(cfg!.events).toEqual([
        {
          signature: "Transfer(address,address,uint256)",
          topicHash: TRANSFER_TOPIC,
          direction: "mint",
          amountEncoding: "transfer-value",
          filterTopic: { index: 1, value: ZERO_ADDRESS_PADDED },
        },
        {
          signature: "Transfer(address,address,uint256)",
          topicHash: TRANSFER_TOPIC,
          direction: "burn",
          amountEncoding: "transfer-value",
          filterTopic: { index: 2, value: ZERO_ADDRESS_PADDED },
        },
      ]);
    }
  });
});
