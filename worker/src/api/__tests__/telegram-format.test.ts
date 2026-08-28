import { describe, expect, it } from "vitest";
import { formatTelegramCompactUsd, formatTelegramSignedCompactUsd } from "../telegram-format";

describe("Telegram compact USD formatting", () => {
  it("preserves user-visible tier and sign bytes", () => {
    expect(formatTelegramCompactUsd(1_250_000_000_000)).toBe("$1250.0B");
    expect(formatTelegramCompactUsd(2_500_000_000)).toBe("$2.5B");
    expect(formatTelegramCompactUsd(3_500_000)).toBe("$3.5M");
    expect(formatTelegramCompactUsd(4_500)).toBe("$4.5K");
    expect(formatTelegramCompactUsd(999)).toBe("$999");
    expect(formatTelegramCompactUsd(-2_500_000)).toBe("$-2.5M");
    expect(formatTelegramSignedCompactUsd(2_500_000)).toBe("+$2.5M");
    expect(formatTelegramSignedCompactUsd(-2_500_000)).toBe("-$2.5M");
  });

  it("returns null for nullish and non-finite values", () => {
    expect(formatTelegramCompactUsd(null)).toBeNull();
    expect(formatTelegramCompactUsd(Infinity)).toBeNull();
    expect(formatTelegramSignedCompactUsd(undefined)).toBeNull();
    expect(formatTelegramSignedCompactUsd(NaN)).toBeNull();
  });
});
