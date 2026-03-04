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

describe("mint-burn-contracts top-100 Ethereum additions", () => {
  const top100EthereumAdditions = [
    { stablecoinId: "241", symbol: "USDO", address: "0x8238884ec9668ef77b90c6dff4d1a9f4f4823bfe", decimals: 18 },
    { stablecoinId: "254", symbol: "EURCV", address: "0x5f7827fdeb7c20b443265fc2f40845b715385ff2", decimals: 18 },
    { stablecoinId: "147", symbol: "AEUR", address: "0xa40640458fbc27b6eefedea1e9c9e17d4cee7a21", decimals: 18 },
    { stablecoinId: "275", symbol: "USDQ", address: "0xc83e27f270cce0a3a3a29521173a83f402c1768b", decimals: 6 },
    { stablecoinId: "256", symbol: "REUSD", address: "0x57ab1e0003f623289cd798b1824be09a793e4bec", decimals: 18 },
    { stablecoinId: "325", symbol: "EURI", address: "0x9d1a7a3191102e9f900faa10540837ba84dcbae7", decimals: 18 },
    { stablecoinId: "19", symbol: "GUSD", address: "0x056fd409e1d7a124bd7017459dfea2f387b6d5cd", decimals: 2 },
    { stablecoinId: "11", symbol: "USDP", address: "0x8e870d67f660d95d5be530380d0ec0bd388289e1", decimals: 18 },
    { stablecoinId: "263", symbol: "USDX", address: "0xf8750b54d86be7ae9e32b4a0c826811198d63313", decimals: 18 },
    { stablecoinId: "290", symbol: "XUSD", address: "0xc08e7e23c235073c6807c2efe7021304cb7c2815", decimals: 6 },
    { stablecoinId: "313", symbol: "MUSD", address: "0xaca92e438df0b2401ff60da7e4337b687a2435da", decimals: 6 },
    { stablecoinId: "255", symbol: "YUSD", address: "0x4274cd7277c7bb0806bd5fe84b9adae466a8da0a", decimals: 18 },
    { stablecoinId: "22", symbol: "SUSD", address: "0x57ab1ec28d129707052df4df418d58a2d46d5f51", decimals: 18 },
    { stablecoinId: "8", symbol: "LUSD", address: "0x5f98805a4e8be255a32880fdec7f6728c6568ba0", decimals: 18 },
    { stablecoinId: "10", symbol: "MIM", address: "0x99d8a9c45b2eca8864373a26d1459e3dff1e17f3", decimals: 18 },
    { stablecoinId: "307", symbol: "USDCV", address: "0x5422374b27757da72d5265cc745ea906e0446634", decimals: 18 },
    { stablecoinId: "225", symbol: "ZeUSD", address: "0x7dc9748da8e762e569f9269f48f69a1a9f8ea761", decimals: 6 },
    { stablecoinId: "101", symbol: "EURE", address: "0x39b8b6385416f4ca36a20319f70d28621895279d", decimals: 18 },
    { stablecoinId: "230", symbol: "USN", address: "0xda67b4284609d2d48e5d10cfac411572727dc1ed", decimals: 18 },
    { stablecoinId: "185", symbol: "GYD", address: "0xe07f9d810a48ab5c3c914ba3ca53af14e4491e8a", decimals: 18 },
    { stablecoinId: "106", symbol: "EUSD", address: "0xa0d69e286b938e21cbf7e51d71f6a4c8918f482f", decimals: 18 },
    { stablecoinId: "55", symbol: "EURA", address: "0x1a7e4e63778b4f12a199c062f3efdd288afcbce8", decimals: 18 },
    { stablecoinId: "303", symbol: "meUSD", address: "0xdd468a1ddc392dcdbef6db6e34e89aa338f9f186", decimals: 18 },
    { stablecoinId: "51", symbol: "EURS", address: "0xdb25f211ab05b1c97d595516f45794528a807ad8", decimals: 2 },
    { stablecoinId: "326", symbol: "MSUSD", address: "0xab5eb14c09d416f0ac63661e57edb7aecdb9befa", decimals: 18 },
    { stablecoinId: "346", symbol: "NUSD", address: "0xe556aba6fe6036275ec1f87eda296be72c811bce", decimals: 18 },
    { stablecoinId: "343", symbol: "USAT", address: "0x07041776f5007aca2a54844f50503a18a72a8b68", decimals: 6 },
    { stablecoinId: "20", symbol: "ALUSD", address: "0xbc6da0fe9ad5f3b0d58160288917aa56653660e9", decimals: 18 },
    { stablecoinId: "348", symbol: "FIDD", address: "0x7c135549504245b5eae64fc0e99fa5ebabb8e35d", decimals: 18 },
    { stablecoinId: "297", symbol: "MSUSD", address: "0x4ba01f22827018b4772cd326c7627fb4956a7c00", decimals: 18 },
  ];

  it("tracks newly added top-100 Ethereum contracts via standard zero-address Transfer filters", () => {
    for (const expected of top100EthereumAdditions) {
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

describe("mint-burn-contracts top-150 Ethereum additions", () => {
  const top150EthereumAdditions = [
    { stablecoinId: "266", symbol: "pUSD", address: "0xdddd73f5df1f0dc31373357beac77545dc5a6f3f", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "234", symbol: "WUSD", address: "0x7cd017ca5ddb86861fa983a34b5f495c6f898c41", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "324", symbol: "SBC", address: "0xf9fb20b8e097904f0ab7d12e9dbee88f2dcd0f16", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "23", symbol: "OUSD", address: "0x2a8e1e676ec238d8a992307b495b45b3feaa5e86", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "253", symbol: "USBD", address: "0x6bede1c6009a78c222d9bdb7974bb67847fdb68c", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "331", symbol: "USP", address: "0x098697ba3fee4ea76294c5d6a466a4e3b3e95fe6", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "240", symbol: "USDR", address: "0x7b43e3875440b44613dc3bc08e7763e6da63c8f8", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "304", symbol: "USDU", address: "0xdde3ec717f220fc6a29d6a4be73f91da5b718e55", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "cg-ustb", symbol: "USTB", address: "0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e", decimals: 6, dustThreshold: 1_000 },
    { stablecoinId: "cg-ousg", symbol: "OUSG", address: "0x1b19c19393e2d034d8ff31ff34c81252fcbbee92", decimals: 18, dustThreshold: 100 },
    { stablecoinId: "cg-uscc", symbol: "USCC", address: "0x14d60e7fdc0d71d8611742720e4c50e7a974020c", decimals: 6, dustThreshold: 1_000 },
    { stablecoinId: "cg-mtbill", symbol: "mTBILL", address: "0xdd629e5241cbc5919847783e6c96b2de4754e438", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "cg-wrapped-savings-rusd", symbol: "wsrUSD", address: "0xd3fd63209fa2d55b07a0f6db36c2f43900be3094", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "289", symbol: "XSGD", address: "0x70e8de73ce538da2beed35d14187f6959a8eca96", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "122", symbol: "GYEN", address: "0xc08512927d12348f6620a698105e1baac6ecd911", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "165", symbol: "AUDD", address: "0x4cce605ed955295432958d8951d0b176c10720d5", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "cg-jpyc", symbol: "JPYC", address: "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "gold-xaum", symbol: "XAUm", address: "0x2103e845c5e135493bb6c2a4f0b8651956ea8682", decimals: 18, dustThreshold: 10 },
    { stablecoinId: "gold-dgld", symbol: "DGLD", address: "0xa9299c296d7830a99414d1e5546f5171fa01e9c8", decimals: 18, dustThreshold: 10 },
    { stablecoinId: "silver-kag", symbol: "KAG", address: "0xf94d9b6dc4eacd89fe3235d9a3c2465fea405157", decimals: 9, dustThreshold: 10_000 },
    { stablecoinId: "158", symbol: "VEUR", address: "0x6ba75d640bebfe5da1197bb5a2aff3327789b5d3", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "239", symbol: "EURR", address: "0x50753cfaf86c094925bf976f218d043f8791e408", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "247", symbol: "EUROP", address: "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "cg-eurq", symbol: "EURQ", address: "0x8df723295214ea6f21026eeeb4382d475f146f9f", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "319", symbol: "EURAU", address: "0x4933a85b5b5466fbaf179f72d3de273c287ec2c2", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "cg-deuro", symbol: "DEURO", address: "0xba3f535bbcccca2a154b573ca6c5a49baae0a3ea", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "157", symbol: "VCHF", address: "0x79d4f0232a66c4c91b89c76362016a1707cfbf4f", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "317", symbol: "tGBP", address: "0x27f6c8289550fce67f6b50bed1f519966afe5287", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "cg-zarp", symbol: "ZARP", address: "0xb755506531786c8ac63b756bab1ac387bacb0c04", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "145", symbol: "CADC", address: "0xcadc0acd4b445166f12d2c07eac6e2544fbe2eef", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "299", symbol: "PHT", address: "0xbe370ad45d44eb45174c4ec60b88839fef32c077", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "cg-syrupusdc", symbol: "syrupUSDC", address: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "cg-syrupusdt", symbol: "syrupUSDT", address: "0x356b8d89c1e1239cbbb9de4815c39a1474d5ba7d", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "353", symbol: "AID", address: "0x18f52b3fb465118731d9e0d276d4eb3599d57596", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "354", symbol: "apxUSD", address: "0x98a878b1cd98131b271883b390f68d2c90674665", decimals: 18, dustThreshold: 10_000 },
  ];

  it("tracks newly added top-150 Ethereum contracts via standard zero-address Transfer filters", () => {
    for (const expected of top150EthereumAdditions) {
      const cfg = MINT_BURN_CONFIGS.find(
        (c) =>
          c.chain.chainId === "ethereum" &&
          c.stablecoinId === expected.stablecoinId &&
          c.contractAddress === expected.address,
      );

      expect(cfg, `Missing config for ${expected.symbol}`).toBeDefined();
      expect(cfg!.symbol).toBe(expected.symbol);
      expect(cfg!.decimals).toBe(expected.decimals);
      expect(cfg!.dustThreshold).toBe(expected.dustThreshold);
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
