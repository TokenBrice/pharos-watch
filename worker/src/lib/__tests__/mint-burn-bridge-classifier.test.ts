import { describe, expect, it } from "vitest";
import {
  classifyBridgeAwareBurnRows,
  type MintBurnBridgeClassifiableRow,
  type MintBurnTxContext,
} from "../mint-burn-bridge-classifier";
import {
  MINT_BURN_CONFIGS,
  type MintBurnBridgeDetectionConfig,
  type MintBurnCcipBridgeDetectionConfig,
  type MintBurnCctpBridgeDetectionConfig,
  type MintBurnContractConfig,
  type MintBurnLayerZeroOftBridgeDetectionConfig,
} from "../mint-burn-contracts";
import { ccipBridgeDetection, layerZeroOftBridgeDetection } from "../mint-burn-contracts-helpers";

type CcipCoinCase = {
  stablecoinId: string;
  symbol: string;
  detection: MintBurnCcipBridgeDetectionConfig;
};

type LayerZeroCoinCase = {
  stablecoinId: string;
  symbol: string;
  detection: MintBurnLayerZeroOftBridgeDetectionConfig;
};

type CctpCoinCase = {
  stablecoinId: string;
  symbol: string;
  detection: MintBurnCctpBridgeDetectionConfig;
};

const CCIP_CASE_IDS = ["zchf-frankencoin", "usd1-world-liberty-financial", "avusd-avant", "usdo-openeden"] as const;
const LAYERZERO_CASE_IDS = ["usdai-usd-ai"] as const;
const CCTP_CASE_IDS = ["usdc-circle", "eurc-circle"] as const;

function loadCoinCase(stablecoinId: string): {
  stablecoinId: string;
  symbol: string;
  detection: MintBurnBridgeDetectionConfig;
} {
  const config = MINT_BURN_CONFIGS.find(
    (entry): entry is MintBurnContractConfig =>
      entry.chain.chainId === "ethereum" && entry.stablecoinId === stablecoinId,
  );
  if (!config || !config.bridgeDetection) {
    throw new Error(`Missing CCIP bridgeDetection config for stablecoin ${stablecoinId}`);
  }
  return {
    stablecoinId: config.stablecoinId,
    symbol: config.symbol,
    detection: config.bridgeDetection,
  };
}

function loadCcipCase(stablecoinId: string): CcipCoinCase {
  const coin = loadCoinCase(stablecoinId);
  if (coin.detection.protocol !== "ccip") {
    throw new Error(`Expected CCIP bridgeDetection config for stablecoin ${stablecoinId}`);
  }
  return {
    ...coin,
    detection: coin.detection,
  };
}

function loadLayerZeroCase(stablecoinId: string): LayerZeroCoinCase {
  const config = MINT_BURN_CONFIGS.find(
    (entry): entry is MintBurnContractConfig =>
      entry.stablecoinId === stablecoinId && entry.bridgeDetection?.protocol === "layerzero-oft",
  );
  if (!config || !config.bridgeDetection || config.bridgeDetection.protocol !== "layerzero-oft") {
    throw new Error(`Expected LayerZero OFT bridgeDetection config for stablecoin ${stablecoinId}`);
  }
  const coin = {
    stablecoinId: config.stablecoinId,
    symbol: config.symbol,
    detection: config.bridgeDetection,
  };
  if (coin.detection.protocol !== "layerzero-oft") {
    throw new Error(`Expected LayerZero OFT bridgeDetection config for stablecoin ${stablecoinId}`);
  }
  return {
    ...coin,
    detection: coin.detection,
  };
}

function loadCctpCase(stablecoinId: string): CctpCoinCase {
  const coin = loadCoinCase(stablecoinId);
  if (coin.detection.protocol !== "cctp") {
    throw new Error(`Expected CCTP bridgeDetection config for stablecoin ${stablecoinId}`);
  }
  return {
    ...coin,
    detection: coin.detection,
  };
}

