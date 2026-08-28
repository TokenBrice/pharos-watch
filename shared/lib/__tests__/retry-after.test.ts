import { describe, expect, it } from "vitest";
import { parseRetryAfterSeconds } from "../retry-after";

describe("parseRetryAfterSeconds", () => {
  it("parses numeric seconds and HTTP dates", () => {
    expect(parseRetryAfterSeconds("12")).toBe(12);
    expect(parseRetryAfterSeconds("1.2")).toBe(2);
    expect(parseRetryAfterSeconds("Wed, 21 Oct 2015 07:28:10 GMT", {
      nowMs: Date.parse("Wed, 21 Oct 2015 07:28:00 GMT"),
    })).toBe(10);
  });

  it("rejects blank, malformed, and negative values", () => {
    expect(parseRetryAfterSeconds(null)).toBeNull();
    expect(parseRetryAfterSeconds(" ")).toBeNull();
    expect(parseRetryAfterSeconds("later")).toBeNull();
    expect(parseRetryAfterSeconds("-1")).toBeNull();
  });

  it("supports legacy numeric-prefix and rounding policies at caller boundaries", () => {
    expect(parseRetryAfterSeconds("12.9junk", {
      allowNumericPrefix: true,
      numericRounding: "floor",
    })).toBe(12);
    expect(parseRetryAfterSeconds("1.25", { numericRounding: "none" })).toBe(1.25);
  });
});
