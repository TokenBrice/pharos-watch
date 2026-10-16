import { describe, expect, it, vi } from "vitest";
import {
  runCli,
} from "../maintenance/build-l2beat-bridge-route-candidates";

describe("build-l2beat-bridge-route-candidates", () => {
  it("refuses report writes into stablecoin source data", async () => {
    const stdout = { write: vi.fn(() => true) };

    await expect(runCli([
      "--coin",
      "usdc-circle",
      "--report",
      "shared/data/stablecoins/l2beat-bridge.md",
    ], process.cwd(), stdout)).rejects.toThrow("advisory");
  });
});
