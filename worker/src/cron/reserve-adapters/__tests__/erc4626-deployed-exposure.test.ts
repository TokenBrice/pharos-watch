import { beforeEach, describe, expect, it } from "vitest";
import { resetRpcMocks } from "./helpers/rpc-mock";
import { mockErc4626Rpc, runTrackedVault } from "./erc4626-single-asset.test-support";

describe("ERC-4626 held versus deployed exposure", () => {
  beforeEach(resetRpcMocks);

  it("does not claim USDC holdings for YieldFi's zero-idle live observation", async () => {
    mockErc4626Rpc({
      vault: "0x19ebd191f7a24ece672ba13a302212b5ef7f35cb",
      totalAssets: 10_696_286_730_934n,
      convertedAssets: 10_696_286_730_934n,
      idleBalance: 0n,
    });
    const result = await runTrackedVault("yusd-yieldfi");
    expect(result.slices).toEqual([expect.objectContaining({ pct: 100, risk: "high" })]);
    expect(result.slices[0]).not.toHaveProperty("coinId");
    expect(result.metadata?.unknownExposurePct).toBe(100);
  });

  it("attributes only measured idle USDC while retaining the deployed remainder", async () => {
    mockErc4626Rpc({ idleBalance: 25_000_000n });
    const result = await runTrackedVault("syrupusdc-maple");
    expect(result.slices).toEqual([
      expect.objectContaining({ pct: 25, coinId: "usdc-circle" }),
      expect.objectContaining({ pct: 75, risk: "high" }),
    ]);
    expect(result.slices[1]).not.toHaveProperty("coinId");
    expect(result.slices[1]).not.toHaveProperty("depType");
    expect(result.metadata?.unknownExposurePct).toBe(75);
  });

  it.each([100_000_000n, 120_000_000n])("keeps a single underlying slice when holdings cover totalAssets (%s)", async (idleBalance) => {
    mockErc4626Rpc({ idleBalance });
    const result = await runTrackedVault("syrupusdc-maple");
    expect(result.slices).toEqual([expect.objectContaining({ pct: 100, coinId: "usdc-circle", risk: "medium" })]);
    expect(result.metadata?.unknownExposurePct).toBe(0);
  });

  it("does not invent an idle holding when the balance probe is unreadable", async () => {
    mockErc4626Rpc({ idleBalance: null });
    const result = await runTrackedVault("syrupusdc-maple");
    expect(result.slices).toEqual([expect.objectContaining({ pct: 100, risk: "high" })]);
    expect(result.slices[0]).not.toHaveProperty("coinId");
    expect(result.metadata?.unknownExposurePct).toBe(100);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "erc4626-idle-balance-unavailable", effect: "degraded" }));
  });
});
