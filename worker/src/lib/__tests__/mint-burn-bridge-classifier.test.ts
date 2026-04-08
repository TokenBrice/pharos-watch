import { describe, expect, it } from "vitest";
import {
  classifyBridgeAwareBurnRows,
  type MintBurnBridgeClassifiableRow,
} from "../mint-burn-bridge-classifier";
import {
  MINT_BURN_CONFIGS,
  type MintBurnBridgeDetectionConfig,
  type MintBurnCcipBridgeDetectionConfig,
  type MintBurnContractConfig,
  type MintBurnLayerZeroOftBridgeDetectionConfig,
} from "../mint-burn-contracts";

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

const CCIP_CASE_IDS = ["usdc-circle", "zchf-frankencoin", "usd1-world-liberty-financial", "avusd-avant", "usdo-openeden"] as const;
const LAYERZERO_CASE_IDS = ["usdai-usd-ai"] as const;

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

const COIN_CASES = CCIP_CASE_IDS.map((stablecoinId) => loadCcipCase(stablecoinId));
const LAYERZERO_CASES = LAYERZERO_CASE_IDS.map((stablecoinId) => loadLayerZeroCase(stablecoinId));

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

function signalContext(detection: MintBurnCcipBridgeDetectionConfig) {
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

    it(`[${coin.symbol}] flags bridge signal with unknown pool as review_required`, () => {
      const row = makeBurnRow({
        tx_hash: `0xunknown-pool-${coin.stablecoinId}`,
        counterparty: "0x9999000000000000000000000000000000000000",
      });
      const contexts = new Map([[row.tx_hash, signalContext(coin.detection)]]);

      classifyBridgeAwareBurnRows([row], coin.detection, contexts);

      expect(row.burn_type).toBe("review_required");
      expect(row.burn_review_reason).toBe("bridge-signal-with-unknown-pool");
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
