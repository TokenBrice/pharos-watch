import { describe, expect, it } from "vitest";
import {
  classifyBridgeAwareBurnRows,
  type MintBurnBridgeClassifiableRow,
} from "../mint-burn-bridge-classifier";
import type { MintBurnBridgeDetectionConfig } from "../mint-burn-contracts";

const CCIP_SEND_REQUESTED_TOPIC = "0xd0c3c799bf9e2639de44391e7f524d229b2b55f5b1ea94b2bf7da42f7243dddd";

const BRIDGE_CONFIG: MintBurnBridgeDetectionConfig = {
  protocol: "ccip",
  knownBridgePoolAddresses: ["0x9359cd75549dae00cdd8d22297bc9b13fbbe4b79"],
  knownBridgeRouterAddresses: ["0x80226fc0ee2b096224eeac085bb9a8cba1146f7d"],
  bridgeSignalTopics: [CCIP_SEND_REQUESTED_TOPIC],
  bridgeSignalSelectors: ["0x96f4e9f9"],
};

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

describe("classifyBridgeAwareBurnRows", () => {
  it("keeps genuine burns as effective_burn", () => {
    const row = makeBurnRow({ tx_hash: "0xgenuine" });
    const contexts = new Map([
      ["0xgenuine", { to: "0x1111111111111111111111111111111111111111", inputSelector: "0xdeadbeef", logTopics: [] }],
    ]);

    classifyBridgeAwareBurnRows([row], BRIDGE_CONFIG, contexts);

    expect(row.burn_type).toBe("effective_burn");
    expect(row.burn_review_reason).toBeNull();
  });

  it("classifies CCIP bridge burns as bridge_burn", () => {
    const row = makeBurnRow({
      tx_hash: "0xbridge",
      counterparty: "0x9359cd75549dae00cdd8d22297bc9b13fbbe4b79",
    });
    const contexts = new Map([
      [
        "0xbridge",
        {
          to: "0x80226fc0ee2b096224eeac085bb9a8cba1146f7d",
          inputSelector: "0x96f4e9f9",
          logTopics: [CCIP_SEND_REQUESTED_TOPIC],
        },
      ],
    ]);

    classifyBridgeAwareBurnRows([row], BRIDGE_CONFIG, contexts);

    expect(row.burn_type).toBe("bridge_burn");
    expect(row.burn_review_reason).toBeNull();
  });

  it("handles mixed transactions without downgrading genuine burns", () => {
    const bridgeRow = makeBurnRow({
      id: "row-bridge",
      tx_hash: "0xmixed",
      counterparty: "0x9359cd75549dae00cdd8d22297bc9b13fbbe4b79",
    });
    const genuineRow = makeBurnRow({
      id: "row-genuine",
      tx_hash: "0xmixed",
      counterparty: "0x1234000000000000000000000000000000000000",
    });
    const contexts = new Map([
      [
        "0xmixed",
        {
          to: "0x80226fc0ee2b096224eeac085bb9a8cba1146f7d",
          inputSelector: "0x96f4e9f9",
          logTopics: [CCIP_SEND_REQUESTED_TOPIC],
        },
      ],
    ]);

    classifyBridgeAwareBurnRows([bridgeRow, genuineRow], BRIDGE_CONFIG, contexts);

    expect(bridgeRow.burn_type).toBe("bridge_burn");
    expect(genuineRow.burn_type).toBe("effective_burn");
    expect(genuineRow.burn_review_reason).toBeNull();
  });

  it("flags unknown bridge-pool burns for review", () => {
    const row = makeBurnRow({
      tx_hash: "0xunknown-bridge",
      counterparty: "0x9999000000000000000000000000000000000000",
    });
    const contexts = new Map([
      [
        "0xunknown-bridge",
        {
          to: "0x80226fc0ee2b096224eeac085bb9a8cba1146f7d",
          inputSelector: "0x96f4e9f9",
          logTopics: [CCIP_SEND_REQUESTED_TOPIC],
        },
      ],
    ]);

    classifyBridgeAwareBurnRows([row], BRIDGE_CONFIG, contexts);

    expect(row.burn_type).toBe("review_required");
    expect(row.burn_review_reason).toBe("bridge-signal-with-unknown-pool");
  });
});
