import { makeIdempotentAdminRoute } from "../lib/route-wrappers";
import { errorResponse, jsonResponse } from "../lib/api-utils";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { logAdminAction } from "../lib/admin-action-audit";

interface AdminRouteContext {
  db: D1Database;
  url: URL;
  request: Request;
  trustedAdmin: boolean;
}

const VALID_CIRCUITS = new Set<string>(Object.values(CIRCUIT_SOURCE));

export const handleResetCircuitBreaker = makeIdempotentAdminRoute<AdminRouteContext>(
  "route-reset-circuit-breaker",
  "reset-circuit-breaker",
  async ({ db, url, request }) => {
    const circuit = url.searchParams.get("circuit")?.trim();
    if (!circuit) return errorResponse(400, "Missing required query param: circuit");
    if (!VALID_CIRCUITS.has(circuit)) return errorResponse(400, `Unknown circuit: ${circuit}`);

    // Breaker state is persisted in the `cache` table under "circuit:<source>"
    // (worker/src/lib/circuit-breaker.ts). Deleting the row forces the next
    // call to re-probe with a closed breaker.
    const result = await db.prepare("DELETE FROM cache WHERE key = ?").bind(`circuit:${circuit}`).run();
    const cleared = result.meta?.changes ?? 0;
    await logAdminAction(
      db,
      { action: "reset-circuit-breaker", target: circuit, result: "ok", httpStatus: 200, details: { cleared } },
      request,
    );
    return jsonResponse({ ok: true, cleared }, { status: 200, noStore: true });
  },
);
