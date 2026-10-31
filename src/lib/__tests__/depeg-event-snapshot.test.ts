import { describe, expect, it } from "vitest";
import { readDepegEventSnapshot } from "@/lib/depeg-event-snapshot";

describe("depeg archive catalog retirement", () => {
  it("marks every archive row whose coin is absent from the tracked catalog", () => {
    const entries = readDepegEventSnapshot({ missing: "throw" });
    const retiredIds = [...new Set(
      entries.filter((event) => event.retired === true).map((event) => event.stablecoinId),
    )].sort();
    expect(retiredIds).toEqual([
      "351",
      "bean-beanstalk",
      "evausdt-eva",
      "gold-vro",
      "gyd-gyroscope",
      "iron-iron-finance",
      "mnee-mnee",
      "pusd-pleasing",
      "rai-reflexer",
      "ust-terra-classic",
      "veur-vnx",
      "yu-yala",
    ]);
  });

  it("leaves catalog coins unmarked", () => {
    const entries = readDepegEventSnapshot({ missing: "throw" });
    const catalogEvent = entries.find((event) => event.stablecoinId === "usdt-tether");
    expect(catalogEvent).toBeDefined();
    expect(catalogEvent).not.toHaveProperty("retired");
  });
});