const COIN_CASES = CCIP_CASE_IDS.map((stablecoinId) => loadCcipCase(stablecoinId));
const LAYERZERO_CASES = LAYERZERO_CASE_IDS.map((stablecoinId) => loadLayerZeroCase(stablecoinId));
const CCTP_CASES = CCTP_CASE_IDS.map((stablecoinId) => loadCctpCase(stablecoinId));

function makeBurnRow(overrides?: Partial<MintBurnBridgeClassifiableRow>): MintBurnBridgeClassifiableRow {
  return {
    id: overrides?.id ?? "row-1",
    tx_hash: overrides?.tx_hash ?? "0xtx",
    direction: overrides?.direction ?? "burn",
    flow_type: overrides?.flow_type ?? "standard",
    counterparty: overrides?.counterparty ?? "0xabc0000000000000000000000000000000000000",
    burn_type: overrides?.burn_type ?? null,
    burn_review_reason: overrides?.burn_review_reason ?? null,
  };
}

function signalContext(detection: MintBurnCcipBridgeDetectionConfig | MintBurnCctpBridgeDetectionConfig) {
  return {
    from: "0xsender",
    to: detection.knownBridgeRouterAddresses[0],
    inputSelector: detection.bridgeSignalSelectors[0],
    logTopics: [detection.bridgeSignalTopics[0]],
    logAddresses: [detection.knownBridgeRouterAddresses[0]],
  };
}

function layerZeroSignalContext(detection: MintBurnLayerZeroOftBridgeDetectionConfig) {
  return {
    from: "0xe93685f3bba03016f02bd1828badd6195988d950",
    to: detection.knownBridgeContractAddresses[0],
    inputSelector: detection.bridgeSignalSelectors[0],
    logTopics: [detection.bridgeSignalTopics[0]],
    logAddresses: [
      detection.knownBridgeContractAddresses[0],
      detection.bridgeSignalEmitterAddresses[0],
    ],
  };
}

