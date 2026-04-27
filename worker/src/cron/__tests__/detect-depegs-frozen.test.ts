import { describe, expect, it } from "vitest";
import { shouldCloseOrphanedDepeg } from "../detect-depegs";

describe("orphan-close exemption for frozen coins", () => {
  it("does not force-close depeg events for frozen coins", () => {
    expect(
      shouldCloseOrphanedDepeg(
        "usr-resolv",
        new Set(["usdt-tether"]),
        new Set(["usr-resolv"]),
      ),
    ).toBe(false);
  });

  it("force-closes orphans that are neither tracked nor frozen", () => {
    expect(
      shouldCloseOrphanedDepeg("zombie-coin", new Set(["usdt-tether"]), new Set()),
    ).toBe(true);
  });

  it("does not force-close active tracked coins", () => {
    expect(
      shouldCloseOrphanedDepeg("usdt-tether", new Set(["usdt-tether"]), new Set()),
    ).toBe(false);
  });
});
