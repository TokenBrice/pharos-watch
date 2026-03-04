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

describe("mint-burn-contracts top-50 Ethereum additions", () => {
  const top50EthereumAdditions = [
    { stablecoinId: "246", symbol: "USDf", address: "0xfa2b947eec368f42195f24f36d2af29f7c24cec2", decimals: 18 },
    { stablecoinId: "237", symbol: "USYC", address: "0x136471a34f6ef19fe571effc1ca711fdb8e49f2b", decimals: 6 },
    { stablecoinId: "250", symbol: "RLUSD", address: "0x8292bb45bf1ee4d140127049757c2e0ff06317ed", decimals: 18 },
    { stablecoinId: "129", symbol: "USDY", address: "0x96f6ef951840721adbf46ac996b59e0235cb985c", decimals: 18 },
    { stablecoinId: "173", symbol: "BUIDL", address: "0x7712c34205737192402172409a8f7ccef8aa2aec", decimals: 6 },
    { stablecoinId: "14", symbol: "USDD", address: "0x4f8e5de400de08b164e7421b3ee387f461becd1a", decimals: 18 },
    { stablecoinId: "221", symbol: "USDTB", address: "0xc139190f447e929f090edeb554d95abb8b18ac1c", decimals: 18 },
    { stablecoinId: "213", symbol: "M", address: "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b", decimals: 6 },
    { stablecoinId: "336", symbol: "U", address: "0xce24439f2d9c6a2289f741120fe202248b666666", decimals: 18 },
    { stablecoinId: "309", symbol: "USDai", address: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", decimals: 18 },
    { stablecoinId: "195", symbol: "USD0", address: "0x73a15fed60bf67631dc6cd7bc5b6e8da8190acf5", decimals: 18 },
    { stablecoinId: "258", symbol: "A7A5", address: "0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9", decimals: 6 },
    { stablecoinId: "7", symbol: "TUSD", address: "0x0000000000085d4780b73119b644ae5ecd22b376", decimals: 18 },
    { stablecoinId: "296", symbol: "CUSD", address: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc", decimals: 18 },
    { stablecoinId: "197", symbol: "USR", address: "0x66a1e37c9b0eaddca17d3662d6c05f4decf3e110", decimals: 18 },
    { stablecoinId: "220", symbol: "USDA", address: "0x8a60e489004ca22d775c5f2c657598278d17d9c2", decimals: 18 },
    { stablecoinId: "6", symbol: "FRAX", address: "0x853d955acef822db058eb8505911ed77f175b99e", decimals: 18 },
    { stablecoinId: "15", symbol: "DOLA", address: "0x865377367054516e17014ccded1e7d814edc9ce4", decimals: 18 },
    { stablecoinId: "298", symbol: "IUSD", address: "0x48f9e38f3070ad8945dfeae3fa70987722e3d89c", decimals: 18 },
    { stablecoinId: "218", symbol: "satUSD", address: "0x1958853a8be062dc4f401750eb233f5850f0d0d2", decimals: 18 },
    { stablecoinId: "249", symbol: "BRZ", address: "0x01d33fd36ec67c6ada32cf36b31e88ee190b1839", decimals: 18 },
    { stablecoinId: "306", symbol: "GUSD", address: "0xaf6186b3521b60e27396b5d23b48abc34bf585c5", decimals: 6 },
    { stablecoinId: "340", symbol: "rwaUSDi", address: "0xa39986f96b80d04e8d7aeaaf47175f47c23fd0f4", decimals: 6 },
    { stablecoinId: "271", symbol: "avUSD", address: "0xf4c13d631450de6b12a19829e37c8e2826891dc4", decimals: 18 },
    { stablecoinId: "332", symbol: "pmUSD", address: "0xc0c17dd08263c16f6b64e772fb9b723bf1344ddf", decimals: 18 },
    { stablecoinId: "202", symbol: "USDz", address: "0xa469b7ee9ee773642b3e93e842e5d9b5baa10067", decimals: 18 },
    { stablecoinId: "284", symbol: "MNEE", address: "0x8ccedbae4916b79da7f3f612efb2eb93a2bfd6cf", decimals: 18 },
    { stablecoinId: "257", symbol: "TBILL", address: "0xdd50c053c096cb04a3e3362e2b622529ec5f2e8a", decimals: 6 },
    { stablecoinId: "66", symbol: "FPI", address: "0x5ca135cb8527d76e932f34b5145575f9d8cbe08e", decimals: 18 },
  ];

  it("tracks newly added top-50 Ethereum contracts via standard zero-address Transfer filters", () => {
    for (const expected of top50EthereumAdditions) {
      const cfg = MINT_BURN_CONFIGS.find(
        (c) =>
          c.chain.chainId === "ethereum" &&
          c.stablecoinId === expected.stablecoinId &&
          c.contractAddress === expected.address,
      );

      expect(cfg, `Missing config for ${expected.symbol}`).toBeDefined();
      expect(cfg!.symbol).toBe(expected.symbol);
      expect(cfg!.decimals).toBe(expected.decimals);
      expect(cfg!.startBlock).toBe(21_900_000);
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