describe("classifyBridgeAwareBurnRows", () => {
  it("defaults to effective_burn when detection is disabled", () => {
    const row = makeBurnRow({ tx_hash: "0xgenuine" });
    classifyBridgeAwareBurnRows([row], undefined, new Map());
    expect(row.burn_type).toBe("effective_burn");
    expect(row.burn_review_reason).toBeNull();
  });

  for (const coin of COIN_CASES) {
    it(`[${coin.symbol}] classifies known pool + bridge signal as bridge_burn`, () => {
      const row = makeBurnRow({
        tx_hash: `0xbridge-${coin.stablecoinId}`,
        counterparty: coin.detection.knownBridgePoolAddresses[0],
      });
      const contexts = new Map([[row.tx_hash, signalContext(coin.detection)]]);

      classifyBridgeAwareBurnRows([row], coin.detection, contexts);

      expect(row.burn_type).toBe("bridge_burn");
      expect(row.burn_review_reason).toBeNull();
    });

    it(`[${coin.symbol}] keeps standard burns as effective_burn`, () => {
      const row = makeBurnRow({
        tx_hash: `0xeffective-${coin.stablecoinId}`,
        counterparty: "0x1234000000000000000000000000000000000000",
      });
      const contexts = new Map([
        [
          row.tx_hash,
          {
            from: "0x1234000000000000000000000000000000000000",
            to: "0x1111111111111111111111111111111111111111",
            inputSelector: "0xdeadbeef",
            logTopics: [],
            logAddresses: [],
          },
        ],
      ]);

      classifyBridgeAwareBurnRows([row], coin.detection, contexts);

      expect(row.burn_type).toBe("effective_burn");
      expect(row.burn_review_reason).toBeNull();
    });

    it(`[${coin.symbol}] flags known pool without signal as review_required`, () => {
      const row = makeBurnRow({
        tx_hash: `0xmissing-signal-${coin.stablecoinId}`,
        counterparty: coin.detection.knownBridgePoolAddresses[0],
      });
      const contexts = new Map([
        [
          row.tx_hash,
          {
            from: "0x1234000000000000000000000000000000000000",
            to: "0x1111111111111111111111111111111111111111",
            inputSelector: "0xdeadbeef",
            logTopics: [],
            logAddresses: [],
          },
        ],
      ]);

      classifyBridgeAwareBurnRows([row], coin.detection, contexts);

      expect(row.burn_type).toBe("review_required");
      expect(row.burn_review_reason).toBe("known-bridge-pool-without-bridge-signal");
    });

    it(`[${coin.symbol}] tags bridge signal with unknown pool as bridge_transfer (aggressive: bridge tx = bridge rows)`, () => {
      const row = makeBurnRow({
        tx_hash: `0xunknown-pool-${coin.stablecoinId}`,
        counterparty: "0x9999000000000000000000000000000000000000",
      });
      const contexts = new Map([[row.tx_hash, signalContext(coin.detection)]]);

      classifyBridgeAwareBurnRows([row], coin.detection, contexts);

      expect(row.flow_type).toBe("bridge_transfer");
      expect(row.burn_type).toBe("bridge_burn");
      expect(row.burn_review_reason).toBeNull();
    });

    it(`[${coin.symbol}] treats null tx context as review_required (Alchemy lookup failure)`, () => {
      const row = makeBurnRow({
        tx_hash: `0xnull-ctx-${coin.stablecoinId}`,
        counterparty: coin.detection.knownBridgePoolAddresses[0],
      });
      // null context = Alchemy failed to fetch tx/receipt
      const txContext = new Map<string, null>([[row.tx_hash, null]]);

      classifyBridgeAwareBurnRows([row], coin.detection, txContext);

      expect(row.burn_type).toBe("review_required");
      expect(row.burn_review_reason).toBe("tx-context-unavailable");
    });
  }

  for (const cctpCoin of CCTP_CASES) {
    it(`[${cctpCoin.symbol}] classifies known pool + bridge signal as bridge_burn`, () => {
      const row = makeBurnRow({
        tx_hash: `0xbridge-${cctpCoin.stablecoinId}`,
        counterparty: cctpCoin.detection.knownBridgePoolAddresses[0],
      });
      const contexts = new Map([[row.tx_hash, signalContext(cctpCoin.detection)]]);

      classifyBridgeAwareBurnRows([row], cctpCoin.detection, contexts);

      expect(row.burn_type).toBe("bridge_burn");
      expect(row.burn_review_reason).toBeNull();
    });

    it(`[${cctpCoin.symbol}] keeps standard burns as effective_burn`, () => {
      const row = makeBurnRow({
        tx_hash: `0xeffective-${cctpCoin.stablecoinId}`,
        counterparty: "0x1234000000000000000000000000000000000000",
      });
      const contexts = new Map([
        [
          row.tx_hash,
          {
            from: "0x1234000000000000000000000000000000000000",
            to: "0x1111111111111111111111111111111111111111",
            inputSelector: "0xdeadbeef",
            logTopics: [],
            logAddresses: [],
          },
        ],
      ]);

      classifyBridgeAwareBurnRows([row], cctpCoin.detection, contexts);

      expect(row.burn_type).toBe("effective_burn");
      expect(row.burn_review_reason).toBeNull();
    });

    it(`[${cctpCoin.symbol}] flags known pool without signal as review_required`, () => {
      const row = makeBurnRow({
        tx_hash: `0xmissing-signal-${cctpCoin.stablecoinId}`,
        counterparty: cctpCoin.detection.knownBridgePoolAddresses[0],
      });
      const contexts = new Map([
        [
          row.tx_hash,
          {
            from: "0x1234000000000000000000000000000000000000",
            to: "0x1111111111111111111111111111111111111111",
            inputSelector: "0xdeadbeef",
            logTopics: [],
            logAddresses: [],
          },
        ],
      ]);

      classifyBridgeAwareBurnRows([row], cctpCoin.detection, contexts);

      expect(row.burn_type).toBe("review_required");
      expect(row.burn_review_reason).toBe("known-bridge-pool-without-bridge-signal");
    });

    it(`[${cctpCoin.symbol}] tags bridge signal with unknown pool as bridge_transfer (aggressive: bridge tx = bridge rows)`, () => {
      const row = makeBurnRow({
        tx_hash: `0xunknown-pool-${cctpCoin.stablecoinId}`,
        counterparty: "0x9999000000000000000000000000000000000000",
      });
      const contexts = new Map([[row.tx_hash, signalContext(cctpCoin.detection)]]);

      classifyBridgeAwareBurnRows([row], cctpCoin.detection, contexts);

      expect(row.flow_type).toBe("bridge_transfer");
      expect(row.burn_type).toBe("bridge_burn");
      expect(row.burn_review_reason).toBeNull();
    });

    it(`[${cctpCoin.symbol}] treats null tx context as review_required (Alchemy lookup failure)`, () => {
      const row = makeBurnRow({
        tx_hash: `0xnull-ctx-${cctpCoin.stablecoinId}`,
        counterparty: cctpCoin.detection.knownBridgePoolAddresses[0],
      });
      // null context = Alchemy failed to fetch tx/receipt
      const txContext = new Map<string, null>([[row.tx_hash, null]]);

      classifyBridgeAwareBurnRows([row], cctpCoin.detection, txContext);

      expect(row.burn_type).toBe("review_required");
      expect(row.burn_review_reason).toBe("tx-context-unavailable");
    });
  }

  for (const coin of LAYERZERO_CASES) {
    it(`[${coin.symbol}] classifies LayerZero bridge mints and burns as bridge transfers`, () => {
      const burnRow = makeBurnRow({
        tx_hash: `0xbridge-burn-${coin.stablecoinId}`,
        direction: "burn",
        counterparty: "0xb5cb4b95676b1c0259b3f3686bb9290ed9c8171c",
      });
      const mintRow = makeBurnRow({
        id: "row-2",
        tx_hash: `0xbridge-mint-${coin.stablecoinId}`,
        direction: "mint",
        counterparty: "0xb5cb4b95676b1c0259b3f3686bb9290ed9c8171c",
      });
      const contexts = new Map([
        [burnRow.tx_hash, layerZeroSignalContext(coin.detection)],
        [mintRow.tx_hash, layerZeroSignalContext(coin.detection)],
      ]);

      classifyBridgeAwareBurnRows([burnRow, mintRow], coin.detection, contexts);

      expect(burnRow.burn_type).toBe("bridge_burn");
      expect(burnRow.flow_type).toBe("bridge_transfer");
      expect(mintRow.burn_type).toBeNull();
      expect(mintRow.flow_type).toBe("bridge_transfer");
    });

    it(`[${coin.symbol}] keeps non-bridge activity on standard flow semantics`, () => {
      const burnRow = makeBurnRow({
        tx_hash: `0xeffective-${coin.stablecoinId}`,
        direction: "burn",
        counterparty: "0x1234000000000000000000000000000000000000",
      });
      const contexts = new Map([
        [
          burnRow.tx_hash,
          {
            from: "0x1234000000000000000000000000000000000000",
            to: "0x1111111111111111111111111111111111111111",
            inputSelector: "0xdeadbeef",
            logTopics: [],
            logAddresses: [],
          },
        ],
      ]);

      classifyBridgeAwareBurnRows([burnRow], coin.detection, contexts);

      expect(burnRow.burn_type).toBe("effective_burn");
      expect(burnRow.flow_type).toBe("standard");
    });

    it(`[${coin.symbol}] classifies executor-side local compose mints without adapter logs as bridge transfers`, () => {
      const mintRow = makeBurnRow({
        tx_hash: `0xexecutor-mint-${coin.stablecoinId}`,
        direction: "mint",
        counterparty: "0x24a92e28b4260f89ef62f5f4d7bc8a27c6c44c23",
      });
      const executorAddress = coin.detection.knownBridgeContractAddresses[1];
      const localComposeSelector =
        coin.detection.bridgeSignalSelectors[coin.detection.bridgeSignalSelectors.length - 1];
      const contexts = new Map([
        [
          mintRow.tx_hash,
          {
            from: "0x2cca77f15cd9f7f9c6acd8c062b18561759372a6",
            to: executorAddress,
            inputSelector: localComposeSelector,
            logTopics: [coin.detection.bridgeSignalTopics[0]],
            logAddresses: [coin.detection.bridgeSignalEmitterAddresses[0], "0x24a92e28b4260f89ef62f5f4d7bc8a27c6c44c23"],
          },
        ],
      ]);

      classifyBridgeAwareBurnRows([mintRow], coin.detection, contexts);

      expect(mintRow.burn_type).toBeNull();
      expect(mintRow.flow_type).toBe("bridge_transfer");
    });
  }
});

