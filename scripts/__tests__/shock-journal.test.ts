import { describe, expect, it } from "vitest";

import { getShockRpcMaxBatchSize } from "../lib/mechanism-measurement/shock-journal";

describe("shock journal RPC batching", () => {
  it("applies provider limits only to exact hosts and subdomains", () => {
    expect(getShockRpcMaxBatchSize("https://base.drpc.org")).toBe(3);
    expect(getShockRpcMaxBatchSize("https://drpc.org/rpc")).toBe(3);
    expect(getShockRpcMaxBatchSize("https://eth.blockscout.com/api")).toBe(5);
    expect(getShockRpcMaxBatchSize("https://blockscout.com")).toBe(5);
  });

  it("does not infer the provider from another URL component or hostname substring", () => {
    expect(getShockRpcMaxBatchSize("https://example.com/rpc/drpc.org")).toBe(50);
    expect(getShockRpcMaxBatchSize("https://example.com/?provider=blockscout.com")).toBe(50);
    expect(getShockRpcMaxBatchSize("https://drpc.org.example.com")).toBe(50);
    expect(getShockRpcMaxBatchSize("https://notblockscout.com")).toBe(50);
  });
});
