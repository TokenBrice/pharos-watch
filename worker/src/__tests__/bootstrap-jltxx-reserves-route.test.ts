import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../cron/bootstrap-jltxx-reserves", () => ({ bootstrapJltxxReserves: vi.fn() }));
import { bootstrapJltxxReserves } from "../cron/bootstrap-jltxx-reserves";
import { handleBootstrapJltxxReserves } from "../handlers/scheduled/jltxx-reserve-bootstrap-manual";
import { closeOpenLeaseDatabases, makeLeaseDb } from "../lib/__tests__/cron-leases.test-support";
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
  it.each<{ trustedAdmin: boolean; headers: Record<string, string>; status: number }>([{ trustedAdmin: false, headers: {}, status: 401 }, { trustedAdmin: true, headers: { "X-Pharos-Admin": "" }, status: 403 }])(
    "requires authenticated mutation authority ($status)", async ({ trustedAdmin, headers, status }) => {
      const response = await handleBootstrapJltxxReserves({ db: makeLeaseDb(), chainRpcs: new Map(), trustedAdmin, request: request(headers) });
      expect(response.status).toBe(status);
      expect(capture).not.toHaveBeenCalled();
    },
  );
  it.each<{ headers: Record<string, string>; body: string | undefined; query: string }>([
    { headers: { "Idempotency-Key": "" }, body: undefined, query: "" },
    { headers: {}, body: '{"stablecoinId":"stbt-matrixdock"}', query: "" },
    { headers: {}, body: undefined, query: "?rpc=https://example.com" },
  ])("rejects missing intent and all config/coin/RPC overrides", async ({ headers, body, query }) => {
    const response = await handleBootstrapJltxxReserves({ db: makeLeaseDb(), chainRpcs: new Map(), trustedAdmin: true, request: request(headers, body, query) });
    expect(response.status).toBe(400);
    expect(capture).not.toHaveBeenCalled();
  });
  it("captures synchronously with idempotent replay but never advertises admission or runtime PASS", async () => {
    const db = makeLeaseDb();
    for (let i = 0; i < 2; i++) {
      const response = await handleBootstrapJltxxReserves({ db, chainRpcs: new Map(), trustedAdmin: true, request: request() });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ admissionAllowed: false, runtimePriceMarketcapPass: false });
    }
    expect(capture).toHaveBeenCalledTimes(1);
    expect(db.getLease("sync-live-reserves")).toBeUndefined();
  });
  it("cannot overlap the ordinary reserve producer lease", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb({ leases: [{ job: "sync-live-reserves", lease_owner: "ordinary-owner", lease_until: now + 300, heartbeat_at: now, updated_at: now }] });
    const response = await handleBootstrapJltxxReserves({ db, chainRpcs: new Map(), trustedAdmin: true, request: request() });
    expect(response.status).toBe(409);
    expect(capture).not.toHaveBeenCalled();
    expect(db.getLease("sync-live-reserves")?.lease_owner).toBe("ordinary-owner");
  });
  it("releases ownership and requires reconciliation after an unconfirmed capture failure", async () => {
    capture.mockRejectedValue(new Error("bootstrap source unavailable"));
    const db = makeLeaseDb();
    const response = await handleBootstrapJltxxReserves({ db, chainRpcs: new Map(), trustedAdmin: true, request: request() });
    expect(response.status).toBe(503);
    expect(response.headers.get("X-Execution-Certainty")).toBe("unknown");
    expect(await response.json()).toMatchObject({ error: "execution_unknown" });
    const replay = await handleBootstrapJltxxReserves({ db, chainRpcs: new Map(), trustedAdmin: true, request: request() });
    expect(replay.status).toBe(503);
    expect(await replay.json()).toMatchObject({ error: "execution_unknown" });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(db.getLease("sync-live-reserves")).toBeUndefined();
  });
});
