import { describe, it, expect } from "vitest";
import { isSuccessfulOutcome, type FetcherOutcome } from "../fetcher-result";

describe("isSuccessfulOutcome", () => {
  it("returns true for ok outcomes", () => {
    const outcome: FetcherOutcome<number> = { kind: "ok", value: 1 };
    expect(isSuccessfulOutcome(outcome)).toBe(true);
  });

  it("returns true for no-data outcomes (transport ok, zero matches)", () => {
    const outcome: FetcherOutcome<number> = { kind: "no-data", value: 0 };
    expect(isSuccessfulOutcome(outcome)).toBe(true);
  });

  it("returns true for blocked outcomes (provider block, no contribution)", () => {
    const outcome: FetcherOutcome<number> = { kind: "blocked", value: 0 };
    expect(isSuccessfulOutcome(outcome)).toBe(true);
  });

  it("returns false for upstream-error outcomes", () => {
    const outcome: FetcherOutcome<number> = {
      kind: "upstream-error",
      value: 0,
      reason: "connection refused",
    };
    expect(isSuccessfulOutcome(outcome)).toBe(false);
  });
});
