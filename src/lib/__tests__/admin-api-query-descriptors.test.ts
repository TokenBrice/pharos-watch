import { describe, expect, it } from "vitest";
import { ADMIN_API_QUERY_DESCRIPTORS } from "@/lib/admin-api-query-descriptors";

describe("admin API query descriptors", () => {
  it("owns status and request-source paths and query keys", () => {
    expect(ADMIN_API_QUERY_DESCRIPTORS.status).toMatchObject({
      queryKey: ["status"],
      path: "/api/status",
    });
    expect(ADMIN_API_QUERY_DESCRIPTORS.requestSourceStats).toMatchObject({
      queryKey: ["request-source-stats", 24, 3600, 5, 25],
      path: "/api/request-source-stats?hours=24&bucketSec=3600&routeLimit=5&apiKeyLimit=25",
    });
  });

  it("includes the request-page cursor in both the fetch path and query identity", () => {
    expect(
      ADMIN_API_QUERY_DESCRIPTORS.apiKeyRequests({
        status: "pending_verification",
        limit: 50,
        cursor: "page-2",
      }),
    ).toMatchObject({
      queryKey: ["api-key-requests", "pending_verification", 50, "page-2"],
      path: "/api/api-key-requests-admin?status=pending_verification&limit=50&cursor=page-2",
    });
  });

  it.each([
    { target: "global" as const, path: "/api/api-keys/audit-log?limit=50", enabled: true },
    { target: 7, path: "/api/api-keys/audit-log?apiKeyId=7&limit=50", enabled: true },
    { target: null, path: "/api/api-keys/audit-log?limit=50", enabled: false },
  ])("scopes the audit log to $target and only polls a selected target", ({ target, path, enabled }) => {
    expect(ADMIN_API_QUERY_DESCRIPTORS.apiKeyAuditLog(target)).toMatchObject({
      queryKey: ["api-key-audit-log", target],
      path,
      enabled,
    });
  });
});
