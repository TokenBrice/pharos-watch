import { describe, it, expect } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  buildMintBurnScope,
  collectMintBurnBridgeValidationErrors,
  getMintBurnConfigsForStablecoin,
  MINT_BURN_BRIDGE_VALIDATION_ERROR_COUNT,
  MINT_BURN_BRIDGE_VALIDATION_ERRORS,
  MINT_BURN_CONFIGS,
  validateMintBurnBridgeDetection,
} from "../mint-burn-contracts";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_ADDRESS_PADDED = "0x0000000000000000000000000000000000000000000000000000000000000000";
const REMOVED_STABLECOIN_IDS = [
  "253",
  "uscc-legacy",
] as const;

describe("mint-burn-contracts reUSD config", () => {
  it("tracks canonical reUSD token zero-address Transfers instead of vault collateral events", () => {
    const configs = getMintBurnConfigsForStablecoin("reusd-re-protocol");
    expect(configs).toHaveLength(1);

    const cfg = configs[0]!;
    expect(cfg).toMatchObject({
      chain: { chainId: "ethereum" },
      symbol: "reUSD",
      contractAddress: "0x5086bf358635b81d8c47c66d1c8b9e567db70c72",
      decimals: 18,
      dustThreshold: 10_000,
      startBlock: 21_675_000,
      tier: "extended",
      adapterKind: "transfer-zero-address",
    });
    expect(cfg.events).toEqual([
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
  });
});

describe("mint-burn-contracts 3Jane USD3 config", () => {
  it("starts zero-address Transfer tracking at the verified proxy deployment block", () => {
    const configs = getMintBurnConfigsForStablecoin("usd3-3jane");
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      chain: { chainId: "ethereum" },
      symbol: "USD3",
      contractAddress: "0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc",
      decimals: 6,
      dustThreshold: 10_000,
      startBlock: 23_214_680,
      tier: "extended",
      adapterKind: "transfer-zero-address",
      startBlockSource: "blockscout-ethereum-proxy-deployment-2025-08-25",
      startBlockConfidence: "high",
    });
    expect(configs[0]!.events.map((event) => event.direction)).toEqual(["mint", "burn"]);
  });
});

describe("mint-burn-contracts removals", () => {
  it("does not track explicitly removed no-signal tokens", () => {
    const trackedIds = new Set(MINT_BURN_CONFIGS.map((c) => c.stablecoinId));
    for (const removedId of REMOVED_STABLECOIN_IDS) {
      expect(trackedIds.has(removedId)).toBe(false);
    }
  });
});

describe("mint-burn-contracts configured scope", () => {
  it("exposes both Ethereum and Arbitrum tracking after the USDai canonical-chain switch", () => {
    const uniqueChains = new Set(MINT_BURN_CONFIGS.map((c) => c.chain.chainId));
    expect(uniqueChains).toEqual(new Set(["ethereum", "arbitrum"]));
    expect(buildMintBurnScope()).toEqual({
      chainIds: ["ethereum", "arbitrum"],
      label: "Configured issuance chains",
    });
  });

  it("tracks USDC with CCTP bridge detection", () => {
    const configs = getMintBurnConfigsForStablecoin("usdc-circle");
    expect(configs.length).toBeGreaterThan(0);
    const ethConfig = configs.find((c) => c.chain.chainId === "ethereum");
    expect(ethConfig).toBeDefined();
    expect(ethConfig!.bridgeDetection?.protocol).toBe("cctp");
  });

  it("tracks EURC with CCTP bridge detection", () => {
    const configs = getMintBurnConfigsForStablecoin("eurc-circle");
    expect(configs.length).toBeGreaterThan(0);
    const ethConfig = configs.find((c) => c.chain.chainId === "ethereum");
    expect(ethConfig).toBeDefined();
    expect(ethConfig!.bridgeDetection?.protocol).toBe("cctp");
  });

  it("tracks USDai on Arbitrum with LayerZero bridge detection", () => {
    const configs = getMintBurnConfigsForStablecoin("usdai-usd-ai");
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      chain: { chainId: "arbitrum" },
      symbol: "USDai",
      dustThreshold: 10_000,
      tier: "extended",
      startBlock: 336_209_932,
      startBlockSource: "reviewed-arbitrum-deployment-2025-05-13",
      startBlockConfidence: "high",
      bridgeDetection: {
        protocol: "layerzero-oft",
        knownBridgeContractAddresses: [
          "0xffa10065ce1d1c42fabc46e06b84ed8ffeb4bae5",
          "0x31cae3b7fb82d847621859fb1585353c5720660d",
        ],
      },
    });
  });
});

