import { describe, expect, it } from "vitest";
import { STRICT_CONTRACT_PATHS_LIST } from "../../../../src/lib/strict-contract-paths";
import { route } from "../../router";
import { mockD1 } from "./helpers/mock-d1";

const db = mockD1();
const ctx = {
  waitUntil: (_promise: Promise<unknown>) => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

describe("router contract: strict frontend paths are routable", () => {
  it("routes all strict contract paths", async () => {
    for (const path of STRICT_CONTRACT_PATHS_LIST) {
      const result = route(new URL(`https://api.pharos.watch${path}`), db, ctx);
      expect(result, `expected route for ${path}`).not.toBeNull();

      const response = await result!;
      expect(response.status, `unexpected 404 for ${path}`).not.toBe(404);
    }
  });

  it("returns null for unknown paths", () => {
    const result = route(new URL("https://api.pharos.watch/api/definitely-not-real"), db, ctx);
    expect(result).toBeNull();
  });

  it("blocks GET on mutating admin routes except audit dry-run", async () => {
    const blocked = await route(
      new URL("https://api.pharos.watch/api/backfill-depegs"),
      db,
      ctx,
      new Request("https://api.pharos.watch/api/backfill-depegs", { method: "GET" }),
    );
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(405);

    const blockedAudit = await route(
      new URL("https://api.pharos.watch/api/audit-depeg-history"),
      db,
      ctx,
      new Request("https://api.pharos.watch/api/audit-depeg-history", { method: "GET" }),
    );
    expect(blockedAudit).not.toBeNull();
    expect(blockedAudit!.status).toBe(405);

    const allowedDryRun = await route(
      new URL("https://api.pharos.watch/api/audit-depeg-history?dry-run=true"),
      db,
      ctx,
      new Request("https://api.pharos.watch/api/audit-depeg-history?dry-run=true", { method: "GET" }),
    );
    expect(allowedDryRun).not.toBeNull();
    expect(allowedDryRun!.status).not.toBe(405);
  });
});
