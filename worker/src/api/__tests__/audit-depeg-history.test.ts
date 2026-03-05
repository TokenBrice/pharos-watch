import { describe, expect, it } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "./helpers/auth";
import { handleAuditDepegHistory } from "../audit-depeg-history";

stubCryptoForAuth();

describe("handleAuditDepegHistory method safety", () => {
  it("rejects GET mutations when dry-run is not set", async () => {
    const db = mockD1([{ match: "depeg_events", rows: [] }]);
    const req = makeApiRequest("/api/audit-depeg-history", { adminKey: "secret" });

    const res = await handleAuditDepegHistory(db, makeApiUrl(req.url), "secret", req);
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("dry-run=true");
  });

  it("allows GET dry-run previews", async () => {
    const db = mockD1([{ match: "depeg_events", rows: [] }]);
    const req = makeApiRequest("/api/audit-depeg-history?dry-run=true", { adminKey: "secret" });

    const res = await handleAuditDepegHistory(db, makeApiUrl(req.url), "secret", req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dryRun: boolean; totalMatching: number };
    expect(body.dryRun).toBe(true);
    expect(body.totalMatching).toBe(0);
  });
});
