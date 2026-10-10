import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../jltxx-reserve-capture", () => ({ bootstrapJltxxReserves: vi.fn() }));
import { bootstrapJltxxReserves } from "../jltxx-reserve-capture";
import { handleBootstrapJltxxReserves } from "../bootstrap-jltxx-reserves";
import { closeOpenLeaseDatabases, makeLeaseDb } from "../../../src/lib/__tests__/cron-leases.test-support";
const capture = vi.mocked(bootstrapJltxxReserves);
function request(headers: Record<string, string> = {}, body?: string, query = "") {
  return new Request(`https://ops-api.pharos.watch/api/bootstrap-jltxx-reserves${query}`, {
    method: "POST", headers: { "X-Pharos-Admin": "1", "Idempotency-Key": "test-intent", ...headers }, body,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  capture.mockResolvedValue({ evidenceCaptured: true, admissionAllowed: false, runtimePriceMarketcapPass: false, reason: "native-class-temporal-review-unavailable", configFingerprint: "test-fingerprint", attemptStatus: "synced" });
});
afterEach(closeOpenLeaseDatabases);
describe("fixed quarantined JLTXX bootstrap action", () => {
  it.each<{ headers: Record<string, string>; body: string | undefined; query: string }>([
    { headers: { "Idempotency-Key": "" }, body: undefined, query: "" },
    { headers: {}, body: '{"stablecoinId":"stbt-matrixdock"}', query: "" },
    { headers: {}, body: undefined, query: "?rpc=https://example.com" },
  ])("rejects missing intent and all config/coin/RPC overrides", async ({ headers, body, query }) => {
    const response = await handleBootstrapJltxxReserves({ db: makeLeaseDb(), chainRpcs: new Map(), request: request(headers, body, query) });
    expect(response.status).toBe(400);
    expect(capture).not.toHaveBeenCalled();
  });
  it("captures synchronously under lease without claiming HTTP idempotent replay or admission", async () => {
    const db = makeLeaseDb();
    for (let i = 0; i < 2; i++) {
      const response = await handleBootstrapJltxxReserves({ db, chainRpcs: new Map(), request: request() });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ admissionAllowed: false, runtimePriceMarketcapPass: false });
    }
    expect(capture).toHaveBeenCalledTimes(2);
    expect(db.getLease("sync-live-reserves")).toBeUndefined();
  });
  it("cannot overlap the ordinary reserve producer lease", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb({ leases: [{ job: "sync-live-reserves", lease_owner: "ordinary-owner", lease_until: now + 300, heartbeat_at: now, updated_at: now }] });
    const response = await handleBootstrapJltxxReserves({ db, chainRpcs: new Map(), request: request() });
    expect(response.status).toBe(409);
    expect(capture).not.toHaveBeenCalled();
    expect(db.getLease("sync-live-reserves")?.lease_owner).toBe("ordinary-owner");
  });
  it("releases ownership and requires reconciliation after an unconfirmed capture failure", async () => {
    capture.mockRejectedValue(new Error("bootstrap source unavailable"));
    const db = makeLeaseDb();
    await expect(handleBootstrapJltxxReserves({ db, chainRpcs: new Map(), request: request() }))
      .rejects.toThrow("bootstrap source unavailable");
    expect(db.getLease("sync-live-reserves")).toBeUndefined();
  });
});