describe("mint-burn-contracts shared metadata alignment", () => {
  it("resolves tracked token identities from shared metadata unless explicitly overridden", () => {
    for (const config of MINT_BURN_CONFIGS) {
      const meta = TRACKED_META_BY_ID.get(config.stablecoinId);
      expect(meta, `missing tracked metadata for ${config.stablecoinId}`).toBeDefined();

      const matchingDeployment = meta?.contracts?.find(
        (deployment) =>
          deployment.chain === config.chain.chainId
          && deployment.address.toLowerCase() === config.contractAddress.toLowerCase()
          && deployment.decimals === config.decimals,
      );
      if (matchingDeployment) continue;

      throw new Error(
        `expected ${config.stablecoinId} ${config.contractAddress} to be declared in shared metadata`,
      );
    }
  });
});

describe("mint-burn-contracts Ethereum expansion coverage", () => {
  const expectedConfigs = [
    { stablecoinId: "fxusd-f-x-protocol", symbol: "fxUSD", address: "0x085780639cc2cacd35e474e71f4d000e2405d8f6", decimals: 18, dustThreshold: 10_000, startBlock: 19_287_523 },
    { stablecoinId: "crvusd-curve", symbol: "crvUSD", address: "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e", decimals: 18, dustThreshold: 10_000, startBlock: 17_257_952 },
    { stablecoinId: "ausd-agora", symbol: "AUSD", address: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a", decimals: 6, dustThreshold: 10_000, startBlock: 20_257_620 },
    { stablecoinId: "zchf-frankencoin", symbol: "ZCHF", address: "0xb58e61c3098d85632df34eecfb899a1ed80921cb", decimals: 18, dustThreshold: 10_000, startBlock: 18_451_518 },
    { stablecoinId: "eurc-circle", symbol: "EURC", address: "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c", decimals: 6, dustThreshold: 10_000, startBlock: 14_807_227 },
    { stablecoinId: "paxg-paxos", symbol: "PAXG", address: "0x45804880de22913dafe09f4980848ece6ecbaf78", decimals: 18, dustThreshold: 10, startBlock: 8_426_430 },
    { stablecoinId: "xaut-tether", symbol: "XAUT", address: "0x68749665ff8d2d112fa859aa293f07a622782f38", decimals: 6, dustThreshold: 10, startBlock: 13_524_498 },
    { stablecoinId: "usdg-paxos", symbol: "USDG", address: "0xe343167631d89b6ffc58b88d6b7fb0228795491d", decimals: 6, dustThreshold: 10_000, startBlock: 20_915_336 },
    { stablecoinId: "usd1-world-liberty-financial", symbol: "USD1", address: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", decimals: 18, dustThreshold: 10_000, startBlock: 21_720_503 },
  ];

  it("tracks all requested Ethereum-only coins via standard zero-address Transfer filters", () => {
    for (const expected of expectedConfigs) {
      const cfg = MINT_BURN_CONFIGS.find(
        (c) =>
          c.chain.chainId === "ethereum" &&
          c.contractAddress.toLowerCase() === expected.address.toLowerCase(),
      );

      expect(cfg, `Missing config for ${expected.symbol}`).toBeDefined();
      expect(cfg!.symbol).toBe(expected.symbol);
      expect(cfg!.decimals).toBe(expected.decimals);
      expect(cfg!.dustThreshold).toBe(expected.dustThreshold);
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
    { stablecoinId: "usdf-falcon", symbol: "USDf", address: "0xfa2b947eec368f42195f24f36d2af29f7c24cec2", decimals: 18 },
    { stablecoinId: "usyc-hashnote", symbol: "USYC", address: "0x136471a34f6ef19fe571effc1ca711fdb8e49f2b", decimals: 6 },
    { stablecoinId: "rlusd-ripple", symbol: "RLUSD", address: "0x8292bb45bf1ee4d140127049757c2e0ff06317ed", decimals: 18 },
    { stablecoinId: "usdy-ondo-finance", symbol: "USDY", address: "0x96f6ef951840721adbf46ac996b59e0235cb985c", decimals: 18 },
    { stablecoinId: "buidl-blackrock", symbol: "BUIDL", address: "0x7712c34205737192402172409a8f7ccef8aa2aec", decimals: 6 },
    { stablecoinId: "usdd-tron-dao-reserve", symbol: "USDD", address: "0x4f8e5de400de08b164e7421b3ee387f461becd1a", decimals: 18 },
    { stablecoinId: "usdtb-ethena", symbol: "USDTB", address: "0xc139190f447e929f090edeb554d95abb8b18ac1c", decimals: 18 },
    { stablecoinId: "m-m0", symbol: "M", address: "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b", decimals: 6 },
    { stablecoinId: "usd0-usual", symbol: "USD0", address: "0x73a15fed60bf67631dc6cd7bc5b6e8da8190acf5", decimals: 18 },
    { stablecoinId: "tusd-trueusd", symbol: "TUSD", address: "0x0000000000085d4780b73119b644ae5ecd22b376", decimals: 18 },
    { stablecoinId: "cusd-cap", symbol: "CUSD", address: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc", decimals: 18 },
    { stablecoinId: "frax-frax", symbol: "FRAX", address: "0x853d955acef822db058eb8505911ed77f175b99e", decimals: 18 },
    { stablecoinId: "dola-inverse-finance", symbol: "DOLA", address: "0x865377367054516e17014ccded1e7d814edc9ce4", decimals: 18 },
    { stablecoinId: "iusd-infinifi", symbol: "IUSD", address: "0x48f9e38f3070ad8945dfeae3fa70987722e3d89c", decimals: 18 },
    { stablecoinId: "gusd-gate", symbol: "GUSD", address: "0xaf6186b3521b60e27396b5d23b48abc34bf585c5", decimals: 6 },
    { stablecoinId: "avusd-avant", symbol: "avUSD", address: "0xf4c13d631450de6b12a19829e37c8e2826891dc4", decimals: 18 },
    { stablecoinId: "pmusd-precious-metals", symbol: "pmUSD", address: "0xc0c17dd08263c16f6b64e772fb9b723bf1344ddf", decimals: 18 },
    { stablecoinId: "usdz-anzen", symbol: "USDz", address: "0xa469b7ee9ee773642b3e93e842e5d9b5baa10067", decimals: 18 },
    { stablecoinId: "mnee-mnee", symbol: "MNEE", address: "0x8ccedbae4916b79da7f3f612efb2eb93a2bfd6cf", decimals: 18 },
    { stablecoinId: "tbill-openeden", symbol: "TBILL", address: "0xdd50c053c096cb04a3e3362e2b622529ec5f2e8a", decimals: 6 },
  ];

  it("tracks newly added top-50 Ethereum contracts via standard zero-address Transfer filters", () => {
    for (const expected of top50EthereumAdditions) {
      const cfg = MINT_BURN_CONFIGS.find(
        (c) =>
          c.chain.chainId === "ethereum" &&
          c.contractAddress.toLowerCase() === expected.address.toLowerCase(),
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
    { stablecoinId: "usdo-openeden", symbol: "USDO", address: "0x8238884ec9668ef77b90c6dff4d1a9f4f4823bfe", decimals: 18 },
    { stablecoinId: "eurcv-societe-generale-forge", symbol: "EURCV", address: "0x5f7827fdeb7c20b443265fc2f40845b715385ff2", decimals: 18 },
    { stablecoinId: "reusd-resupply", symbol: "REUSD", address: "0x57ab1e0003f623289cd798b1824be09a793e4bec", decimals: 18 },
    { stablecoinId: "euri-banking-circle", symbol: "EURI", address: "0x9d1a7a3191102e9f900faa10540837ba84dcbae7", decimals: 18 },
    { stablecoinId: "gusd-gemini", symbol: "GUSD", address: "0x056fd409e1d7a124bd7017459dfea2f387b6d5cd", decimals: 2 },
    { stablecoinId: "usdp-paxos", symbol: "USDP", address: "0x8e870d67f660d95d5be530380d0ec0bd388289e1", decimals: 18 },
    { stablecoinId: "xusd-straitsx", symbol: "XUSD", address: "0xc08e7e23c235073c6807c2efe7021304cb7c2815", decimals: 6 },
    { stablecoinId: "musd-metamask", symbol: "MUSD", address: "0xaca92e438df0b2401ff60da7e4337b687a2435da", decimals: 6 },
    { stablecoinId: "yusd-aegis", symbol: "YUSD", address: "0x4274cd7277c7bb0806bd5fe84b9adae466a8da0a", decimals: 18 },
    { stablecoinId: "lusd-liquity", symbol: "LUSD", address: "0x5f98805a4e8be255a32880fdec7f6728c6568ba0", decimals: 18 },
    { stablecoinId: "usdcv-societe-generale-forge", symbol: "USDCV", address: "0x5422374b27757da72d5265cc745ea906e0446634", decimals: 18 },
    { stablecoinId: "eure-monerium", symbol: "EURE", address: "0x39b8b6385416f4ca36a20319f70d28621895279d", decimals: 18 },
    { stablecoinId: "usn-noon", symbol: "USN", address: "0xda67b4284609d2d48e5d10cfac411572727dc1ed", decimals: 18 },
    { stablecoinId: "eusd-electronic-usd", symbol: "EUSD", address: "0xa0d69e286b938e21cbf7e51d71f6a4c8918f482f", decimals: 18 },
    { stablecoinId: "meusd-mezo", symbol: "MUSD", address: "0xdd468a1ddc392dcdbef6db6e34e89aa338f9f186", decimals: 18 },
    { stablecoinId: "msusd-metronome", symbol: "MSUSD", address: "0xab5eb14c09d416f0ac63661e57edb7aecdb9befa", decimals: 18 },
    { stablecoinId: "nusd-neutrl", symbol: "NUSD", address: "0xe556aba6fe6036275ec1f87eda296be72c811bce", decimals: 18 },
    { stablecoinId: "alusd-alchemix", symbol: "alUSD", address: "0xbc6da0fe9ad5f3b0d58160288917aa56653660e9", decimals: 18 },
    { stablecoinId: "fidd-fidelity", symbol: "FIDD", address: "0x7c135549504245b5eae64fc0e99fa5ebabb8e35d", decimals: 18 },
  ];

  it("tracks newly added top-100 Ethereum contracts via standard zero-address Transfer filters", () => {
    for (const expected of top100EthereumAdditions) {
      const cfg = MINT_BURN_CONFIGS.find(
        (c) =>
          c.chain.chainId === "ethereum" &&
          c.contractAddress.toLowerCase() === expected.address.toLowerCase(),
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
    { stablecoinId: "wusd-worldwide", symbol: "WUSD", address: "0x7cd017ca5ddb86861fa983a34b5f495c6f898c41", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "sbc-brale", symbol: "SBC", address: "0xf9fb20b8e097904f0ab7d12e9dbee88f2dcd0f16", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "ousd-origin-protocol", symbol: "OUSD", address: "0x2a8e1e676ec238d8a992307b495b45b3feaa5e86", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "usp-pikudao", symbol: "USP", address: "0x098697ba3fee4ea76294c5d6a466a4e3b3e95fe6", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "ustb-superstate", symbol: "USTB", address: "0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e", decimals: 6, dustThreshold: 1_000 },
    { stablecoinId: "ousg-ondo-finance", symbol: "OUSG", address: "0x1b19c19393e2d034d8ff31ff34c81252fcbbee92", decimals: 18, dustThreshold: 100 },
    { stablecoinId: "mtbill-midas", symbol: "mTBILL", address: "0xdd629e5241cbc5919847783e6c96b2de4754e438", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "wsrusd-reservoir", symbol: "wsrUSD", address: "0xd3fd63209fa2d55b07a0f6db36c2f43900be3094", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "audd-novatti", symbol: "AUDD", address: "0x4cce605ed955295432958d8951d0b176c10720d5", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "jpyc-jpyc", symbol: "JPYC", address: "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "xaum-matrixdock", symbol: "XAUm", address: "0x2103e845c5e135493bb6c2a4f0b8651956ea8682", decimals: 18, dustThreshold: 10 },
    { stablecoinId: "europ-schuman", symbol: "EUROP", address: "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "deuro-deuro", symbol: "DEURO", address: "0xba3f535bbcccca2a154b573ca6c5a49baae0a3ea", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "tgbp-tokenised", symbol: "tGBP", address: "0x27f6c8289550fce67f6b50bed1f519966afe5287", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "syrupusdc-maple", symbol: "syrupUSDC", address: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "syrupusdt-maple", symbol: "syrupUSDT", address: "0x356b8d89c1e1239cbbb9de4815c39a1474d5ba7d", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "aid-gaib", symbol: "AID", address: "0x18f52b3fb465118731d9e0d276d4eb3599d57596", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "apxusd-apyx", symbol: "apxUSD", address: "0x98a878b1cd98131b271883b390f68d2c90674665", decimals: 18, dustThreshold: 10_000 },
  ];

  it("tracks newly added top-150 Ethereum contracts via standard zero-address Transfer filters", () => {
    for (const expected of top150EthereumAdditions) {
      const cfg = MINT_BURN_CONFIGS.find(
        (c) =>
          c.chain.chainId === "ethereum" &&
          c.contractAddress.toLowerCase() === expected.address.toLowerCase(),
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

describe("mint-burn-contracts top-200 Ethereum additions", () => {
  const top200EthereumAdditions = [
    { stablecoinId: "u-united-stables", symbol: "U", address: "0xce24439f2d9c6a2289f741120fe202248b666666", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "a7a5-old-vector", symbol: "A7A5", address: "0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "usda-avalon", symbol: "USDA", address: "0x8a60e489004ca22d775c5f2c657598278d17d9c2", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "brz-transfero", symbol: "BRZ", address: "0x01d33fd36ec67c6ada32cf36b31e88ee190b1839", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "kag-kinesis", symbol: "KAG", address: "0x56ba8b58b7d1f6d384a1c4dd553f39ebc8741b8e", decimals: 18, dustThreshold: 10 },
    { stablecoinId: "satusd-river", symbol: "satUSD", address: "0x1958853a8be062dc4f401750eb233f5850f0d0d2", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "rwausdi-multipli", symbol: "rwaUSDi", address: "0xa39986f96b80d04e8d7aeaaf47175f47c23fd0f4", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "fpi-frax", symbol: "FPI", address: "0x5ca135cb8527d76e932f34b5145575f9d8cbe08e", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "usdq-quantoz", symbol: "USDQ", address: "0xc83e27f270cce0a3a3a29521173a83f402c1768b", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "usdx-hex-trust", symbol: "USDX", address: "0xf8750b54d86be7ae9e32b4a0c826811198d63313", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "mim-abracadabra", symbol: "MIM", address: "0x99d8a9c45b2eca8864373a26d1459e3dff1e17f3", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "usat-tether", symbol: "USAT", address: "0x07041776f5007aca2a54844f50503a18a72a8b68", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "ggbr-goldfish-gold", symbol: "GGBR", address: "0x7e2ac793f3e692f388e66c7dc28f739d13b0b71a", decimals: 18, dustThreshold: 10 },
    { stablecoinId: "xsgd-straitsx", symbol: "XSGD", address: "0x70e8de73ce538da2beed35d14187f6959a8eca96", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "idrt-rupiah-token", symbol: "IDRT", address: "0x998ffe1e43facffb941dc337dd0468d52ba5b48a", decimals: 2, dustThreshold: 10_000 },
    { stablecoinId: "tryb-bilira", symbol: "TRYB", address: "0x2c537e5624e4af88a7ae4060c022609376c8d0eb", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "eurs-stasis", symbol: "EURS", address: "0xdb25f211ab05b1c97d595516f45794528a807ad8", decimals: 2, dustThreshold: 10_000 },
    { stablecoinId: "pusd-plume", symbol: "pUSD", address: "0xdddd73f5df1f0dc31373357beac77545dc5a6f3f", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "usbd-bima", symbol: "USBD", address: "0x6bede1c6009a78c222d9bdb7974bb67847fdb68c", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "dgld-gold-token-sa", symbol: "DGLD", address: "0xa9299c296d7830a99414d1e5546f5171fa01e9c8", decimals: 18, dustThreshold: 10 },
    { stablecoinId: "axcnh-anchorx", symbol: "AxCNH", address: "0x2925ac3be7d585874b88ea51ed50add376ad8239", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "eurq-quantoz", symbol: "EURQ", address: "0x8df723295214ea6f21026eeeb4382d475f146f9f", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "usdu-usdu-finance", symbol: "USDU", address: "0xdde3ec717f220fc6a29d6a4be73f91da5b718e55", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "zarp-zarp", symbol: "ZARP", address: "0xb755506531786c8ac63b756bab1ac387bacb0c04", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "usdp-parallel", symbol: "USDp", address: "0x9b3a8f7cec208e247d97dee13313690977e24459", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "pht-pht", symbol: "PHT", address: "0xbe370ad45d44eb45174c4ec60b88839fef32c077", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "vchf-vnx", symbol: "VCHF", address: "0x79d4f0232a66c4c91b89c76362016a1707cfbf4f", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "ussd-sonic-labs", symbol: "USSD", address: "0x000000000eccff26b795f73fb0a70d48da657fef", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "cadc-cad-coin", symbol: "CADC", address: "0xcadc0acd4b445166f12d2c07eac6e2544fbe2eef", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "veur-vnx", symbol: "VEUR", address: "0x6ba75d640bebfe5da1197bb5a2aff3327789b5d3", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "dusd-dtrinity", symbol: "dUSD", address: "0x07fff99e1664d9b116fbc158c0e99785f81ca236", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "usdaf-asymmetry", symbol: "USDaf", address: "0x9cf12ccd6020b6888e4d4c4e4c7aca33c1eb91f8", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "eurau-allunity", symbol: "EURAU", address: "0x4933a85b5b5466fbaf179f72d3de273c287ec2c2", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "dusd-alto", symbol: "DUSD", address: "0x63d74d22e689c715a04f2c13962b1f77f443d35b", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "ebusd-ebisu", symbol: "ebUSD", address: "0x09fd37d9aa613789c517e76df1c53aece2b60df4", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "ftusd-flying-tulip", symbol: "ftUSD", address: "0xf7d85ec4e7710f71992752eac2111312e73e9c9c", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "usdkg-gold-dollar", symbol: "USDKG", address: "0xe820c06321e60d36257c666643fa5436643445e3", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "chfau-allunity", symbol: "CHFAU", address: "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "mxnb-juno", symbol: "MXNB", address: "0xf197ffc28c23e0309b5559e7a166f2c6164c80aa", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "cjpy-yamato", symbol: "CJPY", address: "0x1cfa5641c01406ab8ac350ded7d735ec41298372", decimals: 18, dustThreshold: 10_000 },
  ];

  it("tracks newly added top-200 Ethereum contracts via standard zero-address Transfer filters", () => {
    for (const expected of top200EthereumAdditions) {
      const cfg = MINT_BURN_CONFIGS.find(
        (c) =>
          c.chain.chainId === "ethereum" &&
          c.contractAddress.toLowerCase() === expected.address.toLowerCase(),
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

describe("mint-burn-contracts provenance metadata", () => {
  it("marks blanket transfer-wave start blocks as low-confidence defaults", () => {
    const cfg = MINT_BURN_CONFIGS.find((entry) => entry.stablecoinId === "u-united-stables");
    expect(cfg).toBeDefined();
    expect(cfg?.adapterKind).toBe("transfer-zero-address");
    expect(cfg?.startBlockSource).toBe("default-coverage-floor-2026-03-24");
    expect(cfg?.startBlockConfidence).toBe("low");
  });

  it("marks reviewed custom-event adapters as high-confidence", () => {
    const cfg = MINT_BURN_CONFIGS.find((entry) => entry.stablecoinId === "usdt-tether");
    expect(cfg).toBeDefined();
    expect(cfg?.adapterKind).toBe("custom-events");
    expect(cfg?.startBlockSource).toBe("reviewed-contract-specific");
    expect(cfg?.startBlockConfidence).toBe("high");
  });
});

describe("validateMintBurnBridgeDetection", () => {
  it("keeps checked-in bridge configs clean at module load", () => {
    expect(MINT_BURN_BRIDGE_VALIDATION_ERRORS).toEqual([]);
    expect(MINT_BURN_BRIDGE_VALIDATION_ERROR_COUNT).toBe(0);
    expect(collectMintBurnBridgeValidationErrors(MINT_BURN_CONFIGS)).toEqual([]);
  });

  it("accepts a well-formed config", () => {
    expect(() => validateMintBurnBridgeDetection({
      protocol: "ccip",
      knownBridgePoolAddresses: ["0x80226fc0ee2b096224eeac085bb9a8cba1146f7d"],
      knownBridgeRouterAddresses: ["0x80226fc0ee2b096224eeac085bb9a8cba1146f7d"],
      bridgeSignalTopics: ["0xd0c3c799bf9e2639de44391e7f524d229b2b55f5b1ea94b2bf7da42f7243dddd"],
      bridgeSignalSelectors: ["0x96f4e9f9"],
    })).not.toThrow();
  });
  it("rejects malformed address (no 0x)", () => {
    expect(() => validateMintBurnBridgeDetection({
      protocol: "ccip",
      knownBridgePoolAddresses: ["80226fc0ee2b096224eeac085bb9a8cba1146f7d"],
      knownBridgeRouterAddresses: [], bridgeSignalTopics: [], bridgeSignalSelectors: [],
    })).toThrow(/address/i);
  });
  it("rejects topic of wrong length", () => {
    expect(() => validateMintBurnBridgeDetection({
      protocol: "ccip",
      knownBridgePoolAddresses: [], knownBridgeRouterAddresses: [],
      bridgeSignalTopics: ["0xdeadbeef"], bridgeSignalSelectors: [],
    })).toThrow(/topic/i);
  });
  it("rejects selector of wrong length", () => {
    expect(() => validateMintBurnBridgeDetection({
      protocol: "ccip",
      knownBridgePoolAddresses: [], knownBridgeRouterAddresses: [],
      bridgeSignalTopics: [], bridgeSignalSelectors: ["0xabcd"],
    })).toThrow(/selector/i);
  });

  it("collects per-config errors for fail-fast module validation", () => {
    const [baseConfig] = MINT_BURN_CONFIGS;
    expect(baseConfig).toBeDefined();
    const malformed = {
      ...baseConfig!,
      bridgeDetection: {
        protocol: "ccip" as const,
        knownBridgePoolAddresses: ["0xnot-an-address"],
        knownBridgeRouterAddresses: [],
        bridgeSignalTopics: [],
        bridgeSignalSelectors: [],
      },
    };

    expect(collectMintBurnBridgeValidationErrors([malformed])).toEqual([
      `${baseConfig!.chain.chainId}/${baseConfig!.stablecoinId}: mint-burn bridge config: invalid address "0xnot-an-address" for protocol ccip`,
    ]);
  });
});
