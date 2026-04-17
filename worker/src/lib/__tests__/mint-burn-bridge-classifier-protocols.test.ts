/**
 * Focused unit tests for the per-protocol bridge classifier helpers.
 *
 * The broader end-to-end suite lives in `mint-burn-bridge-classifier.test.ts`
 * and exercises the dispatcher against real `MINT_BURN_CONFIGS` fixtures. These
 * tests target the helpers directly so each fingerprint / branch is covered in
 * isolation.
 */
import { describe, expect, it } from "vitest";
import {
  classifyLayerZeroOft,
  classifyPoolBridge,
} from "../mint-burn-bridge-classifier-protocols";
import type {
  MintBurnBridgeClassifiableRow,
  MintBurnTxContext,
} from "../mint-burn-bridge-classifier";
import type {
  MintBurnCcipBridgeDetectionConfig,
  MintBurnLayerZeroOftBridgeDetectionConfig,
} from "../mint-burn-contracts";

const OFT_ADAPTER = "0xffa10065ce1d1c42fabc46e06b84ed8ffeb4bae5";
const LZ_ENDPOINT = "0x1a44076050125825900e736c501f859c50fe728c";
const LZ_EXECUTOR = "0x31cae3b7fb82d847621859fb1585353c5720660d";
const PACKET_SENT_TOPIC = "0x1ab700d4ced0c005b164c0f789fd09fcbb0156d4c2041b77336e2ec8b67b61d8";
const PACKET_DELIVERED_TOPIC = "0x3cd5e48f9730b129dc7550f0fcea9c767b7be37837cd10e55eb35f734f4bca04";
const SEND_SELECTOR = "0xc7c7f5b3"; // fingerprintB signal selector
const RANDOM_SELECTOR = "0xdeadbeef";

const CCIP_ROUTER = "0x80226fc0ee2b096224eeac085bb9a8cba1146f7d";
const CCIP_POOL = "0x9359cd75549dae00cdd8d22297bc9b13fbbe4b79";
const CCIP_SEND_REQUESTED_TOPIC = "0xd0c3c799bf9e2639de44391e7f524d229b2b55f5b1ea94b2bf7da42f7243dddd";
const CCIP_SEND_SELECTOR = "0x96f4e9f9";

function makeRow(overrides: Partial<MintBurnBridgeClassifiableRow> = {}): MintBurnBridgeClassifiableRow {
  return {
    id: "id-1",
    tx_hash: "0xtx1",
    direction: "burn",
    flow_type: "standard",
    counterparty: null,
    burn_type: null,
    burn_review_reason: null,
    ...overrides,
  };
}

function layerZeroDetection(): MintBurnLayerZeroOftBridgeDetectionConfig {
  return {
    protocol: "layerzero-oft",
    knownBridgeContractAddresses: [OFT_ADAPTER],
    bridgeSignalEmitterAddresses: [LZ_ENDPOINT],
    bridgeSignalTopics: [PACKET_SENT_TOPIC, PACKET_DELIVERED_TOPIC],
    bridgeSignalSelectors: [SEND_SELECTOR],
  };
}

function ccipDetection(): MintBurnCcipBridgeDetectionConfig {
  return {
    protocol: "ccip",
    knownBridgePoolAddresses: [CCIP_POOL],
    knownBridgeRouterAddresses: [CCIP_ROUTER],
    bridgeSignalTopics: [CCIP_SEND_REQUESTED_TOPIC],
    bridgeSignalSelectors: [CCIP_SEND_SELECTOR],
  };
}

