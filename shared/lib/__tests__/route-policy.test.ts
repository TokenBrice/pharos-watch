import { describe, expect, it } from "vitest";
import { isCanonicalStablecoinId } from "../stablecoin-id";

describe("canonical stablecoin IDs", () => {
  it.each(["usdc-circle", "a7a5-old-vector", "u"])("accepts %s", (id) => {
    expect(isCanonicalStablecoinId(id)).toBe(true);
  });

  it.each(["", "-usdc", "usdc-", "usdc--circle", "USDC", "../admin", "usdc_circle"])(
    "rejects %s",
    (id) => {
      expect(isCanonicalStablecoinId(id)).toBe(false);
    },
  );
});
