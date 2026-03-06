import { describe, expect, it } from "vitest";
import {
  classifyBridgeAwareBurnRows,
  type MintBurnBridgeClassifiableRow,
} from "../mint-burn-bridge-classifier";
import {
  MINT_BURN_CONFIGS,
  type MintBurnBridgeDetectionConfig,
  type MintBurnContractConfig,
} from "../mint-burn-contracts";

type CoinCase = {
  stablecoinId: string;
  symbol: string;
  detection: MintBurnBridgeDetectionConfig;
};

const CCIP_CASE_IDS = ["usdc-circle", "zchf-frankencoin", "usd1-world-liberty-financial", "avusd-avant", "usdo-openeden"] as const;

function loadCoinCase(stablecoinId: string): CoinCase {
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

const COIN_CASES = CCIP_CASE_IDS.map((stablecoinId) => loadCoinCase(stablecoinId));

function makeBurnRow(overrides?: Partial<MintBurnBridgeClassifiableRow>): MintBurnBridgeClassifiableRow {
  return {
    id: overrides?.id ?? "row-1",
    tx_hash: overrides?.tx_hash ?? "0xtx",
    direction: overrides?.direction ?? "burn",
    counterparty: overrides?.counterparty ?? "0xabc0000000000000000000000000000000000000",
    burn_type: overrides?.burn_type ?? null,
    burn_review_reason: overrides?.burn_review_reason ?? null,
  };
}

function signalContext(detection: MintBurnBridgeDetectionConfig) {
  return {
    to: detection.knownBridgeRouterAddresses[0],
    inputSelector: detection.bridgeSignalSelectors[0],
    logTopics: [detection.bridgeSignalTopics[0]],
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
            to: "0x1111111111111111111111111111111111111111",
            inputSelector: "0xdeadbeef",
            logTopics: [],
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
            to: "0x1111111111111111111111111111111111111111",
            inputSelector: "0xdeadbeef",
            logTopics: [],
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
  }
});
