import {
  adminErrorResponse,
  adminJsonResponse,
  type AdminUrlRouteContext,
  makeIdempotentAdminRoute,
} from "../lib/route-wrappers";
import { isActiveCircuitSource } from "../lib/circuit-breaker";
import { logAdminAction } from "../lib/admin-action-audit";

export const handleResetCircuitBreaker = makeIdempotentAdminRoute<AdminUrlRouteContext>(
  "route-reset-circuit-breaker",
  "reset-circuit-breaker",
  async ({ db, url, request }) => {
    const circuit = url.searchParams.get("circuit")?.trim();
    if (!circuit) return adminErrorResponse(400, "Missing required query param: circuit");
    if (!isActiveCircuitSource(circuit)) return adminErrorResponse(400, `Unknown circuit: ${circuit}`);

    // Breaker state is persisted in the `cache` table under "circuit:<source>"
    // (worker/src/lib/circuit-breaker.ts), including configured live-reserve
    // scopes. Deleting the row forces the next call to re-probe closed.
    const result = await db.prepare("DELETE FROM cache WHERE key = ?").bind(`circuit:${circuit}`).run();
    const cleared = result.meta?.changes ?? 0;
    await logAdminAction(
      db,
      { action: "reset-circuit-breaker", target: circuit, result: "ok", httpStatus: 200, details: { cleared } },
      request,
    );
    return adminJsonResponse({ ok: true, cleared }, { status: 200 });
  },
);
