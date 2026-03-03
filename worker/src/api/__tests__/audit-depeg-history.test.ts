import { describe, expect, it, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleAuditDepegHistory } from "../audit-depeg-history";

vi.stubGlobal("crypto", {
  subtle: {
    digest: async (_algo: string, data: ArrayBuffer) => data,
    timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) => {
      const av = new Uint8Array(a);
      const bv = new Uint8Array(b);
      if (av.length !== bv.length) return false;
      return av.every((byte, i) => byte === bv[i]);
    },
  },
});

describe("handleAuditDepegHistory method safety", () => {
  it("rejects GET mutations when dry-run is not set", async () => {
    const db = mockD1([{ match: "depeg_events", rows: [] }]);
    const req = new Request("https://x/api/audit-depeg-history", {
      method: "GET",
      headers: { "X-Admin-Key": "secret" },
    });

    const res = await handleAuditDepegHistory(db, new URL(req.url), "secret", req);
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("dry-run=true");
  });

  it("allows GET dry-run previews", async () => {
    const db = mockD1([{ match: "depeg_events", rows: [] }]);
    const req = new Request("https://x/api/audit-depeg-history?dry-run=true", {
      method: "GET",
      headers: { "X-Admin-Key": "secret" },
    });

    const res = await handleAuditDepegHistory(db, new URL(req.url), "secret", req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dryRun: boolean; totalMatching: number };
    expect(body.dryRun).toBe(true);
    expect(body.totalMatching).toBe(0);
  });
});
