import { describe, it, expect } from "vitest";
import { buildTopicParams } from "../evm-logs";

describe("buildTopicParams", () => {
  it("builds params for single topic (topic0 only)", () => {
    const params = buildTopicParams([{ index: 0, value: "0xabc" }]);
    expect(params.get("topic0")).toBe("0xabc");
    expect(params.has("topic0_1_opr")).toBe(false);
    expect(params.has("topic0_2_opr")).toBe(false);
  });

  it("builds params for compound topics (topic0 + topic1) — mint detection", () => {
    const params = buildTopicParams([
      { index: 0, value: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" },
      { index: 1, value: "0x0000000000000000000000000000000000000000000000000000000000000000" },
    ]);
    expect(params.get("topic0")).toBe(
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
    );
    expect(params.get("topic1")).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    );
    expect(params.get("topic0_1_opr")).toBe("and");
    expect(params.has("topic0_2_opr")).toBe(false);
  });

  it("builds params for topic0 + topic2 — burn detection", () => {
    const params = buildTopicParams([
      { index: 0, value: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" },
      { index: 2, value: "0x0000000000000000000000000000000000000000000000000000000000000000" },
    ]);
    expect(params.get("topic0")).toBe(
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
    );
    expect(params.get("topic2")).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    );
    expect(params.get("topic0_2_opr")).toBe("and");
    expect(params.has("topic0_1_opr")).toBe(false);
  });

  it("builds params for topic0 + topic1 + topic2 (three topics)", () => {
    const params = buildTopicParams([
      { index: 0, value: "0xaaa" },
      { index: 1, value: "0xbbb" },
      { index: 2, value: "0xccc" },
    ]);
    expect(params.get("topic0")).toBe("0xaaa");
    expect(params.get("topic1")).toBe("0xbbb");
    expect(params.get("topic2")).toBe("0xccc");
    expect(params.get("topic0_1_opr")).toBe("and");
    expect(params.get("topic0_2_opr")).toBe("and");
  });
});