const CCIP_ROUTER = "0x80226fc0ee2b096224eeac085bb9a8cba1146f7d";
const CCIP_SEND_REQUESTED_TOPIC = "0xd0c3c799bf9e2639de44391e7f524d229b2b55f5b1ea94b2bf7da42f7243dddd";
const CCIP_SEND_SELECTOR = "0x96f4e9f9";

function row(overrides: Partial<MintBurnBridgeClassifiableRow> = {}): MintBurnBridgeClassifiableRow {
  return {
    id: "id-1", tx_hash: "0xtx1", direction: "mint",
    flow_type: "standard", counterparty: null, burn_type: null, burn_review_reason: null,
    ...overrides,
  };
}

describe("CCIP/CCTP classifier — bridge MINTS", () => {
  // CCIP pool address for ZCHF (per mint-burn-contracts.ts:200). Using a real
  // CCIP pool, not the CCTP TokenMinterV2, so the test stays semantically scoped.
  const CCIP_POOL_ZCHF = "0x9359cd75549dae00cdd8d22297bc9b13fbbe4b79";
  const detection = ccipBridgeDetection([CCIP_POOL_ZCHF]);

  it("tags an isolated CCIP bridge mint (no burn in same tx) as bridge_transfer", () => {
    const rows = [row({ direction: "mint", tx_hash: "0xa" })];
    const ctx = new Map<string, MintBurnTxContext | null>([
      ["0xa", {
        to: CCIP_ROUTER,
        inputSelector: CCIP_SEND_SELECTOR,
        logTopics: [CCIP_SEND_REQUESTED_TOPIC],
        logAddresses: [CCIP_ROUTER],
      }],
    ]);
    classifyBridgeAwareBurnRows(rows, detection, ctx);
    expect(rows[0].flow_type).toBe("bridge_transfer");
  });

  it("tags both mint and burn when both share a CCIP bridge tx", () => {
    const rows = [
      row({ direction: "mint", tx_hash: "0xb", id: "id-2" }),
      row({ direction: "burn", tx_hash: "0xb", id: "id-3", counterparty: CCIP_POOL_ZCHF }),
    ];
    const ctx = new Map<string, MintBurnTxContext | null>([
      ["0xb", { to: CCIP_ROUTER, inputSelector: CCIP_SEND_SELECTOR, logTopics: [CCIP_SEND_REQUESTED_TOPIC], logAddresses: [CCIP_ROUTER] }],
    ]);
    classifyBridgeAwareBurnRows(rows, detection, ctx);
    expect(rows[0].flow_type).toBe("bridge_transfer");
    expect(rows[1].flow_type).toBe("bridge_transfer");
    expect(rows[1].burn_type).toBe("bridge_burn");
  });

  it("does not tag a standard mint with no bridge signal", () => {
    const rows = [row({ direction: "mint", tx_hash: "0xc" })];
    const ctx = new Map<string, MintBurnTxContext | null>([
      ["0xc", { to: "0x1234", inputSelector: "0xabcd", logTopics: [], logAddresses: [] }],
    ]);
    classifyBridgeAwareBurnRows(rows, detection, ctx);
    expect(rows[0].flow_type).toBe("standard");
  });
});