describe("classifyLayerZeroOft", () => {
  it("fingerprintA fires when adapter is touched and endpoint emits signal topic", () => {
    const row = makeRow({ direction: "mint", tx_hash: "0xa" });
    const ctx = new Map<string, MintBurnTxContext | null>([
      ["0xa", {
        to: OFT_ADAPTER,
        inputSelector: RANDOM_SELECTOR,
        logTopics: [PACKET_SENT_TOPIC],
        logAddresses: [OFT_ADAPTER, LZ_ENDPOINT],
      }],
    ]);

    classifyLayerZeroOft([row], layerZeroDetection(), ctx);

    expect(row.flow_type).toBe("bridge_transfer");
  });

  it("fingerprintB fires when adapter is touched with a known signal selector (no topic)", () => {
    const row = makeRow({ direction: "burn", tx_hash: "0xb" });
    const ctx = new Map<string, MintBurnTxContext | null>([
      ["0xb", {
        to: OFT_ADAPTER,
        inputSelector: SEND_SELECTOR,
        logTopics: [],
        logAddresses: [OFT_ADAPTER],
      }],
    ]);

    classifyLayerZeroOft([row], layerZeroDetection(), ctx);

    expect(row.flow_type).toBe("bridge_transfer");
    expect(row.burn_type).toBe("bridge_burn");
  });

  it("fingerprintC fires when endpoint emits signal topic without adapter being touched (Executor-only)", () => {
    const row = makeRow({ direction: "mint", tx_hash: "0xc" });
    const ctx = new Map<string, MintBurnTxContext | null>([
      ["0xc", {
        to: LZ_EXECUTOR,
        inputSelector: RANDOM_SELECTOR,
        logTopics: [PACKET_DELIVERED_TOPIC],
        logAddresses: [LZ_ENDPOINT],
      }],
    ]);

    classifyLayerZeroOft([row], layerZeroDetection(), ctx);

    expect(row.flow_type).toBe("bridge_transfer");
  });

  it("no fingerprint fires when topic emitter does not match the expected endpoint", () => {
    const row = makeRow({ direction: "mint", tx_hash: "0xd" });
    const ctx = new Map<string, MintBurnTxContext | null>([
      ["0xd", {
        to: "0x9999999999999999999999999999999999999999",
        inputSelector: RANDOM_SELECTOR,
        logTopics: [PACKET_DELIVERED_TOPIC],
        logAddresses: ["0x4444444444444444444444444444444444444444"],
      }],
    ]);

    classifyLayerZeroOft([row], layerZeroDetection(), ctx);

    expect(row.flow_type).toBe("standard");
  });
});

describe("classifyPoolBridge", () => {
  it("tags every row in a tx as bridge_transfer when a bridge signal is present", () => {
    // Mint row has no pool counterparty; the tx-level signal still tags it.
    const mintRow = makeRow({ direction: "mint", tx_hash: "0xmint" });
    const ctx = new Map<string, MintBurnTxContext | null>([
      ["0xmint", {
        to: CCIP_ROUTER,
        inputSelector: CCIP_SEND_SELECTOR,
        logTopics: [CCIP_SEND_REQUESTED_TOPIC],
        logAddresses: [CCIP_ROUTER],
      }],
    ]);

    classifyPoolBridge([mintRow], ccipDetection(), ctx);

    expect(mintRow.flow_type).toBe("bridge_transfer");
  });

  it("marks known-pool burn as review_required when tx has no bridge signal", () => {
    const burnRow = makeRow({
      direction: "burn",
      tx_hash: "0xnosig",
      counterparty: CCIP_POOL,
      burn_type: "effective_burn", // simulate default classification already applied
    });
    const ctx = new Map<string, MintBurnTxContext | null>([
      ["0xnosig", {
        to: "0x1111111111111111111111111111111111111111",
        inputSelector: RANDOM_SELECTOR,
        logTopics: [],
        logAddresses: [],
      }],
    ]);

    classifyPoolBridge([burnRow], ccipDetection(), ctx);

    expect(burnRow.burn_type).toBe("review_required");
    expect(burnRow.burn_review_reason).toBe("known-bridge-pool-without-bridge-signal");
    expect(burnRow.flow_type).toBe("standard");
  });

  it("marks known-pool burn as tx-context-unavailable when tx context is missing", () => {
    const burnRow = makeRow({
      direction: "burn",
      tx_hash: "0xnull",
      counterparty: CCIP_POOL,
      burn_type: "effective_burn",
    });
    const ctx = new Map<string, MintBurnTxContext | null>([["0xnull", null]]);

    classifyPoolBridge([burnRow], ccipDetection(), ctx);

    expect(burnRow.burn_type).toBe("review_required");
    expect(burnRow.burn_review_reason).toBe("tx-context-unavailable");
  });
});
