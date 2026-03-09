import { describe, it, expect } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { decodeUint256AtSlot } from "../evm-logs";
import { MINT_BURN_CONFIGS } from "../mint-burn-contracts";

const REUSD_DEPOSITED_TOPIC = "0x8752a472e571a816aea92eec8dae9baf628e840f4929fbcc2d155e6233ff68a7";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_ADDRESS_PADDED = "0x0000000000000000000000000000000000000000000000000000000000000000";
const MINT_BURN_ADDRESS_OVERRIDES = new Set([
  "0x4691c475be804fa85f91c2d6d0adf03114de3093",
  "0x8aeb9453ef22cb38abc7a3af9c208f65c1bfe31e",
]);
const REMOVED_STABLECOIN_IDS = [
  "u-united-stables",
  "usdai-usd-ai",
  "brz-transfero",
  "gyd-gyroscope",
  "eurs-stasis",
  "253",
  "a7a5-old-vector",
  "rwausdi-multipli",
  "aeur-anchored-coins",
  "usdq-quantoz",
  "usdx-hex-trust",
  "mim-abracadabra",
  "zeusd-zoth",
  "usat-tether",
  "usdu-usdu-finance",
  "zarp-zarp",
  "cadc-cad-coin",
  "pht-pht",
  "eurq-quantoz",
  "uscc-legacy",
  "satusd-river",
  "eurau-allunity",
  "vchf-vnx",
  "pusd-plume",
  "veur-vnx",
  "gyen-gyen",
  "usda-avalon",
  "xsgd-straitsx",
  "fpi-frax",
  "dgld-gold-token-sa",
  "kag-kinesis",
] as const;

describe("mint-burn-contracts reUSD config", () => {
  it("uses 18 decimals for reUSD Deposited mint events", () => {
    const reusdDepositConfigs = MINT_BURN_CONFIGS.filter(
      (c) =>
        c.symbol === "reUSD" &&
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
        c.symbol === "reUSD" &&
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

describe("mint-burn-contracts removals", () => {
  it("does not track explicitly removed no-signal tokens", () => {
    const trackedIds = new Set(MINT_BURN_CONFIGS.map((c) => c.stablecoinId));
    for (const removedId of REMOVED_STABLECOIN_IDS) {
      expect(trackedIds.has(removedId)).toBe(false);
    }
  });
});

describe("mint-burn-contracts Ethereum-only scope", () => {
  it("keeps all tracked configs on ethereum", () => {
    const uniqueChains = new Set(MINT_BURN_CONFIGS.map((c) => c.chain.chainId));
    expect(uniqueChains).toEqual(new Set(["ethereum"]));
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

      expect(
        MINT_BURN_ADDRESS_OVERRIDES.has(config.contractAddress.toLowerCase()),
        `expected ${config.stablecoinId} ${config.contractAddress} to be declared in shared metadata or allowlisted override`,
      ).toBe(true);
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
    { stablecoinId: "usr-resolv", symbol: "USR", address: "0x66a1e37c9b0eaddca17d3662d6c05f4decf3e110", decimals: 18 },
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
    { stablecoinId: "susd-synthetix", symbol: "SUSD", address: "0x57ab1ec28d129707052df4df418d58a2d46d5f51", decimals: 18 },
    { stablecoinId: "lusd-liquity", symbol: "LUSD", address: "0x5f98805a4e8be255a32880fdec7f6728c6568ba0", decimals: 18 },
    { stablecoinId: "usdcv-societe-generale-forge", symbol: "USDCV", address: "0x5422374b27757da72d5265cc745ea906e0446634", decimals: 18 },
    { stablecoinId: "eure-monerium", symbol: "EURE", address: "0x39b8b6385416f4ca36a20319f70d28621895279d", decimals: 18 },
    { stablecoinId: "usn-noon", symbol: "USN", address: "0xda67b4284609d2d48e5d10cfac411572727dc1ed", decimals: 18 },
    { stablecoinId: "eusd-electronic-usd", symbol: "EUSD", address: "0xa0d69e286b938e21cbf7e51d71f6a4c8918f482f", decimals: 18 },
    { stablecoinId: "eura-angle", symbol: "EURA", address: "0x1a7e4e63778b4f12a199c062f3efdd288afcbce8", decimals: 18 },
    { stablecoinId: "meusd-mezo", symbol: "meUSD", address: "0xdd468a1ddc392dcdbef6db6e34e89aa338f9f186", decimals: 18 },
    { stablecoinId: "msusd-metronome", symbol: "MSUSD", address: "0xab5eb14c09d416f0ac63661e57edb7aecdb9befa", decimals: 18 },
    { stablecoinId: "nusd-neutrl", symbol: "NUSD", address: "0xe556aba6fe6036275ec1f87eda296be72c811bce", decimals: 18 },
    { stablecoinId: "alusd-alchemix", symbol: "ALUSD", address: "0xbc6da0fe9ad5f3b0d58160288917aa56653660e9", decimals: 18 },
    { stablecoinId: "fidd-fidelity", symbol: "FIDD", address: "0x7c135549504245b5eae64fc0e99fa5ebabb8e35d", decimals: 18 },
    { stablecoinId: "msusd-main-street", symbol: "MSUSD", address: "0x4ba01f22827018b4772cd326c7627fb4956a7c00", decimals: 18 },
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
    { stablecoinId: "usdr-stablr", symbol: "USDR", address: "0x7b43e3875440b44613dc3bc08e7763e6da63c8f8", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "ustb-superstate", symbol: "USTB", address: "0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e", decimals: 6, dustThreshold: 1_000 },
    { stablecoinId: "ousg-ondo-finance", symbol: "OUSG", address: "0x1b19c19393e2d034d8ff31ff34c81252fcbbee92", decimals: 18, dustThreshold: 100 },
    { stablecoinId: "mtbill-midas", symbol: "mTBILL", address: "0xdd629e5241cbc5919847783e6c96b2de4754e438", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "wsrusd-reservoir", symbol: "wsrUSD", address: "0xd3fd63209fa2d55b07a0f6db36c2f43900be3094", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "audd-novatti", symbol: "AUDD", address: "0x4cce605ed955295432958d8951d0b176c10720d5", decimals: 6, dustThreshold: 10_000 },
    { stablecoinId: "jpyc-jpyc", symbol: "JPYC", address: "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29", decimals: 18, dustThreshold: 10_000 },
    { stablecoinId: "xaum-matrixdock", symbol: "XAUm", address: "0x2103e845c5e135493bb6c2a4f0b8651956ea8682", decimals: 18, dustThreshold: 10 },
    { stablecoinId: "eurr-stablr", symbol: "EURR", address: "0x50753cfaf86c094925bf976f218d043f8791e408", decimals: 6, dustThreshold: 10_000 },
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