describe("LayerZero OFT classifier — endpoint-only signal", () => {
  // Fixture references from agents/research/2026-04-08-usdai-mint-burn-bridge-investigation.md.
  // `layerZeroOftBridgeDetection` takes ONLY `knownBridgeContractAddresses`; the emitter
  // (LAYERZERO_ENDPOINT_V2), topics (PACKET_SENT/PACKET_DELIVERED), and selectors are
  // hardcoded inside the helper. We use those canonical defaults here.
  const ARB_LZ_ENDPOINT_V2 = "0x1a44076050125825900e736c501f859c50fe728c"; // same address shared across chains
  const PACKET_DELIVERED_TOPIC = "0x3cd5e48f9730b129dc7550f0fcea9c767b7be37837cd10e55eb35f734f4bca04";
  const detection: MintBurnBridgeDetectionConfig = layerZeroOftBridgeDetection([
    "0xffa10065ce1d1c42fabc46e06b84ed8ffeb4bae5", // USDai OAdapter (Arb)
  ]);

  it("tags a LayerZero-Executor-only mint when endpoint emits PacketDelivered (no OAdapter touch)", () => {
    const rows = [row({ direction: "mint", tx_hash: "0xexec" })];
    const ctx = new Map<string, MintBurnTxContext | null>([
      ["0xexec", {
        to: "0x31cae3b7fb82d847621859fb1585353c5720660d", // LayerZero Executor
        inputSelector: "0x123456ab",
        logTopics: [PACKET_DELIVERED_TOPIC],
        logAddresses: [ARB_LZ_ENDPOINT_V2], // endpoint is in logs but OAdapter is NOT
      }],
    ]);
    classifyBridgeAwareBurnRows(rows, detection, ctx);
    expect(rows[0].flow_type).toBe("bridge_transfer");
  });

  // Documented tradeoff: the Arbitrum LayerZero endpoint is shared across many OFT
  // deployments. A tx that emits PacketDelivered for ANY OFT will now pass fingerprintC.
  // In the current pipeline the classifier is called with detection tied to a specific
  // coin, so an unrelated OFT tx won't affect coins whose mint/burn rows are absent from
  // that tx. The remaining risk is a shared tx where BOTH coins have rows — a mint of
  // tracked coin A in the same tx as a bridge of coin B is (conservatively) now tagged.
  // We accept this as a tradeoff for catching Executor-only mints; add a per-message
  // recipient-address decode step if real fallout emerges.
  it("tags a mint when LayerZero endpoint emits the signal (even without OAdapter touch)", () => {
    // Second detection config using a DIFFERENT known bridge contract.
    const otherOftDetection: MintBurnBridgeDetectionConfig = layerZeroOftBridgeDetection([
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]);
    const rows = [row({ direction: "mint", tx_hash: "0xsame" })];
    const ctx = new Map<string, MintBurnTxContext | null>([
      ["0xsame", {
        to: "0x31cae3b7fb82d847621859fb1585353c5720660d",
        inputSelector: "0x00000000",
        logTopics: [PACKET_DELIVERED_TOPIC],
        logAddresses: [ARB_LZ_ENDPOINT_V2],
      }],
    ]);
    classifyBridgeAwareBurnRows(rows, otherOftDetection, ctx);
    expect(rows[0].flow_type).toBe("bridge_transfer"); // documented tradeoff
  });
});
