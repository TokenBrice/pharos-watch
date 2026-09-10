import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { handleReserveAttemptHistoryRoute } from "../reserve-attempt-history";

function insertAttempt(
  sqlite: ReturnType<typeof createLatestSchemaSqlite>["sqlite"],
  stablecoinId: string,
  attemptedAt: number,
  status: string,
  metadata: string,
): void {
  sqlite
    .prepare(
      `INSERT INTO reserve_sync_attempt_history
         (stablecoin_id, attempted_at, adapter_key, breaker_key, status, metadata)
       VALUES (?, ?, 'adapter', 'live-reserves:adapter', ?, ?)`,
    )
    .run(stablecoinId, attemptedAt, status, metadata);
}

describe("handleReserveAttemptHistoryRoute", () => {
  it("returns the per-coin attempt timeline when authorized", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      insertAttempt(sqlite, "usdc-circle", 1000, "ok", JSON.stringify({ diag: { durationMs: 5 } }));
      insertAttempt(sqlite, "usdc-circle", 1001, "error", JSON.stringify({ failureCategory: "network" }));

      const request = new Request(
        "https://ops-api.pharos.watch/api/reserve-attempt-history?coin=usdc-circle&limit=5",
      );
      const res = await handleReserveAttemptHistoryRoute({
        db,
        trustedAdmin: true,
        request,
        url: new URL(request.url),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { coin: string; attempts: Array<{ status: string; failureCategory: string | null; durationMs: number | null }> };
      expect(body.coin).toBe("usdc-circle");
      expect(body.attempts).toHaveLength(2);
      expect(body.attempts[0]).toMatchObject({ status: "error", failureCategory: "network", durationMs: null });
      expect(body.attempts[1]).toMatchObject({ status: "ok", failureCategory: null, durationMs: 5 });
    } finally {
      sqlite.close();
    }
  });

  it("rejects a request without the required coin parameter", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const request = new Request("https://ops-api.pharos.watch/api/reserve-attempt-history");
      const res = await handleReserveAttemptHistoryRoute({
        db,
        trustedAdmin: true,
        request,
        url: new URL(request.url),
      });
      expect(res.status).toBe(400);
    } finally {
      sqlite.close();
    }
  });
});
