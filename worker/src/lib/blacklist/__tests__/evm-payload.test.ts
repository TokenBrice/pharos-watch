import { describe, expect, it } from "vitest";
import { encodeAbiParameters } from "viem/utils";
import type { BlacklistEventDef } from "../../blacklist-contracts";
import { decodeBlacklistEvmPayload } from "../evm-payload";

const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const caller = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const word = (value: string) => "0x" + "0".repeat(24) + value.slice(2);
const amount = "0x" + (5_000_000n).toString(16).padStart(64, "0");
const event: BlacklistEventDef = {
  signature: "DestroyedBlackFunds(address,uint256)", topicHash: "0xdestroy", eventType: "destroy", hasAmount: true,
};

describe("decodeBlacklistEvmPayload", () => {
  it("extracts indexed uint256 amounts from configured amount topics", () => {
    expect(decodeBlacklistEvmPayload({ ...event, amountTopicIndex: 2 }, {
      topics: [event.topicHash, word(address), amount, word(caller)], data: "0x",
    }, 6)).toEqual({ address, amount: 5, eventType: "destroy" });
  });

  it("extracts address and amount from configured data slots when indexed topics are not the subject", () => {
    expect(decodeBlacklistEvmPayload({ ...event, addressDataIndex: 0, amountDataIndex: 1 }, {
      topics: [event.topicHash, word(caller)],
      data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "string" }, { type: "uint8" }],
        [address, 25_000_000n, "test", 0]),
    }, 6)).toEqual({ address, amount: 25, eventType: "destroy" });
  });

  it.each([false, true])("decodes the default scalar payload with indexed=%s", (indexed) => {
    expect(decodeBlacklistEvmPayload(event, {
      topics: indexed ? [event.topicHash, word(address)] : [event.topicHash],
      data: indexed ? amount : word(address) + amount.slice(2),
    }, 6)).toEqual({ address, amount: 5, eventType: "destroy" });
  });

  it("rejects an amount-bearing data fallback that carries no amount word", () => {
    // A lone data word cannot prove the legacy (address, amount) layout: it may
    // be the amount, so the log must quarantine rather than fabricate an address.
    expect(() => decodeBlacklistEvmPayload(event, {
      topics: [event.topicHash],
      data: "0x" + (5_000_000_000n).toString(16).padStart(64, "0"),
    }, 6)).toThrow("invalid-address");
  });

  it.each(["topic", "data", "override"])("rejects malformed %s address padding", (source) => {
    const malformed = "0x" + "1".repeat(24) + address.slice(2);
    expect(() => decodeBlacklistEvmPayload({ ...event, ...(source === "override" ? { addressDataIndex: 0 } : {}) }, {
      topics: source === "topic" ? [event.topicHash, malformed] : [event.topicHash],
      data: malformed + amount.slice(2),
    }, 6)).toThrow("invalid-address");
  });

  it("keeps amountless destroy quantities unavailable even when extra amount data is present", () => {
    expect(decodeBlacklistEvmPayload({ ...event, hasAmount: false }, {
      topics: [event.topicHash, word(address)], data: amount,
    }, 6).amount).toBeNull();
  });

  it.each(["0x", "0x" + "0".repeat(64)])("distinguishes missing amount data from observed zero %s", (data) => {
    expect(decodeBlacklistEvmPayload(event, { topics: [event.topicHash, word(address)], data }, 6).amount)
      .toBe(data === "0x" ? null : 0);
  });

  it.each([
    ["one", "1".padStart(64, "0"), "blacklist"], ["zero", "0".repeat(64), "unblacklist"],
  ] as const)("decodes the %s bool word", (_name, data, eventType) => {
    expect(decodeBlacklistEvmPayload({ ...event, hasAmount: false, eventTypeFromDataBoolIndex: 0 }, {
      topics: [event.topicHash, word(address)], data: "0x" + data,
    }, 6)).toEqual({ address, amount: null, eventType });
  });

  it.each(["0x", "0x" + "ff".repeat(32)])("fences absent or invalid direction evidence %s", (data) => {
    expect(() => decodeBlacklistEvmPayload({ ...event, eventTypeFromDataBoolIndex: 0 }, {
      topics: [event.topicHash, word(address)], data,
    }, 6)).toThrow("invalid-direction-bool");
  });

  it.each([{ addresses: [] }, { addresses: [address, caller] }] as const)("preserves every address in an ABI batch $addresses", ({ addresses }) => {
    expect(decodeBlacklistEvmPayload({ ...event, addressArrayData: true }, {
      topics: [event.topicHash], data: encodeAbiParameters([{ type: "address[]" }], [addresses]),
    }, 6)).toEqual({ address: addresses, amount: null, eventType: "destroy" });
  });

  it("rejects malformed ABI batches", () => {
    expect(() => decodeBlacklistEvmPayload({ ...event, addressArrayData: true }, {
      topics: [event.topicHash], data: "0xdeadbeef",
    }, 6)).toThrow("invalid-address-array");
  });
});
